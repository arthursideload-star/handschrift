// Offline support: the app opens even without internet (e.g. bad school Wi-Fi).
// Strategy: serve from cache immediately, refresh the cache in the background.
const VERSION = 'v7';
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
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
    }),
  );
});
