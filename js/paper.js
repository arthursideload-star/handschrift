// Paper templates. All measures in millimetres, y grows downwards.

export const PAPERS = {
  leer: { name: 'Leer', kind: 'blank', spacing: 9 },
  'liniert-eng': { name: 'Liniert – Eng (7 mm)', kind: 'lines', spacing: 7, top: 24 },
  liniert: { name: 'Liniert – Mittel (8,5 mm)', kind: 'lines', spacing: 8.5, top: 26 },
  'liniert-weit': { name: 'Liniert – Weit (10 mm)', kind: 'lines', spacing: 10, top: 28 },
  'kariert-eng': { name: 'Kariert – Eng (4 mm)', kind: 'grid', grid: 4, spacing: 8 },
  kariert: { name: 'Kariert – Mittel (5 mm)', kind: 'grid', grid: 5, spacing: 10 },
  'kariert-weit': { name: 'Kariert – Weit (7 mm)', kind: 'grid', grid: 7, spacing: 7 },
  'punkte-eng': { name: 'Gepunktet – Eng (4 mm)', kind: 'dots', grid: 4, spacing: 8 },
  punkte: { name: 'Gepunktet – Mittel (5 mm)', kind: 'dots', grid: 5, spacing: 10 },
  'punkte-weit': { name: 'Gepunktet – Weit (7 mm)', kind: 'dots', grid: 7, spacing: 7 },
  cornell: { name: 'Cornell', kind: 'lines', spacing: 8.5, top: 34, marginLeft: 62, cornell: true },
  // Older variants: still drawn, but only reachable through saved settings.
  'liniert-rand': { hidden: true, name: 'Liniert mit Rand', kind: 'lines', spacing: 8.5, top: 26, marginLeft: 24, marginRight: 14 },
  'kariert-rand': { hidden: true, name: 'Kariert mit Rand', kind: 'grid', grid: 5, spacing: 10, marginLeft: 25 },
  blanko: { hidden: true, name: 'Blanko', kind: 'blank', spacing: 9 },
};

// Old saved settings -> current keys (only used when loading).
export const LEGACY_PAPERS = { blanko: 'leer', 'liniert-rand': 'liniert', 'kariert-rand': 'kariert' };

// GoodNotes paper sizes (mm, portrait).
export const PAGE_SIZES = {
  standard: { name: 'Goodnotes Standard', w: 210, h: 280 },
  a7: { name: 'A7', w: 74, h: 105 },
  a6: { name: 'A6', w: 105, h: 148 },
  a5: { name: 'A5', w: 148, h: 210 },
  a4: { name: 'A4', w: 210, h: 297 },
  a3: { name: 'A3', w: 297, h: 420 },
  letter: { name: 'Letter', w: 215.9, h: 279.4 },
  tabloid: { name: 'Tabloid', w: 279.4, h: 431.8 },
};

export const PAPER_COLORS = {
  weiss: { name: 'Weiß', bg: '#ffffff', line: '#b9c8d8', margin: '#e8a0a0', dot: '#9fb2c6' },
  gelb: { name: 'Gelb', bg: '#fdf7e3', line: '#c7c3ad', margin: '#e3a39a', dot: '#b5ad90' },
  grau: { name: 'Grau', bg: '#f1f1ef', line: '#c4c6c9', margin: '#dba5a5', dot: '#a9acb0' },
  dunkel: { name: 'Dunkel', bg: '#26272b', line: '#4b4e56', margin: '#7c4b4f', dot: '#5b5f68' },
};

export const PAGE_A4 = { w: 210, h: 297 };

// Where text goes: baselines, margins.
export function paperGeometry(paperKey, page, spacingOverride) {
  const def = PAPERS[paperKey] || PAPERS.liniert;
  const spacing = spacingOverride || def.spacing;
  const g = {
    spacing,
    left: def.marginLeft ? def.marginLeft + 3 : 14,
    right: page.w - (def.marginRight ? def.marginRight + 3 : 14),
    bottom: page.h - 14,
    firstBaseline: 26,
  };
  if (def.kind === 'lines') {
    g.firstBaseline = def.top + (def.cornell ? 0 : spacing);
    if (def.cornell) g.bottom = page.h - 62;
  } else if (def.kind === 'grid' || def.kind === 'dots') {
    const off = gridOffset(page, def.grid);
    let y = off.y;
    while (y < 22) y += def.grid;
    g.firstBaseline = y + def.grid;
  } else {
    g.firstBaseline = 30;
  }
  return g;
}

function gridOffset(page, step) {
  return { x: (page.w % step) / 2, y: (page.h % step) / 2 };
}

// Drawing operations for the paper, shared by canvas preview and PDF export.
export function paperOps(paperKey, colorKey, page, spacingOverride) {
  const def = PAPERS[paperKey] || PAPERS.liniert;
  const col = PAPER_COLORS[colorKey] || PAPER_COLORS.weiss;
  const ops = [];
  const line = (x1, y1, x2, y2, color, width = 0.2) => ops.push({ t: 'line', x1, y1, x2, y2, color, width });
  if (def.kind === 'lines') {
    const spacing = spacingOverride || def.spacing;
    for (let y = def.top; y <= page.h - 10; y += spacing) line(0, y, page.w, y, col.line, 0.22);
    if (def.marginLeft) line(def.marginLeft, 0, def.marginLeft, page.h, col.margin, 0.3);
    if (def.marginRight) line(page.w - def.marginRight, 0, page.w - def.marginRight, page.h, col.margin, 0.3);
    if (def.cornell) {
      line(0, def.top - spacing, page.w, def.top - spacing, col.margin, 0.3);
      line(0, page.h - 55, page.w, page.h - 55, col.margin, 0.3);
    }
  } else if (def.kind === 'grid') {
    const off = gridOffset(page, def.grid);
    for (let x = off.x; x <= page.w; x += def.grid) line(x, 0, x, page.h, col.line, 0.15);
    for (let y = off.y; y <= page.h; y += def.grid) line(0, y, page.w, y, col.line, 0.15);
    if (def.marginLeft) line(def.marginLeft, 0, def.marginLeft, page.h, col.margin, 0.3);
  } else if (def.kind === 'dots') {
    const off = gridOffset(page, def.grid);
    for (let y = off.y + def.grid; y < page.h; y += def.grid) {
      for (let x = off.x + def.grid; x < page.w; x += def.grid) ops.push({ t: 'dot', x, y, r: 0.32, color: col.dot });
    }
  }
  return { bg: col.bg, ops };
}
