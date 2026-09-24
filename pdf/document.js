// An existing PDF, read far enough to revise it with an incremental update. A port of
// src/Pdf/Document.php and Page.php; async where decoding streams is.
import { toBinary } from './binary.js';
import { decode } from './filters.js';
import { Dictionary, PdfError, Reference, Stream } from './objects.js';
import { Parser } from './parser.js';

const NOT_TRAILER_KEYS = ['Prev', 'XRefStm', 'Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms'];

/** A page, with the attributes it inherits from the page tree applied. */
export class Page {
  constructor(reference, dictionary, resources, mediaBox, cropBox, rotation) {
    this.reference = reference;
    this.dictionary = dictionary;
    this.resources = resources;
    this.mediaBox = mediaBox;
    this.cropBox = cropBox;
    this.rotation = rotation;
  }

  /** The displayed area: the crop box where it overlaps the media box. */
  viewBox() {
    if (this.cropBox === null) {
      return this.mediaBox;
    }
    const box = [
      Math.max(this.cropBox[0], this.mediaBox[0]),
      Math.max(this.cropBox[1], this.mediaBox[1]),
      Math.min(this.cropBox[2], this.mediaBox[2]),
      Math.min(this.cropBox[3], this.mediaBox[3]),
    ];
    return box[0] < box[2] && box[1] < box[3] ? box : this.mediaBox;
  }
}

export class Document {
  constructor(bytes) {
    this.bytes = bytes;
    this.text = toBinary(bytes);
    this.xref = new Map();
    this.trailer = new Dictionary();
    this.startxref = 0;
    this.xrefIsStream = false;
    this.objects = new Map();
    this.reading = new Set();
    this.objectStreams = new Map();
    this.scanned = null;
    this.pageList = null;
  }

  /** Reads a PDF from its bytes. */
  static async fromBytes(bytes) {
    const header = toBinary(bytes.subarray(0, 1024)).indexOf('%PDF-');
    if (header < 0) {
      throw new PdfError('This is not a PDF.');
    }
    const document = new Document(bytes);
    await document.readCrossReferences();
    return document;
  }

  /** One more than the highest object number in use: where new objects start. */
  size() {
    const trailerSize = this.trailer.get('Size');
    const highest = this.xref.size ? Math.max(...this.xref.keys()) + 1 : 0;
    const scanned = this.scanned?.size ? Math.max(...this.scanned.keys()) + 1 : 0;
    return Math.max(Number.isInteger(trailerSize) ? trailerSize : 0, highest, scanned);
  }

  isEncrypted() {
    return this.trailer.get('Encrypt') !== null;
  }

  hasDigitalSignatures() {
    return this.text.includes('/ByteRange');
  }

  /** An indirect object's value, or null when it does not exist. */
  async object(number) {
    if (this.objects.has(number)) {
      return this.objects.get(number);
    }
    // An object being read is null to itself, so a reference cycle ends rather than waiting forever.
    if (this.reading.has(number)) {
      return null;
    }
    this.reading.add(number);
    try {
      const [type, a, b] = this.xref.get(number) ?? [-1, 0, 0];
      let value = null;
      if (type === 1) value = this.readAt(a, number);
      else if (type === 2) value = await this.readCompressed(a, b, number);
      else if (type !== 0) value = this.readScanned(number);
      this.objects.set(number, value);
      return value;
    } finally {
      this.reading.delete(number);
    }
  }

  /** A value with any indirect references followed. */
  async resolve(value) {
    for (let depth = 0; value instanceof Reference && depth < 32; depth++) {
      value = await this.object(value.number);
    }
    return value;
  }

  /** The pages, in order. */
  async pages() {
    if (this.pageList) {
      return this.pageList;
    }
    const catalog = await this.resolve(this.trailer.get('Root'));
    if (!(catalog instanceof Dictionary)) {
      throw new PdfError('The PDF has no document catalog.');
    }
    this.pageList = [];
    await this.collectPages(catalog.get('Pages'), {}, new Set());
    return this.pageList;
  }

  async collectPages(node, inherited, visited) {
    const reference = node instanceof Reference ? node : null;
    if (reference) {
      if (visited.has(reference.number)) {
        return;
      }
      visited.add(reference.number);
    }

    const dictionary = await this.resolve(node);
    if (!(dictionary instanceof Dictionary)) {
      return;
    }

    inherited = { ...inherited };
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      if (dictionary.has(key)) {
        inherited[key] = dictionary.get(key);
      }
    }

    const kids = await this.resolve(dictionary.get('Kids'));
    if (!dictionary.isName('Type', 'Page') && Array.isArray(kids)) {
      for (const kid of kids) {
        await this.collectPages(kid, inherited, visited);
      }
      return;
    }

