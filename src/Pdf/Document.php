<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * An existing PDF, read far enough to revise it with an incremental update.
 *
 * It follows the chain of cross-reference sections from the end of the file, tables and streams alike,
 * reads objects on demand, including those packed into object streams, and walks the page tree. Where an
 * offset is wrong it falls back to finding objects by scanning the file, as PDF viewers do.
 */
final class Document
{
    /**
     * Where each object is: `[1, offset, generation]`, `[2, object stream, index]`, or `[0, 0, 0]` when it is free.
     *
     * @var array<int, array{0: int, 1: int, 2: int}>
     */
    private array $xref = [];

    private Dictionary $trailer;

    private int $startxref = 0;

    private bool $xrefIsStream = false;

    /** @var array<int, mixed> */
    private array $objects = [];

    /** @var array<int, array{0: string, 1: array<int, int>}> Decoded object streams: their data, and each object's offset in it. */
    private array $objectStreams = [];

    /** @var ?array<int, int> Offsets found by scanning, when the cross-reference sections cannot be trusted. */
    private ?array $scanned = null;

    /** @var ?list<Page> */
    private ?array $pages = null;

    private function __construct(private readonly string $bytes)
    {
        $this->trailer = new Dictionary();
    }

    /**
     * Reads a PDF file.
     *
     * @param string $path The file.
     *
     * @throws PdfException The file could not be read, or is not a PDF.
     */
    public static function open(string $path): self
    {
        $bytes = is_file($path) ? @file_get_contents($path) : false;

        if (false === $bytes) {
            throw new PdfException("Could not read {$path}.");
        }

        return self::fromString($bytes);
    }

    /**
     * Reads a PDF from its bytes.
     *
     * @param string $bytes The PDF.
     *
     * @throws PdfException The bytes are not a PDF.
     */
    public static function fromString(string $bytes): self
    {
        $header = strpos($bytes, '%PDF-');

        if (false === $header || $header > 1024) {
            throw new PdfException('This is not a PDF.');
        }

        $document = new self($bytes);
        $document->readCrossReferences();

        return $document;
    }

    /**
     * The document's bytes, exactly as read.
     */
    public function bytes(): string
    {
        return $this->bytes;
    }

    /**
     * The newest trailer, with entries only older ones set filled in from them.
     */
    public function trailer(): Dictionary
    {
        return $this->trailer;
    }

    /**
     * The offset of the newest cross-reference section, which an update's `/Prev` points to.
     */
    public function startxref(): int
    {
        return $this->startxref;
    }

    /**
     * Whether the newest cross-reference section is a stream, which an update should then use too.
     */
    public function xrefIsStream(): bool
    {
        return $this->xrefIsStream;
    }

    /**
     * One more than the highest object number in use: where new objects start.
     */
    public function size(): int
    {
        $trailerSize = $this->trailer->get('Size');
        $highest = [] === $this->xref ? 0 : max(array_keys($this->xref)) + 1;

        return max(is_int($trailerSize) ? $trailerSize : 0, $highest, $this->scanned ? max(array_keys($this->scanned)) + 1 : 0);
    }

    /**
     * Whether the document is encrypted.
     */
    public function isEncrypted(): bool
    {
        return null !== $this->trailer->get('Encrypt');
    }

    /**
     * Whether the document carries a digital signature, which rewriting it would invalidate.
     */
    public function hasDigitalSignatures(): bool
    {
        return str_contains($this->bytes, '/ByteRange');
    }

    /**
     * An indirect object's value, or null when it does not exist, as PDF defines a missing object.
     *
     * @param int $number The object number.
     */
    public function object(int $number): mixed
    {
        if (array_key_exists($number, $this->objects)) {
            return $this->objects[$number];
        }

        // Mark it as being read, so a reference cycle ends in null rather than recursing forever.
        $this->objects[$number] = null;
        [$type, $a, $b] = $this->xref[$number] ?? [-1, 0, 0];

        $value = match ($type) {
            1 => $this->readAt($a, $number),
            2 => $this->readCompressed($a, $b, $number),
            0 => null,
            default => $this->readScanned($number),
        };

        return $this->objects[$number] = $value;
    }

    /**
     * A value with any indirect references followed.
     *
     * @param mixed $value A value that may be a {@see Reference}.
     */
    public function resolve(mixed $value): mixed
    {
        for ($depth = 0; $value instanceof Reference && $depth < 32; ++$depth) {
            $value = $this->object($value->number);
        }

        return $value;
    }

