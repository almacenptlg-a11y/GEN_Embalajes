/**
 * ============================================================================
 * GENLOGISTICS | SERVICE WORKER OFFLINE-FIRST (sw.js)
 * Versión: 2.0.0-OPT | Estrategia: Network-First (App Shell) + SWR (Assets)
 * ----------------------------------------------------------------------------
 * Responsabilidades:
 * 1. Precaching del App Shell crítico para arranque instantáneo sin red.
 * 2. Network-First para HTML/JS (garantiza sincronía de contrato con GAS).
 * 3. Stale-While-Revalidate para CSS compilado y recursos gráficos.
 * 4. Bypass absoluto para peticiones API hacia script.google.com y métodos POST.
 * ============================================================================
 */

const CACHE_VERSION = 'genlogistics-shell-v2.0.0';

// Rutas relativas para compatibilidad total con subdirectorios de GitHub Pages
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './sync-engine.js'
];

// ============================================================================
// 1. INSTALACIÓN Y PRECACHING DEL APP SHELL
// ============================================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => {
        // addAll falla atómicamente si algún archivo no existe; mapeamos individualmente para resiliencia
        return Promise.allSettled(
          PRECACHE_ASSETS.map((url) =>
            fetch(new Request(url, { cache: 'reload' }))
              .then((res) => {
                if (res.ok) return cache.put(url, res);
              })
              .catch(() => null)
          )
        );
      })
      .then(() => self.skipWaiting()) // Activación inmediata sin esperar cierre de pestañas
  );
});

// ============================================================================
// 2. ACTIVACIÓN Y LIMPIEZA DE VERSIONES ANTERIORES
// ============================================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_VERSION)
            .map((oldCache) => caches.delete(oldCache))
        );
      })
      .then(() => self.clients.claim()) // Toma control inmediato de clientes activos
  );
});

// ============================================================================
// 3. INTERCEPTOR DE RED (ROUTING DE ESTRATEGIAS)
// ============================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Bypass estricto: Solo interceptar GET del mismo origen (ignorar GAS, extensiones, POST)
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com')
  ) {
    return;
  }

  // 2. Estrategia NETWORK-FIRST para HTML y Scripts JS (evita desfase de contrato con Backend)
  const esDocumentoOJs =
    request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname === '/' ||
    url.pathname.endsWith('/');

  if (esDocumentoOJs) {
    event.respondWith(networkFirstStrategy(request));
    return;
  }

  // 3. Estrategia STALE-WHILE-REVALIDATE para CSS compilado, fuentes y SVGs
  event.respondWith(staleWhileRevalidateStrategy(request));
});

/**
 * Network-First con timeout de seguridad (3.5s) para evitar pantallas blancas en redes 2G/3G lentas.
 */
async function networkFirstStrategy(request) {
  const cache = await caches.open(CACHE_VERSION);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const networkResponse = await fetch(request, {
      cache: 'no-cache',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
      return networkResponse;
    }
    throw new Error('Respuesta de red no válida');
  } catch (err) {
    const cachedResponse = await cache.match(request, { ignoreSearch: true });
    if (cachedResponse) {
      return cachedResponse;
    }
    // Fallback último recurso al shell principal si es navegación SPA
    if (request.mode === 'navigate') {
      return cache.match('./index.html');
    }
    return new Response('Recurso no disponible sin conexión.', {
      status: 503,
      statusText: 'Offline'
    });
  }
}

/**
 * Stale-While-Revalidate: Sirve desde caché en O(1) y actualiza en segundo plano.
 */
async function staleWhileRevalidateStrategy(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cachedResponse = await cache.match(request, { ignoreSearch: true });

  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  return cachedResponse || fetchPromise;
}

// ============================================================================
// 4. CANAL DE MENSAJES DESDE LA UI (FORZAR ACTUALIZACIÓN MANUAL)
// ============================================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});