<?php

declare(strict_types=1);

namespace PdfSigner\Tests;

use PdfSigner\SignatureImage;
use PHPUnit\Framework\TestCase;

final class SignatureImageTest extends TestCase
{
    public function testPaperBecomesTransparentAndInkStays(): void
    {
        $image = $this->photo()->withoutWhiteBackground();
        [, $alpha] = $image->samples();

        $mask = array_values(unpack('C*', gzuncompress($alpha)));
        $this->assertSame(0, $mask[0], 'the white corner is transparent');
        $this->assertSame(255, $mask[2 * 5 + 2], 'the black middle is opaque');
    }

    public function testTrimmingKeepsOnlyTheInk(): void
    {
        $image = $this->photo()->withoutWhiteBackground()->trimmed();

        $this->assertSame([1, 1], [$image->width(), $image->height()]);
    }

    public function testAnOpaqueImageNeedsNoMask(): void
    {
        [$rgb, $alpha] = $this->photo()->samples();

        $this->assertNull($alpha);
        $this->assertSame(5 * 5 * 3, strlen(gzuncompress($rgb)));
    }

    public function testAFileThatIsNotAnImageIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        SignatureImage::fromString('not an image');
    }

    /**
     * A 5 × 5 photo of a signature: white paper with one black pixel in the middle.
     */
    private function photo(): SignatureImage
    {
        $image = imagecreatetruecolor(5, 5);
        imagefill($image, 0, 0, imagecolorallocate($image, 255, 255, 255));
        imagesetpixel($image, 2, 2, imagecolorallocate($image, 0, 0, 0));

        // PNG, not JPEG: compression artefacts would smear the one ink pixel into its neighbours.
        ob_start();
        imagepng($image);

        return SignatureImage::fromString((string) ob_get_clean());
    }
}
