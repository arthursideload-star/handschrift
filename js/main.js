import * as store from './store.js';
import { normalizeText, ALL_CHARS } from './charset.js';
import { PAPERS, PAPER_COLORS, PAGE_SIZES, LEGACY_PAPERS, DEFAULT_MARGIN, paperGeometry, paperOps } from './paper.js';
import { layoutText } from './layout.js';
import { parseTimeline, parseMindmap, parseTable, layoutTimeline, layoutMindmap, layoutTable } from './diagrams.js';
import { renderPage, drawStrokes } from './render.js';
import { bbox } from './geom.js';
import { buildPdf, pageContent, PT_PER_MM } from './pdf.js';
import { analyzeTemplate, buildGoodnotes, diagnosticFiles } from './goodnotes.js';
import { createEditor } from './editor.js';
import { initCloud } from './cloud.js';
import { debounce, randomSeed, deliverFiles, toast } from './util.js';

const DEFAULTS = {
  paper: 'liniert',
  paperColor: 'weiss',
  pageFormat: 'a4',
  orientation: 'hoch',
  penType: 'ballpoint',
  inkColor: '#1f2f6b',
  penWidth: 0.3, // mm, full line diameter (GoodNotes "Dicke")
  penWidthV: 2, // settings migration marker
  size: 100,
  messiness: 35,
  slant: 0,
  letterSpacing: 100,
  wordSpacing: 100,
  lineSpacing: 0,
  margin: DEFAULT_MARGIN, // mm from the page edge to the text
  seed: 12345,
  stripMd: true,
  keepGnBackground: false,
  // Zeitstrahl / Mindmap
  timelineDir: 'auto',
  timelineOrient: 'quer',
  timelinePaper: 'leer',
  timelineSize: 100,
  timelineColor: true,
  mindmapOrient: 'quer',
  mindmapPaper: 'leer',
  mindmapSize: 100,
  mindmapColor: true,
  tableOrient: 'hoch',
  tablePaper: 'leer',
  tableSize: 100,
  tableColor: true,
  tableHeader: true,
};

// Shown next to the logo so you can see which version is running (keep in sync with sw.js).
const APP_VERSION = 11;

const DIAGRAM_KINDS = ['timeline', 'mindmap', 'table'];
const DIAGRAM_NAMES = { timeline: 'Zeitstrahl', mindmap: 'Mindmap', table: 'Tabelle' };
const EXAMPLES = {
  tableTitle: 'Die Planeten',
  table: [
    'Planet | Abstand zur Sonne | Monde | Besonderheit',
    'Merkur | 58 Mio. km | 0 | kleinster Planet',
    'Venus | 108 Mio. km | 0 | heißester Planet',
    'Erde | 150 Mio. km | 1 | flüssiges Wasser',
    'Mars | 228 Mio. km | 2 | roter Planet',
    'Jupiter | 778 Mio. km | 95 | größter Planet',
  ].join('\n'),
  timelineTitle: 'Französische Revolution',
  timeline: [
    '1789: Sturm auf die Bastille',
    '1791: Erste Verfassung Frankreichs',
    '1793: Hinrichtung von Ludwig XVI.',
    '1794: Ende der Schreckensherrschaft',
    '1799: Napoleon übernimmt die Macht',
  ].join('\n'),
  mindmap: [
    'Französische Revolution',
    '- Ursachen',
    '  - Hunger und hohe Brotpreise',
    '  - Staatsschulden',
    '  - Ständegesellschaft',
    '- Verlauf',
    '  - Sturm auf die Bastille',
    '  - Erste Verfassung',
    '  - Schreckensherrschaft',
    '- Folgen',
    '  - Menschenrechte',
    '  - Ende des Absolutismus',
    '- Personen',
    '  - Robespierre',
    '  - Napoleon',
  ].join('\n'),
};

// GoodNotes-like pen thicknesses in mm (GoodNotes' slider runs from about 0.1 to 2.0 mm).
const PEN_WIDTHS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2];
const PEN_MIN = 0.1;
const PEN_MAX = 2;
const fmtMm = (v) => `${(Math.round(v * 100) / 100).toString().replace('.', ',')} mm`;
const clampPenWidth = (v) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(PEN_MAX, Math.max(PEN_MIN, Math.round(v * 100) / 100)) : DEFAULTS.penWidth;
};

