// Small shared helpers.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function randomSeed() {
  return (Math.random() * 2 ** 31) >>> 0;
}

export function uuidUpper() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

export function rand32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Offer files to the user: on iPad use the share sheet (→ "In GoodNotes öffnen"),
// otherwise trigger normal downloads.
export async function deliverFiles(files) {
  if (navigator.canShare && navigator.share) {
    try {
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'aborted';
      // iPad/iPhone: building the file took too long, the tap "expired" and Safari
      // refuses the share sheet. Offer a button – a fresh tap is allowed to share.
      if (err && err.name === 'NotAllowedError') return shareOnTap(files);
    }
  }
  return downloadFiles(files);
}

function shareOnTap(files) {
  document.getElementById('share-ready')?.remove();
  const btn = document.createElement('button');
  btn.id = 'share-ready';
  btn.type = 'button';
  btn.textContent = files.length > 1 ? `📤 ${files.length} Dateien sichern / teilen` : `📤 ${files[0].name} sichern / teilen`;
  btn.style.cssText =
    'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;padding:14px 22px;border:0;border-radius:14px;background:#0a84ff;color:#fff;font:600 16px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.25)';
  document.body.appendChild(btn);
  return new Promise((resolve) => {
    btn.onclick = async () => {
      btn.remove();
      try {
        await navigator.share({ files });
        resolve('shared');
      } catch (err) {
        resolve(err && err.name === 'AbortError' ? 'aborted' : downloadFiles(files));
      }
    };
  });
}

async function downloadFiles(files) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000); // iOS Safari reads the blob lazily
    await new Promise((r) => setTimeout(r, 350));
  }
  return 'downloaded';
}

export function toast(msg, kind = 'info', ms = 3800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}
