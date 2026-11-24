// Zeitstrahl + Mindmap: typed outline → handwriting strokes (page coordinates in mm).
//
// Every label is written with the user's own glyphs (layoutText), every line,
// arrow and ellipse is a hand-drawn stroke, so the result can be exported like
// normal handwriting (Bild, PDF, radierbar in GoodNotes).

import { layoutText } from './layout.js';
import { normalizeText } from './charset.js';
import { bbox } from './geom.js';
import { mulberry32 } from './util.js';

// Branch / accent colours (readable on white, yellow and grey paper).
export const PALETTE = ['#d1495b', '#2e86ab', '#3c9d5d', '#e08e0b', '#7b4fb0', '#00897b', '#c2185b', '#5d6d7e'];

const label = (s) => normalizeText(s, { stripMd: true }).replace(/\n+/g, ' ').trim();

// ------------------------------------------------------------------ parsing

/**
 * Timeline input: one event per line, "Datum: Ereignis" (also "Datum - Ereignis",
 * "Datum | Ereignis", tab, or "1789 Ereignis"). A Markdown heading becomes the title.
 * @returns {{ title: string, events: { date: string, text: string }[] }}
 */
export function parseTimeline(text) {
  let title = '';
  const events = [];
  for (let line of (text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const h = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (h) {
      if (!title) title = label(h[1]);
      continue;
    }
    line = line.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, ''); // list bullets / numbering
    line = line.replace(/\*\*(.+?)\*\*/g, '$1');
    let date = '', desc = '';
    const sep = line.match(/:(?=\s|$)|\s[-–—|]\s|\t/);
    if (sep) {
      date = line.slice(0, sep.index);
      desc = line.slice(sep.index + sep[0].length);
    } else {
      // "1789 Sturm auf die Bastille", "14.07.1789 …", "500 v. Chr. …"
      const m = line.match(/^\s*((?:ca\.\s*)?\d[\d./–-]*(?:\s*(?:v\.|n\.)\s*Chr\.)?)\s+(.+)$/);
      if (m) [, date, desc] = m;
      else desc = line;
    }
    date = label(date);
    desc = label(desc);
    if (date || desc) events.push({ date, text: desc });
  }
  return { title, events };
}

/**
 * Mind map input: an indented outline. Indentation (spaces/tabs), list bullets
 * and Markdown headings define the levels. The first top-level line is the centre;
 * further top-level lines become main branches.
 * @returns {{ label: string, children: object[] } | null}
 */
export function parseMindmap(text) {
  const items = [];
  for (const raw of (text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const ws = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    let rest = raw.trim();
    let rank;
    const h = rest.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      rank = h[1].length - 10; // headings sit above everything else
      rest = h[2];
    } else {
      const b = rest.match(/^(?:[-*+•–]|\d+[.)]|[a-z][.)])\s+(.*)$/);
      if (b) rest = b[1];
      rank = ws * 2 + (b ? 1 : 0); // "- x" directly under "Thema" is its child
    }
    const l = label(rest.replace(/:$/, ''));
    if (l) items.push({ rank, label: l, children: [] });
  }
  if (!items.length) return null;
  const roots = [];
  const stack = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].rank >= it.rank) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(it);
    stack.push(it);
  }
  const center = roots[0];
  center.children.push(...roots.slice(1));
  return center;
}

// ------------------------------------------------------------------ helpers

const translate = (strokes, dx, dy) => strokes.map((s) => tag(s.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v)), s.color));
const tag = (s, color) => {
  if (color) s.color = color;
  return s;
};
const paint = (strokes, color) => {
  if (color) strokes.forEach((s) => (s.color = color));
  return strokes;
};

function transformAll(strokes, f) {
  return strokes.map((s) => {
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i += 3) {
      const [x, y] = f(s[i], s[i + 1]);
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = s[i + 2];
    }
    return tag(out, s.color);
  });
}

