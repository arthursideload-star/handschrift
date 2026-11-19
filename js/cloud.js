// Optional login + cloud sync (Supabase). The app works fully without it:
// IndexedDB (store.js) stays the source the app reads from; this module only
// mirrors 'font', 'settings' and 'gnTemplate' to the user's own cloud row.
import * as store from './store.js';
import { toast } from './util.js';

// Public project settings. The publishable key is meant to be in the page –
// Row Level Security in the database makes sure everybody only sees their own row.
const SUPABASE_URL = 'https://bzoqgzvnoxiygxulncjp.supabase.co';
const SUPABASE_KEY = 'sb_publishable__nme3P2nKV-ap1K1LQ-Ciw_7oDqcDYp';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.1/+esm';

const TABLE = 'fonts';
const META_KEY = 'cloudMeta';
const KEYS = { font: 'font', settings: 'settings', gnTemplate: 'template' }; // local key -> column
const PUSH_DELAY = 1500;

let sb = null; // supabase client (loaded lazily, so offline start never breaks)
let user = null;
let status = 'local';
let pushing = false;
let pushAgain = false;
let pushTimer = 0;
let retryTimer = 0;
let syncing = null;
let el = {};

// ------------------------------------------------------------------ meta (persisted sync bookkeeping)
// { userId, lastSyncedAt, dirty: { font: seq, … }, seq }
async function getMeta() {
  return (await store.get(META_KEY).catch(() => null)) || { userId: null, lastSyncedAt: null, dirty: {}, seq: 0 };
}
const saveMeta = (meta) => store.set(META_KEY, meta, { quiet: true });

async function markDirty(localKey) {
  const meta = await getMeta();
  meta.seq = (meta.seq || 0) + 1;
  meta.dirty = { ...meta.dirty, [localKey]: meta.seq };
  await saveMeta(meta);
}

// ------------------------------------------------------------------ public API
export function initCloud() {
  buildUi();
  // Every local change to font/settings/template marks it for upload.
  store.onChange((key) => {
    if (!(key in KEYS)) return;
    markDirty(key).then(() => user && schedulePush());
  });
  if (SUPABASE_URL.startsWith('__')) {
    setStatus('local');
    return;
  }
  connect();
  window.addEventListener('online', () => user && schedulePush(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && user) refreshFromCloud();
  });
}

async function connect() {
  try {
    const { createClient } = await import(SUPABASE_JS);
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'handschrift.auth' },
    });
  } catch (err) {
    console.warn('Cloud nicht erreichbar', err);
    setStatus((await getMeta()).userId ? 'offline' : 'local');
    retryTimer = setTimeout(connect, 30000);
    return;
  }
  sb.auth.onAuthStateChange((event, session) => {
    // Supabase recommends not awaiting other calls inside this callback.
    setTimeout(() => onAuth(event, session), 0);
  });
}

async function onAuth(event, session) {
  if (event === 'PASSWORD_RECOVERY') {
    user = session?.user || null;
    openDialog('newpw');
    return;
  }
  const next = session?.user || null;
  if (event === 'SIGNED_OUT' || !next) {
    user = null;
    setStatus('local');
    renderAccount();
    return;
  }
  const changedUser = !user || user.id !== next.id;
  user = next;
  renderAccount();
  if (changedUser) await syncNow();
}

// ------------------------------------------------------------------ local data helpers
async function readLocal() {
  const [font, settings, tpl] = await Promise.all([store.get('font'), store.get('settings'), store.get('gnTemplate')]);
  return { font: font || null, settings: settings || null, gnTemplate: tpl || null };
}

const glyphCount = (font) => (font && font.glyphs ? Object.keys(font.glyphs).length : 0);

async function toColumn(localKey, value) {
  if (localKey !== 'gnTemplate') return value ?? null;
  if (!value || !value.buffer) return null;
  return { name: value.name || 'Vorlage.goodnotes', b64: await bufferToBase64(value.buffer) };
}

function fromColumn(localKey, value) {
  if (localKey !== 'gnTemplate') return value ?? null;
  if (!value || !value.b64) return null;
  return { name: value.name, buffer: base64ToBuffer(value.b64) };
}

