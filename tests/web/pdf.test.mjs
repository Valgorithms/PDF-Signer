// The browser version's PDF reading and writing: the same cases as tests/Pdf/*Test.php.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBinary } from '../../web/pdf/binary.js';
import { Document } from '../../web/pdf/document.js';
import { decode } from '../../web/pdf/filters.js';
import { IncrementalUpdate } from '../../web/pdf/incremental-update.js';
import { Dictionary, Name, PdfError, PdfString, Reference, Stream } from '../../web/pdf/objects.js';
import { Parser } from '../../web/pdf/parser.js';
import { number, serialize } from '../../web/pdf/serializer.js';
import { PdfBuilder } from './fixtures.mjs';

const layouts = {
  'classic table': [() => PdfBuilder.twoPages().classic(), false],
  'compressed stream': [() => PdfBuilder.twoPages().compressed(), true],
};

test('dictionaries, arrays and references are read', () => {
  const value = new Parser('<< /Type /Page /Kids [1 0 R 2 0 R] /Count 2 /Box [0 -1.5 +3 .25] /On true /None null >>').value();
  assert.ok(value.isName('Type', 'Page'));
  assert.deepEqual(value.get('Kids'), [new Reference(1), new Reference(2)]);
  assert.deepEqual(value.get('Box'), [0, -1.5, 3, 0.25]);
  assert.equal(value.get('On'), true);
  assert.equal(value.get('None'), null);
  assert.equal(new Parser('12 0 RG').value(), 12, 'an R only ends a reference when it is a token');
});

test('names, literal and hex strings decode their escapes', () => {
  assert.deepEqual(new Parser('/A#20B#23C').value(), new Name('A B#C'));
  assert.deepEqual(new Parser('(a \\(b\\) (nested) \\\\ \\101\\60\\t\nc\\\nd)').value(), new PdfString('a (b) (nested) \\ A0\t\ncd'));
  assert.deepEqual(new Parser('<48 69 21>').value(), new PdfString('Hi!', true));
  assert.equal(new Parser('<48692>').value().bytes, 'Hi ');
});

test('streams are read by their length, or to their end when it is wrong', () => {
  assert.equal(new Parser('7 0 obj\n<< /Length 5 >>\nstream\nabcde\nendstream\nendobj').indirectObject(0)[2].data, 'abcde');
  assert.equal(new Parser('7 0 obj\n<< /Length 99 >>\nstream\r\nabcde\r\nendstream').indirectObject(0)[2].data, 'abcde');
});

test('what is read is written back the same', () => {
  const source = '<< /Type /XObject /Name /A#20B /Text (a\\(b\\)c) /Hex <00ff> /List [1 2.5 -3 true null 4 0 R] /Nested << >> >>';
  assert.equal(serialize(new Parser(source).value()), source);
  assert.deepEqual([0, 1.5, 1e-6, -72, -1e-9].map(number), ['0', '1.5', '0.000001', '-72', '0']);
  assert.throws(() => new Parser('BT').value(), PdfError);
});

for (const [name, [build, isStream]] of Object.entries(layouts)) {
  test(`pages are read with what they inherit (${name})`, async () => {
    const document = await Document.fromBytes(build());
    const [first, second] = await document.pages();

    assert.equal(document.xrefIsStream, isStream);
    assert.equal((await document.pages()).length, 2);
    assert.deepEqual(first.reference, new Reference(3));
    assert.deepEqual(first.viewBox(), [0, 0, 612, 792]);
    assert.deepEqual(first.resources, new Reference(5), "the page tree's resources are inherited");
    assert.equal(second.rotation, 90);
    assert.deepEqual(second.viewBox(), [36, 36, 576, 756]);
  });

  test(`objects are read wherever they are stored (${name})`, async () => {
    const document = await Document.fromBytes(build());
    assert.ok((await document.resolve(document.trailer.get('Root'))).isName('Type', 'Catalog'));
    assert.equal(await decode(await document.object(6)), '0 0 1 rg 72 72 144 144 re f');
    assert.equal(await document.object(999), null);
  });
}

test('the newest revision of an object wins', async () => {
  const original = await Document.fromBytes(PdfBuilder.twoPages().classic());
  const update = new IncrementalUpdate(original);
  update.replace(new Reference(6), new Stream(new Dictionary(), 'revised'));
  const revised = await Document.fromBytes(update.toBytes());

  assert.equal((await revised.object(6)).data, 'revised');
  assert.equal((await revised.pages()).length, 2);
  assert.ok(revised.startxref > original.startxref);
});

test('wrong offsets are recovered by scanning, and a file without cross-references is rebuilt', async () => {
  const pdf = toBinary(PdfBuilder.twoPages().classic());
  const shifted = Buffer.from(pdf.replace('%PDF-1.7\n', '%PDF-1.7\n%padding\n'), 'latin1');
  const shiftedDocument = await Document.fromBytes(shifted);
  assert.equal((await shiftedDocument.pages()).length, 2);
  assert.equal(await decode(await shiftedDocument.object(6)), '0 0 1 rg 72 72 144 144 re f');

  const withoutXref = Buffer.from(pdf.slice(0, pdf.indexOf('xref')) + 'trailer << /Root 1 0 R >>', 'latin1');
  assert.equal((await (await Document.fromBytes(withoutXref)).pages()).length, 2);
});

test('something that is not a PDF is refused, and encryption is detected', async () => {
  await assert.rejects(Document.fromBytes(Buffer.from('just text')), PdfError);
  const encrypted = Buffer.from(toBinary(PdfBuilder.twoPages().classic()).replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'), 'latin1');
  assert.ok((await Document.fromBytes(encrypted)).isEncrypted());
});
