// The PDF Signer page: open a PDF, make signatures, place them, and download a signed copy.
import { clampRect, initialSize, placementMatrix, scaleRect, signedFileName } from './geometry.js';
import { documentOptions, loadPdfJs } from './libraries.js';
import { EncryptedPdfError, PdfError } from './pdf/objects.js';
import { capture, SignaturePad } from './signature-pad.js';
import { STYLES, dataUrl, imageCanvas, signatureFromCanvas, typedCanvas } from './signatures.js';
import { signatureFromPixels, Signer } from './signer.js';

const STORAGE_KEY = 'pdf-signer.signatures';
const $ = (id) => document.getElementById(id);
// On a touch screen, people tap rather than click.
const tap = matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';

const state = {
  name: '',
  bytes: null,
  pdf: null,
  pages: [],
  signatures: [],
  items: [],
  armed: null,
  nextId: 1,
};

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      render(state.pages.find((page) => page.element === entry.target));
    }
  }
}, { rootMargin: '800px 0px' });

// ---- Status

let quiet = 0;

/** Shows a message; routine ones fade after a few seconds, while warnings and errors stay until the next. */
function say(message, kind = 'info') {
  const status = $('status');
  status.textContent = message;
  status.className = `status ${kind === 'info' ? '' : kind}`;
  clearTimeout(quiet);
  if (kind === 'info') {
    quiet = setTimeout(() => {
      status.textContent = '';
    }, 8000);
  }
}

// ---- Opening a PDF

