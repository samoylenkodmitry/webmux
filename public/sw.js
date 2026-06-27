// App-shell service worker: network-first with a cache fallback. On the tailnet
// you always get fresh assets; offline (or server down) the shell still loads.
// Bump CACHE to force old caches out after asset changes.
const CACHE = 'ptw-v24';
const SHELL = [
  '/', '/index.html', '/app.js', '/style.css',
  '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js',
  '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Activity alerts: show a notification, and on tap focus/open that session.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* non-JSON */ }
  e.waitUntil(self.registration.showNotification(d.title || 'webmux', {
    body: d.body || '',
    tag: d.tag,
    data: { name: d.name || '' },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [80, 40, 80],
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const name = e.notification.data && e.notification.data.name;
  const url = name ? '/#s=' + encodeURIComponent(name) : '/';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) { if ('focus' in c) { try { await c.navigate(url); } catch { /* ignore */ } return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept API calls or WebSocket upgrades.
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
