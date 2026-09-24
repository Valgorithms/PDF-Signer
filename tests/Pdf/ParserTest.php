<?php

declare(strict_types=1);

namespace PdfSigner\Tests\Pdf;

use PdfSigner\Pdf\Dictionary;
use PdfSigner\Pdf\Name;
use PdfSigner\Pdf\Parser;
use PdfSigner\Pdf\PdfException;
use PdfSigner\Pdf\PdfString;
use PdfSigner\Pdf\Reference;
use PdfSigner\Pdf\Serializer;
use PdfSigner\Pdf\Stream;
use PHPUnit\Framework\TestCase;

final class ParserTest extends TestCase
{
    public function testDictionariesArraysAndReferences(): void
    {
        $value = (new Parser('<< /Type /Page /Kids [1 0 R 2 0 R] /Count 2 /Box [0 -1.5 +3 .25] /On true /Off false /None null >>'))->value();

        $this->assertInstanceOf(Dictionary::class, $value);
        $this->assertTrue($value->isName('Type', 'Page'));
        $this->assertEquals([new Reference(1), new Reference(2)], $value->get('Kids'));
        $this->assertSame(2, $value->get('Count'));
        $this->assertSame([0, -1.5, 3, 0.25], $value->get('Box'));
        $this->assertSame([true, false, null], [$value->get('On'), $value->get('Off'), $value->get('None')]);
    }

    public function testAnROnlyEndsAReferenceWhenItIsAToken(): void
    {
        $this->assertSame(12, (new Parser('12 0 RG'))->value());
    }

    public function testNamesDecodeHashEscapes(): void
    {
        $this->assertEquals(new Name('A B#C'), (new Parser('/A#20B#23C'))->value());
    }

    public function testLiteralStringsHandleNestingEscapesAndLineEndings(): void
    {
        $source = <<<'PDF'
            (a \(b\) (nested) \\ \101\60\t
            c\
            d)
            PDF;

        $this->assertEquals(new PdfString("a (b) (nested) \\ A0\t\ncd"), (new Parser($source))->value());
    }

    public function testHexStringsAllowSpacesAndAnOddDigit(): void
    {
        $this->assertEquals(new PdfString('Hi!', true), (new Parser('<48 69 21>'))->value());
        $this->assertSame('Hi ', (new Parser('<48692>'))->value()->bytes, 'an odd final digit is followed by a 0');
    }

    public function testCommentsAreSkipped(): void
    {
        $this->assertSame([1, 2], (new Parser("[1 % a comment ]\n2]"))->value());
    }

    public function testAStreamIsReadByItsLength(): void
    {
        [$number, $generation, $stream] = (new Parser("7 0 obj\n<< /Length 5 >>\nstream\nabcde\nendstream\nendobj"))->indirectObject(0);

        $this->assertSame([7, 0], [$number, $generation]);
        $this->assertInstanceOf(Stream::class, $stream);
        $this->assertSame('abcde', $stream->data);
    }

    public function testAStreamWithAWrongLengthIsReadToItsEnd(): void
    {
        [, , $stream] = (new Parser("7 0 obj\n<< /Length 99 >>\nstream\r\nabcde\r\nendstream\nendobj"))->indirectObject(0);

        $this->assertSame('abcde', $stream->data);
    }

    public function testAnIndirectLengthIsResolved(): void
    {
        $parser = new Parser("7 0 obj\n<< /Length 8 0 R >>\nstream\nabc\nendstream", 0, static fn (Reference $r) => 3);

        $this->assertSame('abc', $parser->indirectObject(0)[2]->data);
    }

    public function testWhatIsReadIsWrittenBackTheSame(): void
    {
        $source = '<< /Type /XObject /Name /A#20B /Text (a\\(b\\)c) /Hex <00ff> /List [1 2.5 -3 true null 4 0 R] /Nested << >> >>';

        $this->assertSame($source, Serializer::value((new Parser($source))->value()));
    }

    public function testSomethingThatIsNotAValueIsRefused(): void
    {
        $this->expectException(PdfException::class);

        (new Parser('BT'))->value();
    }

    public function testNumbersAreWrittenWithoutExponents(): void
    {
        $this->assertSame(['0', '1.5', '0.000001', '-72', '0'], array_map(Serializer::number(...), [0.0, 1.5, 1e-6, -72.0, -1e-9]));
    }
}