async function openPdf(file) {
  if (!file) {
    return;
  }
  say(`Opening ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let signer;
  try {
    signer = await Signer.fromBytes(bytes);
  } catch (error) {
    say(error instanceof EncryptedPdfError || error instanceof PdfError ? error.message : `${file.name} could not be read as a PDF.`, 'error');
    return;
  }

  let pdf;
  try {
    const pdfjs = await loadPdfJs();
    pdf = await pdfjs.getDocument({ data: bytes.slice(), ...documentOptions }).promise;
  } catch (error) {
    say(error?.name === 'PasswordException'
      ? 'This PDF needs a password to open, so it cannot be signed here.'
      : 'The page viewer could not be loaded. Check your connection and try again.', 'error');
    return;
  }

  state.pdf?.destroy();
  Object.assign(state, { name: file.name, bytes, pdf, items: [] });
  await buildPages(pdf);

  $('app').dataset.state = 'ready';
  $('document-name').textContent = file.name;
  $('document-details').textContent = `${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'}`;
  updateDownload();

  if (signer.hasDigitalSignatures()) {
    say('This PDF is already digitally signed. Adding a signature keeps that signature, but viewers will report the document changed after it was signed.', 'warning');
  } else {
    say(state.signatures.length ? `Choose a signature, then ${tap.toLowerCase()} where it goes.` : 'Make a signature to place on the document.');
  }
}

async function buildPages(pdf) {
  observer.disconnect();
  const container = $('pages');
  container.replaceChildren();
  state.pages = [];

  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const element = document.createElement('div');
    element.className = 'page';
    element.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    element.tabIndex = 0;
    element.setAttribute('aria-label', `Page ${number}`);

    const canvas = document.createElement('canvas');
    const layer = document.createElement('div');
    layer.className = 'layer';
    const label = document.createElement('span');
    label.className = 'page-label';
    label.textContent = `Page ${number}`;
    element.append(canvas, layer, label);
    container.append(element);

    const entry = { number, page, viewport, element, layer, canvas, rendered: false };
    state.pages.push(entry);
    observer.observe(element);

    layer.addEventListener('click', (event) => {
      if (state.armed && event.target === layer) {
        const rect = layer.getBoundingClientRect();
        place(entry, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
      }
    });
    element.addEventListener('keydown', (event) => {
      if (state.armed && event.target === element && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        place(entry, 0.5, 0.5);
      }
    });
  }
}

async function render(entry) {
  if (!entry || entry.rendered) {
    return;
  }
  entry.rendered = true;

  // Sharp on the screen, but no bigger than a canvas can safely be.
  const ratio = window.devicePixelRatio || 1;
  let scale = (entry.element.clientWidth * ratio) / entry.viewport.width;
  scale = Math.min(scale, Math.sqrt(16_000_000 / (entry.viewport.width * entry.viewport.height)));
  const viewport = entry.page.getViewport({ scale });
  entry.canvas.width = Math.floor(viewport.width);
  entry.canvas.height = Math.floor(viewport.height);

  try {
    await entry.page.render({ canvas: entry.canvas, canvasContext: entry.canvas.getContext('2d'), viewport }).promise;
  } catch {
    entry.rendered = false;
  }
}

// ---- Placing signatures

function place(entry, centerX, centerY) {
  const signature = state.signatures.find((s) => s.id === state.armed);
  if (!signature) {
    return;
  }
  const size = initialSize(signature.width / signature.height, entry.viewport.width, entry.viewport.height);
  const item = {
    id: state.nextId++,
    signatureId: signature.id,
    page: entry.number,
    ...clampRect({ x: centerX - size.width / 2, y: centerY - size.height / 2, ...size }),
  };
  state.items.push(item);
  drawItem(item);
  arm(null);
  updateDownload();
  say(`Placed on page ${entry.number}. Drag it to move it, drag its corner to resize it, or use × to remove it.`);
}

function drawItem(item) {
  const entry = state.pages[item.page - 1];
  const signature = state.signatures.find((s) => s.id === item.signatureId);
  const element = document.createElement('div');
  element.className = 'item';
  element.tabIndex = 0;
  element.dataset.id = item.id;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', `${signature.label} on page ${item.page}. Arrow keys move it, plus and minus resize it, Delete removes it.`);

  const image = document.createElement('img');
  image.src = signature.url;
  image.alt = '';
  image.draggable = false;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove this signature');
  remove.addEventListener('click', () => removeItem(item));

  const resize = document.createElement('span');
  resize.className = 'resize';
  resize.setAttribute('aria-hidden', 'true');

  element.append(image, remove, resize);
  entry.layer.append(element);
  position(element, item);

  element.addEventListener('pointerdown', (event) => startDrag(event, item, element, entry, event.target === resize));
  element.addEventListener('keydown', (event) => nudge(event, item, element, entry));
  element.addEventListener('focus', () => element.classList.add('selected'));
  element.addEventListener('blur', () => element.classList.remove('selected'));
}

function position(element, item) {
  element.style.left = `${item.x * 100}%`;
  element.style.top = `${item.y * 100}%`;
  element.style.width = `${item.width * 100}%`;
  element.style.height = `${item.height * 100}%`;
}

function startDrag(event, item, element, entry, resizing) {
  if (event.target.closest('.remove') || (event.pointerType === 'mouse' && event.button !== 0)) {
    return;
  }
  event.preventDefault();
  element.focus();
  capture(element, event.pointerId);

  const bounds = entry.layer.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY, item: { ...item } };
  const signature = state.signatures.find((s) => s.id === item.signatureId);
  // Width over height of the signature in page fractions, which differs from its pixel ratio on a non-square page.
  const aspect = (signature.width / signature.height) * (bounds.height / bounds.width);

  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.x) / bounds.width;
    const dy = (moveEvent.clientY - start.y) / bounds.height;
    let next;
    if (resizing) {
      const width = Math.max(24 / bounds.width, start.item.width + dx);
      next = clampRect({ x: start.item.x, y: start.item.y, width, height: width / aspect });
      if (next.width !== width) {
        next.height = next.width / aspect;
      }
    } else {
      next = clampRect({ ...start.item, x: start.item.x + dx, y: start.item.y + dy });
    }
    Object.assign(item, next);
    position(element, item);
  };
  const stop = () => {
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', stop);
    element.removeEventListener('pointercancel', stop);
  };
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', stop);
  element.addEventListener('pointercancel', stop);
}