    /**
     * The pages, in order.
     *
     * @throws PdfException The document has no page tree.
     *
     * @return list<Page>
     */
    public function pages(): array
    {
        if (null !== $this->pages) {
            return $this->pages;
        }

        $catalog = $this->resolve($this->trailer->get('Root'));

        if (! $catalog instanceof Dictionary) {
            throw new PdfException('The PDF has no document catalog.');
        }

        $this->pages = [];
        $visited = [];
        $this->collectPages($catalog->get('Pages'), [], $visited);

        return $this->pages;
    }

    /**
     * Adds the pages under a page tree node, applying the attributes pages inherit.
     *
     * @param mixed               $node      The node, usually a reference.
     * @param array<string, mixed> $inherited Resources, MediaBox, CropBox and Rotate set by its ancestors.
     * @param array<int, true>    $visited   Nodes already walked, so a loop in the tree cannot recurse forever.
     */
    private function collectPages(mixed $node, array $inherited, array &$visited): void
    {
        $reference = $node instanceof Reference ? $node : null;

        if (null !== $reference) {
            if (isset($visited[$reference->number])) {
                return;
            }
            $visited[$reference->number] = true;
        }

        $dictionary = $this->resolve($node);

        if (! $dictionary instanceof Dictionary) {
            return;
        }

        foreach (['Resources', 'MediaBox', 'CropBox', 'Rotate'] as $key) {
            if ($dictionary->has($key)) {
                $inherited[$key] = $dictionary->get($key);
            }
        }

        $kids = $this->resolve($dictionary->get('Kids'));

        if (! $dictionary->isName('Type', 'Page') && is_array($kids)) {
            foreach ($kids as $kid) {
                $this->collectPages($kid, $inherited, $visited);
            }

            return;
        }

        $mediaBox = $this->box($inherited['MediaBox'] ?? null) ?? [0.0, 0.0, 612.0, 792.0];
        $rotation = $this->resolve($inherited['Rotate'] ?? 0);
        $rotation = is_int($rotation) && 0 === $rotation % 90 ? (($rotation % 360) + 360) % 360 : 0;

        $this->pages[] = new Page($reference, $dictionary, $inherited['Resources'] ?? null, $mediaBox, $this->box($inherited['CropBox'] ?? null), $rotation);
    }

    /**
     * A rectangle, normalised to lower-left and upper-right, or null when it is not one.
     *
     * @param mixed $value The rectangle as stored.
     *
     * @return ?array{float, float, float, float}
     */
    private function box(mixed $value): ?array
    {
        $value = $this->resolve($value);

        if (! is_array($value) || 4 !== count($value)) {
            return null;
        }

        $numbers = array_map(fn ($n) => $this->resolve($n), array_values($value));

        foreach ($numbers as $n) {
            if (! is_int($n) && ! is_float($n)) {
                return null;
            }
        }

        [$x0, $y0, $x1, $y1] = array_map('floatval', $numbers);

        return [min($x0, $x1), min($y0, $y1), max($x0, $x1), max($y0, $y1)];
    }

    /**
     * Follows the cross-reference sections from the last `startxref` back through `/Prev`.
     */
    private function readCrossReferences(): void
    {
        $at = strrpos($this->bytes, 'startxref');

        if (false === $at || ! preg_match('/\Gstartxref\s+(\d+)/', $this->bytes, $match, 0, $at)) {
            $this->rebuildFromScan();

            return;
        }

        $this->startxref = (int) $match[1];
        $trailers = [];
        $visited = [];
        $offset = $this->startxref;

        try {
            while (null !== $offset && ! isset($visited[$offset])) {
                $visited[$offset] = true;
                [$trailer, $isStream] = $this->readSection($offset);

                if ([] === $trailers) {
                    $this->xrefIsStream = $isStream;
                }

                $trailers[] = $trailer;

                // A hybrid file's table points to a stream holding the objects in object streams.
                $hybrid = $trailer->get('XRefStm');
                if (is_int($hybrid) && ! isset($visited[$hybrid])) {
                    $visited[$hybrid] = true;
                    $this->readSection($hybrid);
                }

                $previous = $trailer->get('Prev');
                $offset = is_int($previous) ? $previous : null;
            }
        } catch (PdfException) {
            if ([] === $trailers) {
                $this->rebuildFromScan();

                return;
            }
        }

        foreach ($trailers as $trailer) {
            foreach ($trailer->all() as $key => $value) {
                if (! $this->trailer->has($key) && ! in_array($key, ['Prev', 'XRefStm', 'Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms'], true)) {
                    $this->trailer->set($key, $value);
                }
            }
        }

        if (null === $this->trailer->get('Root')) {
            $this->rebuildFromScan();
        }
    }

