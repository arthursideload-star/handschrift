// "Schreibblatt": a printable/importable A4 sheet with one box per character × 3
// variants. The user fills it in GoodNotes with the ballpoint pen and exports the
// notebook; we read the real strokes back and sort them into the boxes by position.
// No handwriting recognition: which box a stroke lies in tells us the character.

import { ALL_CHARS } from './charset.js';
import { buildPdf, pdfText, pdfRect, pdfLine, PT_PER_MM } from './pdf.js';
import { simplify, roundStroke } from './geom.js';
import { readNotebook } from './goodnotes.js';

// All sheet measures in mm, origin top-left. Inside a cell (relative to cell.y):
// cap line 6.5, x-height 10.5, baseline 14.5, descender 18.5 → cap height 8 mm,
// which matches the editor's glyph units (baseline 0, cap -1, x-height -0.5, desc 0.5).
export const SHEET = {
  w: 210,
  h: 297,
  margin: 12,
  top: 24,
  cols: 9,
  variants: 3,
  rows: 12,
  cellH: 20.5,
  cap: 6.5,
  xHeight: 10.5,
  baseline: 14.5,
  descender: 18.5,
  originX: 3,
  unit: 8, // mm per glyph unit
};
SHEET.cellW = (SHEET.w - 2 * SHEET.margin) / SHEET.cols;
SHEET.charsPerRow = SHEET.cols / SHEET.variants;
SHEET.charsPerPage = SHEET.charsPerRow * SHEET.rows;
SHEET.pages = Math.ceil(ALL_CHARS.length / SHEET.charsPerPage);

const GN_MM = 25.4 / 132; // mm per GoodNotes unit (GoodNotes unit = pt × 132/72)

/** Every box on the sheet: { char, variant, page, row, col, x, y, w, h }. */
export function sheetCells() {
  const cells = [];
  ALL_CHARS.forEach((char, i) => {
    const page = Math.floor(i / SHEET.charsPerPage);
    const k = i % SHEET.charsPerPage;
    const row = Math.floor(k / SHEET.charsPerRow);
    for (let v = 0; v < SHEET.variants; v++) {
      const col = (k % SHEET.charsPerRow) * SHEET.variants + v;
      cells.push({
        char,
        variant: v,
        page,
        row,
        col,
        x: SHEET.margin + col * SHEET.cellW,
        y: SHEET.top + row * SHEET.cellH,
        w: SHEET.cellW,
        h: SHEET.cellH,
      });
    }
  });
  return cells;
}

const CELLS = sheetCells();
const CELL_INDEX = new Map(CELLS.map((c) => [`${c.page}|${c.row}|${c.col}`, c]));

/** Box under a point (mm) on sheet page `page`, or null. */
export function cellAt(page, x, y) {
  const col = Math.floor((x - SHEET.margin) / SHEET.cellW);
  const row = Math.floor((y - SHEET.top) / SHEET.cellH);
  if (col < 0 || col >= SHEET.cols || row < 0 || row >= SHEET.rows) return null;
  return CELL_INDEX.get(`${page}|${row}|${col}`) || null;
}

const LABEL = { '¨': '¨ Punkte', ' ': '' };
// pdfRect doesn't touch the dash pattern, which would otherwise stay dotted from
// the last guide line – reset it to solid first.
const solidRect = (...a) => `[] 0 d ${pdfRect(...a)}`;

function pageContent(p) {
  const H = SHEET.h;
  const out = [];
  // Helvetica/WinAnsi: no typographic dashes or quotes here, only Latin-1.
  out.push(pdfText(SHEET.margin, 11, 14, 'Handschrift - Schreibblatt', '#1f2f6b', H));
  out.push(pdfText(150, 11, 9, `Seite ${p + 1}/${SHEET.pages} - nicht umsortieren`, '#5b6573', H));
  out.push(
    pdfText(
      SHEET.margin,
      17.5,
      8,
      'Jedes graue Zeichen 3x mit dem Kugelschreiber schreiben. Dicke Linie = Grundlinie, oberste Linie = Höhe der Großbuchstaben.',
      '#5b6573',
      H,
    ),
  );
  const cells = CELLS.filter((c) => c.page === p);
  for (const c of cells) {
    const x1 = c.x + 0.8, x2 = c.x + c.w - 0.8;
    out.push(solidRect(c.x, c.y, c.w, c.h, '#d3dae3', 0.2, H));
    out.push(pdfLine(x1, c.y + SHEET.cap, x2, c.y + SHEET.cap, '#c3cdd9', 0.2, H));
    out.push(pdfLine(x1, c.y + SHEET.xHeight, x2, c.y + SHEET.xHeight, '#cfd7e1', 0.2, H, [1, 1]));
    out.push(pdfLine(x1, c.y + SHEET.baseline, x2, c.y + SHEET.baseline, '#7f97b2', 0.4, H));
    out.push(pdfLine(x1, c.y + SHEET.descender, x2, c.y + SHEET.descender, '#d6dde6', 0.2, H, [0.4, 1]));
    const label = LABEL[c.char] ?? c.char;
    out.push(pdfText(c.x + 1, c.y + 3.4, c.variant ? 7 : 8, label, c.variant ? '#b3bcc7' : '#7d8794', H));
  }
  // thicker frame around the 3 boxes of each character
  for (const c of cells.filter((x) => x.variant === 0)) {
    out.push(solidRect(c.x, c.y, c.w * SHEET.variants, c.h, '#8fa3b8', 0.5, H));
  }
  out.push(
    pdfText(
      SHEET.margin,
      SHEET.top + SHEET.rows * SHEET.cellH + 7,
      7.5,
      'Tipp: So schreiben wie sonst auch. Die App wechselt die 3 Varianten ab, damit die Schrift lebendig aussieht.',
      '#8a939e',
      H,
    ),
  );
  return out.join('\n');
}