function nudge(event, item, element, entry) {
  const step = event.shiftKey ? 0.05 : 0.005;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    removeItem(item);
    entry.element.focus();
    return;
  }
  if (event.key === '+' || event.key === '=' || event.key === '-') {
    event.preventDefault();
    const factor = event.key === '-' ? 0.9 : 1.1;
    Object.assign(item, clampRect({ ...item, width: item.width * factor, height: item.height * factor }));
    position(element, item);
    return;
  }
  if (moves[event.key]) {
    event.preventDefault();
    const [dx, dy] = moves[event.key];
    Object.assign(item, clampRect({ ...item, x: item.x + dx, y: item.y + dy }));
    position(element, item);
  }
}

function removeItem(item) {
  state.items = state.items.filter((other) => other !== item);
  state.pages[item.page - 1].layer.querySelector(`[data-id="${item.id}"]`)?.remove();
  updateDownload();
}

function updateDownload() {
  $('download').disabled = !state.bytes || state.items.length === 0;
}

// ---- The signature library

async function addSignature(made, label, { persist = true, choose = true } = {}) {
  if (!made) {
    say('There is nothing to add yet.', 'error');
    return;
  }
  const signature = { id: `s${state.nextId++}`, label, ...made, url: URL.createObjectURL(made.blob), image: null };
  state.signatures.push(signature);
  drawSignatures();
  if (persist) {
    await remember();
  }
  if (choose) {
    arm(signature.id);
  }
}

function drawSignatures() {
  const list = $('signatures');
  list.replaceChildren(...state.signatures.map((signature) => {
    const item = document.createElement('li');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'pick';
    pick.setAttribute('aria-pressed', String(state.armed === signature.id));
    pick.setAttribute('aria-label', `Place ${signature.label}`);
    const image = document.createElement('img');
    image.src = signature.url;
    image.alt = '';
    pick.append(image);
    pick.addEventListener('click', () => arm(state.armed === signature.id ? null : signature.id));

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'forget';
    forget.textContent = '×';
    forget.setAttribute('aria-label', `Delete ${signature.label}`);
    forget.addEventListener('click', () => forgetSignature(signature));

    item.append(pick, forget);
    return item;
  }));
}

function arm(id) {
  state.armed = id;
  $('pages').classList.toggle('placing', id !== null);
  for (const pick of document.querySelectorAll('.pick')) {
    pick.setAttribute('aria-pressed', 'false');
  }
  const index = state.signatures.findIndex((s) => s.id === id);
  document.querySelectorAll('.pick')[index]?.setAttribute('aria-pressed', 'true');
  $('hint').textContent = id === null
    ? `Choose a signature, then ${tap.toLowerCase()} where it goes.`
    : state.bytes ? `${tap} the page where it goes, or press Enter on a page to place it in the middle. Esc cancels.` : 'Now open a PDF to place it on.';
}

async function forgetSignature(signature) {
  for (const item of state.items.filter((i) => i.signatureId === signature.id)) {
    removeItem(item);
  }
  state.signatures = state.signatures.filter((s) => s !== signature);
  URL.revokeObjectURL(signature.url);
  if (state.armed === signature.id) {
    arm(null);
  }
  drawSignatures();
  await remember();
}

// Signatures are only kept in this browser, and only when asked; storage may be unavailable.
async function remember() {
  try {
    if (!$('remember').checked) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const saved = [];
    for (const signature of state.signatures) {
      saved.push({ label: signature.label, png: await dataUrl(signature.blob) });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    say('Your signatures could not be remembered in this browser.', 'warning');
  }
}

async function recall() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return;
  }
  if (!Array.isArray(saved)) {
    return;
  }
  $('remember').checked = true;
  for (const { label, png } of saved) {
    try {
      const canvas = await imageCanvas(await (await fetch(png)).blob(), false);
      await addSignature(await signatureFromCanvas(canvas), label, { persist: false, choose: false });
    } catch {
      // A damaged entry is skipped.
    }
  }
}

// ---- Dialogs

