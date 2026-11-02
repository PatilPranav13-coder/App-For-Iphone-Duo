const CACHE_NAME = 'tessera-shell-v1';
const APP_SHELL = [
  '/', '/manifest.json', '/assets/icon.svg', '/assets/tessera-mark.svg',
  '/src/styles.css', '/src/main.js', '/src/analysis/engine.js',
  '/src/storage/database.js', '/src/visualization/chart.js',
  '/src/foldable/posture.js', '/src/notebook/canvas.js',
  '/src/workers/data.worker.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(APP_SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE_NAME; }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put('/', copy); });
      return response;
    }).catch(function () { return caches.match('/'); }));
    return;
  }
  event.respondWith(caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/src/'))) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    });
  }));
});
