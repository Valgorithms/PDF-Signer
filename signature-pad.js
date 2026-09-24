// A pad to draw a signature on with a mouse, pen or finger.

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

    canvas.addEventListener('pointerdown', (event) => this.down(event));
    canvas.addEventListener('pointermove', (event) => this.move(event));
    canvas.addEventListener('pointerup', (event) => this.up(event));
    canvas.addEventListener('pointercancel', () => this.up());
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  isEmpty() {
    return this.strokes.length === 0;
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
   * The drawing, cropped to its strokes, drawn at `scale` times the screen size for sharp printing.
   *
   * @returns {OffscreenCanvas|null} Null when nothing is drawn.
   */
  toCanvas(scale = 3) {
    const points = this.strokes.flatMap((stroke) => stroke.points);
    if (!points.length) {
      return null;
    }

    const margin = Math.max(...this.strokes.map((stroke) => stroke.width)) + 2;
    const left = Math.min(...points.map((p) => p.x)) - margin;
    const top = Math.min(...points.map((p) => p.y)) - margin;
    const width = Math.max(...points.map((p) => p.x)) + margin - left;
    const height = Math.max(...points.map((p) => p.y)) + margin - top;
    const canvas = new OffscreenCanvas(Math.ceil(width * scale), Math.ceil(height * scale));
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    context.translate(-left, -top);
    draw(context, this.strokes);
    return canvas;
  }

  down(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    capture(this.canvas, event.pointerId);
    this.current = { color: this.color, width: this.width * (event.pointerType === 'pen' ? 0.6 + event.pressure : 1), points: [this.point(event)] };
    this.strokes.push(this.current);
    this.schedule();
  }

  move(event) {
    if (!this.current) {
      return;
    }
    // Coalesced events give the fine detail between frames; where there are none, the event itself counts.
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event]) {
      this.current.points.push(this.point(sample));
    }
    this.schedule();
  }

  up(event = null) {
    if (this.current) {
      // A quick stroke can end before a move event reaches where it was released.
      const last = this.current.points[this.current.points.length - 1];
      const end = event ? this.point(event) : null;
      if (end && (last.x !== end.x || last.y !== end.y)) {
        this.current.points.push(end);
        this.schedule();
      }
      this.current = null;
      this.canvas.dispatchEvent(new Event('change'));
    }
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

/** Draws strokes as smooth curves through their midpoints, with round ends. */
function draw(context, strokes) {
  context.lineCap = 'round';
  context.lineJoin = 'round';

  for (const { color, width, points } of strokes) {
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = width;

    if (points.length === 1) {
      context.beginPath();
      context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }

    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
      context.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
    }
    const last = points[points.length - 1];
    context.lineTo(last.x, last.y);
    context.stroke();
  }
}
