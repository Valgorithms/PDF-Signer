// Marks drawn on a page as vector paths: a tick, a cross, a dot, lines, a rectangle and an ellipse. A port of
// src/Mark.php; both write the same operators, number for number.
import { number } from './pdf/serializer.js';

/** How far a Bézier handle reaches for a quarter of a circle of radius 1. */
const KAPPA = 0.5522847498307936;
const K = 0.5 * KAPPA;

/** A circle filling the unit square, as four Bézier curves. */
const OVAL = [
  ['m', 1, 0.5],
  ['c', 1, 0.5 + K, 0.5 + K, 1, 0.5, 1],
  ['c', 0.5 - K, 1, 0, 0.5 + K, 0, 0.5],
  ['c', 0, 0.5 - K, 0.5 - K, 0, 0.5, 0],
  ['c', 0.5 + K, 0, 1, 0.5 - K, 1, 0.5],
  ['h'],
];

/**
 * Each shape as a path in the unit square, y upward from its bottom-left corner, which is how a placement
 * matrix maps an image. `paint` is S to stroke the path or f to fill it; `join` is the line join, round
 * unless the corners should be sharp.
 */
export const SHAPES = {
  tick: { paint: 'S', join: 1, path: [['m', 0.08, 0.52], ['l', 0.38, 0.2], ['l', 0.92, 0.86]] },
  cross: { paint: 'S', join: 1, path: [['m', 0.15, 0.15], ['l', 0.85, 0.85], ['m', 0.15, 0.85], ['l', 0.85, 0.15]] },
  dot: { paint: 'f', join: 1, path: OVAL },
  'line-up': { paint: 'S', join: 1, path: [['m', 0, 0], ['l', 1, 1]] },
  'line-down': { paint: 'S', join: 1, path: [['m', 0, 1], ['l', 1, 0]] },
  rectangle: { paint: 'S', join: 0, path: [['m', 0, 0], ['l', 1, 0], ['l', 1, 1], ['l', 0, 1], ['h']] },
  ellipse: { paint: 'S', join: 1, path: OVAL },
};

/**
 * How thick a mark's lines are, in points: 1.5, except that a tick or cross grows bolder with its size, at
 * an eighth of its smaller side.
 *
 * @param {string} shape
 * @param {number} width The mark's width, in points.
 * @param {number} height Its height.
 */
export function strokeWidth(shape, width, height) {
  return shape === 'tick' || shape === 'cross' ? Math.max(1.5, Math.min(width, height) / 8) : 1.5;
}

export class Mark {
  /**
   * @param {string} shape One of {@link SHAPES}.
   * @param {number[]} color Red, green and blue, each from 0 to 1.
   */
  constructor(shape, color = [0, 0, 0]) {
    if (!Object.hasOwn(SHAPES, shape)) {
      throw new RangeError(`There is no ${shape} mark.`);
    }
    this.shape = shape;
    this.color = color;
  }

  /**
   * The content-stream operators that draw the mark where `matrix` would draw an image. The path is
   * worked out in the page's own space rather than drawn under the matrix, so a line keeps its thickness
   * however the mark is stretched, even flat.
   *
   * @param {number[]} matrix A `cm` matrix: a b c d e f.
   */
  operators(matrix) {
    const [a, b, c, d, e, f] = matrix;
    const { paint, join, path } = SHAPES[this.shape];
    const color = this.color.map(number).join(' ');
    const parts = ['q'];

    if (paint === 'f') {
      parts.push(`${color} rg`);
    } else {
      const width = strokeWidth(this.shape, Math.sqrt(a * a + b * b), Math.sqrt(c * c + d * d));
      parts.push(`${color} RG`, `${number(width)} w`, '1 J', `${join} j`);
    }

    for (const [operator, ...coordinates] of path) {
      const points = [];
      for (let i = 0; i < coordinates.length; i += 2) {
        const [u, v] = [coordinates[i], coordinates[i + 1]];
        points.push(number(a * u + c * v + e), number(b * u + d * v + f));
      }
      parts.push([...points, operator].join(' '));
    }

    parts.push(paint, 'Q');
    return parts.join(' ');
  }
}

/** A colour written #rrggbb, as red, green and blue from 0 to 1. */
export function rgb(hex) {
  const value = Number.parseInt(hex.replace(/^#/, ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
}
