// Geometry for placing signatures, as in src/Geometry.php, plus helpers for the page. No DOM and no
// libraries, so Node can test it.
//
// Positions are on the page as a viewer shows it: in points from its top-left corner, after the crop box
// and /Rotate are applied. The transform is the one pdf.js uses at scale 1, so a spot picked on a page
// pdf.js rendered lands in the same place in the PDF.

/**
 * The transform from user space to the displayed page, y downward: [a, b, c, d, e, f].
 *
 * @param {number[]} viewBox The displayed box: lower-left x and y, upper-right x and y.
 * @param {number} rotation 0, 90, 180 or 270.
 */
export function displayTransform(viewBox, rotation) {
  const [x0, y0, x1, y1] = viewBox;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;
  const [a, b, c, d] = { 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rotation] ?? [1, 0, 0, -1];
  const [offsetX, offsetY] = a === 0
    ? [Math.abs(centerY - y0), Math.abs(centerX - x0)]
    : [Math.abs(centerX - x0), Math.abs(centerY - y0)];

  return [a, b, c, d, offsetX - a * centerX - c * centerY, offsetY - b * centerX - d * centerY];
}

/** The width and height of the displayed page. */
export function displaySize(viewBox, rotation) {
  const width = viewBox[2] - viewBox[0];
  const height = viewBox[3] - viewBox[1];
  return rotation === 90 || rotation === 270 ? [height, width] : [width, height];
}

/** Converts a point on the displayed page to user space. */
export function toUser(transform, x, y) {
  const [a, b, c, d, e, f] = transform;
  const determinant = a * d - b * c;
  const dx = x - e;
  const dy = y - f;
  // Adding 0 turns a -0 into 0.
  return [(d * dx - c * dy) / determinant + 0, (a * dy - b * dx) / determinant + 0];
}

/**
 * The `cm` matrix that draws an image into a rectangle on the displayed page. The image's bottom-left,
 * bottom-right and top-left corners are mapped onto the rectangle's, so rotation and an offset crop box
 * are accounted for and the image stays upright on screen.
 *
 * @param {(x: number, y: number) => number[]} convert Converts a displayed point to user space.
 * @param {{x: number, y: number, width: number, height: number}} rect The rectangle on the displayed page.
 */
export function placementMatrix(convert, rect) {
  const [x0, y0] = convert(rect.x, rect.y + rect.height);
  const [x1, y1] = convert(rect.x + rect.width, rect.y + rect.height);
  const [x2, y2] = convert(rect.x, rect.y);
  return [x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0];
}

/** Converts a rectangle stored as fractions of the displayed page into points on it. */
export function scaleRect(fractions, pageWidth, pageHeight) {
  return {
    x: fractions.x * pageWidth,
    y: fractions.y * pageHeight,
    width: fractions.width * pageWidth,
    height: fractions.height * pageHeight,
  };
}

/**
 * The size of a newly placed signature, as fractions of the page: `targetWidth` points wide at its own
 * aspect ratio, made smaller if that would be wider than `maxWidth` or taller than `maxHeight` of the page.
 */
export function initialSize(aspect, pageWidth, pageHeight, targetWidth = 180, maxWidth = 0.4, maxHeight = 0.25) {
  let width = Math.min(targetWidth, pageWidth * maxWidth);
  let height = width / aspect;
  if (height > pageHeight * maxHeight) {
    height = pageHeight * maxHeight;
    width = height * aspect;
  }
  return { width: width / pageWidth, height: height / pageHeight };
}

/** Keeps a rectangle, in fractions of the page, inside the page. */
export function clampRect(rect) {
  const width = Math.min(rect.width, 1);
  const height = Math.min(rect.height, 1);
  return {
    x: Math.min(Math.max(rect.x, 0), 1 - width),
    y: Math.min(Math.max(rect.y, 0), 1 - height),
    width,
    height,
  };
}

/** The file name for the signed copy of a PDF. */
export function signedFileName(name) {
  const base = name.replace(/\.pdf$/i, '') || 'document';
  return `${base}-signed.pdf`;
}
