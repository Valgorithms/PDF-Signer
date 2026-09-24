// Decodes stream data through the filters it names. A port of src/Pdf/Filters.php; async, because the
// browser's zlib is. Only what reading a document's structure needs is supported.
import { inflate, toBinary } from './binary.js';
import { Dictionary, Name, PdfError } from './objects.js';

/**
 * Decodes a stream's data.
 *
 * @param {import('./objects.js').Stream} stream
 * @param {(value: any) => Promise<any>} resolve Resolves indirect values in the dictionary.
 * @returns {Promise<string>} The decoded binary string.
 */
export async function decode(stream, resolve = async (value) => value) {
  let filters = await resolve(stream.dictionary.get('Filter'));
  let parameters = await resolve(stream.dictionary.get('DecodeParms'));
  filters = filters === null ? [] : Array.isArray(filters) ? filters : [filters];
  parameters = Array.isArray(parameters) ? parameters : [parameters];
  let data = stream.data;

  for (const [index, entry] of filters.entries()) {
    const filter = await resolve(entry);
    const options = await resolve(parameters[index] ?? null);
    if (!(filter instanceof Name)) {
      throw new PdfError('A stream names a filter that is not a name.');
    }

    switch (filter.value) {
      case 'FlateDecode':
      case 'Fl': {
        const inflated = await inflate(data);
        if (inflated === null) {
          throw new PdfError('A compressed stream is damaged.');
        }
        data = predict(inflated, options instanceof Dictionary ? options : null);
        break;
      }
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHex(data);
        break;
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85(data);
        break;
      default:
        throw new PdfError(`Streams encoded with /${filter.value} are not supported.`);
    }
  }

  return data;
}

/** Undoes a PNG (10–15) or TIFF (2) predictor. */
function predict(data, options) {
  const predictor = Number(options?.get('Predictor') ?? 1);
  if (predictor < 2) {
    return data;
  }

  const colors = Number(options.get('Colors') ?? 1);
  const bits = Number(options.get('BitsPerComponent') ?? 8);
  const columns = Number(options.get('Columns') ?? 1);
  const bytesPerPixel = Math.max(1, Math.floor((colors * bits) / 8));
  const rowLength = Math.floor((columns * colors * bits + 7) / 8);
  const input = Uint8Array.from(data, (c) => c.charCodeAt(0));

  if (predictor === 2) {
    if (bits !== 8) {
      throw new PdfError('The TIFF predictor is only supported for 8-bit components.');
    }
    for (let row = 0; row < input.length; row += rowLength) {
      for (let i = row + bytesPerPixel; i < Math.min(row + rowLength, input.length); i++) {
        input[i] = (input[i] + input[i - bytesPerPixel]) & 0xff;
      }
    }
    return toBinary(input);
  }

  const rows = Math.floor(input.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);

  for (let r = 0; r < rows; r++) {
    const type = input[r * (rowLength + 1)];
    for (let i = 0; i < rowLength; i++) {
      const raw = input[r * (rowLength + 1) + 1 + i];
      const at = r * rowLength + i;
      const left = i >= bytesPerPixel ? out[at - bytesPerPixel] : 0;
      const up = r > 0 ? out[at - rowLength] : 0;
      const upLeft = r > 0 && i >= bytesPerPixel ? out[at - rowLength - bytesPerPixel] : 0;
      let add;
      switch (type) {
        case 0: add = 0; break;
        case 1: add = left; break;
        case 2: add = up; break;
        case 3: add = Math.floor((left + up) / 2); break;
        case 4: add = paeth(left, up, upLeft); break;
        default: throw new PdfError(`A stream uses unknown PNG filter ${type}.`);
      }
      out[at] = (raw + add) & 0xff;
    }
  }

  return toBinary(out);
}

/** The PNG Paeth predictor: whichever neighbour is closest to left + up − up-left. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
}

function asciiHex(data) {
  const end = data.indexOf('>');
  let hex = (end < 0 ? data : data.slice(0, end)).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2) {
    hex += '0';
  }
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

function ascii85(data) {
  const end = data.indexOf('~>');
  const text = (end < 0 ? data : data.slice(0, end)).replace(/\s+/g, '');
  let out = '';
  let group = [];
  const word = (digits, bytes) => {
    let value = 0;
    for (const digit of digits) {
      value = value * 85 + digit;
    }
    value >>>= 0;
    return String.fromCharCode(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff).slice(0, bytes);
  };

  for (const c of text) {
    if (c === 'z' && group.length === 0) {
      out += '\0\0\0\0';
      continue;
    }
    group.push(c.charCodeAt(0) - 33);
    if (group.length === 5) {
      out += word(group, 4);
      group = [];
    }
  }

  if (group.length) {
    const count = group.length;
    while (group.length < 5) {
      group.push(84);
    }
    out += word(group, count - 1);
  }

  return out;
}
