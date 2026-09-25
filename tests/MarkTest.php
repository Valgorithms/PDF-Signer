<?php

declare(strict_types=1);

namespace PdfSigner\Tests;

use PdfSigner\Mark;
use PHPUnit\Framework\TestCase;

final class MarkTest extends TestCase
{
    public function testATickIsDrawnInThePagesOwnSpaceAndBoldensWithItsSize(): void
    {
        $this->assertSame(
            'q 0 0 0 RG 1.75 w 1 J 1 j 101.12 207.28 m 105.32 202.8 l 112.88 212.04 l S Q',
            (new Mark(Mark::TICK))->operators([14, 0, 0, 14, 100, 200]),
        );
        $this->assertStringContainsString(' 5 w ', (new Mark(Mark::CROSS))->operators([40, 0, 0, 60, 0, 0]), 'an eighth of the smaller side');
    }

    public function testAFlatLineKeepsItsThickness(): void
    {
        $this->assertSame('q 0 0 0 RG 1.5 w 1 J 1 j 50 300 m 250 300 l S Q', (new Mark(Mark::LINE_UP))->operators([200, 0, 0, 0, 50, 300]));
        $this->assertSame('q 0 0 0 RG 1.5 w 1 J 1 j 50 340 m 250 300 l S Q', (new Mark(Mark::LINE_DOWN))->operators([200, 0, 0, 40, 50, 300]));
    }

    public function testADotIsFilledARectangleHasSharpCornersAndAnEllipseIsFourCurves(): void
    {
        $dot = (new Mark(Mark::DOT, Mark::rgb('b3141c')))->operators([10, 0, 0, 10, 0, 0]);
        $this->assertStringStartsWith('q 0.701961 0.078431 0.109804 rg 10 5 m ', $dot);
        $this->assertStringEndsWith(' h f Q', $dot);

        $this->assertSame('q 0 0 0 RG 1.5 w 1 J 0 j 0 0 m 30 0 l 30 20 l 0 20 l h S Q', (new Mark(Mark::RECTANGLE))->operators([30, 0, 0, 20, 0, 0]));
        $this->assertSame(4, substr_count((new Mark(Mark::ELLIPSE))->operators([30, 0, 0, 20, 0, 0]), ' c '));
    }

    public function testColoursAreReadFromHexadecimal(): void
    {
        $this->assertSame([31 / 255, 63 / 255, 191 / 255], Mark::rgb('#1f3fbf'));
        $this->assertSame([0, 0, 0], Mark::rgb('000000'));

        $this->expectException(\InvalidArgumentException::class);
        Mark::rgb('red');
    }

    public function testAnUnknownShapeIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Mark('star');
    }
}