const INK_SWATCHES = [
  ['#1f2f6b', 'Blau'],
  ['#1c1c1e', 'Schwarz'],
  ['#0b5bd3', 'Hellblau'],
  ['#b3261e', 'Rot'],
  ['#1d7a46', 'Grün'],
  ['#6b2fa3', 'Lila'],
  ['#f2f2f2', 'Weiß'],
];

const state = {
  font: { version: 1, glyphs: {} },
  settings: { ...DEFAULTS },
  gnTemplate: null, // analysed template
  gnTemplateName: '',
  result: null,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ init
async function init() {
  try {
    const [font, settings, tpl] = await Promise.all([store.get('font'), store.get('settings'), store.get('gnTemplate')]);
    if (font && font.glyphs) state.font = font;
    if (settings) state.settings = { ...DEFAULTS, ...settings };
    state.settings.paper = LEGACY_PAPERS[state.settings.paper] || state.settings.paper;
    // Settings saved before the GoodNotes thickness presets: the old default 0.45 mm looked too fat.
    if (!settings || settings.penWidthV !== 2) {
      if (!settings || settings.penWidth === 0.45) state.settings.penWidth = DEFAULTS.penWidth;
      state.settings.penWidthV = 2;
    }
    state.settings.penWidth = clampPenWidth(state.settings.penWidth);
    if (!PAPERS[state.settings.paper]) state.settings.paper = DEFAULTS.paper;
    for (const k of DIAGRAM_KINDS) if (!PAPERS[state.settings[`${k}Paper`]]) state.settings[`${k}Paper`] = DEFAULTS[`${k}Paper`];
    if (!PAGE_SIZES[state.settings.pageFormat] && state.settings.pageFormat !== 'vorlage') state.settings.pageFormat = DEFAULTS.pageFormat;
    if (tpl && tpl.buffer) {
      try {
        state.gnTemplate = await analyzeTemplate(tpl.buffer);
        state.gnTemplateName = tpl.name;
      } catch (err) {
        console.warn('Vorlage konnte nicht gelesen werden', err);
      }
    }
  } catch (err) {
    console.warn('Speicher nicht verfügbar', err);
  }

  $('app-version').textContent = `Version ${APP_VERSION}`;
  buildSettingsUi();
  readIncomingText();
  DIAGRAM_KINDS.forEach(initDiagramTab);

  const editor = createEditor({
    getFont: () => state.font,
    saveFont: () => store.set('font', state.font),
    onChange: () => scheduleRender(),
  });
  state.editor = editor;

  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => showTab(b.dataset.tab)),
  );
  showTab(Object.keys(state.font.glyphs).length ? 'write' : 'font');

  $('text').addEventListener('input', () => {
    localStorage.setItem('handschrift.text', $('text').value);
    scheduleRender();
  });
  $('paste').onclick = async () => {
    try {
      $('text').value = await navigator.clipboard.readText();
      $('text').dispatchEvent(new Event('input'));
    } catch (_) {
      toast('Einfügen nicht erlaubt – halte ins Textfeld gedrückt und wähle „Einsetzen“.');
    }
  };
  $('clear-text').onclick = () => {
    $('text').value = '';
    $('text').dispatchEvent(new Event('input'));
  };
  $('reroll').onclick = () => {
    state.settings.seed = randomSeed();
    saveSettings();
    render();
  };
  $('export-png').onclick = () => exportPng(compute, 'Handschrift').catch(fail);
  $('export-pdf').onclick = () => exportPdf(compute, 'Handschrift').catch(fail);
  $('export-cut').onclick = () => exportCutout(compute, 'Handschrift').catch(fail);
  $('export-gn').onclick = () => exportGoodnotes(writeForTemplate, 'Handschrift').catch(fail);
  $('gn-template').addEventListener('change', (e) => loadTemplate(e.target.files[0]).catch(fail));
  $('gn-template-remove').onclick = removeTemplate;
  $('gn-diag').onclick = () => exportDiagnostics().catch(fail);
  $('font-export').onclick = exportFont;
  $('font-import').addEventListener('change', (e) => importFont(e.target.files[0]).catch(fail));
  $('font-reset').onclick = resetFont;

  const onResize = debounce(render, 150);
  new ResizeObserver(onResize).observe($('pages'));
  DIAGRAM_KINDS.forEach((k) => new ResizeObserver(onResize).observe(section(k).querySelector('.pages')));
  renderTemplateInfo();
  render();
  store.requestPersistence();
  initCloud(); // optional login + sync; listens to store changes
}