/** Writes labels with the user's handwriting and collects missing glyphs. */
function makeWriter(font, base) {
  let n = 0;
  const missing = new Set();
  /**
   * Text block with its top-left at (0,0), wrapped to maxWidth.
   * @returns {{ strokes, w, h, x0, x1 }} x0/x1 = real ink extent, h = layout height
   */
  function block(text, cap, maxWidth, align = 'left') {
    const spacing = cap * 1.55;
    // never break inside a word: widen the block to the longest word
    const words = text.split(/\s+/).filter((w) => w.length > 3);
    if (words.length) {
      const longest = Math.max(...words.map((w) => raw(w, cap, 1e6, 'left', spacing).w));
      maxWidth = Math.max(maxWidth, longest + cap * 0.4);
    }
    const out = raw(text, cap, maxWidth, align, spacing);
    out.maxWidth = maxWidth;
    return out;
  }
  function raw(text, cap, maxWidth, align, spacing) {
    const res = layoutText(text, font, {
      page: { w: maxWidth, h: 1e9 },
      geo: { spacing, left: 0, right: maxWidth, bottom: 1e12, firstBaseline: cap },
      capHeight: cap,
      messiness: base.messiness,
      slant: base.slant,
      letterSpacing: base.letterSpacing,
      wordSpacing: base.wordSpacing,
      seed: (base.seed + ++n * 7919) >>> 0,
      align,
    });
    res.missing.forEach((c) => missing.add(c));
    const strokes = res.pages.flatMap((p) => p.strokes);
    const bb = bbox(strokes);
    const lines = text ? Math.max(1, res.lines) : 0;
    return {
      strokes,
      h: lines ? cap + (lines - 1) * spacing + cap * 0.45 : 0,
      x0: bb ? bb.x0 : 0,
      x1: bb ? bb.x1 : 0,
      w: bb ? bb.x1 - bb.x0 : 0,
    };
  }
  return { block, missing };
}

/** Hand-drawn polyline: resampled with a soft, smooth wobble. */
function handPath(pts, rng, m, step = 1.2) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(l);
    total += l;
  }
  if (!total) return [pts[0][0], pts[0][1], 0.5];
  const amp = (0.12 + 0.35 * m) * Math.min(1, total / 25);
  const l1 = 18 + rng() * 30, l2 = 7 + rng() * 9, p1 = rng() * 6.28, p2 = rng() * 6.28;
  const count = Math.max(2, Math.ceil(total / step));
  const out = [];
  let si = 0, acc = 0;
  for (let k = 0; k <= count; k++) {
    const d = (k / count) * total;
    while (si < seg.length - 1 && acc + seg[si] < d) acc += seg[si++];
    const t = seg[si] ? (d - acc) / seg[si] : 0;
    const a = pts[si], b = pts[si + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const fade = Math.sin((Math.PI * d) / total); // ends stay where they belong
    const off = amp * fade * (0.7 * Math.sin(d / l1 * 6.28 + p1) + 0.3 * Math.sin(d / l2 * 6.28 + p2));
    out.push(a[0] + dx * t - (dy / len) * off, a[1] + dy * t + (dx / len) * off, 0.5 + 0.12 * Math.sin(d / 9 + p1));
  }
  return out;
}

function bezier(p0, p1, p2, p3, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

/** Hand-drawn ellipse that overshoots its start a little, like a real pen loop. */
function handEllipse(cx, cy, rx, ry, rng, m) {
  const a0 = -2.4 + rng() * 0.5;
  const sweep = Math.PI * 2 + 0.3 + rng() * 0.25;
  const n = Math.max(36, Math.round((rx + ry) * 1.2));
  const f = 2 + Math.floor(rng() * 2), p = rng() * 6.28;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + sweep * t;
    const r = 1 + 0.035 * (0.4 + m) * Math.sin(f * a + p) + 0.05 * t; // spiral out slightly
    out.push(cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r, 0.5);
  }
  return out;
}

/** Two short strokes forming an arrow tip at `tip`, pointing along (dx, dy). */
function arrowHead(tip, dx, dy, size, rng, m) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  return [-1, 1].map((side) => {
    const ang = (27 + (rng() - 0.5) * 8) * (Math.PI / 180) * side;
    const c = Math.cos(ang), s = Math.sin(ang);
    const bx = -(ux * c - uy * s) * size, by = -(ux * s + uy * c) * size;
    return handPath([[tip[0] + bx, tip[1] + by], tip], rng, m * 0.3, 0.6);
  });
}

