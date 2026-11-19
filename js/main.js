import * as store from './store.js';
import { normalizeText, ALL_CHARS } from './charset.js';
import { PAPERS, PAPER_COLORS, PAGE_SIZES, LEGACY_PAPERS, paperGeometry, paperOps } from './paper.js';
import { layoutText } from './layout.js';
import { renderPage } from './render.js';
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
  seed: 12345,
  stripMd: true,
  keepGnBackground: false,
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

  buildSettingsUi();
  readIncomingText();

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
  $('export-png').onclick = () => exportPng().catch(fail);
  $('export-pdf').onclick = () => exportPdf().catch(fail);
  $('export-gn').onclick = () => exportGoodnotes().catch(fail);
  $('gn-template').addEventListener('change', (e) => loadTemplate(e.target.files[0]).catch(fail));
  $('gn-template-remove').onclick = removeTemplate;
  $('gn-diag').onclick = () => exportDiagnostics().catch(fail);
  $('font-export').onclick = exportFont;
  $('font-import').addEventListener('change', (e) => importFont(e.target.files[0]).catch(fail));
  $('font-reset').onclick = resetFont;

  new ResizeObserver(debounce(render, 150)).observe($('pages'));
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
  if (name === 'write') render();
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
  const geo = paperGeometry(s.paper, page, s.lineSpacing || 0);
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
  res.paper = paperOps(s.paper, s.paperColor, page, s.lineSpacing || 0);
  res.pen = { type: s.penType, color: s.inkColor, width: clampPenWidth(s.penWidth) };
  res.text = text;
  return res;
}

const scheduleRender = debounce(() => render(), 90);

function render() {
  if (!$('tab-write').classList.contains('active')) return;
  const res = compute();
  state.result = res;
  const wrap = $('pages');
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

  const glyphCount = Object.keys(state.font.glyphs).length;
  const info = [];
  info.push(`${res.pages.length} Seite${res.pages.length === 1 ? '' : 'n'}`);
  $('page-info').textContent = info.join(' · ');
  const miss = $('missing');
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

async function exportPng() {
  const res = compute();
  ensureContent(res);
  const files = [];
  for (let i = 0; i < res.pages.length; i++) {
    const c = renderPage(document.createElement('canvas'), res.pages[i], res.paper, res.pen, res.page, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    files.push(new File([blob], `Handschrift-${stamp()}-${i + 1}.png`, { type: 'image/png' }));
  }
  await deliverFiles(files);
}

async function exportPdf() {
  const res = compute();
  ensureContent(res);
  const pages = res.pages.map((p) => ({
    wPt: res.page.w * PT_PER_MM,
    hPt: res.page.h * PT_PER_MM,
    content: pageContent({ pageMm: res.page, paper: res.paper, strokes: p.strokes, pen: res.pen }),
  }));
  const bytes = await buildPdf(pages);
  await deliverFiles([new File([bytes], `Handschrift-${stamp()}.pdf`, { type: 'application/pdf' })]);
}

async function exportGoodnotes() {
  if (!state.gnTemplate) {
    showTab('gn');
    toast('Für den radierbaren Export brauchst du einmal eine GoodNotes-Vorlage.');
    return;
  }
  if (state.settings.pageFormat !== 'vorlage') {
    update({ pageFormat: 'vorlage' });
    toast('Seitenformat an deine GoodNotes-Vorlage angepasst.');
  }
  const res = compute();
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
    files.push(new File([blob], `Handschrift-${stamp()}-${i + 1}.goodnotes`, { type: 'application/octet-stream' }));
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
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline-Modus nicht verfügbar', err));
}

// Font replaced from outside the editor (e.g. GoodNotes Schreibblatt import in sheet-ui.js).
window.addEventListener('font-changed', (e) => {
  if (e.detail && e.detail.font) state.font = e.detail.font;
  if (state.editor) state.editor.refresh();
  scheduleRender();
});