    /**
     * Reads one cross-reference section, table or stream.
     *
     * @param int $offset Where it starts.
     *
     * @return array{0: Dictionary, 1: bool} Its trailer dictionary, and whether it was a stream.
     */
    private function readSection(int $offset): array
    {
        $parser = new Parser($this->bytes, $offset);

        if ($parser->startsWith('xref')) {
            return [$this->readTable($parser->position() + 4), false];
        }

        [, , $stream] = $this->parser()->indirectObject($offset);

        if (! $stream instanceof Stream || ! $stream->dictionary->isName('Type', 'XRef')) {
            throw new PdfException("There is no cross-reference section at offset {$offset}.");
        }

        $this->readStreamEntries($stream);

        return [$stream->dictionary, true];
    }

    /**
     * Reads a cross-reference table's entries, and the trailer after them.
     *
     * @param int $offset Just after the `xref` keyword.
     */
    private function readTable(int $offset): Dictionary
    {
        $parser = new Parser($this->bytes, $offset);

        while (! $parser->startsWith('trailer')) {
            if (! preg_match('/\G\s*(\d+)\s+(\d+)/', $this->bytes, $subsection, 0, $parser->position())) {
                throw new PdfException('A cross-reference table is damaged.');
            }

            $at = $parser->position() + strlen($subsection[0]);
            $first = (int) $subsection[1];

            for ($i = 0, $count = (int) $subsection[2]; $i < $count; ++$i) {
                if (! preg_match('/\G\s*(\d{1,10})\s+(\d{1,5})\s+([nf])/', $this->bytes, $entry, 0, $at)) {
                    throw new PdfException('A cross-reference table entry is damaged.');
                }

                $at += strlen($entry[0]);
                $this->xref[$first + $i] ??= 'n' === $entry[3] ? [1, (int) $entry[1], (int) $entry[2]] : [0, 0, 0];
            }

            $parser->seek($at);
        }

        $parser->seek($parser->position() + 7);
        $trailer = $parser->value();

        if (! $trailer instanceof Dictionary) {
            throw new PdfException('A trailer is damaged.');
        }

        return $trailer;
    }

    /**
     * Reads a cross-reference stream's entries.
     *
     * @param Stream $stream The stream, whose dictionary is also a trailer.
     */
    private function readStreamEntries(Stream $stream): void
    {
        $data = Filters::decode($stream, $this->resolve(...));
        $widths = array_map('intval', (array) $this->resolve($stream->dictionary->get('W')));
        $index = $this->resolve($stream->dictionary->get('Index')) ?? [0, (int) $this->resolve($stream->dictionary->get('Size'))];
        $entryLength = array_sum($widths);

        if (3 !== count($widths) || $entryLength < 1) {
            throw new PdfException('A cross-reference stream is damaged.');
        }

        $at = 0;

        for ($i = 0; $i + 1 < count($index); $i += 2) {
            for ($n = 0, $first = (int) $index[$i]; $n < (int) $index[$i + 1] && $at + $entryLength <= strlen($data); ++$n) {
                $fields = [];
                foreach ($widths as $width) {
                    $fields[] = $width ? (int) hexdec(bin2hex(substr($data, $at, $width))) : null;
                    $at += $width;
                }

                // A missing type field means type 1.
                $this->xref[$first + $n] ??= match ($fields[0] ?? 1) {
                    1 => [1, (int) $fields[1], (int) ($fields[2] ?? 0)],
                    2 => [2, (int) $fields[1], (int) $fields[2]],
                    default => [0, 0, 0],
                };
            }
        }
    }

    /**
     * Reads the object at an offset, falling back to scanning when it is not the object expected there.
     *
     * @param int $offset Where the cross-reference section says it is.
     * @param int $number The object number expected.
     */
    private function readAt(int $offset, int $number): mixed
    {
        try {
            [$found, , $value] = $this->parser()->indirectObject($offset);

            if ($found === $number) {
                return $value;
            }
        } catch (PdfException) {
        }

        return $this->readScanned($number);
    }

