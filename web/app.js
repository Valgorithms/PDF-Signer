// The PDF Signer page: open a PDF, make signatures, place them, and download a signed copy.
import { clampRect, initialSize, placementMatrix, scaleRect, signedFileName } from './geometry.js';
import { documentOptions, loadPdfJs } from './libraries.js';
import { EncryptedPdfError, PdfError } from './pdf/objects.js';
import { Mark, rgb, SHAPES, strokeWidth } from './marks.js';
import { capture, constrainEnd, SignaturePad } from './signature-pad.js';
import { STYLES, dataUrl, imageCanvas, resolveStyle, signatureFromCanvas, typedCanvas } from './signatures.js';
import { signatureFromPixels, Signer } from './signer.js';

const STORAGE_KEY = 'pdf-signer.signatures';
const SVG = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const clamp = (fraction) => Math.min(Math.max(fraction, 0), 1);

/**
 * The marks that go straight onto a page: what each is called, and its size in points when it is placed with
 * a tap. `drawn` ones are drawn by dragging instead; a tap still places one at this size.
 */
const MARKS = {
  tick: { label: 'Tick', size: [14, 14] },
  cross: { label: 'Cross', size: [14, 14] },
  dot: { label: 'Dot', size: [7, 7] },
  line: { label: 'Line', size: [120, 0], drawn: true },
  rectangle: { label: 'Rectangle', size: [100, 40], drawn: true },
  ellipse: { label: 'Ellipse', size: [100, 40], drawn: true },
};

/** How far beyond its box a mark is drawn on screen, in CSS pixels, so the width of its lines fits. */
const BLEED = 12;
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