function bufferToBase64(buffer) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([buffer]));
  });
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function mergeFonts(a, b) {
  const glyphs = {};
  for (const src of [a, b]) {
    for (const [ch, list] of Object.entries((src && src.glyphs) || {})) {
      const seen = new Set((glyphs[ch] || []).map((v) => JSON.stringify(v)));
      for (const v of list) {
        const k = JSON.stringify(v);
        if (!seen.has(k)) {
          seen.add(k);
          (glyphs[ch] ||= []).push(v);
        }
      }
    }
  }
  return { version: 1, glyphs };
}

// Write data into the local cache (without triggering an upload) and reload
// the page, so every part of the app shows the new letters/settings.
async function writeLocalAndReload(data, message) {
  for (const key of Object.keys(KEYS)) {
    if (!(key in data)) continue;
    if (data[key] == null) await store.del(key, { quiet: true });
    else await store.set(key, data[key], { quiet: true });
  }
  sessionStorage.setItem('handschrift.cloudToast', message);
  location.reload();
}

// ------------------------------------------------------------------ sync on login / on return
async function fetchRow() {
  const { data, error } = await sb.from(TABLE).select('*').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

function syncNow() {
  if (!syncing) syncing = doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  if (!user) return;
  setStatus('syncing');
  let row;
  try {
    row = await fetchRow();
  } catch (err) {
    return pushFailed(err);
  }
  const meta = await getMeta();
  const local = await readLocal();
  const sameUser = meta.userId === user.id;
  const dirty = Object.keys(meta.dirty || {}).length > 0;

  if (!row) {
    // Nothing in the cloud yet: upload what this device has.
    const dirtyAll = allDirty(local, meta);
    await saveMeta({ ...meta, userId: user.id, lastSyncedAt: null, dirty: dirtyAll });
    if (Object.values(local).some((v) => v != null)) return push();
    return setStatus('ok');
  }

  const cloud = {
    font: row.font,
    settings: row.settings,
    gnTemplate: fromColumn('gnTemplate', row.template),
  };

  if (sameUser) {
    const cloudChanged = row.updated_at !== meta.lastSyncedAt;
    if (!cloudChanged) return dirty ? push() : setStatus('ok');
    if (!dirty) return adoptCloud(cloud, local, row.updated_at, 'Neuere Version aus der Cloud geladen ✓');
    // Changed here (offline) AND on another device: fall through and ask.
  } else {
    // First login on this device (or a different account).
    const localHas = glyphCount(local.font) > 0;
    const cloudHas = glyphCount(cloud.font) > 0;
    if (!localHas) return adoptCloud(cloud, local, row.updated_at, 'Deine Schrift wurde aus der Cloud geladen ✓');
    if (!cloudHas) return uploadLocal(local, cloud, meta);
    if (JSON.stringify(local.font.glyphs) === JSON.stringify(cloud.font.glyphs))
      return adoptCloud(cloud, local, row.updated_at, 'Mit der Cloud verbunden ✓');
  }

  const choice = await askConflict(glyphCount(local.font), glyphCount(cloud.font));
  if (choice === 'cloud') return adoptCloud(cloud, local, row.updated_at, 'Schrift aus der Cloud übernommen ✓');
  if (choice === 'local') return uploadLocal(local, cloud, meta);
  // merge
  const merged = {
    font: mergeFonts(cloud.font, local.font),
    settings: cloud.settings ?? local.settings,
    gnTemplate: cloud.gnTemplate ?? local.gnTemplate,
  };
  const dirtyMerged = allDirty(merged, meta);
  await saveMeta({ ...meta, userId: user.id, lastSyncedAt: row.updated_at, dirty: dirtyMerged });
  return writeLocalAndReload(merged, 'Schriften zusammengeführt ✓ – wird hochgeladen …');
}

function allDirty(data, meta) {
  const dirty = {};
  for (const k of Object.keys(KEYS)) if (data[k] != null) dirty[k] = ++meta.seq;
  return dirty;
}

async function adoptCloud(cloud, local, updatedAt, message) {
  const data = {
    font: cloud.font ?? local.font,
    settings: cloud.settings ?? local.settings,
    gnTemplate: cloud.gnTemplate ?? local.gnTemplate,
  };
  const meta = await getMeta();
  const dirty = {};
  // Keep local-only pieces (e.g. template not yet in the cloud) for upload.
  for (const k of Object.keys(KEYS)) if (cloud[k] == null && local[k] != null) dirty[k] = ++meta.seq;
  await saveMeta({ ...meta, userId: user.id, lastSyncedAt: updatedAt, dirty });
  const same = Object.keys(KEYS).every((k) => k === 'gnTemplate' || JSON.stringify(data[k]) === JSON.stringify(local[k]));
  const sameTpl = (data.gnTemplate?.buffer?.byteLength || 0) === (local.gnTemplate?.buffer?.byteLength || 0);
  if (same && sameTpl) {
    if (Object.keys(dirty).length) return push();
    return setStatus('ok');
  }
  return writeLocalAndReload(data, message);
}

async function uploadLocal(local, cloud, meta) {
  // Keep the cloud template if this device has none.
  if (!local.gnTemplate && cloud.gnTemplate) await store.set('gnTemplate', cloud.gnTemplate, { quiet: true });
  const data = { ...local, gnTemplate: local.gnTemplate ?? cloud.gnTemplate };
  const dirtyData = allDirty(data, meta);
  await saveMeta({ ...meta, userId: user.id, dirty: dirtyData });
  return push();
}

async function refreshFromCloud() {
  if (syncing || pushing) return;
  const meta = await getMeta();
  if (Object.keys(meta.dirty || {}).length) return schedulePush(0);
  try {
    const { data, error } = await sb.from(TABLE).select('updated_at').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    if (data && data.updated_at !== meta.lastSyncedAt) await syncNow();
    else setStatus('ok');
  } catch (err) {
    setStatus('offline');
  }
}

// ------------------------------------------------------------------ upload
function schedulePush(delay = PUSH_DELAY) {
  clearTimeout(pushTimer);
  setStatus('pending');
  pushTimer = setTimeout(() => push(), delay);
}

async function push() {
  if (!user || !sb) return;
  if (pushing) {
    pushAgain = true;
    return;
  }
  pushing = true;
  clearTimeout(retryTimer);
  try {
    const meta = await getMeta();
    const sent = { ...(meta.dirty || {}) };
    if (!Object.keys(sent).length) return setStatus('ok');
    setStatus('syncing');
    const payload = { user_id: user.id };
    for (const k of Object.keys(sent)) payload[KEYS[k]] = await toColumn(k, await store.get(k));
    const { data, error } = await sb.from(TABLE).upsert(payload, { onConflict: 'user_id' }).select('updated_at').single();
    if (error) throw error;
    const now = await getMeta();
    for (const [k, seq] of Object.entries(sent)) if (now.dirty[k] === seq) delete now.dirty[k];
    now.lastSyncedAt = data.updated_at;
    now.userId = user.id;
    await saveMeta(now);
    setStatus(Object.keys(now.dirty).length ? 'pending' : 'ok');
    if (Object.keys(now.dirty).length) pushAgain = true;
  } catch (err) {
    pushFailed(err);
  } finally {
    pushing = false;
    if (pushAgain) {
      pushAgain = false;
      schedulePush(300);
    }
  }
}

function pushFailed(err) {
  console.warn('Cloud-Sync fehlgeschlagen', err);
  const offline = !navigator.onLine || /fetch|network|load failed/i.test(String(err && (err.message || err)));
  setStatus(offline ? 'offline' : 'error');
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => (user ? syncNow() : null), offline ? 20000 : 60000);
}

