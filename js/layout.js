// Text → positioned handwriting strokes (page coordinates in mm).
//
// Glyph coordinates (as drawn in the editor): baseline y = 0, cap line y = -1,
// x-height y = -0.5, descender y = +0.5; y grows downwards.

import { mulberry32 } from './util.js';
import { bbox, wobble, cleanStroke } from './geom.js';

// Glyphs drawn on iPad may contain late duplicate Pencil points – clean once per stroke.
const cleaned = new WeakMap();
const clean = (strokes) => {
  let c = cleaned.get(strokes);
  if (!c) cleaned.set(strokes, (c = strokes.map(cleanStroke)));
  return c;
};
import { COMPOSE } from './charset.js';

const DEG = Math.PI / 180;

// ---- letter heights
// Capitals, digits and ascender letters must stand clearly taller than "a, c, e, …".
// Glyphs that were drawn too small (e.g. capitals as small as lower-case letters)
// are enlarged at layout time, measured against the user's own x-height.
const SMALL = 'acemnorsuvwxz';
const TALL = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789bdhkl']);
const MIN_TALL = 1.45; // tall glyph must be at least this × x-height …
const TARGET_TALL = 1.75; // … otherwise it is enlarged to this × x-height
const heightAbove = (strokes) => {
  const bb = bbox(strokes);
  return bb ? -bb.y0 : 0;
};

/** Median height of the user's small letters (glyph units), 0.5 if unknown. */
export function xHeightOf(font) {
  const hs = [];
  for (const ch of SMALL) for (const v of font.glyphs[ch] || []) {
    const h = heightAbove(clean(v.s));
    if (h > 0.05) hs.push(h);
  }
  if (!hs.length) return 0.5;
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}

/** Scale factor that makes a too-small tall glyph tall enough (1 = keep). */
export function tallFix(ch, strokes, xh) {
  if (!TALL.has(ch)) return 1;
  const h = heightAbove(strokes);
  if (h <= 0.05 || h >= xh * MIN_TALL) return 1;
  return Math.min(2.2, (xh * TARGET_TALL) / h);
}

const scaleStrokes = (strokes, f) => (f === 1 ? strokes : strokes.map((st) => st.map((v, i) => (i % 3 === 2 ? v : v * f))));

/**
 * @param {string} text  normalised text
 * @param {object} font  { glyphs: { [char]: [{ s: number[][] }] } }
 * @param {object} o     { page:{w,h}, geo:{spacing,left,right,bottom,firstBaseline},
 *                         capHeight, messiness(0..1), slant(deg), letterSpacing, wordSpacing, seed,
 *                         align?: 'left'|'center'|'right' (within geo.left..geo.right) }
 * @returns {{ pages: { strokes: number[][] }[], missing: Set<string>, lines: number }}
 */