function fail(err) {
  console.error(err);
  toast(err && err.message ? err.message : String(err), 'error', 6000);
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'font') state.editor.show();
  if (name === 'write' || DIAGRAM_KINDS.includes(name)) render();
}

function readIncomingText() {
  let incoming = null;
  const h = location.hash;
  if (h.startsWith('#text=')) incoming = decodeURIComponent(h.slice(6).replace(/\+/g, ' '));
  const q = new URLSearchParams(location.search).get('text');
  if (q) incoming = q;
  if (incoming != null) {
    $('text').value = incoming;
    localStorage.setItem('handschrift.text', incoming);
    history.replaceState(null, '', location.pathname); // don't keep the text in the address bar
  } else {
    $('text').value = localStorage.getItem('handschrift.text') ?? $('text').value;
  }
}

// ------------------------------------------------------------------ settings UI
function buildSettingsUi() {
  const s = state.settings;
  const paperSel = $('set-paper');
  paperSel.innerHTML = Object.entries(PAPERS)
    .filter(([, v]) => !v.hidden)
    .map(([k, v]) => `<option value="${k}">${v.name}</option>`)
    .join('');
  paperSel.value = s.paper;
  paperSel.onchange = () => update({ paper: paperSel.value, lineSpacing: 0 });

  const colors = $('set-paper-color');
  colors.innerHTML = Object.entries(PAPER_COLORS)
    .map(([k, v]) => `<button type="button" data-v="${k}" title="${v.name}" style="--c:${v.bg}"></button>`)
    .join('');
  colors.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const patch = { paperColor: b.dataset.v };
    if (b.dataset.v === 'dunkel' && s.inkColor !== '#f2f2f2') patch.inkColor = '#f2f2f2';
    if (b.dataset.v !== 'dunkel' && s.inkColor === '#f2f2f2') patch.inkColor = DEFAULTS.inkColor;
    update(patch);
  };

  const ink = $('set-ink');
  ink.innerHTML =
    INK_SWATCHES.map(([c, n]) => `<button type="button" data-v="${c}" title="${n}" style="--c:${c}"></button>`).join('') +
    `<label class="swatch-custom" title="Eigene Farbe"><input type="color" id="set-ink-custom"></label>`;
  ink.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) update({ inkColor: b.dataset.v });
  };
  $('set-ink-custom').oninput = (e) => update({ inkColor: e.target.value });

  $('set-pen').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) update({ penType: b.dataset.v });
  };
  const fmtSel = $('set-format');
  fmtSel.innerHTML =
    Object.entries(PAGE_SIZES).map(([k, v]) => `<option value="${k}">${v.name} (${v.w.toString().replace('.', ',')} × ${v.h.toString().replace('.', ',')} mm)</option>`).join('') +
    '<option value="vorlage">Wie meine GoodNotes-Vorlage</option>';
  fmtSel.onchange = (e) => update({ pageFormat: e.target.value });
  $('set-orient').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) update({ orientation: b.dataset.v });
  };

  $('set-width-presets').innerHTML = PEN_WIDTHS.map((w) => `<button type="button" data-v="${w}" title="${fmtMm(w)}">${String(w).replace('.', ',')}</button>`).join('');
  $('set-width-presets').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const w = Number(b.dataset.v);
    $('set-width').value = w;
    $('set-width').parentElement.querySelector('output').textContent = fmtMm(w);
    update({ penWidth: w });
  };

  const ranges = [
    ['set-width', 'penWidth', fmtMm],
    ['set-size', 'size', (v) => `${v} %`],
    ['set-mess', 'messiness', (v) => `${v} %`],
    ['set-slant', 'slant', (v) => `${v}°`],
    ['set-letter', 'letterSpacing', (v) => `${v} %`],
    ['set-word', 'wordSpacing', (v) => `${v} %`],
    ['set-line', 'lineSpacing', (v) => (v ? `${String(v).replace('.', ',')} mm` : 'Auto')],
    ['set-margin', 'margin', (v) => `${v} mm`],
  ];
  for (const [id, key, fmt] of ranges) {
    const el = $(id);
    const out = el.parentElement.querySelector('output');
    el.value = s[key];
    out.textContent = fmt(Number(el.value));
    el.addEventListener('input', () => {
      out.textContent = fmt(Number(el.value));
      update({ [key]: Number(el.value) }, true);
    });
  }
  $('set-strip').checked = s.stripMd;
  $('set-strip').onchange = (e) => update({ stripMd: e.target.checked });
  $('set-keep-bg').checked = s.keepGnBackground;
  $('set-keep-bg').onchange = (e) => update({ keepGnBackground: e.target.checked });
  syncSettingsUi();
}