/** Small filled-looking dot: two nested loops. */
function handDot(x, y, r, rng) {
  return [handEllipse(x, y, r, r, rng, 0), handEllipse(x, y, r * 0.45, r * 0.45, rng, 0)];
}

const opts = (o) => ({
  messiness: o.messiness ?? 0.35,
  slant: o.slant || 0,
  letterSpacing: o.letterSpacing ?? 1,
  wordSpacing: o.wordSpacing ?? 1,
  seed: o.seed || 1,
});

// ------------------------------------------------------------------ timeline

/**
 * @param data  result of parseTimeline (title may be overridden by o.title)
 * @param o     { page:{w,h}, margin, cap (mm), direction:'auto'|'waagerecht'|'senkrecht',
 *                colorful, messiness, slant, letterSpacing, wordSpacing, seed }
 * @returns {{ pages: { strokes }[], missing: Set<string>, shrunk: boolean }}
 */
export function layoutTimeline(data, font, o) {
  const title = o.title != null && o.title.trim() ? label(o.title) : data.title;
  const events = data.events;
  // auto: across landscape pages, downwards on portrait pages or when there are many events
  const dir =
    o.direction === 'waagerecht' || o.direction === 'senkrecht'
      ? o.direction
      : o.page.w > o.page.h && events.length <= 8
        ? 'waagerecht'
        : 'senkrecht';
  const fn = dir === 'waagerecht' ? timelineHorizontal : timelineVertical;
  // Shrink the writing until it fits (horizontal) / stays readable (vertical).
  let cap = o.cap;
  for (let i = 0; i < 14; i++) {
    const res = fn(title, events, font, { ...o, cap });
    if (res.fits || cap < 1.6) return { pages: res.pages, missing: res.missing, shrunk: cap < o.cap * 0.95 };
    cap *= 0.9;
  }
  return { pages: [], missing: new Set(), shrunk: true };
}

function timelineBox(o) {
  const m = Math.max(3, o.margin);
  return { left: m, right: o.page.w - m, top: m, bottom: o.page.h - m };
}

function writeTitle(title, W, box, cap, color, rng, m, strokes) {
  if (!title) return box.top;
  const t = W.block(title, cap * 1.45, box.right - box.left);
  strokes.push(...translate(t.strokes, box.left, box.top));
  const uy = box.top + t.h + 1.2;
  strokes.push(paint([handPath([[box.left, uy], [box.left + Math.max(20, t.x1 + 2), uy]], rng, m)], color)[0]);
  return uy + cap * 1.6;
}

