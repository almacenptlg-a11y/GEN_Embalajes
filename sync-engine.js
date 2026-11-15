/**
 * @fileoverview Motor de Sincronización Offline-First (IndexedDB + Outbox Queue + Edge Compression)
 * @module SyncEngine
 * @architecture Zero-Latency Optimistic UI & Background Worker
 */

const SyncEngine = (() => {
    const DB_NAME = 'GenLogistics_Embalajes_DB';
    const DB_VERSION = 1;
    const STORE_CACHE = 'cache_datos';
    const STORE_QUEUE = 'sync_queue';

    let db = null;
    let isSyncing = false;
    let pollingInterval = null;
    let config = {
        apiUrl: '',
        token: '',
        onQueueChange: () => {},      // Callback para actualizar badge en UI
        onRemoteDataSync: () => {},   // Callback cuando llegan datos frescos en segundo plano
        onSyncError: () => {}         // Callback silencioso o de log
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
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
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
    // 4. WORKER DE SINCRONIZACIÓN (PUSH & PULL)
    // ==========================================
    async function processQueue() {
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
        await notifyQueueStatus();

        // Procesamiento estricto secuencial (FIFO) para mantener integridad referencial
        for (const item of queue) {
            if (!navigator.onLine) break; // Abortar si se cae la red a mitad de lote

            try {
                const bodyPayload = {
                    action: item.action,
                    token: config.token,
                    client_uuid: item.uuid, // Clave de idempotencia para GAS
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
                    // Transacción confirmada por el servidor: eliminar de Outbox
                    await removeQueueItem(item.id);
                    await notifyQueueStatus();
                } else {
                    // Error lógico controlado desde GAS (ej. validación)
                    console.error(`[SyncEngine] Rechazo del servidor en ${item.action}:`, result.message);
                    config.onSyncError(result.message, item);
                    // Opcional: Si es un error irrecuperable de negocio, remover para no atascar la cola
                    if (result.fatal) await removeQueueItem(item.id);
                    break;
                }
            } catch (networkErr) {
                console.warn('[SyncEngine] Microcorte de red durante Push. Reintentando luego...', networkErr);
                break; // Salir del bucle y esperar al próximo trigger/polling
            }
        }

        isSyncing = false;
        await notifyQueueStatus();

        // Si la cola quedó limpia tras hacer Push, traer el estado real consolidado del servidor
        const remaining = await getQueueItems();
        if (remaining.length === 0 && navigator.onLine) {
            pullLatestState();
        }
    }

    async function pullLatestState() {
        // PROHIBIDO hacer Pull si hay cambios locales sin subir (evita sobrescribir Optimistic UI)
        const pending = await getQueueItems();
        if (pending.length > 0 || !navigator.onLine || isSyncing) return;

        try {
            const [resCargos, resHistory] = await Promise.all([
                fetch(`${config.apiUrl}?action=getActiveCargos&token=${config.token}`, { redirect: 'follow' }),
                fetch(`${config.apiUrl}?action=getHistory&token=${config.token}`, { redirect: 'follow' })
            ]);

            const jsonCargos = await resCargos.json();
            const jsonHistory = await resHistory.json();

            if (jsonCargos.status === 'success') {
                await saveCache('cargosActivos', jsonCargos.data);
            }
            if (jsonHistory.status === 'success') {
                await saveCache('historial', jsonHistory.data);
            }

            // Notificar a la UI para que repinte silenciosamente si es necesario
            config.onRemoteDataSync({
                cargosActivos: jsonCargos.status === 'success' ? jsonCargos.data : null,
                historial: jsonHistory.status === 'success' ? jsonHistory.data : null
            });

        } catch (err) {
            // Silencioso: si falla el pull en segundo plano, el usuario sigue trabajando con IndexedDB
            console.debug('[SyncEngine] Background pull omitido por red inestable.');
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

        // Añadir margen de seguridad de 10px
        const pad = 10;
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(width, maxX + pad);
        maxY = Math.min(height, maxY + pad);

        const cropW = maxX - minX;
        const cropH = maxY - minY;

        // Escalar a máximo 400px de ancho manteniendo proporción
        const maxWidth = 400;
        const scale = cropW > maxWidth ? maxWidth / cropW : 1;

        const offscreen = document.createElement('canvas');
        offscreen.width = cropW * scale;
        offscreen.height = cropH * scale;

        const offCtx = offscreen.getContext('2d');
        offCtx.drawImage(sourceCanvas, minX, minY, cropW, cropH, 0, 0, offscreen.width, offscreen.height);

        // Retorna PNG recortado (peso típico: ~4KB - 8KB frente a los ~60KB originales)
        return offscreen.toDataURL('image/png');
    }

    // ==========================================
    // 6. INICIALIZADOR PÚBLICO Y EVENT LISTENERS
    // ==========================================
    async function init(userConfig) {
        config = { ...config, ...userConfig };
        await initDB();

        // Listeners nativos de conectividad
        window.addEventListener('online', () => {
            console.info('[SyncEngine] Conexión restaurada. Ejecutando sincronización...');
            processQueue();
        });

        window.addEventListener('offline', () => {
            console.warn('[SyncEngine] Modo Offline activado.');
            notifyQueueStatus();
        });

        // Heartbeat Polling cada 30 segundos
        if (pollingInterval) clearInterval(pollingInterval);
        pollingInterval = setInterval(() => {
            if (!navigator.onLine) return;
            getQueueItems().then(items => {
                if (items.length > 0) processQueue();
                else pullLatestState();
            });
        }, 30000);

        await notifyQueueStatus();
        
        // Intentar vaciar cola residual al arrancar
        if (navigator.onLine) processQueue();
    }

    return {
        init,
        saveCache,
        getCache,
        enqueueMutation,
        getQueueItems,
        processQueue,
        pullLatestState,
        compressSignature
    };
})();