function syncSettingsUi() {
  const s = state.settings;
  $('set-paper').value = s.paper;
  document.querySelectorAll('#set-paper-color button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.paperColor));
  document.querySelectorAll('#set-ink button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.inkColor));
  document.querySelectorAll('#set-pen button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.penType));
  document.querySelectorAll('#set-width-presets button').forEach((b) => b.classList.toggle('on', Math.abs(Number(b.dataset.v) - s.penWidth) < 0.001));
  const fmt = $('set-format');
  fmt.querySelector('option[value="vorlage"]').disabled = !state.gnTemplate;
  if (!state.gnTemplate && s.pageFormat === 'vorlage') s.pageFormat = DEFAULTS.pageFormat;
  fmt.value = s.pageFormat;
  document.querySelectorAll('#set-orient button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === s.orientation);
    b.disabled = s.pageFormat === 'vorlage';
  });
  for (const k of DIAGRAM_KINDS) {
    document.querySelectorAll(`#${k}-orient button`).forEach((b) => {
      b.classList.toggle('on', b.dataset.v === s[`${k}Orient`]);
      b.disabled = s.pageFormat === 'vorlage';
    });
    $(`${k}-paper`).value = s[`${k}Paper`];
    $(`${k}-color`).checked = !!s[`${k}Color`];
  }
  $('table-header').checked = !!s.tableHeader;
  document.querySelectorAll('#timeline-dir button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.timelineDir));
}

const saveSettings = debounce(() => store.set('settings', state.settings).catch(() => {}), 300);

function update(patch, fast = false) {
  Object.assign(state.settings, patch);
  syncSettingsUi();
  saveSettings();
  if (fast) scheduleRender();
  else render();
}

// ------------------------------------------------------------------ layout + preview
function pageSize() {
  if (state.settings.pageFormat === 'vorlage' && state.gnTemplate) return state.gnTemplate.pageMm;
  const sz = PAGE_SIZES[state.settings.pageFormat] || PAGE_SIZES.a4;
  return state.settings.orientation === 'quer' ? { w: sz.h, h: sz.w } : { w: sz.w, h: sz.h };
}

function compute() {
  const s = state.settings;
  const page = pageSize();
  const geo = paperGeometry(s.paper, page, s.lineSpacing || 0, s.margin);
  const text = normalizeText($('text').value, { stripMd: s.stripMd });
  const capHeight = geo.spacing * 0.62 * (s.size / 100);
  const res = layoutText(text, state.font, {
    page,
    geo,
    capHeight,
    messiness: s.messiness / 100,
    slant: s.slant,
    letterSpacing: s.letterSpacing / 100,
    wordSpacing: s.wordSpacing / 100,
    seed: s.seed,
  });
  res.page = page;
  res.paper = paperOps(s.paper, s.paperColor, page, s.lineSpacing || 0, s.margin);
  res.pen = { type: s.penType, color: s.inkColor, width: clampPenWidth(s.penWidth) };
  res.text = text;
  return res;
}

const scheduleRender = debounce(() => render(), 90);

function render() {
  if ($('tab-write').classList.contains('active')) return renderWrite();
  for (const k of DIAGRAM_KINDS) if (section(k).classList.contains('active')) return renderDiagram(k);
}

function renderWrite() {
  const res = compute();
  state.result = res;
  showPages($('pages'), res);
  $('page-info').textContent = `${res.pages.length} Seite${res.pages.length === 1 ? '' : 'n'}`;
  showMissing($('missing'), res);
}

function showPages(wrap, res) {
  const width = Math.max(240, wrap.clientWidth - 2);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pxPerMm = (width * dpr) / res.page.w;
  const canvases = [...wrap.querySelectorAll('canvas')];
  res.pages.forEach((p, i) => {
    let c = canvases[i];
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'page';
      wrap.append(c);
    }
    renderPage(c, p, res.paper, res.pen, res.page, pxPerMm);
    c.style.width = `${width}px`;
  });
  canvases.slice(res.pages.length).forEach((c) => c.remove());
}

function showMissing(miss, res) {
  const glyphCount = Object.keys(state.font.glyphs).length;
  if (!glyphCount) {
    miss.hidden = false;
    miss.innerHTML = `Du hast noch keine Buchstaben gezeichnet. <button type="button" class="link" data-go="font">Jetzt deine Schrift anlegen →</button>`;
  } else if (res.missing.size) {
    miss.hidden = false;
    const chars = [...res.missing].sort((a, b) => ALL_CHARS.indexOf(a) - ALL_CHARS.indexOf(b));
    miss.innerHTML =
      `Diese Zeichen fehlen noch in deiner Schrift: ` +
      chars.map((c) => `<button type="button" class="chip" data-char="${encodeURIComponent(c)}">${escapeHtml(c)}</button>`).join(' ');
  } else {
    miss.hidden = true;
  }
  miss.onclick = (e) => {
    const go = e.target.closest('[data-go]');
    const ch = e.target.closest('[data-char]');
    if (go) showTab('font');
    if (ch) {
      showTab('font');
      state.editor.select(decodeURIComponent(ch.dataset.char));
    }
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ensureContent(res) {
  if (!Object.keys(state.font.glyphs).length) throw new Error('Leg zuerst unter „Meine Schrift“ deine Buchstaben an.');
  if (!res.text.trim()) throw new Error('Gib zuerst einen Text ein.');
}

// ------------------------------------------------------------------ exports
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

async function exportPng(computeFn, name) {
  const res = computeFn();
  ensureContent(res);
  const files = [];
  for (let i = 0; i < res.pages.length; i++) {
    const c = renderPage(document.createElement('canvas'), res.pages[i], res.paper, res.pen, res.page, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    files.push(new File([blob], `${name}-${stamp()}-${i + 1}.png`, { type: 'image/png' }));
  }
  await deliverFiles(files);
}

// Transparent PNG with only the handwriting, cropped to it – pastes into a GoodNotes
// page without a white paper block around it.
async function exportCutout(computeFn, name) {
  const res = computeFn();
  ensureContent(res);
  const files = [];
  const px = 10; // px per mm
  for (let i = 0; i < res.pages.length; i++) {
    const strokes = res.pages[i].strokes;
    const bb = bbox(strokes);
    if (!bb) continue;
    const pad = 1.5 + res.pen.width;
    const c = document.createElement('canvas');
    c.width = Math.ceil((bb.w + 2 * pad) * px);
    c.height = Math.ceil((bb.h + 2 * pad) * px);
    const ctx = c.getContext('2d');
    ctx.translate((pad - bb.x0) * px, (pad - bb.y0) * px);
    drawStrokes(ctx, strokes, res.pen, px);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    files.push(new File([blob], `${name}-Schrift-${stamp()}-${i + 1}.png`, { type: 'image/png' }));
  }
  await deliverFiles(files);
}

async function exportPdf(computeFn, name) {
  const res = computeFn();
  ensureContent(res);
  const pages = res.pages.map((p) => ({
    wPt: res.page.w * PT_PER_MM,
    hPt: res.page.h * PT_PER_MM,
    content: pageContent({ pageMm: res.page, paper: res.paper, strokes: p.strokes, pen: res.pen }),
  }));
  const bytes = await buildPdf(pages);
  await deliverFiles([new File([bytes], `${name}-${stamp()}.pdf`, { type: 'application/pdf' })]);
}

// "Schreiben" for GoodNotes: the page must have the template's size.
function writeForTemplate() {
  if (state.settings.pageFormat !== 'vorlage') {
    update({ pageFormat: 'vorlage' });
    toast('Seitenformat an deine GoodNotes-Vorlage angepasst.');
  }
  return compute();
}

async function exportGoodnotes(computeFn, name) {
  if (!state.gnTemplate) {
    showTab('gn');
    toast('Für den radierbaren Export brauchst du einmal eine GoodNotes-Vorlage.');
    return;
  }
  const res = computeFn();
  ensureContent(res);
  const tpl = state.gnTemplate;
  const files = [];
  for (let i = 0; i < res.pages.length; i++) {
    let bg = null;
    if (!state.settings.keepGnBackground) {
      bg = await buildPdf([
        {
          wPt: tpl.ptSize.w,
          hPt: tpl.ptSize.h,
          content: pageContent({ pageMm: res.page, paper: res.paper, strokes: [], pen: res.pen, includeInk: false }),
        },
      ]);
    }
    const thumbCanvas = renderPage(document.createElement('canvas'), res.pages[i], res.paper, res.pen, res.page, 1.6);
    const thumb = new Uint8Array(await (await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.8))).arrayBuffer());
    const blob = buildGoodnotes(tpl, res.pages[i].strokes, res.pen, bg, thumb);
    files.push(new File([blob], `${name}-${stamp()}-${i + 1}.goodnotes`, { type: 'application/octet-stream' }));
  }
  await deliverFiles(files);
  toast(
    files.length > 1
      ? `${files.length} GoodNotes-Dateien erstellt (eine pro Seite). In GoodNotes über „Importieren“ öffnen.`
      : 'GoodNotes-Datei erstellt. In GoodNotes über „Importieren“ öffnen.',
    'ok',
    6000,
  );
}

async function exportDiagnostics() {
  const tpl = state.gnTemplate;
  if (!tpl) return toast('Erst eine Vorlage laden.');
  const res = compute();
  let strokes = res.pages[0] && res.pages[0].strokes.length ? res.pages[0].strokes : null;
  if (!strokes) strokes = [[20, 30, 0.5, 60, 40, 0.5, 100, 30, 0.5], [20, 50, 0.5, 100, 50, 0.5]];
  const bg = await buildPdf([
    { wPt: tpl.ptSize.w, hPt: tpl.ptSize.h, content: pageContent({ pageMm: res.page, paper: res.paper, strokes: [], pen: res.pen, includeInk: false }) },
  ]);
  const thumbCanvas = renderPage(document.createElement('canvas'), { strokes }, res.paper, res.pen, res.page, 1.6);
  const thumb = new Uint8Array(await (await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.8))).arrayBuffer());
  const files = diagnosticFiles(tpl, strokes, res.pen, bg, thumb).map(
    ([name, blob]) => new File([blob], `Test-${name}.goodnotes`, { type: 'application/octet-stream' }),
  );
  await deliverFiles(files);
}

// ------------------------------------------------------------------ Zeitstrahl + Mindmap
const section = (kind) => $(`tab-${kind}`);
const textKey = (kind) => `handschrift.${kind}`;

function initDiagramTab(kind) {
  const sec = section(kind);
  const s = state.settings;
  const ta = $(`${kind}-text`);
  const titleEl = $(`${kind}-title`);
  ta.value = localStorage.getItem(textKey(kind)) ?? EXAMPLES[kind];
  if (titleEl) titleEl.value = localStorage.getItem(textKey(`${kind}.title`)) ?? EXAMPLES[`${kind}Title`];
  const changed = () => {
    localStorage.setItem(textKey(kind), ta.value);
    if (titleEl) localStorage.setItem(textKey(`${kind}.title`), titleEl.value);
    scheduleRender();
  };
  ta.addEventListener('input', changed);
  if (titleEl) titleEl.addEventListener('input', changed);

  sec.querySelector('[data-paste]').onclick = async () => {
    try {
      ta.value = await navigator.clipboard.readText();
      changed();
    } catch (_) {
      toast('Einfügen nicht erlaubt – halte ins Textfeld gedrückt und wähle „Einsetzen“.');
    }
  };
  sec.querySelector('[data-clear]').onclick = () => {
    ta.value = '';
    if (titleEl) titleEl.value = '';
    changed();
    ta.focus();
  };
  sec.querySelector('[data-example]').onclick = () => {
    ta.value = EXAMPLES[kind];
    if (titleEl) titleEl.value = EXAMPLES[`${kind}Title`];
    changed();
  };

  const paper = $(`${kind}-paper`);
  paper.innerHTML = Object.entries(PAPERS)
    .filter(([, v]) => !v.hidden)
    .map(([k, v]) => `<option value="${k}">${v.name}</option>`)
    .join('');
  paper.onchange = () => update({ [`${kind}Paper`]: paper.value });
  $(`${kind}-orient`).onclick = (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) update({ [`${kind}Orient`]: b.dataset.v });
  };
  if (kind === 'timeline') {
    $('timeline-dir').onclick = (e) => {
      const b = e.target.closest('button');
      if (b) update({ timelineDir: b.dataset.v });
    };
  }
  const size = $(`${kind}-size`);
  const out = size.parentElement.querySelector('output');
  size.value = s[`${kind}Size`];
  out.textContent = `${size.value} %`;
  size.addEventListener('input', () => {
    out.textContent = `${size.value} %`;
    update({ [`${kind}Size`]: Number(size.value) }, true);
  });
  $(`${kind}-color`).onchange = (e) => update({ [`${kind}Color`]: e.target.checked });
  if (kind === 'table') $('table-header').onchange = (e) => update({ tableHeader: e.target.checked });
  sec.querySelector('[data-reroll]').onclick = () => {
    state.settings.seed = randomSeed();
    saveSettings();
    render();
  };

  const name = DIAGRAM_NAMES[kind];
  sec.querySelector('[data-export="png"]').onclick = () => exportPng(() => computeDiagram(kind), name).catch(fail);
  sec.querySelector('[data-export="pdf"]').onclick = () => exportPdf(() => computeDiagram(kind), name).catch(fail);
  sec.querySelector('[data-export="cut"]').onclick = () => exportCutout(() => computeDiagram(kind), name).catch(fail);
  sec.querySelector('[data-export="gn"]').onclick = () => exportGoodnotes(() => computeDiagram(kind, true), name).catch(fail);
}