export function layoutText(text, font, o) {
  const rng = mulberry32(o.seed || 1);
  const m = o.messiness;
  const cap = o.capHeight;
  const missing = new Set();
  const lastVariant = new Map();
  const slantTan = Math.tan((o.slant || 0) * DEG);
  const xh = xHeightOf(font);
  // how strongly line starts and word heights vary: 1 at the default messiness (35 %)
  const vary = Math.min(1.8, m / 0.35) * (o.indentJitter ?? 1);

  const pages = [{ strokes: [] }];
  let page = pages[0];
  let lineIdx = 0;
  let lineCount = 0;

  const baselineY = () => o.geo.firstBaseline + lineIdx * o.geo.spacing;
  const newLine = () => {
    lineIdx++;
    if (baselineY() > o.geo.bottom) {
      page = { strokes: [] };
      pages.push(page);
      lineIdx = 0;
    }
  };

  // ---- build one glyph instance (strokes in mm, relative to baseline origin)
  function variantsFor(ch) {
    const v = font.glyphs[ch];
    return v && v.length ? v : null;
  }

  function pickVariant(ch, list) {
    if (list.length === 1) return list[0];
    const last = lastVariant.get(ch);
    let i = Math.floor(rng() * list.length);
    if (i === last) i = (i + 1 + Math.floor(rng() * (list.length - 1))) % list.length;
    lastVariant.set(ch, i);
    return list[i];
  }

  function rawStrokesFor(ch) {
    const list = variantsFor(ch);
    if (list) {
      const st = clean(pickVariant(ch, list).s);
      return scaleStrokes(st, tallFix(ch, st, xh));
    }
    const comp = COMPOSE[ch];
    if (comp) {
      const base = variantsFor(comp[0]);
      const dots = variantsFor(comp[1]);
      if (base && dots) {
        let b = clean(pickVariant(comp[0], base).s);
        b = scaleStrokes(b, tallFix(comp[0], b, xh));
        const d = clean(pickVariant(comp[1], dots).s);
        const bb = bbox(b), db = bbox(d);
        const dx = (bb.x0 + bb.x1) / 2 - (db.x0 + db.x1) / 2;
        // dots are drawn above a small letter; over a capital they go up by the height difference
        const dy = comp[2] ? Math.min(0, bb.y0 + xh) : 0;
        const moved = d.map((s) => s.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v)));
        return [...b, ...moved];
      }
    }
    return null;
  }

  function makeGlyph(ch) {
    const raw = rawStrokesFor(ch);
    if (!raw) {
      missing.add(ch);
      return null;
    }
    const s = cap * (1 + (rng() - 0.5) * 2 * 0.06 * m);
    const rot = (rng() - 0.5) * 2 * 2.5 * DEG * m;
    const dy = (rng() - 0.5) * 2 * 0.035 * m; // in cap units
    const wob = wobble(rng, 0.018 * m);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const strokes = raw.map((st) => {
      const out = new Array(st.length);
      for (let i = 0; i < st.length; i += 3) {
        let x = st[i], y = st[i + 1];
        const w = wob(x, y);
        x += w[0];
        y += w[1] + dy;
        x -= y * slantTan; // slant (y is negative above the baseline)
        const rx = x * cr - y * sr, ry = x * sr + y * cr;
        out[i] = rx * s;
        out[i + 1] = ry * s;
        out[i + 2] = st[i + 2];
      }
      return out;
    });
    const bb = bbox(strokes);
    return { strokes, x0: bb.x0, x1: bb.x1 };
  }

  // ---- words → glyph runs
  const letterGap = () => cap * (0.11 * (o.letterSpacing ?? 1) + (rng() - 0.5) * 0.06 * m);
  const spaceWidth = () => cap * 0.5 * (o.wordSpacing ?? 1) * (1 + (rng() - 0.5) * 0.35 * m);
  // Every line starts a little left or right of the margin – a ruler along the
  // line starts would give away that it's generated.
  const lineStart = () => o.geo.left + (rng() - 0.4) * cap * 0.55 * vary;
  // Words sit slightly higher or lower; now and then one jumps a bit more.
  const wordShift = () => {
    let d = (rng() - 0.5) * 2 * 0.045 * cap;
    if (rng() < 0.22) d += (rng() < 0.5 ? -1 : 1) * (0.05 + 0.05 * rng()) * cap;
    return d * vary;
  };

  function buildWord(word) {
    const items = [];
    let x = 0;
    for (const ch of word) {
      const g = makeGlyph(ch);
      if (!g) {
        x += cap * 0.55;
        continue;
      }
      const shift = (items.length ? x + letterGap() : x) - g.x0;
      items.push({ g, shift });
      x = shift + g.x1;
    }
    return { items, width: x };
  }

  // ---- place lines
  let lineItems = [];
  function flushLine() {
    if (!lineItems.length) return;
    const slope = (rng() - 0.5) * 2 * 0.012 * m;
    const waveAmp = cap * 0.045 * m;
    const waveLen = 60 + rng() * 80;
    const phase = rng() * 6.283;
    const by = baselineY();
    let shift = 0;
    if (o.align === 'center' || o.align === 'right') {
      const x1 = Math.max(...lineItems.map((it) => it.x1));
      const free = o.geo.right - x1;
      if (free > 0) shift = o.align === 'center' ? free / 2 - (lineItems[0].x0 - o.geo.left) / 2 : free;
    }
    for (const it of lineItems) {
      for (const st of it.strokes) {
        const out = new Array(st.length);
        for (let i = 0; i < st.length; i += 3) {
          const x = st[i] + it.x + shift;
          const rel = x - o.geo.left;
          out[i] = x;
          out[i + 1] = st[i + 1] + it.dy + by + slope * rel + waveAmp * Math.sin((rel / waveLen) * 6.283 + phase);
          out[i + 2] = st[i + 2];
        }
        page.strokes.push(out);
      }
    }
    lineItems = [];
  }

  const paragraphs = text.split('\n');
  paragraphs.forEach((para, pi) => {
    if (pi > 0) newLine();
    lineCount++;
    let x = lineStart();
    const words = para.split(/ +/);
    let first = true;
    for (const word of words) {
      if (!word) continue;
      const w = buildWord(word);
      const dy = wordShift();
      const gap = first ? 0 : spaceWidth();
      if (!first && x + gap + w.width > o.geo.right) {
        flushLine();
        newLine();
        lineCount++;
        x = lineStart();
      } else {
        x += gap;
      }
      // very long word: break it across lines letter by letter
      for (const it of w.items) {
        const gx = x + it.shift;
        if (gx + it.g.x1 > o.geo.right && it !== w.items[0] && gx > o.geo.left + cap) {
          flushLine();
          newLine();
          lineCount++;
          x = o.geo.left - it.shift - it.g.x0;
        }
        lineItems.push({ strokes: it.g.strokes, dy, x: x + it.shift, x0: x + it.shift + it.g.x0, x1: x + it.shift + it.g.x1 });
      }
      x += w.width;
      first = false;
    }
    flushLine();
  });

  return { pages, missing, lines: lineCount };
}
