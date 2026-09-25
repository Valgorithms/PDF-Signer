// Turns a drawn, typed or uploaded signature into a trimmed image with a transparent background.
import { opaqueBounds, whiteToTransparent } from './pixels.js';

/**
 * The styles a typed signature can take. The first three are signature fonts shipped with the page in
 * `fonts/`, so they look the same on every device; `bundled` names the font and its folder there. The
 * rest use handwriting-like fonts the device may have, and a plain one for dates and initials.
 */
export const STYLES = {
  brush: { label: 'Brush signature', font: '"Mr Dafoe", cursive', bundled: { family: 'Mr Dafoe', folder: 'mr-dafoe' } },
  pen: { label: 'Pen signature', font: '"Herr Von Muellerhoff", cursive', bundled: { family: 'Herr Von Muellerhoff', folder: 'herr-von-muellerhoff' } },
  formal: { label: 'Formal script', font: '"Great Vibes", cursive', bundled: { family: 'Great Vibes', folder: 'great-vibes' } },
  script: { label: 'Script, from this device', font: '"Segoe Script", "Snell Roundhand", "Brush Script MT", "Apple Chancery", cursive' },
  handwriting: { label: 'Handwriting, from this device', font: '"Bradley Hand", "Segoe Print", "Ink Free", "Comic Sans MS", cursive' },
  print: { label: 'Print, for dates and initials', font: 'system-ui, "Segoe UI", Helvetica, Arial, sans-serif' },
};

/**
 * Each bundled font comes in two files, split by the characters they cover, as Google Fonts splits them. The
 * browser fetches the second only for a name that needs it, such as one with Ł or ő.
 */
export const SUBSETS = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};

const registered = new Set();

/**
 * Makes sure a style's font is ready to draw `text` with. A canvas does not wait for a font the way a page
 * does: drawing before it has loaded silently uses the fallback. Resolves either way, since the fallback
 * still makes a usable signature when the font cannot be fetched.
 *
 * @param {keyof STYLES} style
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function loadStyle(style, text) {
  const bundled = STYLES[style]?.bundled;
  if (!bundled) {
    return;
  }

  if (!registered.has(bundled.family)) {
    registered.add(bundled.family);
    for (const [subset, unicodeRange] of Object.entries(SUBSETS)) {
      const file = new URL(`fonts/${bundled.folder}/${subset}.woff2`, import.meta.url);
      document.fonts.add(new FontFace(bundled.family, `url("${file}") format("woff2")`, { unicodeRange }));
    }
  }

  try {
    await document.fonts.load(`96px "${bundled.family}"`, text || 'Your name');
  } catch {
    // Drawn in the fallback instead.
  }
}

/**
 * The letters of `text` that a bundled style's font has no shape for, and would borrow from another font.
 * Mr Dafoe and Herr Von Muellerhoff cover Western European letters but not, say, ą, č, ő or ż. Load the
 * style first.
 *
 * @param {keyof STYLES} style
 * @param {string} text
 * @returns {string[]} Empty for a style that is not bundled.
 */
export function missingLetters(style, text) {
  const family = STYLES[style]?.bundled?.family;
  if (!family) {
    return [];
  }

  // A letter the font lacks falls through to the next font in the list, so its width then depends on which
  // font that is. One the font has measures the same either way.
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  const width = (letter, fallback) => {
    probe.font = `40px "${family}", ${fallback}`;
    return probe.measureText(letter).width;
  };
  return [...new Set(text.normalize('NFC'))].filter((letter) => letter.trim() && width(letter, 'monospace') !== width(letter, 'serif'));
}

/**
 * The style to draw `text` in, with its font loaded. That is the style asked for, unless its font lacks some
 * of the letters: a signature that changes font partway through looks wrong, so then it is the first bundled
 * style that has them all, when one does.
 *
 * @param {keyof STYLES} style
 * @param {string} text
 * @returns {Promise<{style: keyof STYLES, missing: string[]}>} `missing` lists the letters the asked-for style lacks.
 */
export async function resolveStyle(style, text) {
  await loadStyle(style, text);
  const missing = missingLetters(style, text);
  if (!missing.length) {
    return { style, missing };
  }

  for (const [other, { bundled }] of Object.entries(STYLES)) {
    if (bundled && other !== style) {
      await loadStyle(other, text);
      if (!missingLetters(other, text).length) {
        return { style: other, missing };
      }
    }
  }
  return { style, missing };
}

/**
 * A signature from a canvas: cropped to what is not transparent, with its pixels and a PNG to show it.
 *
 * @returns {Promise<{width: number, height: number, rgba: Uint8ClampedArray, blob: Blob}|null>} Null when the canvas is blank.
 */
export async function signatureFromCanvas(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const bounds = opaqueBounds(data.data, canvas.width, canvas.height);
  if (!bounds) {
    return null;
  }

  const cropped = new OffscreenCanvas(bounds.width, bounds.height);
  const context = cropped.getContext('2d');
  context.putImageData(data, -bounds.x, -bounds.y);
  const rgba = context.getImageData(0, 0, bounds.width, bounds.height).data;

  return { width: bounds.width, height: bounds.height, rgba, blob: await cropped.convertToBlob({ type: 'image/png' }) };
}

/**
 * Text drawn in a style, at three times a 32-point size so it prints sharply. Choose the style with
 * `resolveStyle()` first, which also loads its font.
 *
 * @param {string} text
 * @param {keyof STYLES} style
 * @param {string} color
 */
export function typedCanvas(text, style, color) {
  const size = 96;
  const font = `${size}px ${STYLES[style]?.font ?? STYLES.brush.font}`;
  const measure = new OffscreenCanvas(1, 1).getContext('2d');
  measure.font = font;
  const metrics = measure.measureText(text);
  const pad = Math.ceil(size * 0.3);
  const width = Math.ceil(metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) + pad * 2;
  const height = Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) + pad * 2;

  const canvas = new OffscreenCanvas(Math.max(width, 1), Math.max(height, 1));
  const context = canvas.getContext('2d');
  context.font = font;
  context.fillStyle = color;
  context.fillText(text, pad + metrics.actualBoundingBoxLeft, pad + metrics.actualBoundingBoxAscent);
  return canvas;
}

/**
 * An uploaded picture of a signature, at most 1600 pixels wide, optionally with its white paper made transparent.
 *
 * @param {Blob} file
 * @param {boolean} removeWhite
 */
export async function imageCanvas(file, removeWhite) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name ?? 'The file'} is not an image this browser can read.`);
  }

  const scale = Math.min(1, 1600 / bitmap.width);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  if (removeWhite) {
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    whiteToTransparent(data.data);
    context.putImageData(data, 0, 0);
  }

  return canvas;
}

/** A PNG as a data URL, for remembering a signature in this browser. */
export function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