function diagramPage(kind, forTemplate) {
  const s = state.settings;
  if (state.gnTemplate && (forTemplate || s.pageFormat === 'vorlage')) return state.gnTemplate.pageMm;
  const sz = PAGE_SIZES[s.pageFormat] || PAGE_SIZES.a4;
  return s[`${kind}Orient`] === 'quer' ? { w: sz.h, h: sz.w } : { w: sz.w, h: sz.h };
}

function computeDiagram(kind, forTemplate = false) {
  const s = state.settings;
  const page = diagramPage(kind, forTemplate);
  const raw = $(`${kind}-text`).value;
  const o = {
    page,
    margin: s.margin,
    cap: 5 * (s[`${kind}Size`] / 100),
    colorful: !!s[`${kind}Color`],
    messiness: s.messiness / 100,
    slant: s.slant,
    letterSpacing: s.letterSpacing / 100,
    wordSpacing: s.wordSpacing / 100,
    seed: s.seed,
  };
  let res;
  if (kind === 'timeline') {
    const title = $('timeline-title').value;
    res = layoutTimeline(parseTimeline(raw), state.font, { ...o, title, direction: s.timelineDir });
    res.text = raw + title;
  } else if (kind === 'table') {
    const title = $('table-title').value;
    res = layoutTable(parseTable(raw), state.font, { ...o, title, header: s.tableHeader });
    res.text = raw + title;
  } else {
    res = layoutMindmap(parseMindmap(raw), state.font, o);
    res.text = raw;
  }
  if (!res.pages.length) res.pages = [{ strokes: [] }];
  res.page = page;
  res.paper = paperOps(s[`${kind}Paper`], s.paperColor, page, 0, s.margin);
  res.pen = { type: s.penType, color: s.inkColor, width: clampPenWidth(s.penWidth) };
  return res;
}

