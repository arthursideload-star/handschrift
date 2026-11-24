// Canvas rendering of paper + handwriting.
import { toQuads, ribbon } from './geom.js';

export function penWidthAt(pen) {
  return pen.type === 'fountain' ? (p) => pen.width * (0.35 + 1.15 * p) : () => pen.width;
}

export function drawPaper(ctx, paper, scale) {
  ctx.fillStyle = paper.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'butt';
  for (const op of paper.ops) {
    if (op.t === 'line') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = Math.max(0.6, op.width * scale);
      ctx.beginPath();
      ctx.moveTo(op.x1 * scale, op.y1 * scale);
      ctx.lineTo(op.x2 * scale, op.y2 * scale);
      ctx.stroke();
    } else if (op.t === 'dot') {
      ctx.fillStyle = op.color;
      ctx.beginPath();
      ctx.arc(op.x * scale, op.y * scale, Math.max(0.7, op.r * scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Strokes may carry their own colour (`stroke.color`, e.g. mind map branches);
// everything else uses the pen colour.
export function groupByColor(strokes, fallback) {
  const groups = new Map();
  for (const s of strokes) {
    const c = s.color || fallback;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(s);
  }
  return groups;
}

export function drawStrokes(ctx, strokes, pen, scale) {
  for (const [color, list] of groupByColor(strokes, pen.color)) drawInk(ctx, list, { ...pen, color }, scale);
}

function drawInk(ctx, strokes, pen, scale) {
  ctx.fillStyle = pen.color;
  ctx.strokeStyle = pen.color;
  if (pen.type === 'fountain') {
    const wAt = penWidthAt(pen);
    for (const s of strokes) {
      const poly = ribbon(s, wAt);
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * scale, y * scale) : ctx.moveTo(x * scale, y * scale)));
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  ctx.lineWidth = Math.max(0.5, pen.width * scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const s of strokes) {
    const q = toQuads(s);
    ctx.moveTo(q.start[0] * scale, q.start[1] * scale);
    for (const [cx, cy, x, y] of q.segs) ctx.quadraticCurveTo(cx * scale, cy * scale, x * scale, y * scale);
  }
  ctx.stroke();
}

export function renderPage(canvas, page, paper, pen, pageSize, pxPerMm) {
  canvas.width = Math.round(pageSize.w * pxPerMm);
  canvas.height = Math.round(pageSize.h * pxPerMm);
  const ctx = canvas.getContext('2d');
  drawPaper(ctx, paper, pxPerMm);
  drawStrokes(ctx, page.strokes, pen, pxPerMm);
  return canvas;
}
