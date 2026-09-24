// Turns a drawn, typed or uploaded signature into a trimmed image with a transparent background.
import { opaqueBounds, whiteToTransparent } from './pixels.js';

/** Handwriting-like fonts most systems have, with a generic fallback, and a plain one for dates and initials. */
export const STYLES = {
  script: { label: 'Script', font: '"Segoe Script", "Snell Roundhand", "Brush Script MT", "Apple Chancery", cursive' },
  handwriting: { label: 'Handwriting', font: '"Bradley Hand", "Segoe Print", "Ink Free", "Comic Sans MS", cursive' },
  print: { label: 'Print, for dates and initials', font: 'system-ui, "Segoe UI", Helvetica, Arial, sans-serif' },
};

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
 * Text drawn in a style, at three times a 32-point size so it prints sharply.
 *
 * @param {string} text
 * @param {keyof STYLES} style
 * @param {string} color
 */
export function typedCanvas(text, style, color) {
  const size = 96;
  const font = `${size}px ${STYLES[style]?.font ?? STYLES.script.font}`;
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
