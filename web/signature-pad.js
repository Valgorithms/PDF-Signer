// A pad to draw a signature on with a mouse, pen or finger, with an eraser and a few shapes.

/**
 * What a pointer does on the pad: draws freehand, rubs out, or draws a line, rectangle or ellipse from where
 * it goes down to where it comes up.
 */
export const TOOLS = ['pen', 'eraser', 'line', 'rectangle', 'ellipse'];

const SHAPES = ['line', 'rectangle', 'ellipse'];

/** How wide the eraser rubs, in CSS pixels. */
export const ERASER_WIDTH = 16;

export class SignaturePad {
  /**
   * @param {HTMLCanvasElement} canvas Sized with CSS; the pad matches its pixels to the screen.
   * @param {{color?: string, width?: number}} options Ink colour, and line width in CSS pixels.
   */
  constructor(canvas, { color = '#14213d', width = 2.6 } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.color = color;
    this.width = width;
    this.strokes = [];
    this.current = null;
    this.frame = 0;
    this.setTool('pen');

    canvas.addEventListener('pointerdown', (event) => this.down(event));
    canvas.addEventListener('pointermove', (event) => this.move(event));
    canvas.addEventListener('pointerup', (event) => this.up(event));
    canvas.addEventListener('pointercancel', () => this.up());
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Whether nothing has been drawn. Rubbing out does not count, though what it rubs out may leave nothing. */
  isEmpty() {
    return inkBounds(this.strokes) === null;
  }

  clear() {
    this.strokes = [];
    this.redraw();
  }

  undo() {
    this.strokes.pop();
    this.redraw();
  }

  /** Sets the colour for the next strokes. */
  setColor(color) {
    this.color = color;
  }

  /**
   * Chooses what the next strokes do. The canvas's `data-tool` follows it, for the stylesheet's cursor.
   *
   * @param {string} tool One of {@link TOOLS}.
   */
  setTool(tool) {
    if (TOOLS.includes(tool)) {
      this.tool = tool;
      this.canvas.dataset.tool = tool;
    }
  }

  /**
   * The drawing, cropped to its ink, drawn at `scale` times the screen size for sharp printing.
   *
   * @returns {OffscreenCanvas|null} Null when nothing is drawn.
   */
  toCanvas(scale = 3) {
    const bounds = inkBounds(this.strokes);
    if (!bounds) {
      return null;
    }

    const canvas = new OffscreenCanvas(Math.ceil(bounds.width * scale), Math.ceil(bounds.height * scale));
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    context.translate(-bounds.left, -bounds.top);
    draw(context, this.strokes);
    return canvas;
  }

  down(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    capture(this.canvas, event.pointerId);
    const point = this.point(event);
    if (this.tool === 'eraser') {
      this.current = { tool: 'eraser', width: ERASER_WIDTH, points: [point] };
    } else if (this.tool === 'pen') {
      this.current = { tool: 'pen', color: this.color, width: this.width * (event.pointerType === 'pen' ? 0.6 + event.pressure : 1), points: [point] };
    } else {
      // A shape runs from where the pointer went down to where it is now.
      this.current = { tool: this.tool, color: this.color, width: this.width, points: [point, point] };
    }
    this.strokes.push(this.current);
    this.schedule();
  }

  move(event) {
    if (!this.current) {
      return;
    }
    if (SHAPES.includes(this.current.tool)) {
      this.current.points[1] = constrainEnd(this.current.tool, this.current.points[0], this.point(event), event.shiftKey);
    } else {
      // Coalesced events give the fine detail between frames; where there are none, the event itself counts.
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) {
        this.current.points.push(this.point(sample));
      }
    }
    this.schedule();
  }

