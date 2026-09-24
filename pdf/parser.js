// Reads PDF objects from a binary string, following ISO 32000-1 section 7.3. A port of src/Pdf/Parser.php.
import { Dictionary, Name, PdfError, PdfString, Reference, Stream } from './objects.js';

const WHITESPACE = '\0\t\n\f\r ';
const DELIMITERS = '()<>[]{}/%';
const isRegular = (c) => c !== undefined && !WHITESPACE.includes(c) && !DELIMITERS.includes(c);

export class Parser {
  /**
   * @param {string} bytes The binary string to read.
   * @param {number} position Where to start.
   * @param {?(ref: Reference) => (number|null|undefined)} resolveLength Resolves a stream's indirect /Length, when it can.
   */
  constructor(bytes, position = 0, resolveLength = null) {
    this.bytes = bytes;
    this.position = position;
    this.resolveLength = resolveLength;
  }

  skipWhitespace() {
    const s = this.bytes;
    while (this.position < s.length) {
      while (this.position < s.length && WHITESPACE.includes(s[this.position])) {
        this.position++;
      }
      if (s[this.position] !== '%') {
        return;
      }
      while (this.position < s.length && s[this.position] !== '\r' && s[this.position] !== '\n') {
        this.position++;
      }
    }
  }

  /** Whether the next token, after any whitespace, starts with a keyword. */
  startsWith(keyword) {
    this.skipWhitespace();
    return this.bytes.startsWith(keyword, this.position);
  }

  /** The next run of regular characters: a number, keyword or operator. */
  token() {
    this.skipWhitespace();
    const start = this.position;
    while (isRegular(this.bytes[this.position])) {
      this.position++;
    }
    return this.bytes.slice(start, this.position);
  }

  /** The next value. */
  value() {
    this.skipWhitespace();
    const s = this.bytes;
    if (this.position >= s.length) {
      throw new PdfError('The PDF ends in the middle of an object.');
    }

    switch (s[this.position]) {
      case '/': return this.name();
      case '(': return this.literalString();
      case '[': return this.array();
      case '<': return s[this.position + 1] === '<' ? this.dictionary() : this.hexString();
    }

    const start = this.position;
    const token = this.token();

    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^[+-]?\d+$/.test(token)) return this.integerOrReference(Number(token));
    if (/^[+-]?(\d+\.\d*|\.\d+)$/.test(token)) return Number(token);

    throw new PdfError(`Unexpected '${token || s[start]}' at offset ${start}.`);
  }

  /** An indirect object, `12 0 obj … endobj`, with its stream if it has one: [number, generation, value]. */
  indirectObject(offset) {
    this.position = offset;
    const number = this.token();
    const generation = this.token();

    if (!/^\d+$/.test(number) || !/^\d+$/.test(generation) || this.token() !== 'obj') {
      throw new PdfError(`There is no object at offset ${offset}.`);
    }

    let value = this.value();
    if (value instanceof Dictionary && this.startsWith('stream')) {
      value = this.stream(value);
    }

    return [Number(number), Number(generation), value];
  }

  name() {
    this.position++;
    const start = this.position;
    while (isRegular(this.bytes[this.position])) {
      this.position++;
    }
    const raw = this.bytes.slice(start, this.position);
    return new Name(raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  }

  literalString() {
    const s = this.bytes;
    this.position++;
    let depth = 1;
    let out = '';

    while (this.position < s.length) {
      const c = s[this.position++];
      if (c === '\\') {
        out += this.escape();
      } else if (c === '(') {
        depth++;
        out += c;
      } else if (c === ')') {
        if (--depth === 0) {
          return new PdfString(out);
        }
        out += c;
      } else if (c === '\r') {
        if (s[this.position] === '\n') {
          this.position++;
        }
        out += '\n';
      } else {
        out += c;
      }
    }

    throw new PdfError('A string runs to the end of the PDF.');
  }

  escape() {
    const s = this.bytes;
    const c = s[this.position++] ?? '';
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    if (c in simple) {
      return simple[c];
    }
    if (c === '\r') {
      // A backslash at the end of a line continues the string on the next.
      if (s[this.position] === '\n') {
        this.position++;
      }
      return '';
    }
    if (c === '\n') {
      return '';
    }
    if (c >= '0' && c <= '7') {
      let octal = c;
      while (octal.length < 3 && s[this.position] >= '0' && s[this.position] <= '7') {
        octal += s[this.position++];
      }
      return String.fromCharCode(parseInt(octal, 8) & 0xff);
    }
    // Any other escaped character, including ( ) and \, stands for itself.
    return c;
  }

  hexString() {
    const end = this.bytes.indexOf('>', this.position);
    if (end < 0) {
      throw new PdfError('A hex string runs to the end of the PDF.');
    }
    let hex = this.bytes.slice(this.position + 1, end).replace(/[^0-9A-Fa-f]/g, '');
    this.position = end + 1;
    if (hex.length % 2) {
      hex += '0';
    }
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return new PdfString(out, true);
  }

  array() {
    this.position++;
    const items = [];
    for (;;) {
      this.skipWhitespace();
      if (this.bytes[this.position] === ']') {
        this.position++;
        return items;
      }
      items.push(this.value());
    }
  }

  dictionary() {
    this.position += 2;
    const dictionary = new Dictionary();
    for (;;) {
      this.skipWhitespace();
      if (this.bytes.startsWith('>>', this.position)) {
        this.position += 2;
        return dictionary;
      }
      if (this.bytes[this.position] !== '/') {
        throw new PdfError(`A dictionary key at offset ${this.position} is not a name.`);
      }
      const key = this.name().value;
      dictionary.set(key, this.value());
    }
  }

  integerOrReference(integer) {
    const after = this.position;
    if (integer >= 0) {
      const generation = this.token();
      this.skipWhitespace();
      // R must end its token: `12 0 RG` is two numbers and an operator, not a reference.
      if (/^\d+$/.test(generation) && this.bytes[this.position] === 'R' && !isRegular(this.bytes[this.position + 1])) {
        this.position++;
        return new Reference(integer, Number(generation));
      }
    }
    this.position = after;
    return integer;
  }

  stream(dictionary) {
    const s = this.bytes;
    this.position += 6;
    // The keyword is followed by CRLF or LF; a lone CR is not allowed, but is tolerated.
    if (s.startsWith('\r\n', this.position)) {
      this.position += 2;
    } else if (s[this.position] === '\n' || s[this.position] === '\r') {
      this.position++;
    }

    const start = this.position;
    let length = dictionary.get('Length');
    if (length instanceof Reference) {
      length = this.resolveLength?.(length);
    }

    let data;
    if (Number.isInteger(length) && length >= 0 && this.endstreamAt(start + length)) {
      this.position = start + length;
      data = s.slice(start, start + length);
    } else {
      // A missing or wrong /Length: take everything up to the keyword, less the line ending before it.
      const end = s.indexOf('endstream', start);
      if (end < 0) {
        throw new PdfError(`A stream at offset ${start} has no end.`);
      }
      this.position = end;
      data = s.slice(start, end).replace(/(\r\n|\n|\r)$/, '');
    }

    this.position = s.indexOf('endstream', this.position) + 9;
    return new Stream(dictionary, data);
  }

  endstreamAt(offset) {
    if (offset > this.bytes.length) {
      return false;
    }
    let at = offset;
    while (at < offset + 4 && '\r\n \t'.includes(this.bytes[at] ?? 'x')) {
      at++;
    }
    return this.bytes.startsWith('endstream', at);
  }
}
