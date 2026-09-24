<?php

declare(strict_types=1);

namespace PdfSigner;

use PdfSigner\Pdf\Dictionary;
use PdfSigner\Pdf\Document;
use PdfSigner\Pdf\EncryptedPdfException;
use PdfSigner\Pdf\IncrementalUpdate;
use PdfSigner\Pdf\Name;
use PdfSigner\Pdf\Page;
use PdfSigner\Pdf\PdfException;
use PdfSigner\Pdf\Reference;
use PdfSigner\Pdf\Serializer;
use PdfSigner\Pdf\Stream;

/**
 * Adds signature images on top of the pages of an existing PDF.
 *
 * The PDF is revised with an incremental update: its bytes are kept as they are and the signatures are
 * appended, so everything it held survives, including any earlier digital signature as a prior revision.
 *
 * ```php
 * Signer::open('lease.pdf')
 *     ->stamp(SignatureImage::fromFile('signature.png'), page: 3, x: 72, y: 640, width: 160)
 *     ->save('lease-signed.pdf');
 * ```
 *
 * This places a visible signature. It is not a cryptographic digital signature.
 */
final class Signer
{
    /** @var list<array{0: SignatureImage, 1: int, 2: array{float, float, float, float, float, float}}> */
    private array $stamps = [];

    /**
     * @throws EncryptedPdfException The document is encrypted.
     */
    private function __construct(private readonly Document $document)
    {
        if ($document->isEncrypted()) {
            throw EncryptedPdfException::create();
        }
    }

    /**
     * Opens a PDF file.
     *
     * @param string $path The PDF.
     *
     * @throws PdfException          The file could not be read, or is not a PDF.
     * @throws EncryptedPdfException The PDF is encrypted.
     */
    public static function open(string $path): self
    {
        return new self(Document::open($path));
    }

    /**
     * Opens a PDF from its bytes.
     *
     * @param string $bytes The PDF.
     *
     * @throws PdfException          The bytes are not a PDF.
     * @throws EncryptedPdfException The PDF is encrypted.
     */
    public static function fromString(string $bytes): self
    {
        return new self(Document::fromString($bytes));
    }

    /**
     * The number of pages.
     */
    public function pageCount(): int
    {
        return count($this->document->pages());
    }

    /**
     * A page's width and height as displayed, in points, after its crop box and rotation.
     *
     * @param int $page The page number, from 1.
     *
     * @throws \OutOfRangeException There is no such page.
     *
     * @return array{float, float}
     */
    public function pageSize(int $page): array
    {
        $found = $this->page($page);

        return Geometry::displaySize($found->viewBox(), $found->rotation);
    }

    /**
     * Whether the PDF already carries a digital signature. Adding a visible signature keeps it as an
     * earlier revision, but viewers will report that the document changed after it was signed.
     */
    public function hasDigitalSignatures(): bool
    {
        return $this->document->hasDigitalSignatures();
    }

    /**
     * Places a signature on a page.
     *
     * The position is on the page as a viewer shows it, in points from its top-left corner; the signature
     * stays upright even on a rotated page.
     *
     * @param SignatureImage $image  The signature.
     * @param int            $page   The page number, from 1.
     * @param float          $x      The signature's left edge, from the page's left edge.
     * @param float          $y      Its top edge, from the page's top edge.
     * @param float          $width  Its width.
     * @param ?float         $height Its height; by default, whatever keeps the image's proportions.
     *
     * @throws \OutOfRangeException There is no such page.
     */
    public function stamp(SignatureImage $image, int $page, float $x, float $y, float $width, ?float $height = null): self
    {
        $found = $this->page($page);
        $height ??= $width * $image->height() / $image->width();
        $transform = Geometry::displayTransform($found->viewBox(), $found->rotation);
        $toUser = static fn (float $u, float $v): array => Geometry::toUser($transform, $u, $v);

        return $this->stampWithMatrix($image, $page, Geometry::placementMatrix($toUser, $x, $y, $width, $height));
    }

    /**
     * Places a signature with a transformation matrix in the page's user space, which draws the image
     * into the unit square. {@see Signer::stamp()} works this out from a position on the page.
     *
     * @param SignatureImage                                  $image  The signature.
     * @param int                                             $page   The page number, from 1.
     * @param array{float, float, float, float, float, float} $matrix The `cm` operator's a b c d e f.
     *
     * @throws \OutOfRangeException There is no such page.
     */
    public function stampWithMatrix(SignatureImage $image, int $page, array $matrix): self
    {
        $this->page($page);
        $this->stamps[] = [$image, $page, array_map('floatval', array_values($matrix))];

        return $this;
    }

