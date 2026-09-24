<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * Decodes stream data through the filters its dictionary names.
 *
 * Only what reading a document's structure needs is supported: Flate, with the PNG and TIFF predictors that
 * cross-reference and object streams use, and the two ASCII encodings. Page content is never decoded.
 */
final class Filters
{
    /**
     * Decodes a stream's data.
     *
     * @param Stream                     $stream  The stream.
     * @param ?\Closure(mixed): mixed $resolve Resolves indirect values in the dictionary.
     *
     * @throws PdfException A filter is not supported, or the data is damaged.
     */
    public static function decode(Stream $stream, ?\Closure $resolve = null): string
    {
        $resolve ??= static fn (mixed $value): mixed => $value;
        $filters = $resolve($stream->dictionary->get('Filter'));
        $parameters = $resolve($stream->dictionary->get('DecodeParms'));
        $filters = null === $filters ? [] : (is_array($filters) ? $filters : [$filters]);
        $parameters = is_array($parameters) ? $parameters : [$parameters];
        $data = $stream->data;

        foreach ($filters as $index => $filter) {
            $filter = $resolve($filter);
            $options = $resolve($parameters[$index] ?? null);

            if (! $filter instanceof Name) {
                throw new PdfException('A stream names a filter that is not a name.');
            }

            $data = match ($filter->value) {
                'FlateDecode', 'Fl' => self::predict(self::inflate($data), $options instanceof Dictionary ? $options : null),
                'ASCIIHexDecode', 'AHx' => self::asciiHex($data),
                'ASCII85Decode', 'A85' => self::ascii85($data),
                default => throw new PdfException("Streams encoded with /{$filter->value} are not supported."),
            };
        }

        return $data;
    }

    /**
     * Inflates zlib data, falling back to a raw deflate stream as some writers produce.
     *
     * @param string $data The compressed bytes.
     */
    private static function inflate(string $data): string
    {
        $out = @gzuncompress($data);

        if (false === $out) {
            $out = @gzinflate($data);
        }

        if (false === $out) {
            throw new PdfException('A compressed stream is damaged.');
        }

        return $out;
    }

    /**
     * Undoes a PNG (10–15) or TIFF (2) predictor.
     *
     * @param string      $data    The inflated bytes.
     * @param ?Dictionary $options The filter's `/DecodeParms`.
     */
    private static function predict(string $data, ?Dictionary $options): string
    {
        $predictor = (int) ($options?->get('Predictor') ?? 1);

        if ($predictor < 2) {
            return $data;
        }

        $colors = (int) ($options->get('Colors') ?? 1);
        $bits = (int) ($options->get('BitsPerComponent') ?? 8);
        $columns = (int) ($options->get('Columns') ?? 1);
        $bytesPerPixel = max(1, intdiv($colors * $bits, 8));
        $rowLength = intdiv($columns * $colors * $bits + 7, 8);

        if (2 === $predictor) {
            if (8 !== $bits) {
                throw new PdfException('The TIFF predictor is only supported for 8-bit components.');
            }

            $out = '';
            foreach ('' === $data ? [] : str_split($data, $rowLength) as $row) {
                for ($i = $bytesPerPixel, $n = strlen($row); $i < $n; ++$i) {
                    $row[$i] = chr((ord($row[$i]) + ord($row[$i - $bytesPerPixel])) & 0xFF);
                }
                $out .= $row;
            }

            return $out;
        }

        $out = '';
        $previous = str_repeat("\0", $rowLength);

        for ($at = 0, $length = strlen($data); $at + 1 + $rowLength <= $length; $at += 1 + $rowLength) {
            $type = ord($data[$at]);
            $row = substr($data, $at + 1, $rowLength);

            for ($i = 0; $i < $rowLength; ++$i) {
                $left = $i >= $bytesPerPixel ? ord($row[$i - $bytesPerPixel]) : 0;
                $up = ord($previous[$i]);
                $upLeft = $i >= $bytesPerPixel ? ord($previous[$i - $bytesPerPixel]) : 0;

                $add = match ($type) {
                    0 => 0,
                    1 => $left,
                    2 => $up,
                    3 => intdiv($left + $up, 2),
                    4 => self::paeth($left, $up, $upLeft),
                    default => throw new PdfException("A stream uses unknown PNG filter {$type}."),
                };

                $row[$i] = chr((ord($row[$i]) + $add) & 0xFF);
            }

            $out .= $row;
            $previous = $row;
        }

        return $out;
    }

    /**
     * The PNG Paeth predictor: whichever neighbour is closest to left + up − up-left.
     */
    private static function paeth(int $left, int $up, int $upLeft): int
    {
        $estimate = $left + $up - $upLeft;
        $toLeft = abs($estimate - $left);
        $toUp = abs($estimate - $up);
        $toUpLeft = abs($estimate - $upLeft);

        if ($toLeft <= $toUp && $toLeft <= $toUpLeft) {
            return $left;
        }

        return $toUp <= $toUpLeft ? $up : $upLeft;
    }

    /**
     * Decodes hex digits up to `>`; an odd final digit is followed by an implied 0.
     *
     * @param string $data The encoded bytes.
     */
    private static function asciiHex(string $data): string
    {
        $end = strpos($data, '>');
        $hex = preg_replace('/[^0-9A-Fa-f]/', '', false === $end ? $data : substr($data, 0, $end));

        return (string) hex2bin(strlen($hex) % 2 ? $hex.'0' : $hex);
    }

    /**
     * Decodes base-85 groups up to `~>`, with `z` standing for four zero bytes.
     *
     * @param string $data The encoded bytes.
     */
    private static function ascii85(string $data): string
    {
        $end = strpos($data, '~>');
        $data = preg_replace('/\s+/', '', false === $end ? $data : substr($data, 0, $end));
        $out = '';
        $group = [];

        // PHP 8.1's str_split('') is [''], not [].
        foreach ('' === $data ? [] : str_split($data) as $c) {
            if ('z' === $c && [] === $group) {
                $out .= "\0\0\0\0";
                continue;
            }

            $group[] = ord($c) - 33;

            if (5 === count($group)) {
                $out .= self::base85Word($group, 4);
                $group = [];
            }
        }

        if ([] !== $group) {
            $count = count($group);
            $out .= self::base85Word(array_pad($group, 5, 84), $count - 1);
        }

        return $out;
    }

    /**
     * The first `$bytes` bytes of the 32-bit word five base-85 digits make.
     *
     * @param list<int> $digits Five digits, 0–84.
     */
    private static function base85Word(array $digits, int $bytes): string
    {
        $value = 0;
        foreach ($digits as $digit) {
            $value = $value * 85 + $digit;
        }

        return substr(pack('N', $value & 0xFFFFFFFF), 0, $bytes);
    }
}
