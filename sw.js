const SW_VERSION = 'soda-v1';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbw5YWIBTuF012N1PQVWfRECP38azRZ5UjXkibpyQgBl_cDKIf9YcewIAUM-i--7QK9e/exec';

const SHELL_CACHE = SW_VERSION + '-shell';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SODA - Offline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: linear-gradient(160deg, #F6CFD7 0%, #F3BAC9 50%, #EBA1B4 100%);
      padding: 20px;
    }
    .card {
      background: white; border-radius: 20px; padding: 48px 36px;
      text-align: center; max-width: 360px; width: 100%;
      box-shadow: 0 20px 60px rgba(195,120,145,0.2);
    }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h2 { font-size: 20px; font-weight: 800; color: #C4607A; margin-bottom: 8px; }
    p { font-size: 13px; color: #9ca3af; line-height: 1.6; margin-bottom: 24px; }
    button {
      width: 100%; padding: 12px; background: #EBA1B4; color: white;
      border: none; border-radius: 10px; font-size: 14px; font-weight: 700;
      cursor: pointer;
    }
    button:hover { background: #E08CA0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📡</div>
    <h2>Tidak Ada Koneksi</h2>
    <p>SODA memerlukan koneksi internet untuk beroperasi. Silakan periksa koneksi Anda dan coba lagi.</p>
    <button onclick="location.reload()">Coba Lagi</button>
  </div>
</body>
</html>`;

// ── Install: cache shell assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: hapus cache lama
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: strategi per tipe request
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // 1. Apps Script → selalu network-first, JANGAN cache
  if (url.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        }))
    );
    return;
  }

  // 2. Google APIs (login, drive, dll) → network-only
  if (url.includes('googleapis.com') || url.includes('google.com/a')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 3. Shell assets (GitHub Pages) → cache-first
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => new Response(OFFLINE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          }));
      })
  );
});
