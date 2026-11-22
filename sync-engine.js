/**
 * ============================================================================
 * GENLOGISTICS | MOTOR DE SINCRONIZACIÓN OFFLINE-FIRST (sync-engine.js)
 * Versión: 2.0.0-OPT | Arquitectura: Headless Edge-to-GAS
 * ----------------------------------------------------------------------------
 * Responsabilidades:
 * 1. Persistencia local asíncrona en IndexedDB (Catálogos, Transacciones y Cola FIFO).
 * 2. Aislamiento transaccional estricto por client_uuid (Cero colisiones en planta).
 * 3. Compresión Edge en <canvas> (Trimming + Fondo Sólido + JPEG 0.72) para firmas.
 * 4. Watchdog anti-deadlock y despacho secuencial FIFO hacia Google Apps Script.
 * ============================================================================
 */

const SyncEngine = (() => {
    // ------------------------------------------------------------------------
    // 1. CONFIGURACIÓN DEL NÚCLEO Y CONSTANTES
    // ------------------------------------------------------------------------
    const DB_NAME = 'GenLogistics_EdgeDB_v2';
    const DB_VERSION = 2;
    const STORE_CACHE = 'cache_datos';
    const STORE_QUEUE = 'sync_queue';

    // Mapa canónico de tablas (alineado con code.gs y script.js)
    const TABLAS = {
        CLIENTES: 'MAE_CLIENTES',
        MATERIALES: 'MAE_MATERIALES',
        AREAS: 'MAE_AREAS',
        CARGOS: 'CARGOS_MEMB',
        DETALLES: 'DETALLE_CARGOS_MEMB'
    };

    let gasUrl = '';
    let dbInstance = null;
    let isSyncing = false;
    let syncLockTimestamp = 0;
    let pollingTimer = null;

    const WATCHDOG_TIMEOUT_MS = 22000; // 22s máximo por petición antes de liberar lock
    const POLLING_INTERVAL_MS = 30000; // Verificación cada 30s si hay cola pendiente

    // ------------------------------------------------------------------------
    // 2. INICIALIZACIÓN Y GESTIÓN DE INDEXEDDB (PROMISE WRAPPERS)
    // ------------------------------------------------------------------------
    function openDB() {
        return new Promise((resolve, reject) => {
            if (dbInstance) return resolve(dbInstance);

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Almacén de tablas maestras y transacciones cacheadas
                if (!db.objectStoreNames.contains(STORE_CACHE)) {
                    db.createObjectStore(STORE_CACHE, { keyPath: 'tabla' });
                }

                // Recrear cola FIFO con client_uuid como PK única (evita sobrescritura de eventos)
                if (db.objectStoreNames.contains(STORE_QUEUE)) {
                    db.deleteObjectStore(STORE_QUEUE);
                }
                const queueStore = db.createObjectStore(STORE_QUEUE, { keyPath: 'client_uuid' });
                queueStore.createIndex('idx_timestamp', 'timestamp', { unique: false });
                queueStore.createIndex('idx_id_cargo', 'id_cargo', { unique: false });
            };

            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                // Manejo de cierre inesperado por limpieza del navegador
                dbInstance.onversionchange = () => {
                    dbInstance.close();
                    dbInstance = null;
                };
                resolve(dbInstance);
            };

            request.onerror = (event) => {
                console.error('[SyncEngine] Error crítico abriendo IndexedDB:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    async function init(endpointUrl) {
        gasUrl = endpointUrl;
        await openDB();

        // Listeners nativos de conectividad del navegador
        window.addEventListener('online', () => {
            actualizarIndicadorRed(true);
            processQueue();
        });

        window.addEventListener('offline', () => {
            actualizarIndicadorRed(false);
        });

        actualizarIndicadorRed(navigator.onLine);

        // Iniciar polling inteligente (solo transmite si queue.length > 0)
        if (pollingTimer) clearInterval(pollingTimer);
        pollingTimer = setInterval(() => {
            if (navigator.onLine) processQueue();
        }, POLLING_INTERVAL_MS);

        // Despacho inicial si quedaron operaciones pendientes de una sesión previa
        if (navigator.onLine) {
            setTimeout(() => processQueue(), 1200);
        }
    }

    // ------------------------------------------------------------------------
    // 3. OPERACIONES DE CACHÉ LOCAL (O(1) KEY-VALUE EN INDEXEDDB)
    // ------------------------------------------------------------------------
    async function saveTable(nombreTabla, registros) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_CACHE, 'readwrite');
            const store = tx.objectStore(STORE_CACHE);
            store.put({
                tabla: nombreTabla,
                data: Array.isArray(registros) ? registros : [],
                updated_at: Date.now()
            });
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async function getLocalTable(nombreTabla) {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_CACHE, 'readonly');
            const store = tx.objectStore(STORE_CACHE);
            const req = store.get(nombreTabla);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => resolve(null);
        });
    }

    /**
     * Obtiene una tabla priorizando IndexedDB (Latencia 0) y resolviendo
     * automáticamente el mapeo de endpoints si se requiere fallback de red.
     */
    async function getTable(nombreSolicitado, forzarRed = false) {
        // Normalizar alias ('AREAS' -> 'MAE_AREAS')
        const nombreCanonico = TABLAS[nombreSolicitado] || nombreSolicitado;

        if (!forzarRed) {
            const localData = await getLocalTable(nombreCanonico);
            if (localData !== null) return localData;
        }

        if (!navigator.onLine) {
            return (await getLocalTable(nombreCanonico)) || [];
        }

        try {
            // Determinar endpoint en GAS según el tipo de tabla
            const esCatalogo = [TABLAS.CLIENTES, TABLAS.MATERIALES, TABLAS.AREAS].includes(nombreCanonico);
            const action = esCatalogo ? 'getCatalogos' : 'getTransacciones';

            const res = await fetch(`${gasUrl}?action=${action}&t=${Date.now()}`, {
                method: 'GET',
                cache: 'no-store'
            });
            const json = await res.json();

            if (json.status === 'success' && json.data) {
                if (esCatalogo) {
                    await Promise.all([
                        saveTable(TABLAS.CLIENTES, json.data.clientes || []),
                        saveTable(TABLAS.MATERIALES, json.data.materiales || []),
                        saveTable(TABLAS.AREAS, json.data.areas || [])
                    ]);
                } else {
                    await Promise.all([
                        saveTable(TABLAS.CARGOS, json.data.cargos || []),
                        saveTable(TABLAS.DETALLES, json.data.detalles || [])
                    ]);
                }
                return (await getLocalTable(nombreCanonico)) || [];
            }
        } catch (err) {
            console.warn(`[SyncEngine] Fallback de red fallido para ${nombreCanonico}:`, err.message);
        }

        return (await getLocalTable(nombreCanonico)) || [];
    }

    /**
     * Sincronización completa en segundo plano (Pull silencioso)
     */
    async function pullAllFromServer() {
        if (!navigator.onLine) return false;
        try {
            const [resCat, resTx] = await Promise.all([
                fetch(`${gasUrl}?action=getCatalogos&t=${Date.now()}`, { cache: 'no-store' }).then(r => r.json()),
                fetch(`${gasUrl}?action=getTransacciones&t=${Date.now()}`, { cache: 'no-store' }).then(r => r.json())
            ]);

            const promesas = [];
            if (resCat.status === 'success' && resCat.data) {
                promesas.push(saveTable(TABLAS.CLIENTES, resCat.data.clientes || []));
                promesas.push(saveTable(TABLAS.MATERIALES, resCat.data.materiales || []));
                promesas.push(saveTable(TABLAS.AREAS, resCat.data.areas || []));
            }
            if (resTx.status === 'success' && resTx.data) {
                promesas.push(saveTable(TABLAS.CARGOS, resTx.data.cargos || []));
                promesas.push(saveTable(TABLAS.DETALLES, resTx.data.detalles || []));
            }

            await Promise.all(promesas);
            return true;
        } catch (e) {
            console.warn('[SyncEngine] Pull silencioso omitido por inestabilidad de red.');
            return false;
        }
    }

    // ------------------------------------------------------------------------
    // 4. COLA FIFO DE MUTACIONES (FIRE AND FORGET)
    // ------------------------------------------------------------------------
    function generarUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    /**
     * Encola una mutación garantizando unicidad por client_uuid.
     * Permite encadenar múltiples acciones sobre un mismo id_cargo sin colisión.
     */
    async function enqueue(action, payload) {
        const db = await openDB();
        const uuid = payload.client_uuid || generarUUID();
        const enrichedPayload = { ...payload, client_uuid: uuid };

        const item = {
            client_uuid: uuid,
            id_cargo: payload.id_cargo || 'N/A',
            action: action,
            payload: enrichedPayload,
            timestamp: Date.now(),
            retries: 0
        };

        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            store.put(item);
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });

        await actualizarBadgeCola();

        // Disparo inmediato no bloqueante si hay conexión
        if (navigator.onLine) {
            processQueue();
        }

        return uuid;
    }

    async function getPendingItems() {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_QUEUE, 'readonly');
            const store = tx.objectStore(STORE_QUEUE);
            const index = store.index('idx_timestamp');
            const req = index.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async function removeQueueItem(clientUuid) {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            tx.objectStore(STORE_QUEUE).delete(clientUuid);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    async function updateQueueItemRetry(item) {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            tx.objectStore(STORE_QUEUE).put(item);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    /**
     * Procesa la cola FIFO secuencialmente para respetar dependencias causales
     * (Ej. Crear Cargo antes de Descargarlo). Incluye Watchdog anti-deadlock.
     */
    async function processQueue() {
        if (!navigator.onLine || !gasUrl) return;

        // Watchdog: si el lock lleva más de 22s activo, se asume hilo colgado y se libera
        if (isSyncing) {
            if (Date.now() - syncLockTimestamp > WATCHDOG_TIMEOUT_MS) {
                console.warn('[SyncEngine] Watchdog activado: liberando lock de sincronización.');
                isSyncing = false;
            } else {
                return;
            }
        }

        const pendientes = await getPendingItems();
        if (pendientes.length === 0) {
            await actualizarBadgeCola();
            return;
        }

        isSyncing = true;
        syncLockTimestamp = Date.now();
        actualizarIndicadorSincronizando(true);

        let huboCambiosRemotos = false;

        try {
            // Orden estricto FIFO por timestamp
            pendientes.sort((a, b) => a.timestamp - b.timestamp);

            for (const item of pendientes) {
                if (!navigator.onLine) break;

                syncLockTimestamp = Date.now(); // Renovar pulso del watchdog por ítem
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 18000);

                try {
                    const response = await fetch(gasUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Evita preflight OPTIONS en GAS
                        body: JSON.stringify({
                            action: item.action,
                            ...item.payload
                        }),
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const result = await response.json();

                    if (result.status === 'success') {
                        await removeQueueItem(item.client_uuid);
                        huboCambiosRemotos = true;
                    } else {
                        // Error lógico controlado por GAS (ej. duplicado o estado inválido)
                        console.warn(`[SyncEngine] GAS rechazó ${item.action} (${item.client_uuid}):`, result.message);
                        // Si ya fue procesado o es irrecuperable tras 5 intentos, purgar para no atascar la cola FIFO
                        item.retries = (item.retries || 0) + 1;
                        if (item.retries >= 5 || (result.message && result.message.includes('ya registrado'))) {
                            await removeQueueItem(item.client_uuid);
                        } else {
                            await updateQueueItemRetry(item);
                            break; // Detener avance FIFO hasta resolver dependencia
                        }
                    }
                } catch (netErr) {
                    clearTimeout(timeoutId);
                    console.warn(`[SyncEngine] Error de red enviando ${item.client_uuid}:`, netErr.message);
                    item.retries = (item.retries || 0) + 1;
                    await updateQueueItemRetry(item);
                    break; // Abortar ciclo FIFO para mantener orden causal
                }
            }
        } finally {
            isSyncing = false;
            actualizarIndicadorSincronizando(false);
            await actualizarBadgeCola();

            // Si se sincronizaron mutaciones, notificar a la UI para refrescar estado desde servidor
            if (huboCambiosRemotos) {
                await pullAllFromServer();
                window.dispatchEvent(new CustomEvent('genlogistics:sync-completed'));
            }
        }
    }

    // ------------------------------------------------------------------------
    // 5. PROCESAMIENTO EDGE DE FIRMAS (TRIM + FONDO SÓLIDO + JPEG COMPRESSION)
    // ------------------------------------------------------------------------
    /**
     * Recorta el espacio vacío alrededor del trazo, redimensiona a máximo 520px
     * y exporta en JPEG sobre fondo blanco sólido (< 8KB) para transmisión ultra rápida.
     */
    function compressSignatureCanvas(sourceCanvas, maxWidth = 520, quality = 0.72) {
        if (!sourceCanvas) return '';

        const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const imgData = ctx.getImageData(0, 0, width, height).data;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasPixels = false;

        // Escaneo rápido de bounding box de píxeles no transparentes
        for (let y = 0; y < height; y++) {
            const rowOffset = y * width * 4;
            for (let x = 0; x < width; x++) {
                if (imgData[rowOffset + x * 4 + 3] > 15) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    hasPixels = true;
                }
            }
        }

        if (!hasPixels) return '';

        // Margen de seguridad de 12px alrededor de la firma
        const pad = 12;
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(width, maxX + pad);
        maxY = Math.min(height, maxY + pad);

        const trimW = Math.max(1, maxX - minX);
        const trimH = Math.max(1, maxY - minY);

        // Escalado proporcional si excede maxWidth
        const scale = trimW > maxWidth ? maxWidth / trimW : 1;
        const targetW = Math.round(trimW * scale);
        const targetH = Math.round(trimH * scale);

        const offscreen = document.createElement('canvas');
        offscreen.width = targetW;
        offscreen.height = targetH;

        const offCtx = offscreen.getContext('2d');
        // Fondo blanco puro obligatorio antes de convertir a JPEG (evita fondo negro por canal alfa)
        offCtx.fillStyle = '#FFFFFF';
        offCtx.fillRect(0, 0, targetW, targetH);
        offCtx.drawImage(sourceCanvas, minX, minY, trimW, trimH, 0, 0, targetW, targetH);

        return offscreen.toDataURL('image/jpeg', quality);
    }

    // ------------------------------------------------------------------------
    // 6. TELEMETRÍA VISUAL NO INTRUSIVA (BADGES DE ESTADO)
    // ------------------------------------------------------------------------
    async function actualizarBadgeCola() {
        const pendientes = await getPendingItems();
        const badge = document.getElementById('sync-queue-badge');
        const countEl = document.getElementById('sync-queue-count');
        if (!badge || !countEl) return;

        if (pendientes.length > 0) {
            countEl.textContent = pendientes.length;
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    }

    function actualizarIndicadorRed(online) {
        const dot = document.getElementById('network-status-dot');
        const text = document.getElementById('network-status-text');
        if (!dot || !text) return;

        if (online) {
            dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
            text.textContent = 'En línea';
        } else {
            dot.className = 'w-2 h-2 rounded-full bg-amber-500';
            text.textContent = 'Modo Offline';
        }
    }

    function actualizarIndicadorSincronizando(syncing) {
        const spinner = document.getElementById('sync-spinner-icon');
        if (!spinner) return;
        if (syncing) {
            spinner.classList.remove('hidden');
        } else {
            spinner.classList.add('hidden');
        }
    }

    // ------------------------------------------------------------------------
    // API PÚBLICA DEL MÓDULO
    // ------------------------------------------------------------------------
    return {
        TABLAS,
        init,
        getTable,
        saveTable,
        pullAllFromServer,
        enqueue,
        processQueue,
        getPendingItems,
        compressSignatureCanvas,
        generarUUID
    };
})();