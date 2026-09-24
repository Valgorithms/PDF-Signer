<?php

declare(strict_types=1);

namespace PdfSigner\Tests\Fixtures;

/**
 * Writes small PDFs for tests, in both of the ways real PDFs store their cross-references: a classic table,
 * or a compressed cross-reference stream with the non-stream objects packed into an object stream.
 */
final class PdfBuilder
{
    /** @var array<int, string> Object number => the object's body, between `obj` and `endobj`. */
    private array $objects = [];

    /**
     * A two-page document. Page 1 inherits its media box and resources from the page tree; page 2 is rotated
     * 90°, has a crop box, and draws with a transform its content never restores.
     */
    public static function twoPages(): self
    {
        return (new self())
            ->add(1, '<< /Type /Catalog /Pages 2 0 R >>')
            ->add(2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] /Resources 5 0 R >>')
            ->add(3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>')
            ->add(4, '<< /Type /Page /Parent 2 0 R /Rotate 90 /CropBox [36 36 576 756] /Contents [7 0 R] /Resources << /XObject << /PdfSigner1 8 0 R >> >> >>')
            ->add(5, '<< /ProcSet [/PDF] >>')
            ->stream(6, '0 0 1 rg 72 72 144 144 re f')
            ->stream(7, '2 0 0 2 0 0 cm 1 0 0 rg 10 10 20 20 re f')
            ->add(8, '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length 0 >>'."\nstream\n\nendstream");
    }

    /**
     * Sets an object's body.
     *
     * @param int    $number The object number.
     * @param string $body   Its body in PDF syntax.
     */
    public function add(int $number, string $body): self
    {
        $this->objects[$number] = $body;

        return $this;
    }

    /**
     * Sets an object to an unfiltered stream.
     *
     * @param int    $number The object number.
     * @param string $data   The stream's data.
     */
    public function stream(int $number, string $data): self
    {
        return $this->add($number, '<< /Length '.strlen($data)." >>\nstream\n{$data}\nendstream");
    }

    /**
     * The document with a classic cross-reference table.
     */
    public function classic(): string
    {
        ksort($this->objects);
        $pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
        $offsets = [];

        foreach ($this->objects as $number => $body) {
            $offsets[$number] = strlen($pdf);
            $pdf .= "{$number} 0 obj\n{$body}\nendobj\n";
        }

        $size = max(array_keys($this->objects)) + 1;
        $xref = strlen($pdf);
        $pdf .= "xref\n0 {$size}\n0000000000 65535 f\r\n";

        for ($number = 1; $number < $size; ++$number) {
            $pdf .= isset($offsets[$number]) ? sprintf("%010d 00000 n\r\n", $offsets[$number]) : "0000000000 00000 f\r\n";
        }

        return $pdf."trailer\n<< /Size {$size} /Root 1 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
    }

    /**
     * The document with a compressed cross-reference stream, using the PNG Up predictor as most writers do,
     * and every object that is not a stream packed into one object stream.
     */
    public function compressed(): string
    {
        ksort($this->objects);
        $packed = array_filter($this->objects, static fn (string $body) => ! str_contains($body, 'stream'));
        $direct = array_diff_key($this->objects, $packed);
        $objectStream = max(array_keys($this->objects)) + 1;
        $xrefNumber = $objectStream + 1;

        $header = [];
        $bodies = '';
        foreach ($packed as $number => $body) {
            $header[] = $number.' '.strlen($bodies);
            $bodies .= $body."\n";
        }
        $header = implode(' ', $header)."\n";
        $data = gzcompress($header.$bodies);
        $direct[$objectStream] = sprintf('<< /Type /ObjStm /N %d /First %d /Filter /FlateDecode /Length %d >>', count($packed), strlen($header), strlen($data))
            ."\nstream\n{$data}\nendstream";
        ksort($direct);

        $pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
        $entries = [];

        foreach ($direct as $number => $body) {
            $entries[$number] = [1, strlen($pdf), 0];
            $pdf .= "{$number} 0 obj\n{$body}\nendobj\n";
        }

        foreach (array_keys($packed) as $index => $number) {
            $entries[$number] = [2, $objectStream, $index];
        }

        $xref = strlen($pdf);
        $entries[$xrefNumber] = [1, $xref, 0];
        $entries[0] = [0, 0, 65535];
        ksort($entries);

        // Each row is 1 + 4 + 2 bytes, filtered with PNG Up: every byte minus the one above it.
        $raw = '';
        $previous = str_repeat("\0", 7);
        for ($number = 0; $number <= $xrefNumber; ++$number) {
            [$type, $field, $generation] = $entries[$number] ?? [0, 0, 0];
            $row = chr($type).pack('N', $field).pack('n', $generation);
            $filtered = '';
            for ($i = 0; $i < 7; ++$i) {
                $filtered .= chr((ord($row[$i]) - ord($previous[$i])) & 0xFF);
            }
            $raw .= "\x02".$filtered;
            $previous = $row;
        }

        $stream = gzcompress($raw);
        $size = $xrefNumber + 1;
        $pdf .= "{$xrefNumber} 0 obj\n<< /Type /XRef /Size {$size} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ".strlen($stream)
            ." >>\nstream\n{$stream}\nendstream\nendobj\n";

        return $pdf."startxref\n{$xref}\n%%EOF\n";
    }
}