    /**
     * Reads an object packed into an object stream.
     *
     * @param int $streamNumber The object stream.
     * @param int $index        The object's position in it.
     * @param int $number       The object number.
     */
    private function readCompressed(int $streamNumber, int $index, int $number): mixed
    {
        if (! isset($this->objectStreams[$streamNumber])) {
            $stream = $this->object($streamNumber);

            if (! $stream instanceof Stream) {
                return null;
            }

            $data = Filters::decode($stream, $this->resolve(...));
            $first = (int) $this->resolve($stream->dictionary->get('First'));
            $count = (int) $this->resolve($stream->dictionary->get('N'));
            $header = new Parser($data);
            $offsets = [];

            for ($i = 0; $i < $count; ++$i) {
                $objectNumber = (int) $header->token();
                $offsets[$objectNumber] = $first + (int) $header->token();
            }

            $this->objectStreams[$streamNumber] = [$data, $offsets];
        }

        [$data, $offsets] = $this->objectStreams[$streamNumber];

        if (! isset($offsets[$number])) {
            return null;
        }

        return (new Parser($data, $offsets[$number], $this->resolveLength(...)))->value();
    }

    /**
     * Reads an object from where scanning the file found it, or null when it is nowhere.
     *
     * @param int $number The object number.
     */
    private function readScanned(int $number): mixed
    {
        $this->scan();

        if (! isset($this->scanned[$number])) {
            return null;
        }

        try {
            return $this->parser()->indirectObject($this->scanned[$number])[2];
        } catch (PdfException) {
            return null;
        }
    }

    /**
     * Finds every `n g obj` in the file; the last one for a number wins, as in an update.
     */
    private function scan(): void
    {
        if (null !== $this->scanned) {
            return;
        }

        $this->scanned = [];
        preg_match_all('/(?<![0-9])(\d+)\s+\d+\s+obj\b/', $this->bytes, $matches, PREG_OFFSET_CAPTURE);

        foreach ($matches[1] as [$number, $offset]) {
            $this->scanned[(int) $number] = $offset;
        }
    }

    /**
     * Rebuilds the document's structure by scanning, for a file whose cross-references are missing or broken.
     *
     * @throws PdfException No document catalog could be found.
     */
    private function rebuildFromScan(): void
    {
        $this->scan();
        $this->xref = [];

        foreach ($this->scanned as $number => $offset) {
            $this->xref[$number] = [1, $offset, 0];
        }

        // Objects in object streams are only found by opening the streams.
        foreach (array_keys($this->scanned) as $number) {
            $stream = $this->object($number);

            if ($stream instanceof Stream && $stream->dictionary->isName('Type', 'ObjStm')) {
                $data = Filters::decode($stream, $this->resolve(...));
                $header = new Parser($data);

                for ($i = 0, $count = (int) $this->resolve($stream->dictionary->get('N')); $i < $count; ++$i) {
                    $objectNumber = (int) $header->token();
                    $header->token();
                    $this->xref[$objectNumber] ??= [2, $number, $i];
                }
            }

            if ($stream instanceof Stream && $stream->dictionary->isName('Type', 'XRef') && null !== $stream->dictionary->get('Root')) {
                $this->trailer = $stream->dictionary;
            }
        }

        $at = strrpos($this->bytes, 'trailer');
        if (false !== $at) {
            try {
                $trailer = (new Parser($this->bytes, $at + 7))->value();
                if ($trailer instanceof Dictionary && null !== $trailer->get('Root')) {
                    $this->trailer = $trailer;
                }
            } catch (PdfException) {
            }
        }

        if (null === $this->trailer->get('Root')) {
            throw new PdfException('The PDF is too damaged to read: it has no document catalog.');
        }

        $this->objects = [];
    }

    /**
     * A parser over the whole file that can resolve an indirect stream length.
     */
    private function parser(): Parser
    {
        return new Parser($this->bytes, 0, $this->resolveLength(...));
    }

    /**
     * Resolves a stream's indirect `/Length`.
     *
     * @param Reference $reference The length object.
     */
    private function resolveLength(Reference $reference): mixed
    {
        return $this->resolve($reference);
    }
}
