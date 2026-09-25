// The signature pad's geometry: where a held shape ends, and how much of the drawing is ink.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constrainEnd, ERASER_WIDTH, inkBounds, TOOLS } from '../../web/signature-pad.js';

const near = (actual, expected) => {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.y - expected.y) < 1e-9, `${JSON.stringify(actual)} ≈ ${JSON.stringify(expected)}`);
};

test('the pen comes first, so the pad opens drawing', () => {
  assert.deepEqual(TOOLS, ['pen', 'eraser', 'line', 'rectangle', 'ellipse']);
});

test('a shape ends where the pointer is unless Shift is held', () => {
  const end = { x: 37, y: 12 };
  for (const tool of ['line', 'rectangle', 'ellipse']) {
    assert.equal(constrainEnd(tool, { x: 0, y: 0 }, end, false), end);
  }
});

test('a held line keeps to steps of 45°, as long as the pointer reaches', () => {
  const start = { x: 10, y: 10 };
  near(constrainEnd('line', start, { x: 110, y: 18 }, true), { x: 10 + Math.hypot(100, 8), y: 10 });
  near(constrainEnd('line', start, { x: 14, y: -90 }, true), { x: 10, y: 10 - Math.hypot(4, 100) });

  const diagonal = constrainEnd('line', start, { x: 60, y: 70 }, true);
  assert.ok(Math.abs((diagonal.x - start.x) - (diagonal.y - start.y)) < 1e-9);
  assert.ok(Math.abs(Math.hypot(diagonal.x - start.x, diagonal.y - start.y) - Math.hypot(50, 60)) < 1e-9);
});

test('a held rectangle or ellipse has equal sides, towards the pointer', () => {
  assert.deepEqual(constrainEnd('rectangle', { x: 10, y: 10 }, { x: 40, y: 20 }, true), { x: 40, y: 40 });
  assert.deepEqual(constrainEnd('ellipse', { x: 10, y: 10 }, { x: -20, y: 5 }, true), { x: -20, y: -20 });
  // Straight down still makes a square rather than a flat line.
  assert.deepEqual(constrainEnd('rectangle', { x: 10, y: 10 }, { x: 10, y: 50 }, true), { x: 50, y: 50 });
});

test('the ink box leaves out the eraser and is null when there is no ink', () => {
  assert.equal(inkBounds([]), null);
  assert.equal(inkBounds([{ tool: 'eraser', width: ERASER_WIDTH, points: [{ x: 5, y: 5 }, { x: 300, y: 200 }] }]), null);

  const bounds = inkBounds([
    { tool: 'pen', color: '#000', width: 2, points: [{ x: 50, y: 60 }, { x: 80, y: 70 }] },
    { tool: 'rectangle', color: '#000', width: 3, points: [{ x: 100, y: 40 }, { x: 70, y: 90 }] },
    { tool: 'eraser', width: ERASER_WIDTH, points: [{ x: 0, y: 0 }, { x: 400, y: 300 }] },
  ]);
  // The widest ink line is 3, so the box reaches 5 beyond the outermost points.
  assert.deepEqual(bounds, { left: 45, top: 35, width: 60, height: 60 });
});
