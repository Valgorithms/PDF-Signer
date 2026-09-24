// Small PDFs for the browser version's tests: the same documents as tests/Fixtures/PdfBuilder.php, with a
// classic cross-reference table or a compressed cross-reference stream and object stream.
import { deflateSync } from 'node:zlib';

const latin1 = (buffer) => buffer.toString('latin1');

export class PdfBuilder {
  constructor() {
    this.objects = new Map();
  }

  /** Two pages: page 1 inherits its box and resources; page 2 is rotated 90°, cropped, and leaves a transform unrestored. */
  static twoPages() {
    return new PdfBuilder()
      .add(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .add(2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] /Resources 5 0 R >>')
      .add(3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>')
      .add(4, '<< /Type /Page /Parent 2 0 R /Rotate 90 /CropBox [36 36 576 756] /Contents [7 0 R] /Resources << /XObject << /PdfSigner1 8 0 R >> >> >>')
      .add(5, '<< /ProcSet [/PDF] >>')
      .stream(6, '0 0 1 rg 72 72 144 144 re f')
      .stream(7, '2 0 0 2 0 0 cm 1 0 0 rg 10 10 20 20 re f')
      .add(8, '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length 0 >>\nstream\n\nendstream');
  }

  add(number, body) {
    this.objects.set(number, body);
    return this;
  }

  stream(number, data) {
    return this.add(number, `<< /Length ${data.length} >>\nstream\n${data}\nendstream`);
  }

  /** The document with a classic cross-reference table, as bytes. */
  classic() {
    const numbers = [...this.objects.keys()].sort((a, b) => a - b);
    let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
    const offsets = new Map();
    for (const number of numbers) {
      offsets.set(number, pdf.length);
      pdf += `${number} 0 obj\n${this.objects.get(number)}\nendobj\n`;
    }
    const size = Math.max(...numbers) + 1;
    const xref = pdf.length;
    pdf += `xref\n0 ${size}\n0000000000 65535 f\r\n`;
    for (let number = 1; number < size; number++) {
      pdf += offsets.has(number) ? `${String(offsets.get(number)).padStart(10, '0')} 00000 n\r\n` : '0000000000 00000 f\r\n';
    }
    pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }

  /** The document with a PNG-predicted cross-reference stream and the non-stream objects in an object stream. */
  compressed() {
    const numbers = [...this.objects.keys()].sort((a, b) => a - b);
    const packed = numbers.filter((n) => !this.objects.get(n).includes('stream'));
    const direct = numbers.filter((n) => this.objects.get(n).includes('stream'));
    const objectStream = Math.max(...numbers) + 1;
    const xrefNumber = objectStream + 1;

    let bodies = '';
    const header = [];
    for (const number of packed) {
      header.push(`${number} ${bodies.length}`);
      bodies += `${this.objects.get(number)}\n`;
    }
    const headerText = `${header.join(' ')}\n`;
    const data = latin1(deflateSync(Buffer.from(headerText + bodies, 'latin1')));
    const bodiesByNumber = new Map(direct.map((n) => [n, this.objects.get(n)]));
    bodiesByNumber.set(objectStream, `<< /Type /ObjStm /N ${packed.length} /First ${headerText.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n${data}\nendstream`);

    let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
    const entries = new Map([[0, [0, 0, 65535]]]);
    for (const number of [...bodiesByNumber.keys()].sort((a, b) => a - b)) {
      entries.set(number, [1, pdf.length, 0]);
      pdf += `${number} 0 obj\n${bodiesByNumber.get(number)}\nendobj\n`;
    }
    packed.forEach((number, index) => entries.set(number, [2, objectStream, index]));
    const xref = pdf.length;
    entries.set(xrefNumber, [1, xref, 0]);

    // Rows of 1 + 4 + 2 bytes, filtered with PNG Up: each byte minus the one above it.
    const raw = [];
    let previous = new Array(7).fill(0);
    for (let number = 0; number <= xrefNumber; number++) {
      const [type, field, generation] = entries.get(number) ?? [0, 0, 0];
      const row = [type, (field >>> 24) & 255, (field >>> 16) & 255, (field >>> 8) & 255, field & 255, (generation >> 8) & 255, generation & 255];
      raw.push(2, ...row.map((byte, i) => (byte - previous[i]) & 255));
      previous = row;
    }
    const stream = latin1(deflateSync(Buffer.from(raw)));
    pdf += `${xrefNumber} 0 obj\n<< /Type /XRef /Size ${xrefNumber + 1} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
    pdf += `startxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }
}

/** A 4 × 2 signature: an opaque black left half and a transparent right half, as RGBA. */
export function signaturePixels() {
  const rgba = new Uint8Array(4 * 2 * 4);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      rgba[(y * 4 + x) * 4 + 3] = 255;
    }
  }
  return rgba;
}
