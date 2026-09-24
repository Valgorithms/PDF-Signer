<?php

declare(strict_types=1);

namespace PdfSigner\Tests;

use PdfSigner\Geometry;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class GeometryTest extends TestCase
{
    public function testAnUnrotatedPageIsFlippedVertically(): void
    {
        $transform = Geometry::displayTransform([0.0, 0.0, 612.0, 792.0], 0);

        $this->assertSame([0.0, 792.0], Geometry::toUser($transform, 0, 0));
        $this->assertSame([612.0, 0.0], Geometry::toUser($transform, 612, 792));
    }

    public function testARotatedPageStartsAtItsCropBoxsLowerLeft(): void
    {
        // Turned 90° clockwise, the box's lower-left corner is shown at the top left.
        $box = [36.0, 36.0, 576.0, 756.0];
        $transform = Geometry::displayTransform($box, 90);

        $this->assertSame([720.0, 540.0], Geometry::displaySize($box, 90));
        $this->assertSame([36.0, 36.0], Geometry::toUser($transform, 0, 0));
        $this->assertSame([36.0, 756.0], Geometry::toUser($transform, 720, 0));
        $this->assertSame([576.0, 36.0], Geometry::toUser($transform, 0, 540));
    }

    /**
     * @return array<string, array{int}>
     */
    public static function rotations(): array
    {
        return ['0°' => [0], '90°' => [90], '180°' => [180], '270°' => [270]];
    }

    #[DataProvider('rotations')]
    public function testASignatureLandsInItsRectangleAndStaysUpright(int $rotation): void
    {
        $box = [20.0, 30.0, 620.0, 830.0];
        $transform = Geometry::displayTransform($box, $rotation);
        $matrix = Geometry::placementMatrix(static fn (float $x, float $y) => Geometry::toUser($transform, $x, $y), 100, 50, 200, 80);

        // Draw the image's corners through the matrix, then show them: they must be the rectangle's corners.
        $shown = static function (float $u, float $v) use ($matrix, $transform): array {
            [$a, $b, $c, $d, $e, $f] = $matrix;
            [$x, $y] = [$a * $u + $c * $v + $e, $b * $u + $d * $v + $f];
            [$ta, $tb, $tc, $td, $te, $tf] = $transform;

            return [round($ta * $x + $tc * $y + $te, 6), round($tb * $x + $td * $y + $tf, 6)];
        };

        $this->assertSame([100.0, 50.0], $shown(0, 1), 'the image\'s top-left is the rectangle\'s top-left');
        $this->assertSame([300.0, 50.0], $shown(1, 1), 'its top-right');
        $this->assertSame([100.0, 130.0], $shown(0, 0), 'its bottom-left');
    }
}