function renderDiagram(kind) {
  const sec = section(kind);
  const res = computeDiagram(kind);
  showPages(sec.querySelector('.pages'), res);
  const info = [`${res.pages.length} Seite${res.pages.length === 1 ? '' : 'n'}`];
  if (res.shrunk) info.push('Schrift verkleinert, damit alles draufpasst');
  sec.querySelector('.page-info').textContent = info.join(' · ');
  showMissing(sec.querySelector('.missing'), res);
}

// ------------------------------------------------------------------ GoodNotes template
async function loadTemplate(file) {
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const tpl = await analyzeTemplate(buffer);
  state.gnTemplate = tpl;
  state.gnTemplateName = file.name;
  await store.set('gnTemplate', { name: file.name, buffer });
  $('gn-template').value = '';
  update({ pageFormat: 'vorlage' });
  renderTemplateInfo();
  toast('Vorlage gespeichert. Ab jetzt kannst du radierbar exportieren.', 'ok');
}

async function removeTemplate() {
  state.gnTemplate = null;
  state.gnTemplateName = '';
  await store.del('gnTemplate');
  update({ pageFormat: 'a4' });
  renderTemplateInfo();
}

function renderTemplateInfo() {
  const el = $('gn-status');
  const t = state.gnTemplate;
  $('gn-template-remove').hidden = !t;
  $('export-gn').classList.toggle('needs-setup', !t);
  if (!t) {
    el.innerHTML = '<p class="muted">Noch keine Vorlage geladen.</p>';
    return;
  }
  const warn = [];
  if (t.pageCount > 1) warn.push(`Die Vorlage hat ${t.pageCount} Seiten – exportiert wird immer nur Seite 1, die anderen bleiben unverändert drin. Besser: Vorlage mit genau 1 Seite.`);
  if (!t.sample) warn.push('In der Vorlage ist kein Kugelschreiber-Strich. Das geht meistens trotzdem – wenn GoodNotes die Datei nicht öffnet, mal mit dem Kugelschreiber einen kleinen Strich in die Vorlage und exportiere sie neu.');
  if (t.otherFormats.length) warn.push('Die Vorlage enthält Füller-/Pinsel-Striche. Die werden beim Export entfernt.');
  const mm = (v) => Math.round(v);
  el.innerHTML = `
    <dl class="kv">
      <dt>Datei</dt><dd>${escapeHtml(state.gnTemplateName)}</dd>
      <dt>Seitengröße</dt><dd>${mm(t.pageMm.w)} × ${mm(t.pageMm.h)} mm</dd>
      <dt>Format-Version</dt><dd>${t.version}</dd>
      <dt>Muster-Strich</dt><dd>${t.sample ? 'gefunden ✓' : 'keiner'}</dd>
    </dl>
    ${warn.map((w) => `<p class="warn">${w}</p>`).join('')}`;
}

