<?php

declare(strict_types=1);

namespace PdfSigner;

use PdfSigner\Pdf\Serializer;

/**
 * A mark drawn on a page as a vector path: a tick, a cross, a dot, a line, a rectangle or an ellipse. For
 * ticking a box, striking something out or drawing a box around it on a form.
 *
 * ```php
 * $signer->mark(new Mark(Mark::TICK), page: 1, x: 72, y: 300, width: 14, height: 14);
 * ```
 *
 * It fills a rectangle on the page the way a signature does; a line runs corner to corner, so a flat
 * rectangle makes a straight line.
 */
final class Mark
{
    public const TICK = 'tick';
    public const CROSS = 'cross';
    public const DOT = 'dot';
    /** A line from the bottom-left corner to the top-right. */
    public const LINE_UP = 'line-up';
    /** A line from the top-left corner to the bottom-right. */
    public const LINE_DOWN = 'line-down';
    public const RECTANGLE = 'rectangle';
    public const ELLIPSE = 'ellipse';

    /** How far a Bézier handle reaches for a quarter of a circle of radius 1. */
    private const KAPPA = 0.5522847498307936;

    /**
     * @param string                    $shape One of the shape constants.
     * @param array{float, float, float} $color Red, green and blue, each from 0 to 1.
     *
     * @throws \InvalidArgumentException There is no such shape.
     */
    public function __construct(public readonly string $shape, public readonly array $color = [0, 0, 0])
    {
        if (null === self::shape($shape)) {
            throw new \InvalidArgumentException("There is no {$shape} mark.");
        }
    }

    /**
     * A colour written as six hexadecimal digits, like `b3141c` or `#b3141c`, as red, green and blue from 0 to 1.
     *
     * @param string $hex The colour.
     *
     * @throws \InvalidArgumentException It is not six hexadecimal digits.
     *
     * @return array{float, float, float}
     */
    public static function rgb(string $hex): array
    {
        if (1 !== preg_match('/^#?([0-9a-f]{6})$/i', $hex, $match)) {
            throw new \InvalidArgumentException("{$hex} is not a colour written as six hexadecimal digits.");
        }

        $value = (int) hexdec($match[1]);

        return [(($value >> 16) & 255) / 255, (($value >> 8) & 255) / 255, ($value & 255) / 255];
    }

    /**
     * How thick a mark's lines are, in points: 1.5, except that a tick or cross grows bolder with its size, at
     * an eighth of its smaller side.
     *
     * @param string $shape  One of the shape constants.
     * @param float  $width  The mark's width, in points.
     * @param float  $height Its height.
     */
    public static function strokeWidth(string $shape, float $width, float $height): float
    {
        return self::TICK === $shape || self::CROSS === $shape ? max(1.5, min($width, $height) / 8) : 1.5;
    }

    /**
     * The content-stream operators that draw the mark where a `cm` matrix would draw an image.
     *
     * The path is worked out in the page's own space rather than drawn under the matrix, so a line keeps its
     * thickness however the mark is stretched, even flat.
     *
     * @param array{float, float, float, float, float, float} $matrix The `cm` operator's a b c d e f.
     */
    public function operators(array $matrix): string
    {
        [$a, $b, $c, $d, $e, $f] = array_values($matrix);
        ['paint' => $paint, 'join' => $join, 'path' => $path] = self::shape($this->shape);
        $color = implode(' ', array_map(Serializer::number(...), $this->color));
        $parts = ['q'];

        if ('f' === $paint) {
            $parts[] = "{$color} rg";
        } else {
            $width = self::strokeWidth($this->shape, sqrt($a * $a + $b * $b), sqrt($c * $c + $d * $d));
            array_push($parts, "{$color} RG", Serializer::number($width).' w', '1 J', "{$join} j");
        }

        foreach ($path as [$operator, $coordinates]) {
            $points = [];

            foreach (array_chunk($coordinates, 2) as [$u, $v]) {
                $points[] = Serializer::number($a * $u + $c * $v + $e);
                $points[] = Serializer::number($b * $u + $d * $v + $f);
            }

            $parts[] = implode(' ', [...$points, $operator]);
        }

        array_push($parts, $paint, 'Q');

        return implode(' ', $parts);
    }

    /**
     * A shape as a path in the unit square, y upward from its bottom-left corner, which is how a placement
     * matrix maps an image; `paint` is S to stroke it or f to fill it, and `join` the line join, round unless
     * the corners should be sharp.
     *
     * @return ?array{paint: string, join: int, path: list<array{0: string, 1: list<float|int>}>}
     */
    private static function shape(string $shape): ?array
    {
        $k = 0.5 * self::KAPPA;
        $oval = [
            ['m', [1, 0.5]],
            ['c', [1, 0.5 + $k, 0.5 + $k, 1, 0.5, 1]],
            ['c', [0.5 - $k, 1, 0, 0.5 + $k, 0, 0.5]],
            ['c', [0, 0.5 - $k, 0.5 - $k, 0, 0.5, 0]],
            ['c', [0.5 + $k, 0, 1, 0.5 - $k, 1, 0.5]],
            ['h', []],
        ];

        return match ($shape) {
            self::TICK => ['paint' => 'S', 'join' => 1, 'path' => [['m', [0.08, 0.52]], ['l', [0.38, 0.2]], ['l', [0.92, 0.86]]]],
            self::CROSS => ['paint' => 'S', 'join' => 1, 'path' => [['m', [0.15, 0.15]], ['l', [0.85, 0.85]], ['m', [0.15, 0.85]], ['l', [0.85, 0.15]]]],
            self::DOT => ['paint' => 'f', 'join' => 1, 'path' => $oval],
            self::LINE_UP => ['paint' => 'S', 'join' => 1, 'path' => [['m', [0, 0]], ['l', [1, 1]]]],
            self::LINE_DOWN => ['paint' => 'S', 'join' => 1, 'path' => [['m', [0, 1]], ['l', [1, 0]]]],
            self::RECTANGLE => ['paint' => 'S', 'join' => 0, 'path' => [['m', [0, 0]], ['l', [1, 0]], ['l', [1, 1]], ['l', [0, 1]], ['h', []]]],
            self::ELLIPSE => ['paint' => 'S', 'join' => 1, 'path' => $oval],
            default => null,
        };
    }
}
