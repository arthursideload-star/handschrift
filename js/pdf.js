// Minimal vector PDF writer (no dependencies).
import { toQuads, ribbon } from './geom.js';
import { hexToRgb } from './util.js';
import { penWidthAt } from './render.js';

const enc = new TextEncoder();
const MM = 72 / 25.4;
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const rgb = (hex) => hexToRgb(hex).map((c) => n(c / 255)).join(' ');

/** Build the content stream of one page. Units in: mm. */
export function pageContent({ pageMm, paper, strokes, pen, includePaper = true, includeInk = true }) {
  const H = pageMm.h * MM;
  const X = (x) => n(x * MM);
  const Y = (y) => n(H - y * MM);
  const out = [];
  if (includePaper && paper) {
    out.push(`${rgb(paper.bg)} rg 0 0 ${n(pageMm.w * MM)} ${n(H)} re f`);
    // group lines by colour+width to keep the file small
    const groups = new Map();
    for (const op of paper.ops) {
      const key = op.t === 'dot' ? `d|${op.color}|${op.r}` : `l|${op.color}|${op.width}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(op);
    }
    for (const [key, ops] of groups) {
      const [kind, color, size] = key.split('|');
      if (kind === 'l') {
        out.push(`${rgb(color)} RG ${n(Number(size) * MM)} w 0 J`);
        out.push(ops.map((o) => `${X(o.x1)} ${Y(o.y1)} m ${X(o.x2)} ${Y(o.y2)} l`).join('\n') + '\nS');
      } else {
        out.push(`${rgb(color)} RG ${n(Number(size) * 2 * MM)} w 1 J`);
        out.push(ops.map((o) => `${X(o.x)} ${Y(o.y)} m ${X(o.x)} ${Y(o.y)} l`).join('\n') + '\nS');
      }
    }
  }
  if (includeInk && strokes && strokes.length) {
    if (pen.type === 'fountain') {
      const wAt = penWidthAt(pen);
      out.push(`${rgb(pen.color)} rg`);
      const parts = [];
      for (const s of strokes) {
        const poly = ribbon(s, wAt);
        parts.push(poly.map(([x, y], i) => `${X(x)} ${Y(y)} ${i ? 'l' : 'm'}`).join(' ') + ' h');
      }
      out.push(parts.join('\n') + '\nf');
    } else {
      out.push(`${rgb(pen.color)} RG ${n(pen.width * MM)} w 1 J 1 j`);
      const parts = [];
      for (const s of strokes) {
        const q = toQuads(s);
        let [px, py] = q.start;
        const seg = [`${X(px)} ${Y(py)} m`];
        for (const [cx, cy, x, y] of q.segs) {
          const c1x = px + (2 / 3) * (cx - px), c1y = py + (2 / 3) * (cy - py);
          const c2x = x + (2 / 3) * (cx - x), c2y = y + (2 / 3) * (cy - y);
          seg.push(`${X(c1x)} ${Y(c1y)} ${X(c2x)} ${Y(c2y)} ${X(x)} ${Y(y)} c`);
          px = x;
          py = y;
        }
        parts.push(seg.join(' '));
      }
      out.push(parts.join('\n') + '\nS');
    }
  }
  return out.join('\n');
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** pages: [{ wPt, hPt, content }] → Uint8Array PDF */
export async function buildPdf(pages) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    length += b.length;
  };
  const obj = (id, body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    if (Array.isArray(body)) body.forEach(push);
    else push(body);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pid = 3 + i * 2;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.wPt)} ${n(p.hPt)}] /Contents ${pid + 1} 0 R /Resources << >> >>`);
    const raw = enc.encode(p.content);
    const z = await deflate(raw);
    const data = z || raw;
    obj(pid + 1, [`<< /Length ${data.length}${z ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, data, '\nendstream']);
  }
  const count = 3 + pages.length * 2;
  const xref = length;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) x += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export { MM as PT_PER_MM };