// Marks are drawn in pixels, so they are drawn again when their page changes size.
const resized = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const page = state.pages.find((entry) => entry.element === target);
    for (const item of state.items.filter((i) => i.kind === 'mark' && i.page === page?.number)) {
      const element = page.layer.querySelector(`[data-id="${item.id}"]`);
      if (element) {
        drawMark(element, item);
      }
    }
  }
});

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
  resized.disconnect();
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
    resized.observe(element);

    layer.addEventListener('click', (event) => {
      // Lines and shapes are placed by the drag that draws them.
      if (state.armed && event.target === layer && !MARKS[armedMark()]?.drawn) {
        const rect = layer.getBoundingClientRect();
        place(entry, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
      }
    });
    layer.addEventListener('pointerdown', (event) => {
      const shape = armedMark();
      if (MARKS[shape]?.drawn && event.target === layer) {
        startDrawing(event, entry, shape);
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

// ---- Placing signatures and marks
//
// A placed item is a signature or a mark, with its page and where it sits on it, in fractions of the page:
// a box (x, y, width, height), except for a line, which keeps its two ends (x1, y1 and x2, y2).

/** The mark being placed, or null. */
function armedMark() {
  return state.armed?.startsWith('mark:') ? state.armed.slice(5) : null;
}

/** An item's box, in fractions of the page. A line's is the box its two ends span. */
function boxOf(item) {
  if (item.x1 === undefined) {
    return item;
  }
  return { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2), width: Math.abs(item.x2 - item.x1), height: Math.abs(item.y2 - item.y1) };
}

/** The shape a mark is drawn as; a line rises or falls across its box. */
function markShape(item) {
  if (item.shape !== 'line') {
    return item.shape;
  }
  return (item.x2 - item.x1) * (item.y2 - item.y1) < 0 ? 'line-up' : 'line-down';
}

function itemLabel(item) {
  return item.kind === 'mark' ? MARKS[item.shape].label : state.signatures.find((s) => s.id === item.signatureId).label;
}

/** A line moved by dx, dy, but no further than keeps both of its ends on the page. */
function moveLine(line, dx, dy) {
  const box = boxOf(line);
  const inside = clampRect({ ...box, x: box.x + dx, y: box.y + dy });
  const [shiftX, shiftY] = [inside.x - box.x, inside.y - box.y];
  return { x1: line.x1 + shiftX, y1: line.y1 + shiftY, x2: line.x2 + shiftX, y2: line.y2 + shiftY };
}

function place(entry, centerX, centerY) {
  const shape = armedMark();
  if (shape) {
    placeMark(entry, shape, centerX, centerY);
    return;
  }

  const signature = state.signatures.find((s) => s.id === state.armed);
  if (!signature) {
    return;
  }
  const size = initialSize(signature.width / signature.height, entry.viewport.width, entry.viewport.height);
  addItem({
    id: state.nextId++,
    kind: 'signature',
    signatureId: signature.id,
    page: entry.number,
    ...clampRect({ x: centerX - size.width / 2, y: centerY - size.height / 2, ...size }),
  });
  arm(null);
  say(`Placed on page ${entry.number}. Drag it to move it, drag its corner to resize it, or use × to remove it.`);
}

/** Places a mark at its usual size. It stays chosen, so a form's boxes can be ticked one after another. */
function placeMark(entry, shape, centerX, centerY) {
  const [width, height] = [MARKS[shape].size[0] / entry.viewport.width, MARKS[shape].size[1] / entry.viewport.height];
  const item = { id: state.nextId++, kind: 'mark', shape, color: $('mark-ink').value, page: entry.number };
  if (shape === 'line') {
    Object.assign(item, moveLine({ x1: centerX - width / 2, y1: centerY, x2: centerX + width / 2, y2: centerY }, 0, 0));
  } else {
    Object.assign(item, clampRect({ x: centerX - width / 2, y: centerY - height / 2, width, height }));
  }
  addItem(item);
  say(`${MARKS[shape].label} placed on page ${entry.number}. ${tap} again for another, or press Esc when you are done.`);
}

function addItem(item) {
  state.items.push(item);
  drawItem(item);
  updateDownload();
}

/**
 * Draws a line, rectangle or ellipse by dragging across the page. Shift keeps a line to steps of 45° and
 * a shape square or round, as on the signature pad. A tap without a drag places one at its usual size.
 */
function startDrawing(event, entry, shape) {
  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }
  event.preventDefault();
  capture(entry.layer, event.pointerId);

  const bounds = entry.layer.getBoundingClientRect();
  const at = (pointer) => ({ x: (pointer.clientX - bounds.left) / bounds.width, y: (pointer.clientY - bounds.top) / bounds.height });
  const start = at(event);
  let item = null;
  let element = null;

  const move = (moveEvent) => {
    // Kept square or level in pixels, where the page's sides are in proportion, then back to fractions.
    const pixels = (point) => ({ x: point.x * bounds.width, y: point.y * bounds.height });
    const end = constrainEnd(shape, pixels(start), pixels(at(moveEvent)), moveEvent.shiftKey);
    const [x, y] = [clamp(end.x / bounds.width), clamp(end.y / bounds.height)];

    // Until the pointer has really moved, it is still a tap.
    if (!item && Math.abs(x - start.x) * bounds.width < 4 && Math.abs(y - start.y) * bounds.height < 4) {
      return;
    }
    item ??= { id: state.nextId++, kind: 'mark', shape, color: $('mark-ink').value, page: entry.number };
    Object.assign(item, shape === 'line'
      ? { x1: start.x, y1: start.y, x2: x, y2: y }
      : { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });

    if (element) {
      position(element, item);
    } else {
      state.items.push(item);
      element = drawItem(item);
    }
  };
  const stop = (stopEvent) => {
    entry.layer.removeEventListener('pointermove', move);
    entry.layer.removeEventListener('pointerup', stop);
    entry.layer.removeEventListener('pointercancel', stop);
    // The shape ends where the pointer was let go, even if no move event reached that spot.
    if (stopEvent.type === 'pointerup') {
      move(stopEvent);
    }
    if (item) {
      updateDownload();
      say(`${MARKS[shape].label} drawn on page ${entry.number}. Drag it to move it, or its ${shape === 'line' ? 'ends' : 'corner'} to reshape it.`);
    } else if (stopEvent.type === 'pointerup') {
      placeMark(entry, shape, start.x, start.y);
    }
  };
  entry.layer.addEventListener('pointermove', move);
  entry.layer.addEventListener('pointerup', stop);
  entry.layer.addEventListener('pointercancel', stop);
}

function drawItem(item) {
  const entry = state.pages[item.page - 1];
  const element = document.createElement('div');
  element.className = item.kind === 'mark' ? `item mark ${item.shape}` : 'item';
  element.tabIndex = 0;
  element.dataset.id = item.id;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', `${itemLabel(item)} on page ${item.page}. Arrow keys move it, plus and minus resize it, Delete removes it.`);

  let content;
  if (item.kind === 'mark') {
    content = document.createElementNS(SVG, 'svg');
    content.setAttribute('aria-hidden', 'true');
    content.append(document.createElementNS(SVG, 'path'));
  } else {
    content = document.createElement('img');
    content.src = state.signatures.find((s) => s.id === item.signatureId).url;
    content.alt = '';
    content.draggable = false;
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove this ${item.kind === 'mark' ? MARKS[item.shape].label.toLowerCase() : 'signature'}`);
  remove.addEventListener('click', () => removeItem(item));

  // A line is reshaped by either end, anything else by its bottom-right corner.
  const handles = (item.shape === 'line' ? ['1', '2'] : ['resize']).map((handle) => {
    const span = document.createElement('span');
    span.className = handle === 'resize' ? 'resize' : 'end';
    span.dataset.handle = handle;
    span.setAttribute('aria-hidden', 'true');
    return span;
  });

  element.append(content, remove, ...handles);
  entry.layer.append(element);
  position(element, item);

  element.addEventListener('pointerdown', (event) => startDrag(event, item, element, entry, event.target.dataset.handle ?? 'move'));
  element.addEventListener('keydown', (event) => nudge(event, item, element, entry));
  element.addEventListener('focus', () => element.classList.add('selected'));
  element.addEventListener('blur', () => element.classList.remove('selected'));
  return element;
}

function position(element, item) {
  const box = boxOf(item);
  element.style.left = `${box.x * 100}%`;
  element.style.top = `${box.y * 100}%`;
  element.style.width = `${box.width * 100}%`;
  element.style.height = `${box.height * 100}%`;
  if (item.kind === 'mark') {
    drawMark(element, item);
  }
}

/**
 * Draws a mark on screen from the same path the PDF gets, at the page's size as shown, with its lines as
 * thick as they will print.
 */
function drawMark(element, item) {
  const entry = state.pages[item.page - 1];
  const [pageWidth, pageHeight] = [entry.layer.clientWidth, entry.layer.clientHeight];
  const box = boxOf(item);
  const [width, height] = [box.width * pageWidth, box.height * pageHeight];
  const shape = markShape(item);
  const { paint, join, path } = SHAPES[shape];
  const commands = { m: 'M', l: 'L', c: 'C', h: 'Z' };

  const d = path.map(([operator, ...coordinates]) => {
    const points = [];
    for (let i = 0; i < coordinates.length; i += 2) {
      // The path's unit square has y upward; the screen's runs down.
      points.push(BLEED + coordinates[i] * width, BLEED + (1 - coordinates[i + 1]) * height);
    }
    return [commands[operator], ...points].join(' ');
  }).join(' ');

  const svg = element.querySelector('svg');
  svg.setAttribute('width', width + 2 * BLEED);
  svg.setAttribute('height', height + 2 * BLEED);
  svg.setAttribute('viewBox', `0 0 ${width + 2 * BLEED} ${height + 2 * BLEED}`);
  svg.style.left = svg.style.top = `${-BLEED}px`;

  const drawn = svg.firstChild;
  drawn.setAttribute('d', d);
  drawn.setAttribute('fill', paint === 'f' ? item.color : 'none');
  drawn.setAttribute('stroke', paint === 'f' ? 'none' : item.color);
  const points = strokeWidth(shape, box.width * entry.viewport.width, box.height * entry.viewport.height);
  drawn.setAttribute('stroke-width', points * (pageWidth / entry.viewport.width));
  drawn.setAttribute('stroke-linecap', 'round');
  drawn.setAttribute('stroke-linejoin', join ? 'round' : 'miter');

  if (item.shape === 'line') {
    for (const end of element.querySelectorAll('.end')) {
      end.style.left = `${(item[`x${end.dataset.handle}`] - box.x) * pageWidth}px`;
      end.style.top = `${(item[`y${end.dataset.handle}`] - box.y) * pageHeight}px`;
    }
  }
}

/**
 * Where an item goes when one of its parts is dragged by dx, dy, in fractions of the page: the whole of it,
 * its corner, or one end of a line. Shift keeps a dragged end of a line to steps of 45°.
 */
function dragged(item, handle, dx, dy, bounds, keep) {
  if (item.shape === 'line') {
    if (handle === 'move') {
      return moveLine(item, dx, dy);
    }
    const other = handle === '1' ? '2' : '1';
    const pixels = (x, y) => ({ x: x * bounds.width, y: y * bounds.height });
    const end = constrainEnd('line', pixels(item[`x${other}`], item[`y${other}`]), pixels(item[`x${handle}`] + dx, item[`y${handle}`] + dy), keep);
    return { [`x${handle}`]: clamp(end.x / bounds.width), [`y${handle}`]: clamp(end.y / bounds.height) };
  }

  if (handle === 'move') {
    return clampRect({ ...item, x: item.x + dx, y: item.y + dy });
  }

  // Rectangles and ellipses stretch freely; signatures, ticks, crosses and dots keep their proportions.
  if (item.shape === 'rectangle' || item.shape === 'ellipse') {
    return clampRect({ x: item.x, y: item.y, width: Math.max(4 / bounds.width, item.width + dx), height: Math.max(4 / bounds.height, item.height + dy) });
  }
  const signature = state.signatures.find((s) => s.id === item.signatureId);
  // Width over height in page fractions, which differs from the pixel ratio on a non-square page.
  const aspect = signature ? (signature.width / signature.height) * (bounds.height / bounds.width) : item.width / item.height;
  const width = Math.max((signature ? 24 : 8) / bounds.width, item.width + dx);
  const next = clampRect({ x: item.x, y: item.y, width, height: width / aspect });
  if (next.width !== width) {
    next.height = next.width / aspect;
  }
  return next;
}

function startDrag(event, item, element, entry, handle) {
  if (event.target.closest('.remove') || (event.pointerType === 'mouse' && event.button !== 0)) {
    return;
  }
  event.preventDefault();
  element.focus();
  capture(element, event.pointerId);

  const bounds = entry.layer.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY, item: { ...item } };

  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.x) / bounds.width;
    const dy = (moveEvent.clientY - start.y) / bounds.height;
    Object.assign(item, dragged(start.item, handle, dx, dy, bounds, moveEvent.shiftKey));
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
    // A line grows or shrinks from its first end.
    Object.assign(item, item.shape === 'line'
      ? { x2: clamp(item.x1 + (item.x2 - item.x1) * factor), y2: clamp(item.y1 + (item.y2 - item.y1) * factor) }
      : clampRect({ ...item, width: item.width * factor, height: item.height * factor }));
    position(element, item);
    return;
  }
  if (moves[event.key]) {
    event.preventDefault();
    const [dx, dy] = moves[event.key];
    Object.assign(item, item.shape === 'line' ? moveLine(item, dx, dy) : clampRect({ ...item, x: item.x + dx, y: item.y + dy }));
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

/** Chooses what the next tap on a page places: a signature by its id, a mark as `mark:` and its name, or nothing. */
function arm(id) {
  state.armed = id;
  const shape = armedMark();
  $('pages').classList.toggle('placing', id !== null);
  $('pages').classList.toggle('drawing', Boolean(MARKS[shape]?.drawn));
  for (const pick of document.querySelectorAll('.pick')) {
    pick.setAttribute('aria-pressed', 'false');
  }
  const index = state.signatures.findIndex((s) => s.id === id);
  document.querySelectorAll('.pick')[index]?.setAttribute('aria-pressed', 'true');
  for (const button of document.querySelectorAll('[data-mark]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mark === shape));
  }

  $('hint').textContent = id === null || shape
    ? `Choose a signature, then ${tap.toLowerCase()} where it goes.`
    : state.bytes ? `${tap} the page where it goes, or press Enter on a page to place it in the middle. Esc cancels.` : 'Now open a PDF to place it on.';
  $('mark-hint').textContent = markHint(shape);
}

function markHint(shape) {
  if (!shape) {
    return 'Tick or cross a box, or draw a line or shape on the page.';
  }
  const name = MARKS[shape].label.toLowerCase();
  const article = /^[aeiou]/.test(name) ? 'an' : 'a';
  if (MARKS[shape].drawn) {
    // Only a keyboard has a Shift key to hold.
    const shift = tap === 'Click' ? `, holding Shift to keep it ${shape === 'line' ? 'straight' : 'even'}` : '';
    return `Drag on the page to draw ${article} ${name}${shift}. Esc stops.`;
  }
  return `${tap} the page wherever ${article} ${name} goes. Esc stops.`;
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

/** Says why a typed signature is not drawn quite as chosen, or nothing when it is. */
function styleNote(chosen, { style, missing }) {
  if (!missing.length) {
    return '';
  }
  const letters = missing.length > 6 ? `${missing.slice(0, 6).join(' ')} …` : new Intl.ListFormat(undefined, { type: 'disjunction' }).format(missing);
  const lacks = `${STYLES[chosen].label} has no ${letters}`;
  return style === chosen ? `${lacks}, so those letters come from another font.` : `${lacks}, so this is ${STYLES[style].label}.`;
}

function setUpDialogs() {
  for (const button of document.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => $(button.dataset.open).showModal());
  }

  // Drawing
  const pad = new SignaturePad($('pad'));
  const tools = document.querySelectorAll('[name="draw-tool"]');
  for (const tool of tools) {
    tool.addEventListener('change', () => pad.setTool(tool.value));
  }
  // Each signature starts with the pen, so reopening the pad never finds it rubbing out.
  $('draw-dialog').addEventListener('close', () => {
    pad.clear();
    tools[0].checked = true;
    pad.setTool(tools[0].value);
  });
  for (const ink of document.querySelectorAll('[name="draw-ink"]')) {
    ink.addEventListener('change', () => pad.setColor(ink.value));
  }
  $('pad-undo').addEventListener('click', () => pad.undo());
  $('pad-clear').addEventListener('click', () => pad.clear());
  $('draw-add').addEventListener('click', async () => {
    const canvas = pad.toCanvas();
    // Ink that was all rubbed out leaves a canvas with nothing on it.
    const made = canvas && await signatureFromCanvas(canvas);
    if (!made) {
      say('Draw your signature on the pad first.', 'error');
      return;
    }
    await addSignature(made, 'drawn signature');
    $('draw-dialog').close();
  });

  // Typing
  const style = $('typed-style');
  style.replaceChildren(...Object.entries(STYLES).map(([value, { label }]) => new Option(label, value)));
  let previews = 0;
  const preview = async () => {
    const text = $('typed-text').value.trim() || 'Your name';
    const chosen = style.value;
    const turn = ++previews;
    const drawn = await resolveStyle(chosen, text);
    // Typing on while a font loads starts newer previews; only the latest is shown.
    if (turn !== previews) {
      return;
    }
    $('typed-note').textContent = styleNote(chosen, drawn);
    const target = $('typed-preview');
    const source = typedCanvas(text, drawn.style, $('typed-ink').value);
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
    const drawn = await resolveStyle(style.value, text);
    await addSignature(await signatureFromCanvas(typedCanvas(text, drawn.style, $('typed-ink').value)), `“${text}”`);
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
    // In the order they were placed, so what was placed later is drawn on top, as it was shown.
    for (const item of state.items) {
      const { viewport } = state.pages[item.page - 1];
      // pdf.js's own conversion, so everything lands exactly where it was shown.
      const matrix = placementMatrix((x, y) => viewport.convertToPdfPoint(x, y), scaleRect(boxOf(item), viewport.width, viewport.height));
      if (item.kind === 'mark') {
        signer.markWithMatrix(new Mark(markShape(item), rgb(item.color)), item.page, matrix);
        continue;
      }
      const signature = state.signatures.find((s) => s.id === item.signatureId);
      signature.image ??= await signatureFromPixels(signature.width, signature.height, signature.rgba);
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
  for (const button of document.querySelectorAll('[data-mark]')) {
    const id = `mark:${button.dataset.mark}`;
    button.addEventListener('click', () => arm(state.armed === id ? null : id));
  }
  setUpDialogs();
  recall();
}

setUp();
