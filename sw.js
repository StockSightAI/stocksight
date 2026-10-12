// StockSight service worker. Its only job is the offline screen: page loads go to the network as usual
// and fall back to /offline.html when there's no connection. Nothing else is cached, so a new release
// reaches everyone on their next load.
const CACHE = 'ss-offline-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([OFFLINE, '/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  // The offline page's logo comes from the saved copy, so it shows without a connection
  if (new URL(e.request.url).pathname === '/icon-192.png') { e.respondWith(caches.match('/icon-192.png').then(r => r || fetch(e.request))); return; }
  if (e.request.mode !== 'navigate') return;   // scripts, data and other images go straight to the network
  e.respondWith((async () => {
    try {
      return (await e.preloadResponse) || await fetch(e.request);
    } catch {
      return (await caches.match(OFFLINE)) || Response.error();
    }
  })());
});
