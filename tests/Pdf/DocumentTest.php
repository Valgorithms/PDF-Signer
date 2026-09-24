<?php

declare(strict_types=1);

namespace PdfSigner\Tests\Pdf;

use PdfSigner\Pdf\Dictionary;
use PdfSigner\Pdf\Document;
use PdfSigner\Pdf\Filters;
use PdfSigner\Pdf\IncrementalUpdate;
use PdfSigner\Pdf\PdfException;
use PdfSigner\Pdf\Reference;
use PdfSigner\Pdf\Stream;
use PdfSigner\Tests\Fixtures\PdfBuilder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class DocumentTest extends TestCase
{
    /**
     * @return array<string, array{string, bool}>
     */
    public static function layouts(): array
    {
        return [
            'classic table' => [PdfBuilder::twoPages()->classic(), false],
            'compressed stream' => [PdfBuilder::twoPages()->compressed(), true],
        ];
    }

    #[DataProvider('layouts')]
    public function testPagesAreReadWithWhatTheyInherit(string $pdf, bool $isStream): void
    {
        $document = Document::fromString($pdf);
        [$first, $second] = $document->pages();

        $this->assertSame($isStream, $document->xrefIsStream());
        $this->assertCount(2, $document->pages());

        $this->assertEquals(new Reference(3), $first->reference);
        $this->assertSame([0.0, 0.0, 612.0, 792.0], $first->viewBox());
        $this->assertSame(0, $first->rotation);
        $this->assertEquals(new Reference(5), $first->resources, 'the page tree\'s resources are inherited');

        $this->assertSame(90, $second->rotation);
        $this->assertSame([36.0, 36.0, 576.0, 756.0], $second->viewBox());
        $this->assertInstanceOf(Dictionary::class, $second->resources);
    }

    #[DataProvider('layouts')]
    public function testObjectsAreReadWhereverTheyAreStored(string $pdf, bool $isStream): void
    {
        $document = Document::fromString($pdf);

        // In the compressed layout the catalog is packed into an object stream, not stored at an offset.
        $this->assertSame($isStream, str_contains($pdf, '/Type /ObjStm'));

        $this->assertTrue($document->resolve($document->trailer()->get('Root'))->isName('Type', 'Catalog'));
        $this->assertSame('0 0 1 rg 72 72 144 144 re f', Filters::decode($document->object(6)));
        $this->assertNull($document->object(999), 'a missing object is null');
    }

    public function testTheNewestRevisionOfAnObjectWins(): void
    {
        $original = Document::fromString(PdfBuilder::twoPages()->classic());
        $update = new IncrementalUpdate($original);
        $update->replace(new Reference(6), new Stream(new Dictionary(), 'revised'));
        $revised = Document::fromString($update->toString());

        $this->assertSame('revised', $revised->object(6)->data);
        $this->assertSame(2, count($revised->pages()), 'objects only the older revision has are still found');
        $this->assertGreaterThan($original->startxref(), $revised->startxref());
    }

    public function testWrongOffsetsAreRecoveredByScanning(): void
    {
        // Shifting everything after the header leaves every offset pointing a few bytes early.
        $pdf = PdfBuilder::twoPages()->classic();
        $shifted = preg_replace('/^(%PDF-1\.7\n)/', "\$1%padding\n", $pdf);

        $document = Document::fromString($shifted);

        $this->assertCount(2, $document->pages());
        $this->assertSame('0 0 1 rg 72 72 144 144 re f', Filters::decode($document->object(6)));
    }

    public function testAFileWithNoCrossReferencesIsRebuilt(): void
    {
        $pdf = PdfBuilder::twoPages()->classic();
        $withoutXref = substr($pdf, 0, strpos($pdf, 'xref')).'trailer << /Root 1 0 R >>';

        $this->assertCount(2, Document::fromString($withoutXref)->pages());
    }

    public function testSomethingThatIsNotAPdfIsRefused(): void
    {
        $this->expectException(PdfException::class);

        Document::fromString('just text');
    }

    public function testEncryptionIsDetected(): void
    {
        $pdf = str_replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R', PdfBuilder::twoPages()->classic());

        $this->assertTrue(Document::fromString($pdf)->isEncrypted());
        $this->assertFalse(Document::fromString(PdfBuilder::twoPages()->classic())->isEncrypted());
    }
}