function timelineVertical(title, events, font, o) {
  const base = opts(o);
  const W = makeWriter(font, base);
  const rng = mulberry32((base.seed ^ 0x5bd1e995) >>> 0);
  const m = base.messiness;
  const cap = o.cap;
  const box = timelineBox(o);
  const cw = box.right - box.left;
  const accent = (i) => (o.colorful ? PALETTE[i % PALETTE.length] : null);

  const pages = [{ strokes: [] }];
  let strokes = pages[0].strokes;
  let y = writeTitle(title, W, box, cap, accent(0), rng, m, strokes);

  const dateCap = cap * 1.0;
  const textCap = cap * 0.95;
  const dateMax = cw * 0.32;
  const dates = events.map((e) => W.block(e.date, dateCap, dateMax, 'right'));
  const dateW = Math.min(dateMax, Math.max(cap * 2, ...dates.map((d) => d.w)));
  const axisX = box.left + dateW + cap * 1.1;
  const textX = axisX + cap * 1.3;
  const textW = box.right - textX;
  const gap = cap * 1.1;

  let axisTop = y - cap * 0.4;
  let lastBottom = y;
  const closeAxis = (bottom, final) => {
    const end = final ? bottom + cap * 1.4 : box.bottom;
    strokes.push(handPath([[axisX, axisTop], [axisX, end]], rng, m));
    if (final) strokes.push(...arrowHead([axisX, end], 0, 1, cap * 0.75, rng, m));
  };

  events.forEach((e, i) => {
    const d = dates[i];
    const t = W.block(e.text, textCap, textW);
    const rowH = Math.max(d.h, t.h);
    if (y + rowH > box.bottom && y > box.top + cap * 3) {
      closeAxis(lastBottom, false);
      pages.push({ strokes: [] });
      strokes = pages[pages.length - 1].strokes;
      y = box.top;
      axisTop = box.top - Math.min(box.top, cap);
    }
    const color = accent(i);
    // date: right-aligned against the axis (block was laid out in [0, dateMax])
    strokes.push(...paint(translate(d.strokes, axisX - cap * 1.1 - d.maxWidth, y), color));
    strokes.push(...paint(handDot(axisX, y + dateCap * 0.55, cap * 0.28, rng), color));
    strokes.push(...translate(t.strokes, textX, y + (dateCap - textCap))); // same baseline as the date
    lastBottom = y + rowH;
    y += rowH + gap;
  });
  if (events.length) closeAxis(lastBottom, true);
  return { pages, missing: W.missing, fits: true };
}

function timelineHorizontal(title, events, font, o) {
  const base = opts(o);
  const W = makeWriter(font, base);
  const rng = mulberry32((base.seed ^ 0x5bd1e995) >>> 0);
  const m = base.messiness;
  const cap = o.cap;
  const box = timelineBox(o);
  const cw = box.right - box.left;
  const accent = (i) => (o.colorful ? PALETTE[i % PALETTE.length] : null);
  const strokes = [];
  const top = writeTitle(title, W, box, cap, accent(0), rng, m, strokes);

  const n = Math.max(1, events.length);
  const axisL = box.left, axisR = box.right;
  const slot = (axisR - axisL - cap * 2) / n;
  const xs = events.map((_, i) => axisL + cap * 0.5 + slot * (i + 0.5));
  const dateCap = cap * 1.0;
  const textCap = cap * 0.92;
  const dates = events.map((e) => W.block(e.date, dateCap, Math.max(cap * 2, slot - cap * 0.6), 'center'));
  // Neighbours on the same side are two slots apart; the outer ones must stay on the page.
  const descWs = xs.map((x) => Math.max(cap * 3, Math.min(slot * 1.9 - cap * 0.8, cw, 2 * (x - box.left), 2 * (box.right - x))));
  const texts = events.map((e, i) => W.block(e.text, textCap, descWs[i], 'center'));

  // even events: text above the axis, date below; odd events the other way round
  const side = (i) => (i % 2 === 0 ? -1 : 1);
  const maxOf = (arr, s, f) => Math.max(0, ...arr.filter((_, i) => side(i) === s).map(f));
  const dateZone = (s) => maxOf(dates, -s, (d) => d.h); // dates of the other parity sit on side s
  const pad = cap * 0.6;
  const above = pad + dateZone(-1) + pad + maxOf(texts, -1, (t) => t.h);
  const below = pad + dateZone(1) + pad + maxOf(texts, 1, (t) => t.h);
  const axisY = top + above + cap * 0.3;
  const fits = axisY + below <= box.bottom;

  if (events.length) {
    strokes.push(handPath([[axisL, axisY], [axisR, axisY]], rng, m));
    strokes.push(...arrowHead([axisR, axisY], 1, 0, cap * 0.8, rng, m));
  }
  events.forEach((e, i) => {
    const s = side(i);
    const x = xs[i];
    const color = accent(i);
    const d = dates[i], t = texts[i];
    strokes.push(...paint(handDot(x, axisY, cap * 0.28, rng), color));
    // date right next to the axis on the opposite side of the text
    const dy = -s > 0 ? axisY + pad : axisY - pad - d.h;
    strokes.push(...paint(translate(d.strokes, x - d.maxWidth / 2, dy), color));
    // text beyond the dates of the neighbours, joined to the axis by a stem
    const zone = dateZone(s);
    const ty = s < 0 ? axisY - pad - zone - pad - t.h : axisY + pad + zone + pad;
    const stemEnd = s < 0 ? ty + t.h + cap * 0.1 : ty - cap * 0.35;
    strokes.push(paint([handPath([[x, axisY + s * cap * 0.45], [x, stemEnd]], rng, m * 0.5)], color)[0]);
    strokes.push(...translate(t.strokes, x - t.maxWidth / 2, ty));
  });
  return { pages: [{ strokes }], missing: W.missing, fits };
}

