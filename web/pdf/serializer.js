// Writes PDF values in PDF syntax, as binary strings. A port of src/Pdf/Serializer.php.
import { Dictionary, Name, PdfString, Reference, Stream } from './objects.js';

/** A value in PDF syntax. */
export function serialize(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return number(value);
  if (value instanceof Name) return name(value.value);
  if (value instanceof Reference) return `${value.number} ${value.generation} R`;
  if (value instanceof PdfString) return value.hex ? `<${hex(value.bytes)}>` : literal(value.bytes);
  if (value instanceof Dictionary) return dictionary(value);
  if (value instanceof Stream) return stream(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(' ')}]`;
  throw new TypeError(`A ${typeof value} cannot be written to a PDF.`);
}

/** A number, without an exponent, since PDF has none, and without trailing zeros. */
export function number(value) {
  if (!Number.isFinite(value)) {
    throw new RangeError('PDF numbers must be finite.');
  }
  if (Number.isInteger(value)) {
    return String(value === 0 ? 0 : value);
  }
  const text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' || text === '' ? '0' : text;
}

function name(value) {
  return '/' + value.replace(/[^\x21-\x7E]|[()<>[\]{}/%#]/g, (c) => '#' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function literal(bytes) {
  return '(' + bytes.replace(/[\\()\r]/g, (c) => (c === '\r' ? '\\r' : '\\' + c)) + ')';
}

function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}

function dictionary(value) {
  let out = '<<';
  for (const [key, entry] of value.entries) {
    out += ` ${name(key)} ${serialize(entry)}`;
  }
  return `${out} >>`;
}

function stream(value) {
  const copy = value.dictionary.copy().set('Length', value.data.length);
  return `${dictionary(copy)}\nstream\n${value.data}\nendstream`;
}
