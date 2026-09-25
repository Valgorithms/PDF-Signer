// The browser version's marks: the same cases as tests/MarkTest.php and the mark tests in SignerTest.php.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '../../web/pdf/document.js';
import { decode } from '../../web/pdf/filters.js';
import { Mark, rgb } from '../../web/marks.js';
import { signatureFromPixels, Signer } from '../../web/signer.js';
import { PdfBuilder, signaturePixels } from './fixtures.mjs';

test('a tick is drawn in the page\'s own space and boldens with its size', () => {
  assert.equal(new Mark('tick').operators([14, 0, 0, 14, 100, 200]), 'q 0 0 0 RG 1.75 w 1 J 1 j 101.12 207.28 m 105.32 202.8 l 112.88 212.04 l S Q');
  assert.ok(new Mark('cross').operators([40, 0, 0, 60, 0, 0]).includes(' 5 w '), 'an eighth of the smaller side');
});

test('a flat line keeps its thickness', () => {
  assert.equal(new Mark('line-up').operators([200, 0, 0, 0, 50, 300]), 'q 0 0 0 RG 1.5 w 1 J 1 j 50 300 m 250 300 l S Q');
  assert.equal(new Mark('line-down').operators([200, 0, 0, 40, 50, 300]), 'q 0 0 0 RG 1.5 w 1 J 1 j 50 340 m 250 300 l S Q');
});

test('a dot is filled, a rectangle has sharp corners and an ellipse is four curves', () => {
  const dot = new Mark('dot', rgb('b3141c')).operators([10, 0, 0, 10, 0, 0]);
  assert.ok(dot.startsWith('q 0.701961 0.078431 0.109804 rg 10 5 m '));
  assert.ok(dot.endsWith(' h f Q'));

  assert.equal(new Mark('rectangle').operators([30, 0, 0, 20, 0, 0]), 'q 0 0 0 RG 1.5 w 1 J 0 j 0 0 m 30 0 l 30 20 l 0 20 l h S Q');
  assert.equal(new Mark('ellipse').operators([30, 0, 0, 20, 0, 0]).split(' c ').length - 1, 4);
});

test('colours are read from hexadecimal, and unknown shapes are refused', () => {
  assert.deepEqual(rgb('#1f3fbf'), [31 / 255, 63 / 255, 191 / 255]);
  assert.throws(() => new Mark('star'), RangeError);
});

test('a mark is drawn with operators alone, after what was placed before it', async () => {
  const signer = await Signer.fromBytes(PdfBuilder.twoPages().classic());
  const signed = await signer
    .stamp(await signatureFromPixels(4, 2, signaturePixels()), 1, 72, 100, 144, 72)
    .mark(new Mark('rectangle'), 1, 72, 100, 144, 72)
    .toBytes();
  const document = await Document.fromBytes(signed);
  const contents = (await document.pages())[0].dictionary.get('Contents');

  assert.equal(
    await decode(await document.object(contents[3].number)),
    'q 144 0 0 72 72 620 cm /PdfSigner1 Do Q\nq 0 0 0 RG 1.5 w 1 J 0 j 72 620 m 216 620 l 216 692 l 72 692 l h S Q\n',
  );
});

test('a mark on a rotated page leaves its resources alone', async () => {
  const original = await Document.fromBytes(PdfBuilder.twoPages().classic());
  const signed = await (await Signer.fromBytes(original.bytes)).mark(new Mark('line-down'), 2, 100, 50, 200, 80).toBytes();
  const document = await Document.fromBytes(signed);
  const page = (await document.pages())[1];

  assert.deepEqual(page.dictionary.get('Resources'), (await original.pages())[1].dictionary.get('Resources'), 'no XObject is added for a mark');
  // The displayed rectangle's top-left and bottom-right are user 86, 136 and 166, 336 on the page turned 90°.
  assert.equal(await decode(await document.object(page.dictionary.get('Contents')[3].number)), 'q 0 0 0 RG 1.5 w 1 J 1 j 86 136 m 166 336 l S Q\n');
});
