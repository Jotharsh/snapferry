const CACHE_NAME = 'snapferry-v1';
const PRECACHE_URLS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'favicon.svg',
  'logo.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'fonts/fredoka-600.woff2',
  'fonts/fredoka-700.woff2',
  'fonts/caveat-700.woff2',
  'vendor/qrcode.js',
  'vendor/jsQR.js',
  'vendor/fflate.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      }).catch(() => {
        // Fallback for HTML navigation when offline
        if (event.request.mode === 'navigate') {
          return caches.match('index.html');
        }
      });
    })
  );
});
