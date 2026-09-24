<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * Reads PDF objects from bytes, following the object syntax of ISO 32000-1, section 7.3.
 */
final class Parser
{
    private const WHITESPACE = "\0\t\n\f\r ";

    private const DELIMITERS = '()<>[]{}/%';

    private readonly int $length;

    /**
     * @param string                             $bytes    The bytes to read.
     * @param int                                $position Where to start reading.
     * @param ?\Closure(Reference): mixed $resolve  Resolves an indirect object, for a stream whose `/Length` is one.
     */
    public function __construct(
        private readonly string $bytes,
        private int $position = 0,
        private readonly ?\Closure $resolve = null,
    ) {
        $this->length = strlen($bytes);
    }

    /**
     * The offset the next read starts at.
     */
    public function position(): int
    {
        return $this->position;
    }

    /**
     * Moves to an offset.
     *
     * @param int $position The offset to read from next.
     */
    public function seek(int $position): void
    {
        $this->position = $position;
    }

    /**
     * Skips whitespace and comments.
     */
    public function skipWhitespace(): void
    {
        while ($this->position < $this->length) {
            $this->position += strspn($this->bytes, self::WHITESPACE, $this->position);

            if ('%' !== ($this->bytes[$this->position] ?? '')) {
                return;
            }

            $this->position += strcspn($this->bytes, "\r\n", $this->position);
        }
    }

    /**
     * Whether the next token, after any whitespace, starts with a keyword such as `xref` or `stream`.
     *
     * @param string $keyword The keyword.
     */
    public function startsWith(string $keyword): bool
    {
        $this->skipWhitespace();

        return 0 === substr_compare($this->bytes, $keyword, $this->position, strlen($keyword));
    }

    /**
     * Reads the next run of regular characters: a number, a keyword, or an operator.
     */
    public function token(): string
    {
        $this->skipWhitespace();
        $length = strcspn($this->bytes, self::WHITESPACE.self::DELIMITERS, $this->position);
        $token = substr($this->bytes, $this->position, $length);
        $this->position += $length;

        return $token;
    }

    /**
     * Reads the next value.
     *
     * @throws PdfException The bytes are not a PDF value.
     *
     * @return mixed A {@see Name}, {@see PdfString}, {@see Dictionary}, {@see Reference}, list, int, float, bool or null.
     */
    public function value(): mixed
    {
        $this->skipWhitespace();

        if ($this->position >= $this->length) {
            throw new PdfException('The PDF ends in the middle of an object.');
        }

        switch ($this->bytes[$this->position]) {
            case '/':
                return $this->name();
            case '(':
                return $this->literalString();
            case '[':
                return $this->array();
            case '<':
                return '<' === ($this->bytes[$this->position + 1] ?? '') ? $this->dictionary() : $this->hexString();
        }

        $start = $this->position;
        $token = $this->token();

        return match (true) {
            'true' === $token => true,
            'false' === $token => false,
            'null' === $token => null,
            1 === preg_match('/^[+-]?\d+$/', $token) => $this->integerOrReference((int) $token),
            1 === preg_match('/^[+-]?(\d+\.\d*|\.\d+)$/', $token) => (float) $token,
            default => throw new PdfException(sprintf("Unexpected '%s' at offset %d.", '' === $token ? $this->bytes[$start] : $token, $start)),
        };
    }

    /**
     * Reads an indirect object, `12 0 obj … endobj`, and the stream that follows its dictionary if it has one.
     *
     * @param int $offset Where the object starts.
     *
     * @throws PdfException There is no object at the offset.
     *
     * @return array{0: int, 1: int, 2: mixed} The object number, generation and value.
     */
    public function indirectObject(int $offset): array
    {
        $this->seek($offset);
        $number = $this->token();
        $generation = $this->token();

        if (! preg_match('/^\d+$/', $number) || ! preg_match('/^\d+$/', $generation) || 'obj' !== $this->token()) {
            throw new PdfException("There is no object at offset {$offset}.");
        }

        $value = $this->value();

        if ($value instanceof Dictionary && $this->startsWith('stream')) {
            $value = $this->stream($value);
        }

        return [(int) $number, (int) $generation, $value];
    }

    /**
     * Reads a name, decoding `#xx` escapes.
     */
    private function name(): Name
    {
        ++$this->position;
        $length = strcspn($this->bytes, self::WHITESPACE.self::DELIMITERS, $this->position);
        $raw = substr($this->bytes, $this->position, $length);
        $this->position += $length;

        return new Name(preg_replace_callback('/#([0-9A-Fa-f]{2})/', static fn (array $m) => chr((int) hexdec($m[1])), $raw));
    }

    /**
     * Reads a `(…)` string: balanced parentheses, backslash escapes, and line endings read as a line feed.
     */
    private function literalString(): PdfString
    {
        ++$this->position;
        $depth = 1;
        $out = '';

        while ($this->position < $this->length) {
            $c = $this->bytes[$this->position++];

            if ('\\' === $c) {
                $out .= $this->escape();
            } elseif ('(' === $c) {
                ++$depth;
                $out .= $c;
            } elseif (')' === $c) {
                if (0 === --$depth) {
                    return new PdfString($out);
                }
                $out .= $c;
            } elseif ("\r" === $c) {
                if ("\n" === ($this->bytes[$this->position] ?? '')) {
                    ++$this->position;
                }
                $out .= "\n";
            } else {
                $out .= $c;
            }
        }

        throw new PdfException('A string runs to the end of the PDF.');
    }

