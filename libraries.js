// Loads pdf.js, which only displays the pages; signing is done by ./signer.js.
//
// pdf.js comes from cdnjs, and each file is checked against a pinned SHA-384 hash before it runs, so a
// changed file is refused. The PDF itself never leaves the browser.

const VERSION = '6.3.289';
const BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${VERSION}/`;
// Fonts, character maps and decoders pdf.js fetches for some PDFs, which cdnjs does not host.
const ASSETS = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/`;
const INTEGRITY = {
  'pdf.min.mjs': 'sha384-z3N/QnTq7KUG0r5jEmpE9EQ2Yw9XQxeHTtq/XWs9uR7UDmdiZAI2xGZ7t151ou8z',
  'pdf.worker.min.mjs': 'sha384-ZsWbdAW9R0tLHblpnT9OlTG0oDnOBndXJiKFJnsmzR2TXBm7oh5eDqIyTrxseosS',
};

/** Options for pdf.js's getDocument(). Scripting and eval stay off: a PDF only needs to be drawn here. */
export const documentOptions = {
  cMapUrl: `${ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}standard_fonts/`,
  wasmUrl: `${ASSETS}wasm/`,
  iccUrl: `${ASSETS}iccs/`,
  isEvalSupported: false,
  enableXfa: false,
};

let loading = null;

/** pdf.js, loaded once. */
export function loadPdfJs() {
  loading ??= (async () => {
    const pdfjs = await import(await verified('pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = await verified('pdf.worker.min.mjs');
    return pdfjs;
  })().catch((error) => {
    loading = null;
    throw error;
  });

  return loading;
}

/** A local URL for a file whose hash matched, so the checked bytes are what runs. */
async function verified(file) {
  const response = await fetch(BASE + file, { integrity: INTEGRITY[file], credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`Could not load ${file}.`);
  }
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'text/javascript' }));
}