/** The sheet as a 3-page A4 PDF (Uint8Array). */
export async function buildSheetPdf() {
  const pages = [];
  for (let p = 0; p < SHEET.pages; p++) {
    pages.push({ wPt: SHEET.w * PT_PER_MM, hPt: SHEET.h * PT_PER_MM, content: pageContent(p) });
  }
  return buildPdf(pages);
}

// Quadratic subpath (GoodNotes units) → polyline in mm, sampled at t = 0.5 and 1.
function pathToMm(path, k) {
  let [px, py] = path.start;
  const pts = [px * k, py * k];
  for (const [cx, cy, x, y] of path.segs) {
    pts.push((0.25 * px + 0.5 * cx + 0.25 * x) * k, (0.25 * py + 0.5 * cy + 0.25 * y) * k);
    pts.push(x * k, y * k);
    px = x;
    py = y;
  }
  return pts;
}

/**
 * Sort strokes of a filled sheet into glyph variants.
 * @param pages      [{ strokes: [{ paths }], other }] – notebook page i = sheet page i
 * @param mediaBoxPt { w, h } of the background PDF inside the notebook (or null = A4)
 * @returns { glyphs: { [char]: [{ s }] }, chars, variants, strokes, other, outside, extraPages, pages }
 */
export function strokesToGlyphs(pages, mediaBoxPt) {
  // GoodNotes units → mm on the printed sheet (corrects a page GoodNotes scaled).
  const scale = mediaBoxPt && mediaBoxPt.w > 0 ? SHEET.w / (mediaBoxPt.w / PT_PER_MM) : 1;
  const k = GN_MM * scale;
  const byCell = new Map();
  let used = 0, other = 0, outside = 0;
  pages.slice(0, SHEET.pages).forEach((page, p) => {
    other += page.other || 0;
    for (const st of page.strokes) {
      const polys = st.paths.map((path) => pathToMm(path, k)).filter((pts) => pts.length >= 2);
      if (!polys.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const pts of polys) {
        for (let i = 0; i < pts.length; i += 2) {
          x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
          y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
        }
      }
      const cell = cellAt(p, (x0 + x1) / 2, (y0 + y1) / 2);
      // strokes spanning several boxes (crossing out, arrows …) don't belong to a glyph
      if (!cell || x1 - x0 > 2 * SHEET.cellW || y1 - y0 > 2 * SHEET.cellH) {
        outside++;
        continue;
      }
      const ox = cell.x + SHEET.originX, oy = cell.y + SHEET.baseline;
      const glyphStrokes = polys.map((pts) => {
        const s = [];
        for (let i = 0; i < pts.length; i += 2) s.push((pts[i] - ox) / SHEET.unit, (pts[i + 1] - oy) / SHEET.unit, 0.5);
        return roundStroke(simplify(s, 0.004), 4);
      });
      if (!byCell.has(cell)) byCell.set(cell, []);
      byCell.get(cell).push(...glyphStrokes);
      used++;
    }
  });
  const glyphs = {};
  let variants = 0;
  for (const cell of CELLS) {
    const s = byCell.get(cell);
    if (!s) continue;
    (glyphs[cell.char] ||= []).push({ s });
    variants++;
  }
  return {
    glyphs,
    chars: Object.keys(glyphs).length,
    variants,
    strokes: used,
    other,
    outside,
    pages: Math.min(pages.length, SHEET.pages),
    extraPages: Math.max(0, pages.length - SHEET.pages),
  };
}

/** Read an exported .goodnotes notebook of the filled sheet. */
export async function readFilledSheet(buffer) {
  const nb = await readNotebook(buffer);
  return strokesToGlyphs(nb.pages, nb.mediaBox);
}

/** New font with the imported glyphs. mode: 'replace' (per character) or 'add'. */
export function mergeGlyphs(font, glyphs, mode) {
  const out = { ...(font || {}), version: (font && font.version) || 1, glyphs: { ...((font && font.glyphs) || {}) } };
  for (const [ch, list] of Object.entries(glyphs)) {
    out.glyphs[ch] = mode === 'add' ? [...(out.glyphs[ch] || []), ...list] : [...list];
  }
  return out;
}
