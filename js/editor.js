// "Meine Schrift": draw each character a few times with Apple Pencil / mouse.
import { GROUPS as ALL_GROUPS, HINTS } from './charset.js';
import { simplify, roundStroke, toQuads, cleanStroke } from './geom.js';
import { toast } from './util.js';

// Visible glyph area in glyph units (baseline 0, cap line -1).
const VIEW = { x0: -0.35, x1: 1.85, y0: -1.45, y1: 0.75 };
const TARGET_VARIANTS = 3;
// Characters that reach up to the top line (capitals, digits, ascenders) vs. small letters.
const TALL = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789bdfhklß']);
const SMALL = new Set([...'acemnorsuvwxzäöü']);

export function createEditor({ getFont, saveFont, onChange }) {
  const pad = document.getElementById('pad');
  const ctx = pad.getContext('2d');
  const curEl = document.getElementById('cur-char');
  const hintEl = document.getElementById('cur-hint');
  const variantsEl = document.getElementById('variants');
  const charsetEl = document.getElementById('charset');
  const progressEl = document.getElementById('font-progress');
  const autoNext = document.getElementById('auto-next');

  // 'print' = Druckschrift (all characters), 'cursive' = Schreibschrift (letters only;
  // digits and punctuation come from the Druckschrift)
  let mode = 'print';
  let GROUPS = ALL_GROUPS;
  let ALL_CHARS = GROUPS.flatMap((g) => [...g.chars]);
  let current = ALL_CHARS[0];
  let strokes = []; // strokes being drawn (glyph units)
  let active = null;
  let penSeen = false;
  let dpr = 1;

  // ---------- coordinate mapping
  const view = () => {
    const r = pad.getBoundingClientRect();
    const sx = r.width / (VIEW.x1 - VIEW.x0);
    const sy = r.height / (VIEW.y1 - VIEW.y0);
    const s = Math.min(sx, sy);
    const ox = (r.width - (VIEW.x1 - VIEW.x0) * s) / 2;
    const oy = (r.height - (VIEW.y1 - VIEW.y0) * s) / 2;
    return { r, s, ox, oy };
  };
  const toGlyph = (e) => {
    const v = view();
    return [(e.clientX - v.r.left - v.ox) / v.s + VIEW.x0, (e.clientY - v.r.top - v.oy) / v.s + VIEW.y0];
  };
  const toPx = (x, y, v) => [(x - VIEW.x0) * v.s + v.ox, (y - VIEW.y0) * v.s + v.oy];

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = pad.getBoundingClientRect();
    pad.width = Math.round(r.width * dpr);
    pad.height = Math.round(r.height * dpr);
    draw();
  }

  // ---------- drawing
  function draw() {
    const v = view();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.r.width, v.r.height);
    const line = (y, color, width, dash) => {
      const [x1, py] = toPx(VIEW.x0, y, v);
      const [x2] = toPx(VIEW.x1, y, v);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x1, py);
      ctx.lineTo(x2, py);
      ctx.stroke();
      ctx.restore();
    };
    // shade the zone the character should fill: tall ones up to the top line
    const zone = TALL.has(current) ? -1 : SMALL.has(current) ? -0.5 : null;
    if (zone != null) {
      const [zx0, zy0] = toPx(VIEW.x0, zone, v);
      const [zx1, zy1] = toPx(VIEW.x1, 0, v);
      ctx.save();
      ctx.fillStyle = zone === -1 ? 'rgba(43, 74, 203, 0.07)' : 'rgba(29, 122, 70, 0.07)';
      ctx.fillRect(zx0, zy0, zx1 - zx0, zy1 - zy0);
      ctx.restore();
    }
    line(-1, zone === -1 ? '#8fa3d9' : '#c9d3df', zone === -1 ? 2 : 1.2);
    line(-0.5, '#d6dde6', 1.2, [6, 6]);
    line(0, '#7f97b2', 2.2);
    line(0.5, '#d6dde6', 1.2, [2, 5]);
    // left guide
    const [gx] = toPx(0, 0, v);
    ctx.save();
    ctx.strokeStyle = '#eef1f5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, v.r.height);
    ctx.stroke();
    ctx.restore();
    // ghost of the character
    ctx.save();
    ctx.fillStyle = 'rgba(40, 60, 90, 0.06)';
    const family =
      mode === 'cursive'
        ? '"Snell Roundhand", "Apple Chancery", "Brush Script MT", "Segoe Script", cursive'
        : '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
    let size = v.s * 1.05;
    // size the example so it fills exactly the shaded zone (capitals up to the top line)
    if (zone != null) {
      ctx.font = `${size}px ${family}`;
      const asc = ctx.measureText(current).actualBoundingBoxAscent;
      if (asc > 0) size *= (-zone * v.s) / asc;
    }
    ctx.font = `${size}px ${family}`;
    ctx.textBaseline = 'alphabetic';
    const [tx, ty] = toPx(0.05, 0, v);
    ctx.fillText(current === '¨' ? '¨' : current, tx, ty);
    ctx.restore();
    // ink
    ctx.strokeStyle = '#1b2a4a';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) drawStroke(s, v);
    if (active) drawStroke(active, v);
  }

  function drawStroke(s, v) {
    ctx.lineWidth = Math.max(2, v.s * 0.035);
    const q = toQuads(s);
    ctx.beginPath();
    const [sx, sy] = toPx(q.start[0], q.start[1], v);
    ctx.moveTo(sx, sy);
    for (const [cx, cy, x, y] of q.segs) {
      const [a, b] = toPx(cx, cy, v);
      const [c, d] = toPx(x, y, v);
      ctx.quadraticCurveTo(a, b, c, d);
    }
    ctx.stroke();
  }

  // ---------- pointer input
  pad.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    if (e.pointerType === 'touch' && penSeen) return; // palm rejection
    e.preventDefault();
    try {
      pad.setPointerCapture(e.pointerId);
    } catch (_) {
      /* pointer already gone */
    }
    const [x, y] = toGlyph(e);
    active = [x, y, pressureOf(e)];
    active.pointerId = e.pointerId;
    active.t = e.timeStamp;
    draw();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      // iPad Safari repeats older coalesced points – only take newer ones.
      if (ev.timeStamp <= active.t) continue;
      active.t = ev.timeStamp;
      const [x, y] = toGlyph(ev);
      const n = active.length;
      if (Math.hypot(x - active[n - 3], y - active[n - 2]) < 0.004) continue;
      active.push(x, y, pressureOf(ev));
    }
    draw();
  });
  const end = (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    const s = roundStroke(simplify(cleanStroke(active), 0.0035), 4);
    strokes.push(s);
    active = null;
    draw();
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  function pressureOf(e) {
    if (e.pointerType === 'pen' && e.pressure > 0) return Math.round(e.pressure * 1000) / 1000;
    return 0.5;
  }

  // ---------- actions
  async function saveVariant() {
    if (!strokes.length) {
      toast('Erst das Zeichen schreiben, dann speichern.');
      return;
    }
    const font = getFont();
    (font.glyphs[current] ||= []).push({ s: strokes });
    strokes = [];
    await saveFont();
    renderVariants();
    renderCharset();
    draw();
    onChange();
    if (autoNext.checked && font.glyphs[current].length >= TARGET_VARIANTS) select(nextChar(1, true));
  }

  function undo() {
    strokes.pop();
    draw();
  }

  function clear() {
    strokes = [];
    draw();
  }

  function nextChar(dir, skipDone = false) {
    const font = getFont();
    let i = ALL_CHARS.indexOf(current);
    for (let k = 0; k < ALL_CHARS.length; k++) {
      i = (i + dir + ALL_CHARS.length) % ALL_CHARS.length;
      if (!skipDone || (font.glyphs[ALL_CHARS[i]] || []).length < TARGET_VARIANTS) return ALL_CHARS[i];
    }
    return ALL_CHARS[(ALL_CHARS.indexOf(current) + dir + ALL_CHARS.length) % ALL_CHARS.length];
  }

  function select(ch) {
    current = ch;
    strokes = [];
    curEl.textContent = ch === ' ' ? '␣' : ch;
    hintEl.textContent =
      (mode === 'cursive' && ch !== '¨'
        ? `Schreibschrift: ${/[A-ZÄÖÜ]/.test(ch) ? 'Großbuchstabe bis zur oberen Linie. ' : ''}Fang unten links mit dem Anstrich an und hör rechts mit dem Abstrich auf – wie im Heft. Die App verbindet die Buchstaben selbst.`
        : null) ||
      HINTS[ch] ||
      (/[A-ZÄÖÜ]/.test(ch)
        ? 'Großbuchstabe: von der dicken Grundlinie bis ganz nach oben zur oberen Linie – deutlich größer als die Kleinbuchstaben.'
        : TALL.has(ch)
          ? 'Hohes Zeichen: von der Grundlinie bis zur oberen Linie.'
          : SMALL.has(ch)
            ? 'Kleinbuchstabe: zwischen der gestrichelten Mittellinie und der dicken Grundlinie.'
            : 'Schreib das Zeichen so, wie du es immer schreibst. Die dicke Linie ist die Grundlinie.');
    renderVariants();
    renderCharset();
    draw();
  }

  function renderVariants() {
    const list = getFont().glyphs[current] || [];
    variantsEl.innerHTML = '';
    if (!list.length) {
      variantsEl.innerHTML = `<p class="muted small">Noch keine Variante. Ziel: ${TARGET_VARIANTS} Stück, damit nicht jeder Buchstabe gleich aussieht.</p>`;
      return;
    }
    list.forEach((variant, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'variant';
      const c = document.createElement('canvas');
      c.width = 132;
      c.height = 132;
      thumb(c, variant.s);
      const del = document.createElement('button');
      del.className = 'variant-del';
      del.title = 'Variante löschen';
      del.textContent = '×';
      del.onclick = async () => {
        list.splice(idx, 1);
        if (!list.length) delete getFont().glyphs[current];
        await saveFont();
        renderVariants();
        renderCharset();
        onChange();
      };
      wrap.append(c, del);
      variantsEl.append(wrap);
    });
  }

  function thumb(canvas, glyphStrokes) {
    const c = canvas.getContext('2d');
    const s = canvas.width / (VIEW.x1 - VIEW.x0);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.strokeStyle = '#c5d0dc';
    c.lineWidth = 1;
    const by = (0 - VIEW.y0) * s;
    c.beginPath();
    c.moveTo(0, by);
    c.lineTo(canvas.width, by);
    c.stroke();
    c.strokeStyle = '#1b2a4a';
    c.lineWidth = 2.2;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const st of glyphStrokes) {
      const q = toQuads(st);
      c.beginPath();
      c.moveTo((q.start[0] - VIEW.x0) * s, (q.start[1] - VIEW.y0) * s);
      for (const [cx, cy, x, y] of q.segs) c.quadraticCurveTo((cx - VIEW.x0) * s, (cy - VIEW.y0) * s, (x - VIEW.x0) * s, (y - VIEW.y0) * s);
      c.stroke();
    }
  }

  function renderCharset() {
    const font = getFont();
    charsetEl.innerHTML = '';
    let done = 0;
    for (const g of GROUPS) {
      const h = document.createElement('h4');
      h.textContent = g.name;
      const grid = document.createElement('div');
      grid.className = 'charset-grid';
      for (const ch of g.chars) {
        const n = (font.glyphs[ch] || []).length;
        if (n) done++;
        const b = document.createElement('button');
        b.className = 'char' + (ch === current ? ' current' : '') + (n >= TARGET_VARIANTS ? ' done' : n ? ' partial' : '');
        b.innerHTML = `<span>${ch === '¨' ? '¨' : escapeHtml(ch)}</span>${n ? `<i>${n}</i>` : ''}`;
        b.title = n ? `${n} Variante(n)` : 'noch nicht gezeichnet';
        b.onclick = () => select(ch);
        grid.append(b);
      }
      charsetEl.append(h, grid);
    }
    progressEl.innerHTML = `<b>${done}</b> von ${ALL_CHARS.length} Zeichen gezeichnet`;
    progressEl.style.setProperty('--p', `${(done / ALL_CHARS.length) * 100}%`);
  }

  document.getElementById('pad-save').onclick = saveVariant;
  document.getElementById('pad-undo').onclick = undo;
  document.getElementById('pad-clear').onclick = clear;
  document.getElementById('prev-char').onclick = () => select(nextChar(-1));
  document.getElementById('next-char').onclick = () => select(nextChar(1));

  window.addEventListener('keydown', (e) => {
    if (!document.getElementById('tab-font').classList.contains('active')) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'Enter') { e.preventDefault(); saveVariant(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') clear();
    else if (e.key === 'ArrowRight') select(nextChar(1));
    else if (e.key === 'ArrowLeft') select(nextChar(-1));
  });

  new ResizeObserver(resize).observe(pad);

  let shown = false;
  return {
    show() {
      if (!shown) {
        shown = true;
        select(ALL_CHARS.find((c) => (getFont().glyphs[c] || []).length < TARGET_VARIANTS) || current);
      }
      resize();
      renderCharset();
      renderVariants();
    },
    refresh() {
      renderCharset();
      renderVariants();
      draw();
    },
    select,
    /** Switch between Druckschrift and Schreibschrift (getFont must follow). */
    setMode(m) {
      mode = m === 'cursive' ? 'cursive' : 'print';
      GROUPS = mode === 'cursive' ? ALL_GROUPS.slice(0, 3) : ALL_GROUPS; // letters, umlauts, ß
      ALL_CHARS = GROUPS.flatMap((g) => [...g.chars]);
      const font = getFont();
      select(ALL_CHARS.find((c) => (font.glyphs[c] || []).length < TARGET_VARIANTS) || ALL_CHARS[0]);
    },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
