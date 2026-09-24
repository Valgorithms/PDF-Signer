// The browser version's placement and signing: the same cases as tests/GeometryTest.php and SignerTest.php.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampRect, displaySize, displayTransform, initialSize, placementMatrix, scaleRect, signedFileName, toUser,
} from '../../web/geometry.js';
import { opaqueBounds, whiteToTransparent } from '../../web/pixels.js';
import { toBinary } from '../../web/pdf/binary.js';
import { Document } from '../../web/pdf/document.js';
import { decode } from '../../web/pdf/filters.js';
import { EncryptedPdfError, Reference, Stream } from '../../web/pdf/objects.js';
import { signatureFromPixels, Signer } from '../../web/signer.js';
import { PdfBuilder, signaturePixels } from './fixtures.mjs';

test('an unrotated page is flipped vertically, and a rotated one starts at its crop box', () => {
  const upright = displayTransform([0, 0, 612, 792], 0);
  assert.deepEqual(toUser(upright, 0, 0), [0, 792]);
  assert.deepEqual(toUser(upright, 612, 792), [612, 0]);

  const box = [36, 36, 576, 756];
  const turned = displayTransform(box, 90);
  assert.deepEqual(displaySize(box, 90), [720, 540]);
  assert.deepEqual(toUser(turned, 0, 0), [36, 36]);
  assert.deepEqual(toUser(turned, 720, 0), [36, 756]);
  assert.deepEqual(toUser(turned, 0, 540), [576, 36]);
});

for (const rotation of [0, 90, 180, 270]) {
  test(`a signature lands in its rectangle and stays upright at ${rotation}°`, () => {
    const transform = displayTransform([20, 30, 620, 830], rotation);
    const [a, b, c, d, e, f] = placementMatrix((x, y) => toUser(transform, x, y), { x: 100, y: 50, width: 200, height: 80 });
    const [ta, tb, tc, td, te, tf] = transform;
    const shown = (u, v) => {
      const [x, y] = [a * u + c * v + e, b * u + d * v + f];
      return [ta * x + tc * y + te, tb * x + td * y + tf].map((n) => Math.round(n * 1e6) / 1e6 + 0);
    };
    assert.deepEqual(shown(0, 1), [100, 50]);
    assert.deepEqual(shown(1, 1), [300, 50]);
    assert.deepEqual(shown(0, 0), [100, 130]);
  });
}

test('page helpers size, keep and name things', () => {
  assert.deepEqual(scaleRect({ x: 0.5, y: 0.25, width: 0.1, height: 0.2 }, 600, 800), { x: 300, y: 200, width: 60, height: 160 });
  assert.deepEqual(initialSize(4, 612, 792), { width: 180 / 612, height: 45 / 792 });
  assert.deepEqual(clampRect({ x: 0.95, y: -0.1, width: 0.2, height: 0.1 }), { x: 0.8, y: 0, width: 0.2, height: 0.1 });
  assert.equal(signedFileName('Lease.PDF'), 'Lease-signed.pdf');
});

test('paper becomes transparent and trimming keeps only the ink', () => {
  const rgba = new Uint8Array(5 * 5 * 4).fill(255);
  rgba.set([0, 0, 0, 255], (2 * 5 + 2) * 4);
  whiteToTransparent(rgba);
  assert.equal(rgba[3], 0);
  assert.equal(rgba[(2 * 5 + 2) * 4 + 3], 255);
  assert.deepEqual(opaqueBounds(rgba, 5, 5), { x: 2, y: 2, width: 1, height: 1 });
});

for (const [name, build] of Object.entries({ 'classic table': () => PdfBuilder.twoPages().classic(), 'compressed stream': () => PdfBuilder.twoPages().compressed() })) {
  test(`a signature is appended and the original kept (${name})`, async () => {
    const original = build();
    const signer = await Signer.fromBytes(original);
    const signed = await signer.stamp(await signatureFromPixels(4, 2, signaturePixels()), 1, 72, 100, 144, 72).toBytes();

    assert.ok(Buffer.from(signed).subarray(0, original.length).equals(original), 'the original bytes are untouched');

    const document = await Document.fromBytes(signed);
    const [page] = await document.pages();
    const contents = [];
    for (const reference of page.dictionary.get('Contents')) {
      contents.push(await decode(await document.object(reference.number)));
    }
    assert.deepEqual(contents.slice(0, 3).map((c) => c.trim()), ['q', '0 0 1 rg 72 72 144 144 re f', 'Q']);
    assert.equal(contents[3], 'q 144 0 0 72 72 620 cm /PdfSigner1 Do Q\n');

    const image = await document.resolve(page.dictionary.get('Resources').get('XObject').get('PdfSigner1'));
    assert.ok(image instanceof Stream);
    assert.deepEqual([image.dictionary.get('Width'), image.dictionary.get('Height')], [4, 2]);
    assert.ok(image.dictionary.get('SMask') instanceof Reference);
    assert.equal(document.xrefIsStream, (await Document.fromBytes(original)).xrefIsStream);
  });
}

test('a rotated page keeps its content and resource names', async () => {
  const signer = await Signer.fromBytes(PdfBuilder.twoPages().classic());
  const signed = await signer.stamp(await signatureFromPixels(4, 2, signaturePixels()), 2, 100, 50, 200, 80).toBytes();
  const document = await Document.fromBytes(signed);
  const page = (await document.pages())[1];
  const contents = page.dictionary.get('Contents');
  const xObjects = page.dictionary.get('Resources').get('XObject');

  assert.deepEqual(contents[1], new Reference(7));
  assert.deepEqual(xObjects.get('PdfSigner1'), new Reference(8));
  assert.equal(await decode(await document.object(contents[3].number)), 'q 0 200 -80 0 166 136 cm /PdfSigner2 Do Q\n');
});

test('a signed document can be signed again, and one image is embedded once', async () => {
  const image = await signatureFromPixels(4, 2, signaturePixels());
  const once = await (await Signer.fromBytes(PdfBuilder.twoPages().compressed())).stamp(image, 1, 10, 10, 50).stamp(image, 2, 10, 10, 50).toBytes();
  assert.equal(toBinary(once).split('/Subtype /Image').length - 1, 2, 'one image and its mask');

  const twice = await (await Signer.fromBytes(once)).stamp(image, 1, 300, 10, 50).toBytes();
  assert.equal(toBinary(twice).split('%%EOF').length - 1, 3);
  const document = await Document.fromBytes(twice);
  const xObjects = (await document.resolve((await document.pages())[0].dictionary.get('Resources'))).get('XObject');
  assert.ok(xObjects.has('PdfSigner1') && xObjects.has('PdfSigner2'));
});

test('missing pages and encrypted documents are refused', async () => {
  const signer = await Signer.fromBytes(PdfBuilder.twoPages().classic());
  assert.deepEqual(signer.pageSize(2), [720, 540]);
  assert.throws(() => signer.stamp(null, 3, 0, 0, 10), RangeError);

  const encrypted = Buffer.from(toBinary(PdfBuilder.twoPages().classic()).replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'), 'latin1');
  await assert.rejects(Signer.fromBytes(encrypted), EncryptedPdfError);
});
