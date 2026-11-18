import * as store from './store.js';
import { normalizeText, ALL_CHARS } from './charset.js';
import { PAPERS, PAPER_COLORS, PAGE_A4, paperGeometry, paperOps } from './paper.js';
import { layoutText } from './layout.js';
import { renderPage } from './render.js';
import { buildPdf, pageContent, PT_PER_MM } from './pdf.js';
import { analyzeTemplate, buildGoodnotes } from './goodnotes.js';
import { createEditor } from './editor.js';
import { debounce, randomSeed, deliverFiles, toast } from './util.js';

const DEFAULTS = {
  paper: 'liniert',
  paperColor: 'weiss',
  pageFormat: 'a4',
  penType: 'ballpoint',
  inkColor: '#1f2f6b',
  penWidth: 0.45,
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
  $('font-export').onclick = exportFont;
  $('font-import').addEventListener('change', (e) => importFont(e.target.files[0]).catch(fail));
  $('font-reset').onclick = resetFont;

  new ResizeObserver(debounce(render, 150)).observe($('pages'));
  renderTemplateInfo();
  render();
  store.requestPersistence();
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
  $('set-format').onchange = (e) => update({ pageFormat: e.target.value });

  const ranges = [
    ['set-width', 'penWidth', (v) => `${v.toFixed(2).replace('.', ',')} mm`],
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
  const fmt = $('set-format');
  fmt.querySelector('option[value="vorlage"]').disabled = !state.gnTemplate;
  if (!state.gnTemplate && s.pageFormat === 'vorlage') s.pageFormat = 'a4';
  fmt.value = s.pageFormat;
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
  return PAGE_A4;
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
  res.pen = { type: s.penType, color: s.inkColor, width: s.penWidth };
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
