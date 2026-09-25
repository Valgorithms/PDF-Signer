// Adds signature images and marks on top of the pages of an existing PDF, as an incremental update that keeps
// the original bytes intact. A port of src/Signer.php and src/SignatureImage.php.
import { deflate } from './pdf/binary.js';
import { Document } from './pdf/document.js';
import { IncrementalUpdate } from './pdf/incremental-update.js';
import { Dictionary, EncryptedPdfError, Name, PdfError, Reference, Stream } from './pdf/objects.js';
import { number, serialize } from './pdf/serializer.js';
import { displaySize, displayTransform, placementMatrix, toUser } from './geometry.js';
import { Mark } from './marks.js';

/**
 * A signature ready to embed: its size, and its RGB and alpha samples compressed with zlib.
 * Build one from pixels with {@link signatureFromPixels}.
 */
export class SignatureImage {
  constructor(width, height, rgb, alpha) {
    this.width = width;
    this.height = height;
    this.rgb = rgb;
    this.alpha = alpha;
  }
}

/**
 * A signature from RGBA pixels, top row first, such as a canvas's image data.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray|Uint8Array} rgba
 */
export async function signatureFromPixels(width, height, rgba) {
  const pixels = width * height;
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  let translucent = false;

  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    alpha[i] = rgba[i * 4 + 3];
    translucent ||= alpha[i] !== 255;
  }

  return new SignatureImage(width, height, await deflate(rgb), translucent ? await deflate(alpha) : null);
}

export class Signer {
  constructor(document, pages) {
    if (document.isEncrypted()) {
      throw new EncryptedPdfError();
    }
    this.document = document;
    this.pages = pages;
    this.stamps = [];
  }

  /** Opens a PDF from its bytes. */
  static async fromBytes(bytes) {
    const document = await Document.fromBytes(bytes);
    if (document.isEncrypted()) {
      throw new EncryptedPdfError();
    }
    return new Signer(document, await document.pages());
  }

  pageCount() {
    return this.pages.length;
  }

  /** A page's width and height as displayed, in points. */
  pageSize(page) {
    const found = this.page(page);
    return displaySize(found.viewBox(), found.rotation);
  }

  /** Whether the PDF already carries a digital signature. */
  hasDigitalSignatures() {
    return this.document.hasDigitalSignatures();
  }

  /**
   * Places a signature on a page, at a position on the page as displayed, in points from its top-left.
   * Without a height, the image keeps its proportions.
   */
  stamp(image, page, x, y, width, height = null) {
    const found = this.page(page);
    const transform = displayTransform(found.viewBox(), found.rotation);
    const rect = { x, y, width, height: height ?? (width * image.height) / image.width };
    return this.stampWithMatrix(image, page, placementMatrix((u, v) => toUser(transform, u, v), rect));
  }

  /** Places a signature with a `cm` matrix in the page's user space. */
  stampWithMatrix(image, page, matrix) {
    this.page(page);
    this.stamps.push([image, page, matrix.map(Number)]);
    return this;
  }

  /**
   * Draws a mark on a page, filling a rectangle on the page as displayed, in points from its top-left.
   * A flat rectangle makes a straight line.
   */
  mark(mark, page, x, y, width, height) {
    const found = this.page(page);
    const transform = displayTransform(found.viewBox(), found.rotation);
    return this.markWithMatrix(mark, page, placementMatrix((u, v) => toUser(transform, u, v), { x, y, width, height }));
  }

  /** Draws a mark where a `cm` matrix in the page's user space would draw an image. */
  markWithMatrix(mark, page, matrix) {
    this.page(page);
    this.stamps.push([mark, page, matrix.map(Number)]);
    return this;
  }

  /** The signed PDF's bytes. */
  async toBytes() {
    if (!this.stamps.length) {
      return this.document.bytes;
    }

    const update = new IncrementalUpdate(this.document);
    const images = new Map();
    const byPage = new Map();

    for (const [thing, page, matrix] of this.stamps) {
      if (!(thing instanceof Mark) && !images.has(thing)) {
        images.set(thing, addImage(update, thing));
      }
      if (!byPage.has(page)) {
        byPage.set(page, []);
      }
      byPage.get(page).push([thing instanceof Mark ? thing : images.get(thing), matrix]);
    }

    // Wrapping each page's content in q … Q means a transform it leaves behind cannot move the signature.
    const save = update.add(new Stream(new Dictionary(), 'q\n'));
    const restore = update.add(new Stream(new Dictionary(), 'Q\n'));

    for (const [pageNumber, stamps] of byPage) {
      const page = this.page(pageNumber);
      if (page.reference === null) {
        throw new PdfError(`Page ${pageNumber} is stored in a way that cannot be revised.`);
      }

      const resources = await this.copyDictionary(page.resources);
      const xObjects = await this.copyDictionary(resources.get('XObject'));
      let content = '';

      let images = 0;

      // In the order they were placed, so a later one is drawn over an earlier one.
      for (const [placed, matrix] of stamps) {
        if (placed instanceof Mark) {
          content += `${placed.operators(matrix)}\n`;
          continue;
        }
        const name = freeName(xObjects);
        xObjects.set(name, placed);
        content += `q ${matrix.map(number).join(' ')} cm ${serialize(new Name(name))} Do Q\n`;
        images++;
      }

      // Marks are drawn with operators alone and need no resources.
      if (images) {
        resources.set('XObject', xObjects);
      }
      const dictionary = page.dictionary.copy();
      dictionary.set('Contents', [save, ...(await this.contents(page)), restore, update.add(new Stream(new Dictionary(), content))]);
      dictionary.set('Resources', resources);
      update.replace(page.reference, dictionary);
    }

    return update.toBytes();
  }

  page(page) {
    if (!Number.isInteger(page) || page < 1 || page > this.pages.length) {
      throw new RangeError(`There is no page ${page}; the PDF has ${this.pages.length}.`);
    }
    return this.pages[page - 1];
  }

  async contents(page) {
    const contents = page.dictionary.get('Contents');
    if (contents instanceof Reference) {
      const target = await this.document.object(contents.number);
      // /Contents may point to an array of streams rather than to a stream.
      return Array.isArray(target) ? target : [contents];
    }
    return Array.isArray(contents) ? contents : [];
  }

  async copyDictionary(value) {
    const resolved = await this.document.resolve(value ?? null);
    return resolved instanceof Dictionary ? resolved.copy() : new Dictionary();
  }
}

/** Adds a signature as an image XObject, with a soft mask when it has transparency. */
function addImage(update, image) {
  const dictionary = (colorSpace) => new Dictionary({
    Type: new Name('XObject'),
    Subtype: new Name('Image'),
    Width: image.width,
    Height: image.height,
    ColorSpace: new Name(colorSpace),
    BitsPerComponent: 8,
    Filter: new Name('FlateDecode'),
  });

  const picture = dictionary('DeviceRGB');
  if (image.alpha !== null) {
    picture.set('SMask', update.add(new Stream(dictionary('DeviceGray'), image.alpha)));
  }
  return update.add(new Stream(picture, image.rgb));
}

/** A resource name not already in use. */
function freeName(xObjects) {
  let n = 1;
  while (xObjects.has(`PdfSigner${n}`)) {
    n++;
  }
  return `PdfSigner${n}`;
}
