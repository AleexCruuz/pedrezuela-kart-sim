// Lets the game install as an app, and makes every update show up on the next launch:
// files of the game are always revalidated with the server (GitHub Pages would otherwise
// serve them from the browser cache for 10 minutes). Other origins (three.js, fonts) pass through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
});
