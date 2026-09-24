<?php

declare(strict_types=1);

namespace PdfSigner;

/**
 * Converts between a page as it is displayed and the PDF user space its content is drawn in.
 *
 * Positions are given on the page as a viewer shows it: in points, from its top-left corner, after the
 * crop box and `/Rotate` are applied. The transform is the one pdf.js uses at scale 1, so a position picked
 * on a page rendered by pdf.js lands in the same place here.
 */
final class Geometry
{
    /**
     * The transform from user space to the displayed page, y downward: a b c d e f.
     *
     * @param array{float, float, float, float} $viewBox  The displayed box: lower-left x and y, upper-right x and y.
     * @param int                               $rotation 0, 90, 180 or 270.
     *
     * @return array{float, float, float, float, float, float}
     */
    public static function displayTransform(array $viewBox, int $rotation): array
    {
        [$x0, $y0, $x1, $y1] = $viewBox;
        $centerX = ($x0 + $x1) / 2;
        $centerY = ($y0 + $y1) / 2;

        [$a, $b, $c, $d] = match ($rotation) {
            90 => [0, 1, 1, 0],
            180 => [-1, 0, 0, 1],
            270 => [0, -1, -1, 0],
            default => [1, 0, 0, -1],
        };

        [$offsetX, $offsetY] = 0 === $a
            ? [abs($centerY - $y0), abs($centerX - $x0)]
            : [abs($centerX - $x0), abs($centerY - $y0)];

        return [
            (float) $a,
            (float) $b,
            (float) $c,
            (float) $d,
            $offsetX - $a * $centerX - $c * $centerY,
            $offsetY - $b * $centerX - $d * $centerY,
        ];
    }

    /**
     * The width and height of the displayed page.
     *
     * @param array{float, float, float, float} $viewBox  The displayed box.
     * @param int                               $rotation 0, 90, 180 or 270.
     *
     * @return array{float, float}
     */
    public static function displaySize(array $viewBox, int $rotation): array
    {
        $width = $viewBox[2] - $viewBox[0];
        $height = $viewBox[3] - $viewBox[1];

        return 90 === $rotation || 270 === $rotation ? [$height, $width] : [$width, $height];
    }

    /**
     * Converts a point on the displayed page to user space.
     *
     * @param array{float, float, float, float, float, float} $transform From {@see Geometry::displayTransform()}.
     * @param float                                           $x         From the displayed page's left edge.
     * @param float                                           $y         From its top edge, downward.
     *
     * @return array{float, float}
     */
    public static function toUser(array $transform, float $x, float $y): array
    {
        [$a, $b, $c, $d, $e, $f] = $transform;
        $determinant = $a * $d - $b * $c;
        $dx = $x - $e;
        $dy = $y - $f;

        return [($d * $dx - $c * $dy) / $determinant, ($a * $dy - $b * $dx) / $determinant];
    }

    /**
     * The `cm` matrix that draws an image into a rectangle on the displayed page.
     *
     * An image is drawn into the unit square, so the matrix maps its bottom-left, bottom-right and top-left
     * corners onto the rectangle's. Converting the corners one by one accounts for rotation and a crop box
     * away from the origin, and keeps the image upright on screen.
     *
     * @param \Closure(float, float): array{float, float} $toUser Converts a displayed point to user space.
     * @param float                                        $x      The rectangle's left edge on the displayed page.
     * @param float                                        $y      Its top edge.
     * @param float                                        $width  Its width.
     * @param float                                        $height Its height.
     *
     * @return array{float, float, float, float, float, float}
     */
    public static function placementMatrix(\Closure $toUser, float $x, float $y, float $width, float $height): array
    {
        [$x0, $y0] = $toUser($x, $y + $height);
        [$x1, $y1] = $toUser($x + $width, $y + $height);
        [$x2, $y2] = $toUser($x, $y);

        return [$x1 - $x0, $y1 - $y0, $x2 - $x0, $y2 - $y0, $x0, $y0];
    }
}