// ------------------------------------------------------------------ font backup
function exportFont() {
  const json = JSON.stringify(state.font);
  deliverFiles([new File([json], `meine-handschrift-${stamp()}.json`, { type: 'application/json' })]);
}

async function importFont(file) {
  if (!file) return;
  const data = JSON.parse(await file.text());
  if (!data || typeof data.glyphs !== 'object') throw new Error('Das ist keine Handschrift-Datei.');
  const replace = confirm('Vorhandene Buchstaben ersetzen? (Abbrechen = zusammenführen)');
  if (replace) state.font = { version: 1, glyphs: data.glyphs };
  else for (const [ch, list] of Object.entries(data.glyphs)) (state.font.glyphs[ch] ||= []).push(...list);
  await store.set('font', state.font);
  $('font-import').value = '';
  state.editor.refresh();
  toast('Schrift geladen.', 'ok');
}

async function resetFont() {
  if (!confirm('Wirklich alle gezeichneten Buchstaben löschen? Das kann man nicht rückgängig machen – sichere sie vorher als Datei.')) return;
  state.font = { version: 1, glyphs: {} };
  await store.set('font', state.font);
  state.editor.refresh();
}

init();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // A new version took over (e.g. the old cache-first worker was replaced): reload once
  // so the page shows the new version right away instead of on the next visit.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker
    .register('sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {}));
    })
    .catch((err) => console.warn('Offline-Modus nicht verfügbar', err));
}

// Font replaced from outside the editor (e.g. GoodNotes Schreibblatt import in sheet-ui.js).
window.addEventListener('font-changed', (e) => {
  if (e.detail && e.detail.font) state.font = e.detail.font;
  if (state.editor) state.editor.refresh();
  scheduleRender();
});
