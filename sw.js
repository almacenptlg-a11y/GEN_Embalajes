/**
 * @fileoverview Service Worker - GenLogistics Embalajes (Offline App Shell)
 * @architecture Cache-First para App Shell | Network-Only para API GAS
 */

const CACHE_VERSION = 'genlogistics-embalajes-v1.1.0';

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
        console.info('[SW] Pre-cacheando App Shell de GenLogistics...');
        return cache.addAll(APP_SHELL_ASSETS);
      })
      .then(() => self.skipWaiting()) // Activar inmediatamente sin esperar cierre de pestañas
      .catch((err) => console.error('[SW] Error durante pre-cacheo:', err))
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
      .then(() => self.clients.claim()) // Tomar control inmediato de los clientes abiertos
  );
});

// ==========================================
// 3. INTERCEPTOR DE RED (FETCH)
// ==========================================
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // REGLA 1: Ignorar peticiones que no sean GET (POST de SyncEngine van directo a red)
  if (event.request.method !== 'GET') return;

  // REGLA 2: Bypass total para Google Apps Script API y Google Drive (manejo exclusivo de SyncEngine)
  if (
    requestUrl.hostname.includes('script.google.com') ||
    requestUrl.hostname.includes('script.googleusercontent.com') ||
    requestUrl.hostname.includes('drive.google.com')
  ) {
    return;
  }

  // REGLA 3: Estrategia Stale-While-Revalidate para el App Shell
  // Sirve desde caché en 0ms y actualiza el archivo en segundo plano si hay red
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          // Validar respuesta correcta antes de actualizar caché
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Si falla la red (modo offline), no hacer nada; ya devolvimos cachedResponse
        });

      // Si existe en caché, devolver al instante (0ms); si no, esperar a la red
      return cachedResponse || fetchPromise;
    })
  );
});
