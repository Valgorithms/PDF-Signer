<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * Revises a document by appending new and changed objects to it, leaving its original bytes untouched.
 *
 * The appended section has its own cross-reference table, or stream when the document's newest section is
 * one, and a trailer whose `/Prev` points to the section before. Everything the document already held, from
 * forms to earlier digital signatures, survives as an older revision.
 *
 * @link https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf Section 7.5.6, Incremental Updates.
 */
final class IncrementalUpdate
{
    /** @var array<int, array{0: int, 1: mixed}> Object number => generation and value. */
    private array $objects = [];

    private int $next;

    /**
     * @param Document $document The document to revise.
     */
    public function __construct(private readonly Document $document)
    {
        $this->next = $document->size();
    }

    /**
     * Adds a new object.
     *
     * @param mixed $value The object's value.
     *
     * @return Reference A reference to it.
     */
    public function add(mixed $value): Reference
    {
        $reference = new Reference($this->next++);
        $this->objects[$reference->number] = [0, $value];

        return $reference;
    }

    /**
     * Replaces an existing object with a new revision of it.
     *
     * @param Reference $reference The object.
     * @param mixed     $value     Its new value.
     */
    public function replace(Reference $reference, mixed $value): void
    {
        $this->objects[$reference->number] = [$reference->generation, $value];
    }

    /**
     * The document with the update appended.
     */
    public function toString(): string
    {
        $out = $this->document->bytes();

        if ('' === $out || ! in_array($out[-1], ["\n", "\r"], true)) {
            $out .= "\n";
        }

        ksort($this->objects);
        $offsets = [];

        foreach ($this->objects as $number => [$generation, $value]) {
            $offsets[$number] = [strlen($out), $generation];
            $out .= "{$number} {$generation} obj\n".Serializer::value($value)."\nendobj\n";
        }

        $trailer = new Dictionary();

        foreach (['Root', 'Info', 'ID'] as $key) {
            if (null !== $this->document->trailer()->get($key)) {
                $trailer->set($key, $this->document->trailer()->get($key));
            }
        }

        $trailer->set('Prev', $this->document->startxref());

        return $this->document->xrefIsStream()
            ? $this->withStream($out, $offsets, $trailer)
            : $this->withTable($out, $offsets, $trailer);
    }

    /**
     * Appends a cross-reference table and trailer.
     *
     * @param string                                   $out     The document so far.
     * @param array<int, array{0: int, 1: int}> $offsets Object number => offset and generation.
     * @param Dictionary                               $trailer The trailer, without `/Size`.
     */
    private function withTable(string $out, array $offsets, Dictionary $trailer): string
    {
        $xref = strlen($out);
        $out .= "xref\n";

        foreach (self::runs(array_keys($offsets)) as [$first, $count]) {
            $out .= "{$first} {$count}\n";

            for ($number = $first; $number < $first + $count; ++$number) {
                $out .= sprintf("%010d %05d n\r\n", ...$offsets[$number]);
            }
        }

        $trailer = new Dictionary(['Size' => $this->next] + $trailer->all());

        return $out.'trailer'."\n".Serializer::value($trailer)."\nstartxref\n{$xref}\n%%EOF\n";
    }

    /**
     * Appends a cross-reference stream, which lists itself among the objects.
     *
     * @param string                                   $out     The document so far.
     * @param array<int, array{0: int, 1: int}> $offsets Object number => offset and generation.
     * @param Dictionary                               $trailer The trailer, without `/Size`.
     */
    private function withStream(string $out, array $offsets, Dictionary $trailer): string
    {
        $self = $this->next++;
        $xref = strlen($out);
        $offsets[$self] = [$xref, 0];
        ksort($offsets);

        $offsetWidth = max(1, (int) ceil(strlen(dechex($xref)) / 2));
        $data = '';
        $index = [];

        foreach (self::runs(array_keys($offsets)) as [$first, $count]) {
            array_push($index, $first, $count);

            for ($number = $first; $number < $first + $count; ++$number) {
                [$offset, $generation] = $offsets[$number];
                $data .= "\x01";

                for ($byte = $offsetWidth - 1; $byte >= 0; --$byte) {
                    $data .= chr(($offset >> (8 * $byte)) & 0xFF);
                }

                $data .= pack('n', $generation);
            }
        }

        $dictionary = new Dictionary([
            'Type' => new Name('XRef'),
            'Size' => $this->next,
            'W' => [1, $offsetWidth, 2],
            'Index' => $index,
        ] + $trailer->all());

        return $out."{$self} 0 obj\n".Serializer::value(new Stream($dictionary, $data))."\nendobj\nstartxref\n{$xref}\n%%EOF\n";
    }

    /**
     * Groups sorted object numbers into runs of consecutive numbers.
     *
     * @param list<int> $numbers Sorted object numbers.
     *
     * @return list<array{0: int, 1: int}> Each run's first number and length.
     */
    private static function runs(array $numbers): array
    {
        $runs = [];

        foreach ($numbers as $number) {
            $last = count($runs) - 1;

            if ($last >= 0 && $runs[$last][0] + $runs[$last][1] === $number) {
                ++$runs[$last][1];
            } else {
                $runs[] = [$number, 1];
            }
        }

        return $runs;
    }
}
