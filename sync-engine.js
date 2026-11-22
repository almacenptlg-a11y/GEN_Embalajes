/**
 * @fileoverview Motor de Sincronización Offline-First (IndexedDB + Outbox Queue + Edge Compression)
 * @module SyncEngine
 * @version 1.4.0
 * @architecture Zero-Latency Optimistic UI | Anti-Deadlock FIFO | Race-Condition Guard
 */

const SyncEngine = (() => {
    const DB_NAME = 'GenLogistics_Embalajes_DB';
    const DB_VERSION = 1;
    const STORE_CACHE = 'cache_datos';
    const STORE_QUEUE = 'sync_queue';
    const MAX_LOGIC_RETRIES = 2; // Evita bloqueo FIFO por errores persistentes

    let db = null;
    let isSyncing = false;
    let syncStartedAt = 0;
    let pollingInterval = null;
    let config = {
        apiUrl: '',
        token: '',
        onQueueChange: () => { },      // Callback para actualizar badge en UI
        onRemoteDataSync: () => { },   // Callback cuando llegan datos frescos en segundo plano
        onSyncError: () => { }         // Callback de notificación de rechazo
    };

    // ==========================================
    // 1. INICIALIZACIÓN DE INDEXEDDB
    // ==========================================
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains(STORE_CACHE)) {
                    database.createObjectStore(STORE_CACHE, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(STORE_QUEUE)) {
                    // autoIncrement garantiza orden estricto FIFO
                    const queueStore = database.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
                    queueStore.createIndex('uuid', 'uuid', { unique: true });
                }
            };

            request.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };

            request.onerror = (e) => {
                console.error('[SyncEngine] Error fatal abriendo IndexedDB:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    // ==========================================
    // 2. OPERACIONES CRUD EN CACHÉ LOCAL (O(1))
    // ==========================================
    function saveCache(key, data) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('DB no inicializada');
            const tx = db.transaction(STORE_CACHE, 'readwrite');
            const store = tx.objectStore(STORE_CACHE);
            const request = store.put({ key, data, updatedAt: Date.now() });

            request.onsuccess = () => resolve(true);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    function getCache(key) {
        return new Promise((resolve, reject) => {
            if (!db) return reject('DB no inicializada');
            const tx = db.transaction(STORE_CACHE, 'readonly');
            const store = tx.objectStore(STORE_CACHE);
            const request = store.get(key);

            request.onsuccess = (e) => resolve(e.target.result ? e.target.result.data : null);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // ==========================================
    // 3. GESTIÓN DE COLA OUTBOX (FIFO)
    // ==========================================
    function generateUUID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async function enqueueMutation(action, payload) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);

            const item = {
                uuid: generateUUID(),
                action: action,
                payload: payload,
                timestamp: Date.now(),
                retries: 0
            };

            const request = store.add(item);

            request.onsuccess = async () => {
                await notifyQueueStatus();
                // Disparar sincronización inmediata (Fire & Forget)
                processQueue();
                resolve(item.uuid);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    function getQueueItems() {
        return new Promise((resolve, reject) => {
            if (!db) return resolve([]);
            const tx = db.transaction(STORE_QUEUE, 'readonly');
            const store = tx.objectStore(STORE_QUEUE);
            const request = store.getAll();

            request.onsuccess = (e) => resolve(e.target.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    function updateQueueItem(item) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            const request = store.put(item);

            request.onsuccess = () => resolve(true);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    function removeQueueItem(id) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            const request = store.delete(id);

            request.onsuccess = () => resolve(true);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async function notifyQueueStatus() {
        const items = await getQueueItems();
        config.onQueueChange(items.length, navigator.onLine);
    }

    // ==========================================
    // 4. WORKER DE SINCRONIZACIÓN (PUSH & PULL BLINDADO)
    // ==========================================
    async function processQueue() {
        // Watchdog anti-deadlock (>25s activo)
        if (isSyncing && (Date.now() - syncStartedAt > 25000)) {
            console.warn('[SyncEngine] Liberando lock de sincronización por timeout (>25s).');
            isSyncing = false;
        }

        if (isSyncing || !navigator.onLine) {
            await notifyQueueStatus();
            return;
        }

        const queue = await getQueueItems();
        if (queue.length === 0) {
            await notifyQueueStatus();
            return;
        }

        isSyncing = true;
        syncStartedAt = Date.now();
        await notifyQueueStatus();

        let pushedCount = 0;

        for (const item of queue) {
            if (!navigator.onLine) break;

            try {
                const bodyPayload = {
                    action: item.action,
                    token: config.token,
                    client_uuid: item.uuid,
                    ...item.payload
                };

                const response = await fetch(config.apiUrl, {
                    method: 'POST',
                    redirect: 'follow',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify(bodyPayload)
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const result = await response.json();

                if (result.status === 'success') {
                    await removeQueueItem(item.id);
                    pushedCount++;
                    await notifyQueueStatus();
                } else {
                    // Rechazo lógico del servidor (ej. permiso denegado, cargo ya eliminado, validación)
                    console.error(`[SyncEngine] Rechazo del servidor en ${item.action}:`, result.message);
                    item.retries = (item.retries || 0) + 1;

                    if (result.fatal || item.retries >= MAX_LOGIC_RETRIES) {
                        // Purgar "Poison Pill" para que no congele el resto de la cola FIFO
                        await removeQueueItem(item.id);
                        config.onSyncError(`${result.message} (Transacción descartada tras rechazo)`, item);
                        await notifyQueueStatus();
                        // Continuar con el siguiente ítem de la cola
                    } else {
                        await updateQueueItem(item);
                        config.onSyncError(result.message, item);
                        break;
                    }
                }
            } catch (networkErr) {
                // Fallo físico de red: conservar ítem intacto y abortar ciclo hasta reconexión
                console.warn('[SyncEngine] Microcorte de red durante Push:', networkErr.message);
                break;
            }
        }

        isSyncing = false;
        syncStartedAt = 0;
        await notifyQueueStatus();

        // Si la cola quedó limpia, descargar estado consolidado (con nocache si acabamos de subir cambios)
        const remaining = await getQueueItems();
        if (remaining.length === 0 && navigator.onLine) {
            await pullLatestState(pushedCount > 0);
        }
    }

    async function pullLatestState(force = false) {
        if (!navigator.onLine) {
            if (force) throw new Error('Sin conexión a internet.');
            return false;
        }

        if (!force) {
            const pending = await getQueueItems();
            if (pending.length > 0 || isSyncing) return false;
        } else {
            // En sincronización manual forzada, drenar cola local primero
            const pending = await getQueueItems();
            if (pending.length > 0) {
                await processQueue();
                const stillPending = await getQueueItems();
                if (stillPending.length > 0) {
                    throw new Error(`Aún hay ${stillPending.length} registro(s) pendiente(s) por subir.`);
                }
            }
        }

        try {
            const tokenParam = encodeURIComponent(config.token);
            const noCacheParam = force ? '&nocache=1' : '';
            const bust = `_t=${Date.now()}${noCacheParam}`;

            const [resCargos, resHistory] = await Promise.all([
                fetch(`${config.apiUrl}?action=getActiveCargos&token=${tokenParam}&${bust}`, {
                    method: 'GET',
                    redirect: 'follow',
                    cache: 'no-store'
                }),
                fetch(`${config.apiUrl}?action=getHistory&token=${tokenParam}&${bust}`, {
                    method: 'GET',
                    redirect: 'follow',
                    cache: 'no-store'
                })
            ]);

            if (!resCargos.ok || !resHistory.ok) {
                throw new Error(`Error HTTP (${resCargos.status} / ${resHistory.status})`);
            }

            const jsonCargos = await resCargos.json();
            const jsonHistory = await resHistory.json();

            if (jsonCargos.status === 'error') throw new Error(jsonCargos.message);
            if (jsonHistory.status === 'error') throw new Error(jsonHistory.message);

            // RACE CONDITION GUARD: Verificar que el usuario no haya creado una mutación local
            // mientras los GET estaban en tránsito
            const pendingAfterFetch = await getQueueItems();
            if (pendingAfterFetch.length > 0) {
                console.info('[SyncEngine] Pull descartado: existen nuevas mutaciones locales en cola.');
                return false;
            }

            if (jsonCargos.status === 'success' && Array.isArray(jsonCargos.data)) {
                await saveCache('cargosActivos', jsonCargos.data);
            }
            if (jsonHistory.status === 'success' && Array.isArray(jsonHistory.data)) {
                await saveCache('historial', jsonHistory.data);
            }

            config.onRemoteDataSync({
                cargosActivos: jsonCargos.status === 'success' ? jsonCargos.data : null,
                historial: jsonHistory.status === 'success' ? jsonHistory.data : null
            });

            return true;
        } catch (err) {
            if (force) throw err;
            console.debug('[SyncEngine] Background pull omitido:', err.message);
            return false;
        }
    }

    // ==========================================
    // 5. COMPRESIÓN EDGE PARA FIRMAS (CANVAS)
    // ==========================================
    function compressSignature(sourceCanvas) {
        const ctx = sourceCanvas.getContext('2d');
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const imgData = ctx.getImageData(0, 0, width, height).data;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        let hasPixels = false;

        // Detectar Bounding Box real del trazo para recortar espacio vacío
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const alpha = imgData[(y * width + x) * 4 + 3];
                if (alpha > 0) {
                    hasPixels = true;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (!hasPixels) return null;

        const pad = 10;
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(width, maxX + pad);
        maxY = Math.min(height, maxY + pad);

        const cropW = maxX - minX;
        const cropH = maxY - minY;

        const maxWidth = 400;
        const scale = cropW > maxWidth ? maxWidth / cropW : 1;

        const offscreen = document.createElement('canvas');
        offscreen.width = Math.round(cropW * scale);
        offscreen.height = Math.round(cropH * scale);

        const offCtx = offscreen.getContext('2d');
        offCtx.drawImage(sourceCanvas, minX, minY, cropW, cropH, 0, 0, offscreen.width, offscreen.height);

        return offscreen.toDataURL('image/png');
    }

    // ==========================================
    // 6. INICIALIZADOR PÚBLICO Y EVENT LISTENERS
    // ==========================================
    async function init(userConfig) {
        config = { ...config, ...userConfig };
        await initDB();

        window.addEventListener('online', () => {
            console.info('[SyncEngine] Conexión restaurada. Ejecutando sincronización...');
            processQueue();
        });

        window.addEventListener('offline', () => {
            console.warn('[SyncEngine] Modo Offline activado.');
            notifyQueueStatus();
        });

        // Heartbeat Polling cada 30 segundos (solo envía datos si cola > 0)
        if (pollingInterval) clearInterval(pollingInterval);
        pollingInterval = setInterval(() => {
            if (!navigator.onLine) return;
            getQueueItems().then(items => {
                if (items.length > 0) processQueue();
                else pullLatestState(false);
            });
        }, 30000);

        await notifyQueueStatus();

        if (navigator.onLine) processQueue();
    }

    return {
        init,
        saveCache,
        getCache,
        enqueueMutation,
        getQueue: getQueueItems,
        getQueueItems,
        processQueue,
        pullLatestState,
        compressSignature
    };
})();