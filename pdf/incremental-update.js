// Revises a document by appending new and changed objects, leaving its original bytes untouched.
// A port of src/Pdf/IncrementalUpdate.php.
import { toBytes } from './binary.js';
import { Dictionary, Name, Reference, Stream } from './objects.js';
import { serialize } from './serializer.js';

export class IncrementalUpdate {
  /** @param {import('./document.js').Document} document */
  constructor(document) {
    this.document = document;
    this.objects = new Map();
    this.next = document.size();
  }

  /** Adds a new object and returns a reference to it. */
  add(value) {
    const reference = new Reference(this.next++);
    this.objects.set(reference.number, [0, value]);
    return reference;
  }

  /** Replaces an existing object with a new revision of it. */
  replace(reference, value) {
    this.objects.set(reference.number, [reference.generation, value]);
  }

  /** The document with the update appended, as bytes. */
  toBytes() {
    const original = this.document.bytes;
    const last = original[original.length - 1];
    let out = last === 0x0a || last === 0x0d ? '' : '\n';
    const base = original.length;
    const offsets = new Map();

    for (const number of [...this.objects.keys()].sort((a, b) => a - b)) {
      const [generation, value] = this.objects.get(number);
      offsets.set(number, [base + out.length, generation]);
      out += `${number} ${generation} obj\n${serialize(value)}\nendobj\n`;
    }

    const trailer = new Dictionary();
    for (const key of ['Root', 'Info', 'ID']) {
      if (this.document.trailer.get(key) !== null) {
        trailer.set(key, this.document.trailer.get(key));
      }
    }
    trailer.set('Prev', this.document.startxref);

    out += this.document.xrefIsStream ? this.streamSection(base, out, offsets, trailer) : this.tableSection(base, out, offsets, trailer);

    const bytes = new Uint8Array(base + out.length);
    bytes.set(original, 0);
    bytes.set(toBytes(out), base);
    return bytes;
  }

  tableSection(base, out, offsets, trailer) {
    const xref = base + out.length;
    let section = 'xref\n';
    for (const [first, count] of runs([...offsets.keys()].sort((a, b) => a - b))) {
      section += `${first} ${count}\n`;
      for (let number = first; number < first + count; number++) {
        const [offset, generation] = offsets.get(number);
        section += `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} n\r\n`;
      }
    }
    const withSize = new Dictionary({ Size: this.next });
    for (const [key, value] of trailer.entries) {
      withSize.set(key, value);
    }
    return `${section}trailer\n${serialize(withSize)}\nstartxref\n${xref}\n%%EOF\n`;
  }

  streamSection(base, out, offsets, trailer) {
    const self = this.next++;
    const xref = base + out.length;
    offsets.set(self, [xref, 0]);
    const offsetWidth = Math.max(1, Math.ceil(xref.toString(16).length / 2));
    const numbers = [...offsets.keys()].sort((a, b) => a - b);
    const index = [];
    let data = '';

    for (const [first, count] of runs(numbers)) {
      index.push(first, count);
      for (let number = first; number < first + count; number++) {
        const [offset, generation] = offsets.get(number);
        data += '\x01';
        for (let byte = offsetWidth - 1; byte >= 0; byte--) {
          data += String.fromCharCode(Math.floor(offset / 2 ** (8 * byte)) & 0xff);
        }
        data += String.fromCharCode((generation >> 8) & 0xff, generation & 0xff);
      }
    }

    const dictionary = new Dictionary({ Type: new Name('XRef'), Size: this.next, W: [1, offsetWidth, 2], Index: index });
    for (const [key, value] of trailer.entries) {
      dictionary.set(key, value);
    }

    return `${self} 0 obj\n${serialize(new Stream(dictionary, data))}\nendobj\nstartxref\n${xref}\n%%EOF\n`;
  }
}

/** Groups sorted object numbers into runs of consecutive numbers: [first, count]. */
function runs(numbers) {
  const out = [];
  for (const number of numbers) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === number) {
      last[1]++;
    } else {
      out.push([number, 1]);
    }
  }
  return out;
}