    /**
     * The signed PDF: the original bytes followed by an update holding the signatures.
     *
     * @throws PdfException A page cannot be revised.
     */
    public function toString(): string
    {
        if ([] === $this->stamps) {
            return $this->document->bytes();
        }

        $update = new IncrementalUpdate($this->document);
        $images = [];
        $byPage = [];

        foreach ($this->stamps as [$image, $page, $matrix]) {
            $images[spl_object_id($image)] ??= $this->addImage($update, $image);
            $byPage[$page][] = [$images[spl_object_id($image)], $matrix];
        }

        // Wrapping each page's content in q … Q means a transform it leaves behind cannot move the signature.
        $save = $update->add(new Stream(new Dictionary(), "q\n"));
        $restore = $update->add(new Stream(new Dictionary(), "Q\n"));

        foreach ($byPage as $number => $stamps) {
            $page = $this->page($number);

            if (null === $page->reference) {
                throw new PdfException("Page {$number} is stored in a way that cannot be revised.");
            }

            $resources = $this->copyDictionary($page->resources);
            $xObjects = $this->copyDictionary($resources->get('XObject'));
            $content = '';

            foreach ($stamps as [$imageReference, $matrix]) {
                $name = $this->freeName($xObjects);
                $xObjects->set($name, $imageReference);
                $content .= 'q '.implode(' ', array_map(Serializer::number(...), $matrix)).' cm '.Serializer::value(new Name($name))." Do Q\n";
            }

            $resources->set('XObject', $xObjects);
            $dictionary = new Dictionary($page->dictionary->all());
            $dictionary->set('Contents', [$save, ...$this->contents($page), $restore, $update->add(new Stream(new Dictionary(), $content))]);
            $dictionary->set('Resources', $resources);
            $update->replace($page->reference, $dictionary);
        }

        return $update->toString();
    }

    /**
     * Writes the signed PDF.
     *
     * @param string $path Where to write it; an existing file is replaced.
     *
     * @throws \RuntimeException The file could not be written.
     *
     * @return string The path.
     */
    public function save(string $path): string
    {
        if (false === @file_put_contents($path, $this->toString())) {
            throw new \RuntimeException("Could not write {$path}.");
        }

        return $path;
    }

    /**
     * A page by number.
     *
     * @param int $page The page number, from 1.
     *
     * @throws \OutOfRangeException There is no such page.
     */
    private function page(int $page): Page
    {
        $pages = $this->document->pages();

        if ($page < 1 || $page > count($pages)) {
            throw new \OutOfRangeException(sprintf('There is no page %d; the PDF has %d.', $page, count($pages)));
        }

        return $pages[$page - 1];
    }

    /**
     * Adds a signature as an image XObject, with a soft mask when it has transparency.
     */
    private function addImage(IncrementalUpdate $update, SignatureImage $image): Reference
    {
        [$rgb, $alpha] = $image->samples();
        $dictionary = static fn (string $colorSpace) => new Dictionary([
            'Type' => new Name('XObject'),
            'Subtype' => new Name('Image'),
            'Width' => $image->width(),
            'Height' => $image->height(),
            'ColorSpace' => new Name($colorSpace),
            'BitsPerComponent' => 8,
            'Filter' => new Name('FlateDecode'),
        ]);

        $picture = $dictionary('DeviceRGB');

        if (null !== $alpha) {
            $picture->set('SMask', $update->add(new Stream($dictionary('DeviceGray'), $alpha)));
        }

        return $update->add(new Stream($picture, $rgb));
    }

    /**
     * A page's content streams, as a list of references.
     *
     * @return list<mixed>
     */
    private function contents(Page $page): array
    {
        $contents = $page->dictionary->get('Contents');

        if ($contents instanceof Reference) {
            $target = $this->document->object($contents->number);

            // /Contents may point to an array of streams rather than to a stream.
            return is_array($target) ? $target : [$contents];
        }

        return is_array($contents) ? $contents : [];
    }

    /**
     * A new dictionary with the entries of a possibly indirect one, or an empty one when there is none.
     *
     * @param mixed $value The dictionary, a reference to one, or null.
     */
    private function copyDictionary(mixed $value): Dictionary
    {
        $value = $this->document->resolve($value);

        return new Dictionary($value instanceof Dictionary ? $value->all() : []);
    }

    /**
     * A resource name not already in use.
     *
     * @param Dictionary $xObjects The page's XObject resources.
     */
    private function freeName(Dictionary $xObjects): string
    {
        for ($n = 1; $xObjects->has("PdfSigner{$n}"); ++$n) {
        }

        return "PdfSigner{$n}";
    }
}
