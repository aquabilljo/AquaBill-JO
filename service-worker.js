/* ==========================================================================
   AquaBill JO — حاسبة فاتورة المياه الأردنية — Service Worker
   ========================================================================== */

const CACHE_NAME = 'aquabill-jo-v14';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './theme-init.js',
  './script.js',
  './qrcode.min.js',
  './manifest.webmanifest',
  './favicon.ico',
  './images/favicon.svg',
  './images/favicon-16.png',
  './images/favicon-32.png',
  './images/apple-touch-icon.png',
  './images/android-chrome-192.png',
  './images/android-chrome-512.png',
  './images/og-image.png',
  './images/logo.png',
  './images/icon-192.png',
  './images/icon-512.png'
];

/* ---------------------------------------------------------------------------
   Install
   ------------------------------------------------------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

/* ---------------------------------------------------------------------------
   Activate
   ------------------------------------------------------------------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith('aquabill-jo-'))
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---------------------------------------------------------------------------
   Fetch
   ------------------------------------------------------------------------- */

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(event.request)
          .then((networkResponse) => {
            if (
              networkResponse &&
              networkResponse.status === 200 &&
              event.request.url.startsWith(self.location.origin)
            ) {
              const responseClone = networkResponse.clone();

              caches.open(CACHE_NAME)
                .then((cache) => {
                  cache.put(event.request, responseClone);
                });
            }

            return networkResponse;
          })
          .catch(() => {
            if (event.request.mode === 'navigate') {
              return caches.match('./index.html');
            }

            return Response.error();
          });
      })
  );
});
