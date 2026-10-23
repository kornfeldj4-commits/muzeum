/* Muzeum service worker: the app opens offline with the last museum data it saw.
 * Data and pages: network first, saved copy when offline (marked with a header).
 * Fonts and icons: saved copy first. */
const VERSION = '__BUILD__';
const CACHE = 'muzeum-' + VERSION;
const SHELL = __SHELL__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('muzeum-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function marked(res) {
  const h = new Headers(res.headers);
  h.set('x-muzeum-cache', '1');
  return res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers: h }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const isData = url.pathname.endsWith('/data/museums.json');
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isData || isPage) {
    e.respondWith(fetch(req).then((res) => {
      if (isData && !res.ok) throw new Error('data ' + res.status);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(isData ? 'data/museums.json' : req, copy)); }
      return res;
    }).catch(() => caches.open(CACHE).then((c) => c.match(isData ? 'data/museums.json' : req, { ignoreSearch: true })
      .then((hit) => hit || (isPage ? c.match('index.html') : undefined))
      .then((hit) => (hit ? (isData ? marked(hit) : hit) : Response.error())))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