// ------------------------------------------------------------------ UI
const STATUS_TEXT = {
  local: 'Nur auf diesem Gerät',
  pending: 'Änderungen werden gespeichert …',
  syncing: 'Wird mit der Cloud abgeglichen …',
  ok: 'In der Cloud gespeichert ✓',
  offline: 'Offline – wird später gespeichert',
  error: 'Cloud-Fehler – wird erneut versucht',
};

function setStatus(s) {
  status = s;
  if (!el.status) return;
  el.status.textContent = user ? STATUS_TEXT[s] : '';
  el.status.dataset.state = s;
  if (el.dlgStatus) el.dlgStatus.textContent = STATUS_TEXT[s];
}

function buildUi() {
  const slot = document.getElementById('account');
  if (!slot) return;
  slot.innerHTML = `
    <span id="sync-status" class="sync-status" aria-live="polite"></span>
    <button type="button" id="account-btn" class="btn small account-btn">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.4 10.1 4 4 0 0 0 7 18Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      <span id="account-label">Anmelden</span>
    </button>`;
  el.status = slot.querySelector('#sync-status');
  el.btn = slot.querySelector('#account-btn');
  el.label = slot.querySelector('#account-label');
  el.btn.onclick = () => openDialog(user ? 'account' : 'login');

  const dlg = document.createElement('dialog');
  dlg.id = 'account-dialog';
  dlg.className = 'cloud-dialog';
  document.body.append(dlg);
  el.dlg = dlg;

  const msg = sessionStorage.getItem('handschrift.cloudToast');
  if (msg) {
    sessionStorage.removeItem('handschrift.cloudToast');
    setTimeout(() => toast(msg, 'ok', 5000), 300);
  }
}

