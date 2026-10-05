/* Phase 0 service worker: the app shell opens without internet. API calls are never cached. */
const VERSION = 'vitral-shell-v2';
// Works at the site root or in a sub-folder (e.g. /app/): every path is relative to where sw.js is served.
const BASE = new URL('./', self.location).pathname;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icons/icon.svg`, `${BASE}fonts/Vazirmatn-Variable.woff2`];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith(`${BASE}api/`)) return;

  // Navigations: network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(BASE, copy));
          return res;
        })
        .catch(() => caches.match(BASE)),
    );
    return;
  }

  // Hashed assets and fonts: cache first.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith(`${BASE}assets/`) || url.pathname.startsWith(`${BASE}fonts/`) || url.pathname.startsWith(`${BASE}icons/`))) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
