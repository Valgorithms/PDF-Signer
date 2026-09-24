// Pixel helpers for turning a picture of a signature into a clean stamp. No DOM, so Node can test them.

/**
 * Makes paper-white pixels transparent, in place, for a signature photographed or scanned on white paper.
 *
 * Pixels brighter than `hard` become fully transparent, pixels darker than `soft` keep their alpha, and
 * those in between fade, so the edges of the ink stay smooth.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba Four bytes per pixel.
 * @param {number} hard Brightness (0–255) at and above which a pixel is paper.
 * @param {number} soft Brightness below which a pixel is ink.
 */
export function whiteToTransparent(rgba, hard = 235, soft = 190) {
  for (let i = 0; i < rgba.length; i += 4) {
    const brightness = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    const keep = Math.min(Math.max((hard - brightness) / (hard - soft), 0), 1);
    rgba[i + 3] = Math.round(rgba[i + 3] * keep);
  }

  return rgba;
}

/**
 * The smallest rectangle holding every pixel more opaque than `threshold`, or null when there are none.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba Four bytes per pixel.
 * @param {number} width
 * @param {number} height
 * @param {number} threshold Alpha (0–255) a pixel must exceed to count.
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function opaqueBounds(rgba, width, height, threshold = 8) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }

  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
