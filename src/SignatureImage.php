<?php

declare(strict_types=1);

namespace PdfSigner;

/**
 * A signature as an image: anything GD can read, such as a PNG drawn with a transparent background or a
 * photo of a signature on paper.
 *
 * Transparency is kept, so only the ink covers the page. GD stores alpha in 7 bits, so it is kept to within
 * one step of 255.
 */
final class SignatureImage
{
    /** @var ?array{0: string, 1: ?string} */
    private ?array $samples = null;

    private function __construct(private readonly \GdImage $image)
    {
    }

    /**
     * Reads an image file.
     *
     * @param string $path The image.
     *
     * @throws \RuntimeException         The file could not be read.
     * @throws \InvalidArgumentException The file is not an image GD can read.
     */
    public static function fromFile(string $path): self
    {
        $bytes = is_file($path) ? @file_get_contents($path) : false;

        if (false === $bytes) {
            throw new \RuntimeException("Could not read {$path}.");
        }

        return self::fromString($bytes, $path);
    }

    /**
     * Reads an image from its bytes.
     *
     * @param string $bytes The image file's contents.
     * @param string $name  What to call the image in an error message.
     *
     * @throws \InvalidArgumentException The bytes are not an image GD can read.
     */
    public static function fromString(string $bytes, string $name = 'The signature'): self
    {
        $image = '' === $bytes ? false : @imagecreatefromstring($bytes);

        if (false === $image) {
            throw new \InvalidArgumentException("{$name} is not an image GD can read (PNG, JPEG, GIF, WebP, BMP or AVIF).");
        }

        if (! imageistruecolor($image)) {
            imagepalettetotruecolor($image);
        }

        imagealphablending($image, false);
        imagesavealpha($image, true);

        return new self($image);
    }

    /**
     * The width in pixels.
     */
    public function width(): int
    {
        return imagesx($this->image);
    }

    /**
     * The height in pixels.
     */
    public function height(): int
    {
        return imagesy($this->image);
    }

    /**
     * A copy with paper-white pixels made transparent, for a signature photographed or scanned on paper.
     *
     * Pixels brighter than `$hard` become fully transparent and pixels darker than `$soft` keep their alpha;
     * those between fade, so the edges of the ink stay smooth.
     *
     * @param int $hard Brightness (0–255) at and above which a pixel is paper.
     * @param int $soft Brightness below which a pixel is ink.
     */
    public function withoutWhiteBackground(int $hard = 235, int $soft = 190): self
    {
        $width = $this->width();
        $height = $this->height();
        $copy = $this->blank($width, $height);

        for ($y = 0; $y < $height; ++$y) {
            for ($x = 0; $x < $width; ++$x) {
                $color = imagecolorat($this->image, $x, $y);
                [$red, $green, $blue] = [($color >> 16) & 0xFF, ($color >> 8) & 0xFF, $color & 0xFF];
                $brightness = 0.299 * $red + 0.587 * $green + 0.114 * $blue;
                $keep = min(max(($hard - $brightness) / ($hard - $soft), 0), 1);
                $opacity = (127 - (($color >> 24) & 0x7F)) * $keep;
                imagesetpixel($copy, $x, $y, imagecolorallocatealpha($copy, $red, $green, $blue, 127 - (int) round($opacity)));
            }
        }

        return new self($copy);
    }

    /**
     * A copy cropped to the pixels that are not fully transparent, or this image when every pixel is.
     */
    public function trimmed(): self
    {
        $width = $this->width();
        $height = $this->height();
        [$left, $top, $right, $bottom] = [$width, $height, -1, -1];

        for ($y = 0; $y < $height; ++$y) {
            for ($x = 0; $x < $width; ++$x) {
                if ((imagecolorat($this->image, $x, $y) >> 24 & 0x7F) < 127) {
                    [$left, $right] = [min($left, $x), max($right, $x)];
                    [$top, $bottom] = [min($top, $y), max($bottom, $y)];
                }
            }
        }

        if ($right < 0) {
            return $this;
        }

        $copy = $this->blank($right - $left + 1, $bottom - $top + 1);
        imagecopy($copy, $this->image, 0, 0, $left, $top, $right - $left + 1, $bottom - $top + 1);

        return new self($copy);
    }

    /**
     * The pixels as 8-bit RGB and alpha samples, top row first, each compressed with zlib.
     *
     * @internal Used by {@see Signer} to embed the image.
     *
     * @return array{0: string, 1: ?string} The RGB samples, and the alpha samples or null when every pixel is opaque.
     */
    public function samples(): array
    {
        if (null !== $this->samples) {
            return $this->samples;
        }

        $rgbStream = deflate_init(ZLIB_ENCODING_DEFLATE);
        $alphaStream = deflate_init(ZLIB_ENCODING_DEFLATE);
        $rgb = '';
        $alpha = '';
        $translucent = false;

        for ($y = 0, $height = $this->height(), $width = $this->width(); $y < $height; ++$y) {
            $rowRgb = [];
            $rowAlpha = [];

            for ($x = 0; $x < $width; ++$x) {
                $color = imagecolorat($this->image, $x, $y);
                array_push($rowRgb, ($color >> 16) & 0xFF, ($color >> 8) & 0xFF, $color & 0xFF);

                // GD's alpha runs from 0 (opaque) to 127 (transparent); a PDF soft mask runs from 0 (transparent) to 255 (opaque).
                $transparency = ($color >> 24) & 0x7F;
                $rowAlpha[] = 255 - intdiv($transparency * 255 + 63, 127);
                $translucent = $translucent || 0 !== $transparency;
            }

            $rgb .= deflate_add($rgbStream, pack('C*', ...$rowRgb), ZLIB_NO_FLUSH);
            $alpha .= deflate_add($alphaStream, pack('C*', ...$rowAlpha), ZLIB_NO_FLUSH);
        }

        $rgb .= deflate_add($rgbStream, '', ZLIB_FINISH);

        return $this->samples = [$rgb, $translucent ? $alpha.deflate_add($alphaStream, '', ZLIB_FINISH) : null];
    }

    /**
     * A fully transparent truecolour canvas that keeps the alpha written to it.
     */
    private function blank(int $width, int $height): \GdImage
    {
        $canvas = imagecreatetruecolor($width, $height);
        imagealphablending($canvas, false);
        imagesavealpha($canvas, true);
        imagefill($canvas, 0, 0, imagecolorallocatealpha($canvas, 0, 0, 0, 127));

        return $canvas;
    }
}
