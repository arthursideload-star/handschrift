// "Schrift aus GoodNotes übernehmen": panel at the top of "Meine Schrift".
// Self-contained: mounts itself, saves the font to the store and tells the rest
// of the app via a `font-changed` event (main.js refreshes editor + preview).

import { buildSheetPdf, readFilledSheet, mergeGlyphs, SHEET } from './sheet.js';
import * as store from './store.js';
import { deliverFiles, toast } from './util.js';
import { ALL_CHARS } from './charset.js';

const CSS = `
.sheet-panel { margin: 0 0 14px; padding: 0 0 12px; border-top: 0; border-bottom: 1px solid var(--line); }
.sheet-panel > summary { padding-top: 0; }
.sheet-panel .steps { font-size: 13px; margin: 8px 0; }
.sheet-panel .row { margin-top: 8px; }
.sheet-result { margin-top: 10px; font-size: 13px; }
.sheet-result p { margin: 6px 0; }
.sheet-preview { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 4px; margin: 8px 0; max-height: 220px; overflow: auto; }
.sheet-preview figure { margin: 0; position: relative; background: #fff; border: 1px solid var(--line); border-radius: 6px; aspect-ratio: 1; }
.sheet-preview svg { width: 100%; height: 100%; display: block; }
.sheet-preview figcaption { position: absolute; top: 1px; left: 3px; font-size: 9px; color: var(--muted); line-height: 1; }
`;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function glyphSvg(strokes) {
  const d = strokes
    .map((s) => {
      let p = '';
      for (let i = 0; i < s.length; i += 3) p += `${i ? 'L' : 'M'}${s[i].toFixed(3)} ${s[i + 1].toFixed(3)}`;
      return s.length === 3 ? `${p}l0.01 0` : p;
    })
    .join('');
  return `<svg viewBox="-0.3 -1.4 2 2" aria-hidden="true"><line x1="-0.3" x2="1.7" y1="0" y2="0" stroke="#d6dde6" stroke-width="0.03"/><path d="${d}" fill="none" stroke="#1f2f6b" stroke-width="0.07" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function mount() {
  const host = document.querySelector('#tab-font .charset-panel');
  if (!host) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const el = document.createElement('details');
  el.className = 'sheet-panel';
  el.innerHTML = `
    <summary>Schrift aus GoodNotes übernehmen</summary>
    <p class="small">Lieber in GoodNotes schreiben? Dann füll dort ein Schreibblatt aus – die App übernimmt deine echten Striche.</p>
    <ol class="steps">
      <li>Schreibblatt herunterladen und in GoodNotes als <b>neues Notizbuch</b> öffnen.</li>
      <li>Mit dem <b>Kugelschreiber</b> jedes Zeichen 3× in seine Kästchen schreiben – auf die dicke Grundlinie. Seiten nicht umsortieren.</li>
      <li>Notizbuch → <b>Teilen/Exportieren</b> → Format <b>„GoodNotes“</b> → in Dateien sichern.</li>
      <li>Die Datei hier laden.</li>
    </ol>
    <div class="row wrap">
      <button type="button" class="btn small" data-act="pdf">Schreibblatt herunterladen (PDF)</button>
      <label class="btn small primary">Ausgefülltes Blatt laden (.goodnotes)<input type="file" accept=".goodnotes,application/octet-stream" hidden></label>
    </div>
    <div class="sheet-result" aria-live="polite"></div>`;
  host.prepend(el);

  const result = el.querySelector('.sheet-result');
  const input = el.querySelector('input[type=file]');
  store
    .get('font')
    .then((f) => { if (!f || !f.glyphs || !Object.keys(f.glyphs).length) el.open = true; })
    .catch(() => {});

  el.querySelector('[data-act=pdf]').onclick = async () => {
    try {
      const bytes = await buildSheetPdf();
      await deliverFiles([new File([bytes], 'Handschrift-Schreibblatt.pdf', { type: 'application/pdf' })]);
    } catch (err) {
      console.error(err);
      toast('Schreibblatt konnte nicht erstellt werden.', 'error');
    }
  };

  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    result.innerHTML = '<p class="muted">Lese Datei …</p>';
    let res;
    try {
      res = await readFilledSheet(await file.arrayBuffer());
    } catch (err) {
      console.error(err);
      result.innerHTML = `<p class="warn">Die Datei konnte nicht gelesen werden: ${escapeHtml(err.message || String(err))}. Bitte das Notizbuch im Format „GoodNotes“ exportieren (nicht als PDF).</p>`;
      return;
    }
    showResult(res);
  });

  async function showResult(res) {
    const notes = [];
    if (res.other) notes.push(`${res.other} Strich${res.other === 1 ? '' : 'e'} mit Füller, Bleistift oder Marker übersprungen – bitte den <b>Kugelschreiber</b> nehmen.`);
    if (res.outside) notes.push(`${res.outside} Strich${res.outside === 1 ? '' : 'e'} außerhalb der Kästchen ignoriert.`);
    if (res.pages < SHEET.pages) notes.push(`Nur ${res.pages} von ${SHEET.pages} Seiten gefunden.`);
    if (res.extraPages) notes.push(`${res.extraPages} zusätzliche Seite${res.extraPages === 1 ? '' : 'n'} am Ende ignoriert.`);
    if (!res.variants) {
      result.innerHTML =
        `<p class="warn">Keine Buchstaben gefunden. Ist das das ausgefüllte Schreibblatt, mit dem Kugelschreiber geschrieben?</p>` +
        notes.map((n) => `<p class="muted">${n}</p>`).join('');
      return;
    }
    const cursive = document.body.dataset.fontMode === 'cursive'; // "Meine Schrift" is set to Schreibschrift
    const font = (await store.get('font').catch(() => null)) || { version: 1, glyphs: {} };
    const target = cursive ? font.cursive || {} : font;
    const existing = Object.keys(res.glyphs).filter((ch) => (target.glyphs?.[ch] || []).length);
    const chars = ALL_CHARS.filter((ch) => res.glyphs[ch]);
    const missing = ALL_CHARS.length - chars.length;
    result.innerHTML = `
      <p><b>${res.chars} Zeichen</b> mit <b>${res.variants} Varianten</b> gefunden${missing ? ` (${missing} Zeichen leer)` : ''}. Sie kommen in deine <b>${cursive ? 'Schreibschrift' : 'Druckschrift'}</b> (umschalten oben im Editor).</p>
      ${notes.map((n) => `<p class="muted">${n}</p>`).join('')}
      <div class="sheet-preview">${chars
        .map((ch) => `<figure title="${escapeHtml(ch)}: ${res.glyphs[ch].length} Variante(n)"><figcaption>${escapeHtml(ch)}</figcaption>${glyphSvg(res.glyphs[ch][0].s)}</figure>`)
        .join('')}</div>
      ${existing.length ? `<p>${existing.length} dieser Zeichen hast du schon. Was soll mit den alten Varianten passieren?</p>` : ''}
      <div class="row wrap">
        ${existing.length
          ? `<button type="button" class="btn small primary" data-mode="replace">Ersetzen</button>
             <button type="button" class="btn small" data-mode="add">Dazunehmen</button>`
          : `<button type="button" class="btn small primary" data-mode="replace">Übernehmen</button>`}
        <button type="button" class="btn small ghost" data-mode="cancel">Abbrechen</button>
      </div>`;
    result.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.mode === 'cancel') {
          result.innerHTML = '';
          return;
        }
        try {
          const current = (await store.get('font')) || { version: 1, glyphs: {} };
          const merged = cursive
            ? { ...current, cursive: mergeGlyphs(current.cursive, res.glyphs, b.dataset.mode) }
            : mergeGlyphs(current, res.glyphs, b.dataset.mode);
          await store.set('font', merged);
          window.dispatchEvent(new CustomEvent('font-changed', { detail: { font: merged, source: 'sheet' } }));
          result.innerHTML = `<p>✓ ${res.chars} Zeichen übernommen.</p>`;
          toast(`${res.chars} Zeichen aus GoodNotes übernommen.`, 'ok');
        } catch (err) {
          console.error(err);
          toast('Speichern fehlgeschlagen.', 'error');
        }
      };
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
