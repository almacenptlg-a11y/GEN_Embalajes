/**
 * @fileoverview Service Worker - GenLogistics Embalajes (Offline App Shell)
 * @version 1.4.0
 * @architecture Stale-While-Revalidate para App Shell | Network-Only para API GAS
 */

const CACHE_VERSION = 'genlogistics-embalajes-v1.4.0';

// Recursos estáticos críticos que forman el App Shell (100% Zero-CDN)
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './sync-engine.js',
  './script.js'
];

// ==========================================
// 1. INSTALACIÓN: PRE-CACHEO RESILIENTE DEL APP SHELL
// ==========================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(async (cache) => {
        console.info('[SW] Pre-cacheando App Shell de GenLogistics...');
        // Cacheo individual resiliente: si un asset opcional falla, no aborta los demás
        const results = await Promise.allSettled(
          APP_SHELL_ASSETS.map(async (assetUrl) => {
            const response = await fetch(assetUrl, { cache: 'no-cache' });
            if (response.ok) {
              await cache.put(assetUrl, response);
            }
          })
        );
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
          console.warn(`[SW] ${failed} recurso(s) no pudieron pre-cachearse durante install.`);
        }
      })
      .then(() => self.skipWaiting())
  );
});

// ==========================================
// 2. ACTIVACIÓN: LIMPIEZA DE CACHÉS OBSOLETOS
// ==========================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_VERSION) {
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
  const requestUrl = new URL(event.request.url);

  // REGLA 1: Ignorar peticiones que no sean GET (POST de SyncEngine van directo a red)
  if (event.request.method !== 'GET') return;

  // REGLA 2: Bypass total para Google Apps Script, Drive y Googleusercontent
  if (
    requestUrl.hostname.includes('script.google.com') ||
    requestUrl.hostname.includes('script.googleusercontent.com') ||
    requestUrl.hostname.includes('drive.google.com') ||
    requestUrl.hostname.includes('googleusercontent.com')
  ) {
    return;
  }

  // REGLA 3: Stale-While-Revalidate para el App Shell
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});