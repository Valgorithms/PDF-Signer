<?php

declare(strict_types=1);

namespace PdfSigner\Tests;

use PdfSigner\Mark;
use PdfSigner\Pdf\Document;
use PdfSigner\Pdf\EncryptedPdfException;
use PdfSigner\Pdf\Filters;
use PdfSigner\Pdf\Reference;
use PdfSigner\Pdf\Stream;
use PdfSigner\SignatureImage;
use PdfSigner\Signer;
use PdfSigner\Tests\Fixtures\PdfBuilder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class SignerTest extends TestCase
{
    /**
     * @return array<string, array{string}>
     */
    public static function layouts(): array
    {
        return [
            'classic table' => [PdfBuilder::twoPages()->classic()],
            'compressed stream' => [PdfBuilder::twoPages()->compressed()],
        ];
    }

    #[DataProvider('layouts')]
    public function testASignatureIsAppendedAndTheOriginalKept(string $original): void
    {
        $signed = Signer::fromString($original)->stamp($this->signature(), 1, 72, 100, 144, 72)->toString();

        $this->assertStringStartsWith($original, $signed, 'the original bytes are untouched');

        $document = Document::fromString($signed);
        $page = $document->pages()[0];
        $contents = array_map(fn (Reference $r) => Filters::decode($document->object($r->number)), $page->dictionary->get('Contents'));

        $this->assertSame(['q', '0 0 1 rg 72 72 144 144 re f', 'Q'], array_map('trim', array_slice($contents, 0, 3)), 'the page\'s own content is wrapped in q … Q');
        $this->assertSame("q 144 0 0 72 72 620 cm /PdfSigner1 Do Q\n", $contents[3]);

        $image = $document->resolve($page->dictionary->get('Resources')->get('XObject')->get('PdfSigner1'));
        $this->assertInstanceOf(Stream::class, $image);
        $this->assertSame([4, 2], [$image->dictionary->get('Width'), $image->dictionary->get('Height')]);
        $this->assertInstanceOf(Reference::class, $image->dictionary->get('SMask'), 'transparency is kept as a soft mask');
        $this->assertTrue($document->resolve($page->dictionary->get('Resources'))->has('ProcSet'), 'inherited resources are carried over');
    }

    #[DataProvider('layouts')]
    public function testTheUpdateUsesTheSameKindOfCrossReferenceAndPointsBack(string $original): void
    {
        $before = Document::fromString($original);
        $after = Document::fromString(Signer::fromString($original)->stamp($this->signature(), 1, 0, 0, 10)->toString());

        $this->assertSame($before->xrefIsStream(), $after->xrefIsStream());
        $this->assertCount(2, $after->pages());
        $this->assertGreaterThan($before->startxref(), $after->startxref());
    }

    public function testARotatedPageKeepsItsContentAndResourceNames(): void
    {
        $signed = Signer::fromString(PdfBuilder::twoPages()->classic())->stamp($this->signature(), 2, 100, 50, 200, 80)->toString();
        $document = Document::fromString($signed);
        $page = $document->pages()[1];
        $contents = $page->dictionary->get('Contents');
        $xObjects = $page->dictionary->get('Resources')->get('XObject');

        $this->assertEquals(new Reference(7), $contents[1], 'a /Contents array is kept in order');
        $this->assertEquals(new Reference(8), $xObjects->get('PdfSigner1'), 'an existing resource keeps its name');
        $this->assertInstanceOf(Stream::class, $document->resolve($xObjects->get('PdfSigner2')));
        // On a page turned 90°, the displayed rectangle x 100–300, y 50–130 is user x 86–166, y 136–336.
        $this->assertSame("q 0 200 -80 0 166 136 cm /PdfSigner2 Do Q\n", Filters::decode($document->object($contents[3]->number)));
    }

    public function testAMarkIsDrawnWithOperatorsAloneAfterWhatWasPlacedBeforeIt(): void
    {
        $signed = Signer::fromString(PdfBuilder::twoPages()->classic())
            ->stamp($this->signature(), 1, 72, 100, 144, 72)
            ->mark(new Mark(Mark::RECTANGLE), 1, 72, 100, 144, 72)
            ->toString();
        $document = Document::fromString($signed);
        $contents = $document->pages()[0]->dictionary->get('Contents');

        $this->assertSame(
            "q 144 0 0 72 72 620 cm /PdfSigner1 Do Q\nq 0 0 0 RG 1.5 w 1 J 0 j 72 620 m 216 620 l 216 692 l 72 692 l h S Q\n",
            Filters::decode($document->object($contents[3]->number)),
        );
    }

    public function testAMarkOnARotatedPageLeavesItsResourcesAlone(): void
    {
        $original = Document::fromString(PdfBuilder::twoPages()->classic());
        $signed = Signer::fromString($original->bytes())->mark(new Mark(Mark::LINE_DOWN), 2, 100, 50, 200, 80)->toString();
        $document = Document::fromString($signed);
        $page = $document->pages()[1];
        $contents = $page->dictionary->get('Contents');

        $this->assertEquals($original->pages()[1]->dictionary->get('Resources'), $page->dictionary->get('Resources'), 'no XObject is added for a mark');
        // The displayed rectangle's top-left and bottom-right are user 86, 136 and 166, 336 on the page turned 90°.
        $this->assertSame("q 0 0 0 RG 1.5 w 1 J 1 j 86 136 m 166 336 l S Q\n", Filters::decode($document->object($contents[3]->number)));
    }

    public function testTheSameSignatureIsEmbeddedOnce(): void
    {
        $signature = $this->signature();
        $signed = Signer::fromString(PdfBuilder::twoPages()->classic())
            ->stamp($signature, 1, 10, 10, 50)
            ->stamp($signature, 2, 10, 10, 50)
            ->toString();

        $this->assertSame(2, substr_count($signed, '/Subtype /Image'), 'one image and its mask');
    }

    public function testASignedDocumentCanBeSignedAgain(): void
    {
        $once = Signer::fromString(PdfBuilder::twoPages()->compressed())->stamp($this->signature(), 1, 10, 10, 50)->toString();
        $twice = Signer::fromString($once)->stamp($this->signature(), 1, 300, 10, 50)->toString();

        $this->assertStringStartsWith($once, $twice);
        $this->assertSame(3, substr_count($twice, '%%EOF'));

        $document = Document::fromString($twice);
        $xObjects = $document->resolve($document->pages()[0]->dictionary->get('Resources'))->get('XObject');
        $this->assertTrue($xObjects->has('PdfSigner1') && $xObjects->has('PdfSigner2'));
    }

    public function testNothingChangesWithoutASignature(): void
    {
        $original = PdfBuilder::twoPages()->classic();

        $this->assertSame($original, Signer::fromString($original)->toString());
    }

    public function testPageSizesAreAsDisplayed(): void
    {
        $signer = Signer::fromString(PdfBuilder::twoPages()->classic());

        $this->assertSame(2, $signer->pageCount());
        $this->assertSame([612.0, 792.0], $signer->pageSize(1));
        $this->assertSame([720.0, 540.0], $signer->pageSize(2));
    }

    public function testAMissingPageIsRefused(): void
    {
        $this->expectException(\OutOfRangeException::class);

        Signer::fromString(PdfBuilder::twoPages()->classic())->stamp($this->signature(), 3, 0, 0, 10);
    }

    public function testAnEncryptedDocumentIsRefused(): void
    {
        $this->expectException(EncryptedPdfException::class);

        Signer::fromString(str_replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R', PdfBuilder::twoPages()->classic()));
    }

    public function testAnExistingDigitalSignatureIsReported(): void
    {
        $pdf = PdfBuilder::twoPages()->add(9, '<< /Type /Sig /ByteRange [0 10 20 30] >>')->classic();

        $this->assertTrue(Signer::fromString($pdf)->hasDigitalSignatures());
        $this->assertFalse(Signer::fromString(PdfBuilder::twoPages()->classic())->hasDigitalSignatures());
    }

    public function testSavingWritesTheFile(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'pdf');

        try {
            Signer::fromString(PdfBuilder::twoPages()->classic())->stamp($this->signature(), 1, 0, 0, 10)->save($path);
            $this->assertCount(2, Document::open($path)->pages());
        } finally {
            @unlink($path);
        }
    }

    /**
     * A 4 × 2 signature: a black left half and a transparent right half.
     */
    private function signature(): SignatureImage
    {
        $image = imagecreatetruecolor(4, 2);
        imagealphablending($image, false);
        imagesavealpha($image, true);
        imagefilledrectangle($image, 2, 0, 3, 1, imagecolorallocatealpha($image, 0, 0, 0, 127));

        ob_start();
        imagepng($image);

        return SignatureImage::fromString((string) ob_get_clean());
    }
}
