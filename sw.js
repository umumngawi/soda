const CACHE_VERSION = 'soda-v2026.01.002';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  console.log('[SW] Installing:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating:', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Jangan intercept request ke GAS
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleapis.com')) {
    return;
  }

  if (event.request.method !== 'GET') return;

  // Gambar → Cache First
  if (event.request.destination === 'image') {
    event.respondWith(
      caches.match(event.request)
        .then(cached => cached || fetch(event.request)
          .then(response => {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
            return response;
          })
        )
        .catch(() => caches.match('./icon-192.png'))
    );
    return;
  }

  // HTML/JS/CSS → Network First, fallback ke cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request)
          .then(cached => cached || caches.match('./index.html'));
      })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
