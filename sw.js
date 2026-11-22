/**
 * @fileoverview Service Worker - GenLogistics Embalajes (Offline App Shell v1.3.2)
 * @architecture Stale-While-Revalidate para App Shell | Network-Only para API GAS
 */

const CACHE_VERSION = 'genlogistics-embalajes-v1.4.0';
const MEDIA_CACHE = 'genlogistics-media-v1';

// Recursos estáticos críticos que forman el App Shell (100% Zero-CDN)
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './sync-engine.js',
  './script.js'
];

// ==========================================
// 1. INSTALACIÓN: PRE-CACHEO DEL APP SHELL
// ==========================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => {
        console.info('[SW] Pre-cacheando App Shell v1.3.2...');
        return cache.addAll(APP_SHELL_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch((err) => console.error('[SW] Error durante pre-cacheo:', err))
  );
});

// ==========================================
// 2. ACTIVACIÓN: LIMPIEZA DE CACHÉS OBSOLETOS
// ==========================================
self.addEventListener('activate', (event) => {
  const validCaches = new Set([CACHE_VERSION, MEDIA_CACHE]);

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (!validCaches.has(cacheName)) {
              console.info('[SW] Eliminando caché antiguo:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// ==========================================
// 3. INTERCEPTOR DE RED (FETCH)
// ==========================================
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // REGLA 1: Solo interceptar GET sobre HTTP/HTTPS
  if (request.method !== 'GET' || !request.url.startsWith('http')) return;

  const requestUrl = new URL(request.url);

  // REGLA 2: Bypass total para API Google Apps Script (manejo exclusivo de SyncEngine)
  if (
    requestUrl.hostname.includes('script.google.com') ||
    requestUrl.hostname.includes('script.googleusercontent.com')
  ) {
    return;
  }

  // REGLA 3: Cache-First para fotos de vehículos/assets externos de imagen
  if (request.destination === 'image' && requestUrl.origin !== self.location.origin) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cachedImg = await cache.match(request);
        if (cachedImg) return cachedImg;

        try {
          const netImg = await fetch(request);
          if (netImg && (netImg.status === 200 || netImg.type === 'opaque')) {
            cache.put(request, netImg.clone());
          }
          return netImg;
        } catch (e) {
          return new Response('', { status: 408, statusText: 'Offline Image' });
        }
      })
    );
    return;
  }

  // REGLA 4: Stale-While-Revalidate con fallback blindado para el App Shell
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          // Si estamos offline y no había match exacto, devolver index.html en navegaciones
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