// ------------------------------------------------------------------ mind map

/**
 * @param root  result of parseMindmap
 * @param o     { page:{w,h}, margin, cap (mm), colorful, messiness, slant, letterSpacing, wordSpacing, seed }
 * @returns {{ pages: { strokes }[], missing: Set<string>, shrunk: boolean }}
 */
export function layoutMindmap(root, font, o) {
  if (!root) return { pages: [{ strokes: [] }], missing: new Set(), shrunk: false };
  // Narrower labels make the map taller and slimmer. Try a few widths and keep the
  // one that allows the biggest writing on this page (portrait pages profit most).
  const pick = (oneSided) => {
    let best = null;
    for (const wf of [1, 0.75, 0.55]) {
      const r = mindmapOnce(root, font, o, wf, oneSided, 1);
      if (!best || r.scale > best.scale * 1.12) best = r;
    }
    return best;
  };
  // Classic map with branches on both sides – unless that would make the writing
  // clearly smaller (narrow portrait pages); then all branches go to the right.
  let best = pick(false);
  if (best.scale < 0.9) {
    const one = pick(true);
    if (one.scale > best.scale) best = one;
  }
  // Use free height: spread the branches out as long as the writing keeps its size.
  for (const vg of [1.7, 2.5, 3.3]) {
    const r = mindmapOnce(root, font, o, best.wf, best.oneSided, vg);
    if (r.scale < best.scale * 0.99) break;
    best = r;
  }
  return { pages: best.pages, missing: best.missing, shrunk: best.scale < 0.95 };
}