    /**
     * Reads what follows a backslash in a literal string.
     */
    private function escape(): string
    {
        $c = $this->bytes[$this->position++] ?? '';

        switch ($c) {
            case 'n': return "\n";
            case 'r': return "\r";
            case 't': return "\t";
            case 'b': return "\x08";
            case 'f': return "\f";
            case "\r":
                // A backslash at the end of a line continues the string on the next.
                if ("\n" === ($this->bytes[$this->position] ?? '')) {
                    ++$this->position;
                }

                return '';
            case "\n":
                return '';
        }

        if ($c >= '0' && $c <= '7') {
            $octal = $c;
            while (strlen($octal) < 3 && ($this->bytes[$this->position] ?? '') >= '0' && $this->bytes[$this->position] <= '7') {
                $octal .= $this->bytes[$this->position++];
            }

            return chr(octdec($octal) & 0xFF);
        }

        // Any other escaped character, including ( ) and \, stands for itself.
        return $c;
    }

    /**
     * Reads a `<…>` string of hex digits; an odd final digit is followed by an implied 0.
     */
    private function hexString(): PdfString
    {
        $end = strpos($this->bytes, '>', $this->position);

        if (false === $end) {
            throw new PdfException('A hex string runs to the end of the PDF.');
        }

        $hex = preg_replace('/[^0-9A-Fa-f]/', '', substr($this->bytes, $this->position + 1, $end - $this->position - 1));
        $this->position = $end + 1;

        return new PdfString((string) hex2bin(strlen($hex) % 2 ? $hex.'0' : $hex), true);
    }

    /**
     * Reads a `[…]` array.
     *
     * @return list<mixed>
     */
    private function array(): array
    {
        ++$this->position;
        $items = [];

        while (true) {
            $this->skipWhitespace();

            if (']' === ($this->bytes[$this->position] ?? '')) {
                ++$this->position;

                return $items;
            }

            $items[] = $this->value();
        }
    }

    /**
     * Reads a `<<…>>` dictionary.
     */
    private function dictionary(): Dictionary
    {
        $this->position += 2;
        $dictionary = new Dictionary();

        while (true) {
            $this->skipWhitespace();

            if ('>>' === substr($this->bytes, $this->position, 2)) {
                $this->position += 2;

                return $dictionary;
            }

            if ('/' !== ($this->bytes[$this->position] ?? '')) {
                throw new PdfException("A dictionary key at offset {$this->position} is not a name.");
            }

            $key = $this->name()->value;
            $dictionary->set($key, $this->value());
        }
    }

    /**
     * An integer, or the reference it starts: `12 0 R`.
     *
     * @param int $integer The integer just read.
     */
    private function integerOrReference(int $integer): int|Reference
    {
        $after = $this->position;

        if ($integer >= 0) {
            $generation = $this->token();
            $this->skipWhitespace();

            // R must end its token: `12 0 RG` is two numbers and an operator, not a reference.
            $afterR = $this->bytes[$this->position + 1] ?? ' ';

            if (preg_match('/^\d+$/', $generation) && 'R' === ($this->bytes[$this->position] ?? '')
                && str_contains(self::WHITESPACE.self::DELIMITERS, $afterR)) {
                ++$this->position;

                return new Reference($integer, (int) $generation);
            }
        }

        $this->position = $after;

        return $integer;
    }

    /**
     * Reads the data of a stream whose dictionary has just been read and whose `stream` keyword is next.
     *
     * @param Dictionary $dictionary The stream's dictionary.
     */
    private function stream(Dictionary $dictionary): Stream
    {
        $this->position += 6;

        // The keyword is followed by CRLF or LF; a lone CR is not allowed, but is tolerated.
        if ("\r\n" === substr($this->bytes, $this->position, 2)) {
            $this->position += 2;
        } elseif ("\n" === ($this->bytes[$this->position] ?? '') || "\r" === ($this->bytes[$this->position] ?? '')) {
            ++$this->position;
        }

        $start = $this->position;
        $length = $dictionary->get('Length');

        if ($length instanceof Reference && null !== $this->resolve) {
            $length = ($this->resolve)($length);
        }

        if (is_int($length) && $length >= 0 && $this->endstreamAt($start + $length)) {
            $this->position = $start + $length;
            $data = substr($this->bytes, $start, $length);
        } else {
            // A missing or wrong /Length: take everything up to the keyword, less the line ending before it.
            $end = strpos($this->bytes, 'endstream', $start);

            if (false === $end) {
                throw new PdfException("A stream at offset {$start} has no end.");
            }

            $this->position = $end;
            $data = preg_replace('/(\r\n|\n|\r)$/', '', substr($this->bytes, $start, $end - $start));
        }

        $this->position = strpos($this->bytes, 'endstream', $this->position) + 9;

        return new Stream($dictionary, $data);
    }

    /**
     * Whether `endstream` follows an offset, after at most a line ending and some spaces.
     *
     * @param int $offset Where the stream's data would end.
     */
    private function endstreamAt(int $offset): bool
    {
        if ($offset > $this->length) {
            return false;
        }

        $offset += strspn($this->bytes, "\r\n \t", $offset, 4);

        return 0 === substr_compare($this->bytes, 'endstream', $offset, 9);
    }
}