    const mediaBox = (await this.box(inherited.MediaBox)) ?? [0, 0, 612, 792];
    let rotation = await this.resolve(inherited.Rotate ?? 0);
    rotation = Number.isInteger(rotation) && rotation % 90 === 0 ? ((rotation % 360) + 360) % 360 : 0;

    this.pageList.push(new Page(reference, dictionary, inherited.Resources ?? null, mediaBox, await this.box(inherited.CropBox), rotation));
  }

  async box(value) {
    value = await this.resolve(value ?? null);
    if (!Array.isArray(value) || value.length !== 4) {
      return null;
    }
    const numbers = [];
    for (const n of value) {
      const resolved = await this.resolve(n);
      if (typeof resolved !== 'number') {
        return null;
      }
      numbers.push(resolved);
    }
    const [x0, y0, x1, y1] = numbers;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }

  async readCrossReferences() {
    const at = this.text.lastIndexOf('startxref');
    const match = at < 0 ? null : /^startxref\s+(\d+)/.exec(this.text.slice(at, at + 40));
    if (!match) {
      await this.rebuildFromScan();
      return;
    }

    this.startxref = Number(match[1]);
    const trailers = [];
    const visited = new Set();
    let offset = this.startxref;

    try {
      while (offset !== null && !visited.has(offset)) {
        visited.add(offset);
        const [trailer, isStream] = await this.readSection(offset);
        if (!trailers.length) {
          this.xrefIsStream = isStream;
        }
        trailers.push(trailer);

        // A hybrid file's table points to a stream holding the objects in object streams.
        const hybrid = trailer.get('XRefStm');
        if (Number.isInteger(hybrid) && !visited.has(hybrid)) {
          visited.add(hybrid);
          await this.readSection(hybrid);
        }

        const previous = trailer.get('Prev');
        offset = Number.isInteger(previous) ? previous : null;
      }
    } catch (error) {
      if (!(error instanceof PdfError)) {
        throw error;
      }
      if (!trailers.length) {
        await this.rebuildFromScan();
        return;
      }
    }

    for (const trailer of trailers) {
      for (const [key, value] of trailer.entries) {
        if (!this.trailer.has(key) && !NOT_TRAILER_KEYS.includes(key)) {
          this.trailer.set(key, value);
        }
      }
    }

    if (this.trailer.get('Root') === null) {
      await this.rebuildFromScan();
    }
  }

  async readSection(offset) {
    const parser = new Parser(this.text, offset);
    if (parser.startsWith('xref')) {
      return [this.readTable(parser.position + 4), false];
    }

    const [, , stream] = this.parser().indirectObject(offset);
    if (!(stream instanceof Stream) || !stream.dictionary.isName('Type', 'XRef')) {
      throw new PdfError(`There is no cross-reference section at offset ${offset}.`);
    }
    await this.readStreamEntries(stream);
    return [stream.dictionary, true];
  }

  readTable(offset) {
    const parser = new Parser(this.text, offset);
    const subsectionPattern = /\s*(\d+)\s+(\d+)/y;
    const entryPattern = /\s*(\d{1,10})\s+(\d{1,5})\s+([nf])/y;

    while (!parser.startsWith('trailer')) {
      subsectionPattern.lastIndex = parser.position;
      const subsection = subsectionPattern.exec(this.text);
      if (!subsection) {
        throw new PdfError('A cross-reference table is damaged.');
      }
      let at = subsectionPattern.lastIndex;
      const first = Number(subsection[1]);

      for (let i = 0, count = Number(subsection[2]); i < count; i++) {
        entryPattern.lastIndex = at;
        const entry = entryPattern.exec(this.text);
        if (!entry) {
          throw new PdfError('A cross-reference table entry is damaged.');
        }
        at = entryPattern.lastIndex;
        if (!this.xref.has(first + i)) {
          this.xref.set(first + i, entry[3] === 'n' ? [1, Number(entry[1]), Number(entry[2])] : [0, 0, 0]);
        }
      }
      parser.position = at;
    }

    parser.position += 7;
    const trailer = parser.value();
    if (!(trailer instanceof Dictionary)) {
      throw new PdfError('A trailer is damaged.');
    }
    return trailer;
  }

  async readStreamEntries(stream) {
    const data = await decode(stream, (value) => this.resolve(value));
    const widths = ((await this.resolve(stream.dictionary.get('W'))) ?? []).map(Number);
    const index = (await this.resolve(stream.dictionary.get('Index'))) ?? [0, Number(await this.resolve(stream.dictionary.get('Size')))];
    const entryLength = widths.reduce((sum, width) => sum + width, 0);

    if (widths.length !== 3 || entryLength < 1) {
      throw new PdfError('A cross-reference stream is damaged.');
    }

    let at = 0;
    for (let i = 0; i + 1 < index.length; i += 2) {
      for (let n = 0, first = Number(index[i]); n < Number(index[i + 1]) && at + entryLength <= data.length; n++) {
        const fields = widths.map((width) => {
          if (!width) {
            return null;
          }
          let value = 0;
          for (let b = 0; b < width; b++) {
            value = value * 256 + data.charCodeAt(at + b);
          }
          at += width;
          return value;
        });

        if (!this.xref.has(first + n)) {
          // A missing type field means type 1.
          const type = fields[0] ?? 1;
          this.xref.set(first + n, type === 1 ? [1, fields[1], fields[2] ?? 0] : type === 2 ? [2, fields[1], fields[2]] : [0, 0, 0]);
        }
      }
    }
  }

  readAt(offset, number) {
    try {
      const [found, , value] = this.parser().indirectObject(offset);
      if (found === number) {
        return value;
      }
    } catch (error) {
      if (!(error instanceof PdfError)) {
        throw error;
      }
    }
    return this.readScanned(number);
  }

  async readCompressed(streamNumber, index, number) {
    if (!this.objectStreams.has(streamNumber)) {
      const stream = await this.object(streamNumber);
      if (!(stream instanceof Stream)) {
        return null;
      }
      const data = await decode(stream, (value) => this.resolve(value));
      const first = Number(await this.resolve(stream.dictionary.get('First')));
      const count = Number(await this.resolve(stream.dictionary.get('N')));
      const header = new Parser(data);
      const offsets = new Map();
      for (let i = 0; i < count; i++) {
        const objectNumber = Number(header.token());
        offsets.set(objectNumber, first + Number(header.token()));
      }
      this.objectStreams.set(streamNumber, [data, offsets]);
    }

    const [data, offsets] = this.objectStreams.get(streamNumber);
    return offsets.has(number) ? new Parser(data, offsets.get(number), (ref) => this.lengthNow(ref)).value() : null;
  }

  readScanned(number) {
    this.scan();
    if (!this.scanned.has(number)) {
      return null;
    }
    try {
      return this.parser().indirectObject(this.scanned.get(number))[2];
    } catch (error) {
      if (!(error instanceof PdfError)) {
        throw error;
      }
      return null;
    }
  }

  scan() {
    if (this.scanned) {
      return;
    }
    this.scanned = new Map();
    for (const match of this.text.matchAll(/(?<![0-9])(\d+)\s+\d+\s+obj\b/g)) {
      this.scanned.set(Number(match[1]), match.index);
    }
  }

  async rebuildFromScan() {
    this.scan();
    this.xref = new Map();
    for (const [number, offset] of this.scanned) {
      this.xref.set(number, [1, offset, 0]);
    }

    // Objects in object streams are only found by opening the streams.
    for (const number of [...this.scanned.keys()]) {
      const stream = await this.object(number);
      if (stream instanceof Stream && stream.dictionary.isName('Type', 'ObjStm')) {
        const data = await decode(stream, (value) => this.resolve(value));
        const header = new Parser(data);
        for (let i = 0, count = Number(await this.resolve(stream.dictionary.get('N'))); i < count; i++) {
          const objectNumber = Number(header.token());
          header.token();
          if (!this.xref.has(objectNumber)) {
            this.xref.set(objectNumber, [2, number, i]);
          }
        }
      }
      if (stream instanceof Stream && stream.dictionary.isName('Type', 'XRef') && stream.dictionary.get('Root') !== null) {
        this.trailer = stream.dictionary;
      }
    }

    const at = this.text.lastIndexOf('trailer');
    if (at >= 0) {
      try {
        const trailer = new Parser(this.text, at + 7).value();
        if (trailer instanceof Dictionary && trailer.get('Root') !== null) {
          this.trailer = trailer;
        }
      } catch (error) {
        if (!(error instanceof PdfError)) {
          throw error;
        }
      }
    }

    if (this.trailer.get('Root') === null) {
      throw new PdfError('The PDF is too damaged to read: it has no document catalog.');
    }
    this.objects = new Map();
  }

  parser() {
    return new Parser(this.text, 0, (ref) => this.lengthNow(ref));
  }

  /**
   * A stream's indirect /Length, when it can be had without waiting: already read, or a plain number at
   * an offset. Otherwise undefined, and the stream is read up to its `endstream` keyword instead.
   */
  lengthNow(reference) {
    if (this.objects.has(reference.number)) {
      return this.objects.get(reference.number);
    }
    const [type, offset] = this.xref.get(reference.number) ?? [-1, 0];
    if (type !== 1) {
      return undefined;
    }
    try {
      const [, , value] = new Parser(this.text).indirectObject(offset);
      return typeof value === 'number' ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
