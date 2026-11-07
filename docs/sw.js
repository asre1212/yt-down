const CACHE = 'yt-down-shell-v1.0.0';
const ASSETS = ['./','./index.html','./style.css','./app.js','./core.js','./manifest.webmanifest','./icon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('yt-down-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || url.pathname.includes('/api/') || event.request.headers.has('Authorization')) return;
  // Versioned shell stays coherent; checking sw.js on each opening installs updates atomically.
  if (event.request.mode === 'navigate') { event.respondWith(caches.match(new URL('./index.html',scope).href).then(cached => cached || fetch(event.request))); return; }
  if (ASSETS.some(path => new URL(path, scope).href === url.href)) event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