function setUpDialogs() {
  for (const button of document.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => $(button.dataset.open).showModal());
  }

  // Drawing
  const pad = new SignaturePad($('pad'));
  $('draw-dialog').addEventListener('close', () => pad.clear());
  for (const ink of document.querySelectorAll('[name="draw-ink"]')) {
    ink.addEventListener('change', () => pad.setColor(ink.value));
  }
  $('pad-undo').addEventListener('click', () => pad.undo());
  $('pad-clear').addEventListener('click', () => pad.clear());
  $('draw-add').addEventListener('click', async () => {
    const canvas = pad.toCanvas();
    if (!canvas) {
      say('Draw your signature on the pad first.', 'error');
      return;
    }
    await addSignature(await signatureFromCanvas(canvas), 'drawn signature');
    $('draw-dialog').close();
  });

  // Typing
  const style = $('typed-style');
  style.replaceChildren(...Object.entries(STYLES).map(([value, { label }]) => new Option(label, value)));
  const preview = () => {
    const text = $('typed-text').value.trim();
    const target = $('typed-preview');
    const source = typedCanvas(text || 'Your name', style.value, $('typed-ink').value);
    target.width = source.width;
    target.height = source.height;
    target.getContext('2d').drawImage(source, 0, 0);
  };
  for (const id of ['typed-text', 'typed-style', 'typed-ink']) {
    $(id).addEventListener('input', preview);
  }
  document.querySelector('[data-open="type-dialog"]').addEventListener('click', preview);
  // Enter adds the signature, rather than submitting the form through its first button, Cancel.
  $('typed-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('type-add').click();
    }
  });
  $('typed-date').addEventListener('click', () => {
    $('typed-text').value = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date());
    style.value = 'print';
    preview();
  });
  $('type-add').addEventListener('click', async () => {
    const text = $('typed-text').value.trim();
    if (!text) {
      say('Type something first.', 'error');
      return;
    }
    await addSignature(await signatureFromCanvas(typedCanvas(text, style.value, $('typed-ink').value)), `“${text}”`);
    $('type-dialog').close();
  });

  // Uploading
  let uploaded = null;
  const showUpload = async () => {
    const file = $('image-file').files[0];
    uploaded = null;
    if (!file) {
      return;
    }
    try {
      uploaded = await imageCanvas(file, $('image-white').checked);
      const target = $('image-preview');
      target.width = uploaded.width;
      target.height = uploaded.height;
      target.getContext('2d').drawImage(uploaded, 0, 0);
    } catch (error) {
      say(error.message, 'error');
    }
  };
  $('image-file').addEventListener('change', showUpload);
  $('image-white').addEventListener('change', showUpload);
  $('image-add').addEventListener('click', async () => {
    if (!uploaded) {
      say('Choose an image first.', 'error');
      return;
    }
    await addSignature(await signatureFromCanvas(uploaded), 'uploaded signature');
    $('image-dialog').close();
  });
}

// ---- Downloading

async function download() {
  if (!state.items.length) {
    return;
  }
  say('Adding your signatures…');
  $('download').disabled = true;

  try {
    const signer = await Signer.fromBytes(state.bytes);
    for (const item of state.items) {
      const signature = state.signatures.find((s) => s.id === item.signatureId);
      signature.image ??= await signatureFromPixels(signature.width, signature.height, signature.rgba);
      const { viewport } = state.pages[item.page - 1];
      // pdf.js's own conversion, so the signature lands exactly where it was shown.
      const matrix = placementMatrix((x, y) => viewport.convertToPdfPoint(x, y), scaleRect(item, viewport.width, viewport.height));
      signer.stampWithMatrix(signature.image, item.page, matrix);
    }

    const url = URL.createObjectURL(new Blob([await signer.toBytes()], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = signedFileName(state.name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    say(`${link.download} is ready. The original is kept intact inside it.`);
  } catch (error) {
    say(error instanceof PdfError ? error.message : 'The signed PDF could not be made.', 'error');
  } finally {
    updateDownload();
  }
}

// ---- Start

function setUp() {
  const drop = $('drop');
  $('pdf-file').addEventListener('change', (event) => openPdf(event.target.files[0]));
  $('another-file').addEventListener('change', (event) => openPdf(event.target.files[0]));
  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    document.addEventListener(type, () => drop.classList.remove('over'));
  }
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = [...event.dataTransfer.files].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    openPdf(file);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.armed && !document.querySelector('dialog[open]')) {
      arm(null);
    }
  });

  $('download').addEventListener('click', download);
  $('remember').addEventListener('change', remember);
  setUpDialogs();
  recall();
}

setUp();