function renderAccount() {
  if (!el.label) return;
  el.label.textContent = user ? 'Konto' : 'Anmelden';
  el.btn.title = user ? `Angemeldet als ${user.email}` : 'Anmelden, um deine Schrift auf allen Geräten zu haben';
  setStatus(status);
}

function openDialog(view) {
  const dlg = el.dlg;
  if (!dlg) return;
  if (SUPABASE_URL.startsWith('__')) {
    toast('Cloud-Speicher ist noch nicht eingerichtet.');
    return;
  }
  if (!sb) {
    toast('Keine Verbindung zum Cloud-Speicher. Bist du online?', 'error');
    connect();
    return;
  }
  dlg.innerHTML = views[view]();
  el.dlgStatus = dlg.querySelector('[data-status]');
  bind[view]?.(dlg);
  if (!dlg.open) dlg.showModal();
  setStatus(status);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const views = {
  login: () => `
    <form method="dialog" class="cloud-form" data-form="login">
      <h2>Anmelden</h2>
      <p class="muted small">Mit einem Konto ist deine Schrift auf jedem iPad da – du musst die Buchstaben nie wieder zeichnen. Ohne Konto bleibt alles nur auf diesem Gerät.</p>
      <label class="cloud-field">E-Mail
        <input type="email" name="email" autocomplete="username" required inputmode="email" autocapitalize="off" spellcheck="false">
      </label>
      <label class="cloud-field">Passwort
        <input type="password" name="password" autocomplete="current-password" required minlength="6">
      </label>
      <p class="cloud-msg" data-msg></p>
      <div class="cloud-actions">
        <button type="submit" class="btn primary" value="signin">Anmelden</button>
        <button type="submit" class="btn" value="signup">Neues Konto erstellen</button>
      </div>
      <div class="cloud-actions between">
        <button type="button" class="link" data-act="forgot">Passwort vergessen?</button>
        <button type="button" class="link" data-act="close">Schließen</button>
      </div>
    </form>`,
  account: () => `
    <div class="cloud-form">
      <h2>Dein Konto</h2>
      <p>Angemeldet als <b>${esc(user?.email || '')}</b></p>
      <p class="muted small" data-status></p>
      <p class="muted small">Deine Buchstaben, Einstellungen und die GoodNotes-Vorlage werden automatisch gespeichert. Auf einem anderen iPad einfach mit derselben E-Mail anmelden.</p>
      <div class="cloud-actions">
        <button type="button" class="btn" data-act="sync">Jetzt abgleichen</button>
        <button type="button" class="btn danger" data-act="signout">Abmelden</button>
      </div>
      <p class="muted small">Beim Abmelden bleibt deine Schrift auf diesem Gerät. Auf fremden/Schul-iPads nach dem Benutzen abmelden.</p>
      <div class="cloud-actions between"><span></span><button type="button" class="link" data-act="close">Schließen</button></div>
    </div>`,
  newpw: () => `
    <form method="dialog" class="cloud-form" data-form="newpw">
      <h2>Neues Passwort</h2>
      <label class="cloud-field">Neues Passwort
        <input type="password" name="password" autocomplete="new-password" required minlength="6">
      </label>
      <p class="cloud-msg" data-msg></p>
      <div class="cloud-actions"><button type="submit" class="btn primary">Speichern</button></div>
    </form>`,
};

const bind = {
  login(dlg) {
    const form = dlg.querySelector('form');
    const msg = dlg.querySelector('[data-msg]');
    const say = (t, kind = '') => {
      msg.textContent = t;
      msg.dataset.kind = kind;
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = e.submitter?.value || 'signin';
      const email = form.email.value.trim();
      const password = form.password.value;
      const buttons = form.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      say(action === 'signup' ? 'Konto wird erstellt …' : 'Anmelden …');
      try {
        if (action === 'signup') {
          const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
          if (error) throw error;
          if (!data.session) {
            say('Fast geschafft! Wir haben dir eine E-Mail geschickt. Klick auf den Link darin und melde dich danach hier an.', 'ok');
            return;
          }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
        dlg.close();
        toast('Angemeldet ✓', 'ok');
      } catch (err) {
        say(authError(err), 'error');
        if (/email not confirmed/i.test(String(err && err.message))) offerResend(msg, email);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    });
    dlg.querySelector('[data-act="forgot"]').onclick = async () => {
      const email = form.email.value.trim();
      if (!email) return say('Gib zuerst oben deine E-Mail ein.', 'error');
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      say(error ? authError(error) : 'Wir haben dir einen Link zum Zurücksetzen geschickt.', error ? 'error' : 'ok');
    };
    dlg.querySelector('[data-act="close"]').onclick = () => dlg.close();
  },
  account(dlg) {
    dlg.querySelector('[data-act="sync"]').onclick = () => syncNow();
    dlg.querySelector('[data-act="signout"]').onclick = async () => {
      await sb.auth.signOut();
      const meta = await getMeta();
      await saveMeta({ ...meta, userId: null, lastSyncedAt: null });
      dlg.close();
      toast('Abgemeldet. Deine Schrift bleibt auf diesem Gerät.');
    };
    dlg.querySelector('[data-act="close"]').onclick = () => dlg.close();
  },
  newpw(dlg) {
    const form = dlg.querySelector('form');
    const msg = dlg.querySelector('[data-msg]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: form.password.value });
      if (error) {
        msg.textContent = authError(error);
        msg.dataset.kind = 'error';
        return;
      }
      dlg.close();
      toast('Passwort geändert ✓', 'ok');
      syncNow();
    });
  },
};

function appUrl() {
  return location.origin + location.pathname;
}

// "Email not confirmed": let people request the confirmation mail again.
function offerResend(msg, email) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small';
  b.textContent = 'Bestätigungs-Mail nochmal senden';
  b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: appUrl() } });
    msg.textContent = error ? authError(error) : 'Neue Mail ist unterwegs – schau auch im Spam-Ordner nach.';
    msg.dataset.kind = error ? 'error' : 'ok';
  };
  msg.append(' ', b);
}