  up(event = null) {
    const stroke = this.current;
    if (!stroke) {
      return;
    }
    this.current = null;

    if (SHAPES.includes(stroke.tool)) {
      if (event) {
        stroke.points[1] = constrainEnd(stroke.tool, stroke.points[0], this.point(event), event.shiftKey);
      }
      // A tap with a shape tool draws nothing, rather than a speck.
      const [start, end] = stroke.points;
      if (Math.abs(end.x - start.x) < 2 && Math.abs(end.y - start.y) < 2) {
        this.strokes.splice(this.strokes.indexOf(stroke), 1);
      }
    } else if (event) {
      // A quick stroke can end before a move event reaches where it was released.
      const last = stroke.points[stroke.points.length - 1];
      const end = this.point(event);
      if (last.x !== end.x || last.y !== end.y) {
        stroke.points.push(end);
      }
    }
    this.schedule();
    this.canvas.dispatchEvent(new Event('change'));
  }

  /**
   * A pointer's position on the pad, in CSS pixels. Measured from the pad's own box rather than taken
   * from offsetX, which browsers do not all compute the same way.
   */
  point(event) {
    const box = this.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left - this.canvas.clientLeft, y: event.clientY - box.top - this.canvas.clientTop };
  }

  schedule() {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.redraw();
    });
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * ratio);
    this.canvas.height = Math.round(this.canvas.clientHeight * ratio);
    this.redraw();
  }

  redraw() {
    const ratio = this.canvas.width / (this.canvas.clientWidth || 1);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.context.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    draw(this.context, this.strokes);
  }
}

/**
 * Keeps a pointer's events coming to an element while it moves off it. Capture can fail when the pointer
 * is already gone; the stroke is still drawn, just without capture.
 */
export function capture(element, pointerId) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Carry on uncaptured.
  }
}

/**
 * Where a shape ends. Held with Shift (`keep`), a line keeps to steps of 45° and a rectangle or ellipse to
 * equal sides, reaching as far as the pointer does.
 *
 * @param {string} tool
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} end
 * @param {boolean} keep
 * @returns {{x: number, y: number}}
 */
export function constrainEnd(tool, start, end, keep) {
  if (!keep) {
    return end;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'line') {
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = Math.hypot(dx, dy);
    return { x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle) };
  }

  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + (Math.sign(dx) || 1) * side, y: start.y + (Math.sign(dy) || 1) * side };
}

/**
 * The box around everything drawn in ink, with room for the width of its lines. Rubbing out is left out:
 * it can only take ink away, and the signature is trimmed to what is left when it is added.
 *
 * @returns {{left: number, top: number, width: number, height: number}|null} Null when there is no ink.
 */
export function inkBounds(strokes) {
  const inked = strokes.filter((stroke) => stroke.tool !== 'eraser');
  const points = inked.flatMap((stroke) => stroke.points);
  if (!points.length) {
    return null;
  }

  const margin = Math.max(...inked.map((stroke) => stroke.width)) + 2;
  const left = Math.min(...points.map((p) => p.x)) - margin;
  const top = Math.min(...points.map((p) => p.y)) - margin;
  return {
    left,
    top,
    width: Math.max(...points.map((p) => p.x)) + margin - left,
    height: Math.max(...points.map((p) => p.y)) + margin - top,
  };
}

/**
 * Draws strokes in order, so the eraser rubs out only what came before it. Freehand strokes are smooth
 * curves through their midpoints, with round ends.
 */
function draw(context, strokes) {
  for (const { tool = 'pen', color = '#000', width, points } of strokes) {
    context.save();
    // The eraser clears what it passes over, down to the transparent canvas.
    context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = width;
    context.lineCap = 'round';
    context.lineJoin = tool === 'rectangle' ? 'miter' : 'round';
    context.beginPath();

    const [start, end] = points;
    if (tool === 'line') {
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    } else if (tool === 'rectangle') {
      context.rect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    } else if (tool === 'ellipse') {
      context.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2);
    } else if (points.length === 1) {
      // A tap: a dot as wide as the line.
      context.arc(start.x, start.y, width / 2, 0, Math.PI * 2);
    } else {
      context.moveTo(start.x, start.y);
      for (let i = 1; i < points.length - 1; i++) {
        const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
        context.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
      }
      const last = points[points.length - 1];
      context.lineTo(last.x, last.y);
    }

    // Shapes always have two points, so only a tap is filled.
    if (points.length === 1) {
      context.fill();
    } else {
      context.stroke();
    }
    context.restore();
  }
}