function mindmapOnce(root, font, o, wf, oneSided, vg) {
  const base = opts(o);
  const W = makeWriter(font, base);
  const rng = mulberry32((base.seed ^ 0x2545f491) >>> 0);
  const m = base.messiness;
  const cap = o.cap;
  const strokes = [];

  // ---- measure
  const capAt = (d) => (d === 0 ? cap * 1.45 : d === 1 ? cap * 1.1 : cap * 0.92);
  const widthAt = (d) => (d === 0 ? capAt(0) * 9 : (d === 1 ? capAt(1) * 10 : capAt(d) * 12) * wf);
  const hgap = cap * 2.4;
  const vgap = cap * 0.8 * vg;
  const pre = (node, depth, side) => {
    node.depth = depth;
    node.side = side;
    node.cap = capAt(depth);
    node.text = W.block(node.label, node.cap, widthAt(depth), depth === 0 ? 'center' : side < 0 ? 'right' : 'left');
    node.ulen = node.text.w + node.cap * 0.7;
    node.h = node.text.h + node.cap * 0.35;
    node.children.forEach((c) => pre(c, depth + 1, side));
    const kids = node.children.reduce((a, c) => a + c.sh, 0) + vgap * Math.max(0, node.children.length - 1);
    node.sh = Math.max(node.h, kids);
  };

  // centre
  root.depth = 0;
  root.cap = capAt(0);
  root.text = W.block(root.label, root.cap, widthAt(0), 'center');
  const rx = root.text.w / 2 + root.cap * 0.9;
  const ry = root.text.h / 2 + root.cap * 0.65;

  // ---- split main branches: right side top→bottom, then left side bottom→top (clockwise)
  const branches = root.children;
  branches.forEach((c, i) => {
    c.color = o.colorful ? PALETTE[i % PALETTE.length] : null;
    pre(c, 1, 1);
  });
  const total = branches.reduce((a, c) => a + c.sh, 0);
  // first k branches go right: pick k so that both sides are about equally tall
  let k = Math.min(1, branches.length), acc = 0, bestDiff = Infinity;
  for (let i = 1; i <= Math.max(1, branches.length - 1) && i <= branches.length; i++) {
    acc += branches[i - 1].sh;
    const diff = Math.abs(total - 2 * acc);
    if (diff < bestDiff) [bestDiff, k] = [diff, i];
  }
  if (oneSided) k = branches.length;
  const right = branches.slice(0, k);
  const left = branches.slice(k).reverse();
  left.forEach((c) => pre(c, 1, -1)); // re-measure with right-aligned labels
  branches.forEach((c, i) => setColor(c, o.colorful ? PALETTE[i % PALETTE.length] : null));

  // ---- place
  const place = (node, xNear, yTop) => {
    const s = node.side;
    node.cy = yTop + node.sh / 2;
    node.yLine = node.cy + node.h / 2;
    node.xNear = xNear;
    node.xFar = xNear + s * node.ulen;
    const kids = node.children.reduce((a, c) => a + c.sh, 0) + vgap * Math.max(0, node.children.length - 1);
    let y = yTop + (node.sh - kids) / 2;
    for (const c of node.children) {
      place(c, node.xFar + s * hgap, y);
      y += c.sh + vgap;
    }
  };
  const sideHeight = (list) => list.reduce((a, c) => a + c.sh, 0) + vgap * Math.max(0, list.length - 1);
  const placeSide = (list, s) => {
    let y = -sideHeight(list) / 2;
    for (const c of list) {
      place(c, s * (rx + hgap * 1.2), y);
      y += c.sh + vgap;
    }
  };
  placeSide(right, 1);
  placeSide(left, -1);

  // ---- draw
  strokes.push(...translate(root.text.strokes, -root.text.maxWidth / 2, -root.text.h / 2 + root.cap * 0.1));
  strokes.push(handEllipse(0, 0, rx, ry, rng, m));
  const connect = (from, node) => {
    const to = [node.xNear, node.yLine];
    const dx = to[0] - from[0];
    const path = bezier(from, [from[0] + dx * 0.5, from[1]], [to[0] - dx * 0.45, to[1]], to);
    strokes.push(paint([handPath(path, rng, m * 0.6)], node.color)[0]);
  };
  const draw = (node, from) => {
    connect(from, node);
    strokes.push(paint([handPath([[node.xNear, node.yLine], [node.xFar, node.yLine]], rng, m * 0.5)], node.color)[0]);
    const tx = node.side > 0 ? node.xNear + node.cap * 0.35 : node.xNear - node.cap * 0.35 - node.text.maxWidth;
    strokes.push(...translate(node.text.strokes, tx, node.yLine - node.cap * 0.2 - node.text.h));
    for (const c of node.children) draw(c, [node.xFar, node.yLine]);
  };
  for (const c of branches) {
    // start on the ellipse, in the direction of the branch
    const dx = c.xNear, dy = c.yLine;
    const t = Math.atan2(dy / ry, dx / rx);
    draw(c, [Math.cos(t) * rx, Math.sin(t) * ry]);
  }

  // ---- fit to the page: shrink if needed, centre horizontally, start at the top margin
  const bb = bbox(strokes);
  const mg = Math.max(3, o.margin);
  const aw = o.page.w - 2 * mg, ah = o.page.h - 2 * mg;
  // small maps may grow a bit to use the page, big ones shrink until they fit
  const sc = bb ? Math.min(1.4, aw / bb.w, ah / bb.h) : 1;
  const ox = bb ? mg + (aw - bb.w * sc) / 2 - bb.x0 * sc : 0;
  const oy = bb ? mg - bb.y0 * sc : 0;
  const placed = transformAll(strokes, (x, y) => [x * sc + ox, y * sc + oy]);
  return { pages: [{ strokes: placed }], missing: W.missing, scale: sc, wf, oneSided };
}

function setColor(node, color) {
  node.color = color;
  node.children.forEach((c) => setColor(c, color));
}