function authError(err) {
  const m = String((err && err.message) || err);
  if (/not authorized|email_address_not_authorized/i.test(m)) return 'An diese E-Mail-Adresse kann gerade keine Mail geschickt werden (E-Mail-Versand noch nicht eingerichtet).';
  if (/email rate limit/i.test(m)) return 'Gerade wurden zu viele E-Mails verschickt – bitte in einer Stunde nochmal probieren.';
  if (/invalid login credentials/i.test(m)) return 'E-Mail oder Passwort stimmt nicht.';
  if (/email not confirmed/i.test(m)) return 'Bitte bestätige zuerst deine E-Mail (Link in der Mail).';
  if (/already registered|already been registered/i.test(m)) return 'Für diese E-Mail gibt es schon ein Konto – melde dich an.';
  if (/password should be at least|weak password/i.test(m)) return 'Das Passwort ist zu kurz (mindestens 6 Zeichen).';
  if (/rate limit|too many/i.test(m)) return 'Zu viele Versuche – warte kurz und probier es nochmal.';
  if (/fetch|network|load failed/i.test(m)) return 'Keine Internetverbindung.';
  return m;
}

// Ask once what to do when this device and the cloud both have letters.
function askConflict(localCount, cloudCount) {
  return new Promise((resolve) => {
    const dlg = el.dlg;
    dlg.innerHTML = `
      <div class="cloud-form">
        <h2>Zwei Versionen deiner Schrift</h2>
        <p>Auf diesem Gerät: <b>${localCount}</b> Zeichen · In der Cloud: <b>${cloudCount}</b> Zeichen.</p>
        <p class="muted small">Was soll gelten?</p>
        <div class="cloud-choices">
          <button type="button" class="btn primary" data-v="cloud">Cloud übernehmen<small>Version dieses Geräts wird ersetzt</small></button>
          <button type="button" class="btn" data-v="local">Lokal hochladen<small>Cloud-Version wird ersetzt</small></button>
          <button type="button" class="btn" data-v="merge">Zusammenführen<small>alle Varianten aus beiden behalten</small></button>
        </div>
      </div>`;
    dlg.querySelectorAll('[data-v]').forEach(
      (b) =>
        (b.onclick = () => {
          dlg.close();
          resolve(b.dataset.v);
        }),
    );
    dlg.oncancel = (e) => e.preventDefault(); // must choose
    if (!dlg.open) dlg.showModal();
  }).finally(() => (el.dlg.oncancel = null));
}
