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

/** Median height of the small letters of a glyph set (glyph units), 0.5 if unknown. */
export function xHeightOf(glyphs) {
  const hs = [];
  for (const ch of SMALL) for (const v of glyphs[ch] || []) {
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

const LETTER = /^[A-Za-zÄÖÜäöüß]$/;

// ---- Schreibschrift: where a letter is left (exit) and entered (entry)
const strokeLen = (s) => {
  let l = 0;
  for (let i = 3; i < s.length; i += 3) l += Math.hypot(s[i] - s[i - 3], s[i + 1] - s[i - 2]);
  return l;
};
function direction(s, fromEnd) {
  const n = s.length / 3;
  const k = Math.min(n - 1, 3);
  if (k < 1) return [1, 0];
  const a = fromEnd ? n - 1 - k : 0, b = fromEnd ? n - 1 : k;
  const dx = s[b * 3] - s[a * 3], dy = s[b * 3 + 1] - s[a * 3 + 1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}
/**
 * Exit = end of the main (longest) stroke if it ends on the right, else the stroke
 * ending furthest right; entry = start of the first stroke if it starts on the left.
 * Dots, accents and t-bars are drawn later and are short, so they are skipped.
 * Only joins in the lower zone (baseline … a bit above the x-height) count.
 */
function joints(strokes, x0, x1, cap) {
  if (!strokes.length) return {};
  const lens = strokes.map(strokeLen);
  const max = Math.max(...lens);
  const cands = strokes.map((s, i) => i).filter((i) => lens[i] >= max * 0.3 && strokes[i].length >= 6);
  if (!cands.length) return {};
  const w = x1 - x0 || 1;
  const endX = (i) => strokes[i][strokes[i].length - 3];
  const main = lens.indexOf(max);
  let ex = endX(main) >= x0 + 0.55 * w ? main : cands.reduce((a, b) => (endX(b) > endX(a) ? b : a));
  let en = cands.includes(0) && strokes[0][0] <= x0 + 0.45 * w ? 0 : cands.reduce((a, b) => (strokes[b][0] < strokes[a][0] ? b : a));
  const inZone = (y) => y <= 0.2 * cap && y >= -0.85 * cap;
  const out = {};
  const se = strokes[ex], n = se.length;
  if (inZone(se[n - 2]) && se[n - 3] >= x0 + 0.5 * w) out.exit = { x: se[n - 3], y: se[n - 2], p: se[n - 1], dir: direction(se, true) };
  const sn = strokes[en];
  if (inZone(sn[1]) && sn[0] <= x0 + 0.5 * w) out.entry = { x: sn[0], y: sn[1], p: sn[2], dir: direction(sn, false) };
  return out;
}

/** Smooth hand-drawn join from the exit of one letter to the entry of the next. */
function joinStroke(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  // never shoot backwards: blend odd directions towards "to the right"
  const fix = (d) => {
    let [x, y] = d;
    if (x < 0.3) x = 0.3 + Math.max(0, x) * 0.5;
    const l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  const da = fix(a.dir), db = fix(b.dir);
  const L = Math.max(dist * 0.42, 0.01);
  const p1 = [a.x + da[0] * L, a.y + da[1] * L], p2 = [b.x - db[0] * L, b.y - db[1] * L];
  const n = Math.max(4, Math.round(dist * 2.5));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(
      u * u * u * a.x + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * b.y,
      a.p + (b.p - a.p) * t,
    );
  }
  return out;
}

const scaleStrokes = (strokes, f) => (f === 1 ? strokes : strokes.map((st) => st.map((v, i) => (i % 3 === 2 ? v : v * f))));

/**
 * @param {string} text  normalised text
 * @param {object} font  { glyphs: { [char]: [{ s: number[][] }] } }
 * @param {object} o     { page:{w,h}, geo:{spacing,left,right,bottom,firstBaseline},
 *                         capHeight, messiness(0..1), slant(deg), letterSpacing, wordSpacing, seed,
 *                         align?: 'left'|'center'|'right' (within geo.left..geo.right),
 *                         cursive?: true → Schreibschrift: font.cursive.glyphs, letters joined }
 * @returns {{ pages: { strokes: number[][] }[], missing: Set<string>, lines: number }}
 */
export function layoutText(text, font, o) {
  const rng = mulberry32(o.seed || 1);
  const m = o.messiness;
  const cap = o.capHeight;
  const missing = new Set();
  const lastVariant = new Map();
  const slantTan = Math.tan((o.slant || 0) * DEG);
  // Schreibschrift uses its own glyph set; digits, punctuation and letters not drawn
  // yet come from the Druckschrift (missing letters are still reported).
  const cursive = !!o.cursive;
  const glyphs = cursive ? (font.cursive && font.cursive.glyphs) || {} : font.glyphs;
  const xh = xHeightOf(Object.keys(glyphs).some((c) => SMALL.includes(c)) ? glyphs : font.glyphs);
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
    const v = glyphs[ch];
    if (v && v.length) return v;
    if (!cursive) return null;
    if (COMPOSE[ch] && glyphs[COMPOSE[ch][0]]) return null; // ä from the cursive a + dots
    const p = font.glyphs[ch];
    if (!p || !p.length) return null;
    if (LETTER.test(ch)) missing.add(ch); // only drawn in Druckschrift so far
    return p;
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
    const g = { strokes, x0: bb.x0, x1: bb.x1 };
    if (cursive && LETTER.test(ch)) Object.assign(g, joints(strokes, bb.x0, bb.x1, cap));
    return g;
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

  // Schreibschrift: letters sit closer, the join bridges the small gap
  const joinGap = () => cap * (0.07 * (o.letterSpacing ?? 1) + (rng() - 0.5) * 0.04 * m);

  function buildWord(word) {
    const items = [];
    let x = 0;
    let prev = null; // previous item, if the next letter may join it
    for (const ch of word) {
      const g = makeGlyph(ch);
      if (!g) {
        x += cap * 0.55;
        prev = null;
        continue;
      }
      let shift = (items.length ? x + letterGap() : x) - g.x0;
      let join = null;
      if (prev && prev.g.exit && g.entry) {
        const ex = prev.shift + prev.g.exit.x;
        // join point a little right of the exit, but the letters' bodies must not collide
        shift = Math.max(ex + joinGap() - g.entry.x, x - cap * 0.12 - g.x0);
        const a = { ...prev.g.exit, x: ex };
        const b = { ...g.entry, x: g.entry.x + shift };
        if (Math.hypot(b.x - a.x, b.y - a.y) > cap * 0.02) join = joinStroke(a, b);
      }
      const it = { g, shift, join };
      items.push(it);
      x = shift + g.x1;
      prev = it;
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
      let broke = false; // a letter-wise line break cuts the join to the next letter
      for (const it of w.items) {
        const gx = x + it.shift;
        if (gx + it.g.x1 > o.geo.right && it !== w.items[0] && gx > o.geo.left + cap) {
          flushLine();
          newLine();
          lineCount++;
          x = o.geo.left - it.shift - it.g.x0;
          broke = true;
        }
        if (it.join && !broke) {
          // join strokes are in word coordinates
          let jx0 = Infinity, jx1 = -Infinity;
          for (let i = 0; i < it.join.length; i += 3) (jx0 = Math.min(jx0, it.join[i])), (jx1 = Math.max(jx1, it.join[i]));
          lineItems.push({ strokes: [it.join], dy, x, x0: x + jx0, x1: x + jx1 });
        }
        broke = false;
        lineItems.push({ strokes: it.g.strokes, dy, x: x + it.shift, x0: x + it.shift + it.g.x0, x1: x + it.shift + it.g.x1 });
      }
      x += w.width;
      first = false;
    }
    flushLine();
  });

  return { pages, missing, lines: lineCount };
}
