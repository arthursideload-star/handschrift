// Offline support: the app opens even without internet (e.g. bad school Wi-Fi).
// Strategy: network first (always the newest version when online), cache only as
// fallback when offline. Keep VERSION in sync with APP_VERSION in js/main.js.
const VERSION = 'v12';
const CACHE = `handschrift-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-512.png',
  './js/main.js',
  './js/charset.js',
  './js/diagrams.js',
  './js/cloud.js',
  './js/sheet.js',
  './js/sheet-ui.js',
  './js/editor.js',
  './js/geom.js',
  './js/goodnotes.js',
  './js/layout.js',
  './js/paper.js',
  './js/pdf.js',
  './js/render.js',
  './js/store.js',
  './js/util.js',
  './js/zip.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache, so the new version really is new
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('handschrift-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // never touch other hosts (e.g. login API)
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(req, { cache: 'no-cache' }); // revalidate with the server
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (_) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
        return Response.error();
      }
    }),
  );
});
