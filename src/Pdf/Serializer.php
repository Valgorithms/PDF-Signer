<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * Writes PDF values in PDF syntax.
 */
final class Serializer
{
    /**
     * A value in PDF syntax.
     *
     * @param mixed $value A {@see Name}, {@see PdfString}, {@see Dictionary}, {@see Stream}, {@see Reference}, list, int, float, bool or null.
     *
     * @throws \InvalidArgumentException The value has no PDF form.
     */
    public static function value(mixed $value): string
    {
        return match (true) {
            null === $value => 'null',
            true === $value => 'true',
            false === $value => 'false',
            is_int($value), is_float($value) => self::number($value),
            $value instanceof Name => self::name($value->value),
            $value instanceof Reference => "{$value->number} {$value->generation} R",
            $value instanceof PdfString => $value->hex ? '<'.bin2hex($value->bytes).'>' : self::literal($value->bytes),
            $value instanceof Dictionary => self::dictionary($value),
            $value instanceof Stream => self::stream($value),
            is_array($value) => '['.implode(' ', array_map(self::value(...), $value)).']',
            default => throw new \InvalidArgumentException('A '.get_debug_type($value).' cannot be written to a PDF.'),
        };
    }

    /**
     * A number, written without an exponent, since PDF has none, and without trailing zeros.
     *
     * @param int|float $number The number.
     *
     * @throws \InvalidArgumentException The number is infinite or not a number.
     */
    public static function number(int|float $number): string
    {
        if (is_int($number)) {
            return (string) $number;
        }

        if (! is_finite($number)) {
            throw new \InvalidArgumentException('PDF numbers must be finite.');
        }

        $text = rtrim(rtrim(sprintf('%.6F', $number), '0'), '.');

        return '-0' === $text || '' === $text ? '0' : $text;
    }

    /**
     * A name, escaping with `#xx` any byte that is not a regular printable character.
     *
     * @param string $value The name, without its slash.
     */
    private static function name(string $value): string
    {
        return '/'.preg_replace_callback(
            '/[^\x21-\x7E]|[()<>\[\]{}\/%#]/',
            static fn (array $m) => sprintf('#%02X', ord($m[0])),
            $value,
        );
    }

    /**
     * A `(…)` string, escaping the bytes that would end or alter it.
     *
     * @param string $bytes The string.
     */
    private static function literal(string $bytes): string
    {
        return '('.strtr($bytes, ['\\' => '\\\\', '(' => '\\(', ')' => '\\)', "\r" => '\\r']).')';
    }

    /**
     * A `<<…>>` dictionary.
     *
     * @param Dictionary $dictionary The dictionary.
     */
    private static function dictionary(Dictionary $dictionary): string
    {
        $out = '<<';

        foreach ($dictionary as $key => $value) {
            $out .= ' '.self::name($key).' '.self::value($value);
        }

        return $out.' >>';
    }

    /**
     * A stream: its dictionary with `/Length` set to the data's, then the data.
     *
     * @param Stream $stream The stream.
     */
    private static function stream(Stream $stream): string
    {
        $dictionary = new Dictionary($stream->dictionary->all());
        $dictionary->set('Length', strlen($stream->data));

        return self::dictionary($dictionary)."\nstream\n".$stream->data."\nendstream";
    }
}
