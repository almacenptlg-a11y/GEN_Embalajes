/**
 * @fileoverview Frontend AppLogic - Sistema de Embalajes y Cargos (GenLogistics v1.3.3-OPT)
 * @architecture Zero-Trust | Offline-First | Optimistic UI O(1) | Auto-Split Excedentes | Dual Direct Print (A4 / 80mm)
 */

const API_URL = "https://script.google.com/macros/s/AKfycbzhPAhH-K2qURzzW69xoH-QJ6RZdmQw3gJIt80Y6f4iTKyS7BqhXrgHTGWrO0PiSj4m/exec";
const API_SECRET_TOKEN = "GEN_EMB_2026_SECURE_KEY";

const DOMINIO_HUB_PERMITIDO = [
  "https://almacenptlg-a11y.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

const AppState = {
  user: null,
  isSessionVerified: false,
  datos: {
    choferes: [], vehiculos: [], destinos: [], materiales: [], areas: []
  },
  cargoItems: [],
  cargosActivos: [],
  pendingAutoPrint: [],
  sortConfig: { key: "fecha", asc: false },
  filtrosGlobales: {
    soloCriticosSLA: false,
    materialId: null,       // ID_MEMB seleccionado en los chips "EN RUTA"
    fechaDesde: "",         // YYYY-MM-DD sincronizado en ambas vistas
    fechaHasta: ""          // YYYY-MM-DD sincronizado en ambas vistas
  },
  historial: [],
  historialFiltrado: [],
  sortHistoryConfig: { key: "horaCargo", asc: false }
};

let cargoActualModalId = null;
let isManualSyncRunning = false;

// ==========================================
// 0. HELPERS DE SANITIZACIÓN Y FORMATO O(1)
// ==========================================
function escapeHTML(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanId(val) {
  return String(val ?? "").replace(/^'+/, "").trim();
}

function formatFechaLimaLocal(dateObj = new Date()) {
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
}

/**
 * Regla de Negocio: Un viaje es pendiente SOLO si NO tiene ningún retorno registrado (DEVUELVE === 0)
 * y posee unidades despachadas pendientes. Si ya tuvo retorno (con faltante o excedente), pertenece al Histórico.
 */
function esViajeSinRetorno(cargo) {
  if (!cargo || !Array.isArray(cargo.detalles) || cargo.detalles.length === 0) return false;
  const tieneAlgunRetorno = cargo.detalles.some(d => (parseInt(d.DEVUELVE || 0, 10) > 0));
  if (tieneAlgunRetorno) return false;
  return cargo.detalles.some(d => (parseInt(d.LLEVA || 0, 10) > 0));
}

// ==========================================
// 1. SEGURIDAD: IFRAME ENFORCER (Anti-Bypass)
// ==========================================
if (window === window.top) {
  document.documentElement.innerHTML = `
    <body style="background-color: #111827; color: #ef4444; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif; text-align: center;">
      <div>
        <svg style="width: 80px; height: 80px; margin: 0 auto 20px auto;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
        <h1 style="font-size: 2rem; font-weight: bold; margin-bottom: 10px;">ACCESO DENEGADO</h1>
        <p style="color: #9ca3af;">Este módulo es privado y solo puede ejecutarse dentro del HUB corporativo.</p>
      </div>
    </body>
  `;
  throw new Error("Ejecución bloqueada por política de seguridad (No-Iframe).");
}

const AuthRules = {
  norm(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  },

  extractRawRole() {
    const u = AppState.user;
    if (!u) return '';
    return (
      u.rol ||
      u.role ||
      u.perfil ||
      u.nivel ||
      u.tipo ||
      u.tipoUsuario ||
      u.cargo ||
      (u.permisos && (u.permisos.embalajes || u.permisos.rol)) ||
      ''
    );
  },

  isAdmin() {
    const u = AppState.user;
    if (!u) return false;
    if (u.isAdmin === true || u.admin === true || u.esAdmin === true) return true;

    const rol = this.norm(this.extractRawRole());
    if (!rol) return false;

    return rol === 'ADMIN' || rol === 'ADMINISTRADOR' || rol.startsWith('ADMINISTRADOR');
  },

  currentUserName() {
    return this.norm(AppState.user?.nombre || AppState.user?.name || AppState.user?.fullName);
  },

  currentUserRole() {
    if (this.isAdmin()) return 'ADMIN';
    const raw = this.norm(this.extractRawRole());
    return raw || 'OPERARIO';
  },

  cargoTieneDevoluciones(cargo) {
    if (!cargo || !Array.isArray(cargo.detalles)) return false;
    return cargo.detalles.some(d => (parseInt(d.DEVUELVE || 0, 10) > 0));
  },

  canModifyLinea(cargo, det) {
    if (!AppState.user) return false;
    if (this.isAdmin()) return true;

    const emisorLinea = this.norm(det['GESTOR CARGO'] || cargo.gestor);
    const esCreador = emisorLinea && emisorLinea === this.currentUserName();
    if (!esCreador) return false;

    const devuelto = parseInt(det.DEVUELVE || 0, 10);
    if (devuelto > 0) return false;

    return true;
  },

  canDeleteCargo(cargo) {
    if (!AppState.user || !cargo) return false;
    if (this.isAdmin()) return true;

    const creadorCargo = this.norm(cargo.gestor);
    const esCreador = creadorCargo && creadorCargo === this.currentUserName();
    if (!esCreador) return false;

    if (this.cargoTieneDevoluciones(cargo)) return false;

    return true;
  },

  canAddSalidaExtra(cargo) {
    if (!AppState.user || !cargo) return false;
    if (this.isAdmin()) return true;
    return this.norm(cargo.gestor) === this.currentUserName();
  }
};

// ==========================================
// 2. SEGURIDAD, TEMA Y ARRANQUE DEL MOTOR
// ==========================================
window.addEventListener('message', (event) => {
  if (!DOMINIO_HUB_PERMITIDO.includes(event.origin)) {
    console.warn("Bloqueo de seguridad:", event.origin);
    return;
  }

  const { type, user, theme } = event.data || {};

  if (type === 'THEME_UPDATE') {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }

  if (type === 'SESSION_SYNC' && user) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    AppState.user = user;
    AppState.isSessionVerified = true;
    actualizarUIUsuario();

    if (AppState.datos.choferes.length === 0) {
      initApp();
    }
  }
});

// Delegación global de eventos para botones de sincronización (soporta botón único y legacy)
document.addEventListener('click', (e) => {
  const syncBtn = e.target.closest('#btnSyncGlobalDesktop, #btnSyncGlobalMobile, #sync-badge, #btnSyncMobile, #btnRefreshCargos, #btnRefreshHistorico');
  if (syncBtn) {
    window.forzarSincronizacionManual(e);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await SyncEngine.init({
    apiUrl: API_URL,
    token: API_SECRET_TOKEN,
    onQueueChange: actualizarBadgeSync,
    onRemoteDataSync: handleRemoteSyncUpdate,
    onSyncError: (msg) => mostrarToast(`Error de sincronización: ${msg}`, 'error')
  });

  window.parent.postMessage({ type: 'MODULO_LISTO' }, '*');

  setTimeout(() => {
    if (!AppState.isSessionVerified) {
      const statusDiv = document.getElementById('status-indicator');
      if (statusDiv) {
        statusDiv.innerHTML = '⚠️ Acceso Restringido';
        statusDiv.className = "flex items-center gap-2 text-xs font-semibold text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-400/10 px-3.5 py-1.5 rounded-full border border-red-200 dark:border-red-400/20 backdrop-blur-md";
      }
      const btnSubmit = document.getElementById('btnSubmit');
      if (btnSubmit) btnSubmit.disabled = true;
    }
  }, 4000);
});

function actualizarUIUsuario() {
  if (!AppState.user) return;
  const statusDiv = document.getElementById('status-indicator');
  if (statusDiv) {
    const esAdmin = AuthRules.isAdmin();
    const rolBadge = esAdmin
      ? `<span class="px-1.5 py-0.5 text-[10px] font-black rounded bg-purple-600 text-white tracking-wider">ADMIN</span>`
      : `<span class="px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-600/20 text-emerald-700 dark:text-emerald-300">${escapeHTML(AuthRules.currentUserRole())}</span>`;

    statusDiv.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span> ${escapeHTML(AppState.user.nombre)} | ${escapeHTML(AppState.user.area || '')} ${rolBadge}`;
    statusDiv.className = "flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-400/10 px-3.5 py-1.5 rounded-full border border-emerald-200 dark:border-emerald-400/20 backdrop-blur-md";
  }
  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit) btnSubmit.disabled = false;
}

// ==========================================
// 3. UI Y MOTOR DE SINCRONIZACIÓN UNIFICADO
// ==========================================
function actualizarBadgeSync(pendingCount, isOnline) {
  const badgeDesktop = document.getElementById('btnSyncGlobalDesktop') || document.getElementById('sync-badge');
  const iconDesktop = document.getElementById('syncIconDesktop') || document.getElementById('sync-icon');
  const textDesktop = document.getElementById('syncTextDesktop') || document.getElementById('sync-text');

  const btnMobile = document.getElementById('btnSyncGlobalMobile') || document.getElementById('btnSyncMobile');
  const iconMobile = document.getElementById('syncIconMobile');
  const textMobile = document.getElementById('syncTextMobile');

  if (!isOnline) {
    if (badgeDesktop && iconDesktop && textDesktop) {
      badgeDesktop.className = "hidden lg:flex items-center gap-2 text-xs font-bold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30";
      iconDesktop.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"></path>`;
      iconDesktop.classList.remove('animate-spin-sync');
      textDesktop.textContent = pendingCount > 0 ? `Offline (${pendingCount} en cola)` : `Modo Offline`;
    }
    if (btnMobile) {
      btnMobile.className = "lg:hidden flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-all bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20";
      if (iconMobile && textMobile) {
        iconMobile.classList.remove('animate-spin-sync');
        textMobile.textContent = `Offline${pendingCount > 0 ? ` (${pendingCount})` : ''}`;
      } else {
        btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span><span>Offline${pendingCount > 0 ? ` (${pendingCount})` : ''}</span>`;
      }
    }
  } else if (pendingCount > 0) {
    if (badgeDesktop && iconDesktop && textDesktop) {
      badgeDesktop.className = "hidden lg:flex items-center gap-2 text-xs font-bold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-500/30";
      iconDesktop.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>`;
      iconDesktop.classList.add('animate-spin-sync');
      textDesktop.textContent = `Sincronizando (${pendingCount})...`;
    }
    if (btnMobile) {
      btnMobile.className = "lg:hidden flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-all bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/20";
      if (iconMobile && textMobile) {
        iconMobile.classList.add('animate-spin-sync');
        textMobile.textContent = `Subiendo (${pendingCount})`;
      } else {
        btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-500 animate-ping"></span><span>Subiendo (${pendingCount})</span>`;
      }
    }
  } else {
    if (badgeDesktop && iconDesktop && textDesktop) {
      badgeDesktop.className = "hidden lg:flex items-center gap-2 text-xs font-bold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30 hover:opacity-80";
      iconDesktop.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>`;
      iconDesktop.classList.remove('animate-spin-sync');
      textDesktop.textContent = `Sincronizado`;
    }
    if (btnMobile) {
      btnMobile.className = "lg:hidden flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-all bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20";
      if (iconMobile && textMobile) {
        iconMobile.classList.remove('animate-spin-sync');
        iconMobile.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>`;
        textMobile.textContent = `Sincronizado`;
      } else {
        btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Al día</span>`;
      }
    }
  }
}

function resolverImpresionDiferidaOficial(cargosRemotos) {
  if (!Array.isArray(AppState.pendingAutoPrint) || AppState.pendingAutoPrint.length === 0) return;
  if (!Array.isArray(cargosRemotos) || cargosRemotos.length === 0) return;

  const pendientesRestantes = [];

  AppState.pendingAutoPrint.forEach((pend) => {
    // 1. Búsqueda directa si el backend devuelve localIdRef o mantiene firma/metadatos exactos
    const matchOficial = cargosRemotos.find((c) => {
      const idOficial = String(c.idCargo || "");
      if (!idOficial || idOficial.startsWith("LOC-")) return false;

      if (c.localIdRef && c.localIdRef === pend.localId) return true;

      const mismoChofer = cleanId(c.choferId) === cleanId(pend.choferId);
      const mismaPlaca = cleanId(c.placa) === cleanId(pend.placa);
      const mismasLineas = Array.isArray(c.detalles) && c.detalles.length === pend.totalItems;
      const mismasUnidades = Array.isArray(c.detalles) &&
        c.detalles.reduce((acc, d) => acc + (parseInt(d.LLEVA || 0, 10)), 0) === pend.totalUnidades;

      return mismoChofer && mismaPlaca && mismasLineas && mismasUnidades;
    });

    if (matchOficial) {
      // Abrir modal oficial validado y lanzar impresión directa del Ticket 80mm
      abrirDetalle(matchOficial.idCargo);
      setTimeout(() => {
        generarDocumentoImpresion(matchOficial.idCargo, 'A4');
      }, 250);
    } else if (Date.now() - pend.createdAt < 300000) {
      // Mantener en espera hasta 5 minutos si aún no termina de subir la cola offline
      pendientesRestantes.push(pend);
    }
  });

  AppState.pendingAutoPrint = pendientesRestantes;
}

function handleRemoteSyncUpdate({ cargosActivos, historial }) {
  if (Array.isArray(cargosActivos)) {
    // 1. Verificar antes de filtrar si algún cargo recién validado debe abrir impresión oficial
    resolverImpresionDiferidaOficial(cargosActivos);

    // 2. Aplicar regla de negocio: solo viajes sin ningún retorno registrado
    AppState.cargosActivos = cargosActivos
      .filter(esViajeSinRetorno)
      .map(cargo => ({
        ...cargo,
        _horaSort: estandarizarFecha(cargo.hora)
      }));

    if (!document.getElementById('viewDescargo')?.classList.contains('hidden')) {
      renderizarCargosFiltrados();
    }
  }

  if (Array.isArray(historial)) {
    AppState.historial = historial;
    if (!document.getElementById('viewHistorico')?.classList.contains('hidden')) {
      renderizarHistorico();
    }
  }

  if (cargoActualModalId && String(cargoActualModalId).startsWith("LOC-")) {
    const sigueExistiendo = AppState.cargosActivos.some(c => c.idCargo === cargoActualModalId);
    if (!sigueExistiendo) {
      cerrarDetalle();
    }
  }
}

window.forzarSincronizacionManual = async function (e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();

  if (isManualSyncRunning) return;

  if (!navigator.onLine) {
    mostrarToast("Sin conexión a internet. Operando en modo offline.", "error");
    return;
  }

  isManualSyncRunning = true;
  const iconDesktop = document.getElementById('syncIconDesktop') || document.getElementById('sync-icon');
  const textDesktop = document.getElementById('syncTextDesktop') || document.getElementById('sync-text');
  const btnMobile = document.getElementById('btnSyncGlobalMobile') || document.getElementById('btnSyncMobile');
  const iconMobile = document.getElementById('syncIconMobile');
  const textMobile = document.getElementById('syncTextMobile');

  if (iconDesktop) iconDesktop.classList.add('animate-spin-sync');
  if (textDesktop) textDesktop.textContent = 'Sincronizando...';
  if (iconMobile && textMobile) {
    iconMobile.classList.add('animate-spin-sync');
    textMobile.textContent = 'Sincronizando...';
  } else if (btnMobile) {
    btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-500 animate-ping"></span><span>Buscando...</span>`;
  }

  try {
    if (typeof SyncEngine !== 'undefined' && typeof SyncEngine.processQueue === 'function') {
      await SyncEngine.processQueue();
    }

    let pendingItems = [];
    if (typeof SyncEngine !== 'undefined' && typeof SyncEngine.getQueueItems === 'function') {
      pendingItems = await SyncEngine.getQueueItems();
    }

    if (pendingItems.length > 0) {
      mostrarToast(`Aún hay ${pendingItems.length} registros pendientes por subir.`, "error");
      return;
    }

    const bust = `_t=${Date.now()}&nocache=1`;
    const tokenParam = encodeURIComponent(API_SECRET_TOKEN);

    const [resCargos, resHistory] = await Promise.all([
      fetch(`${API_URL}?action=getActiveCargos&token=${tokenParam}&${bust}`, {
        method: "GET",
        redirect: "follow",
        cache: "no-store"
      }),
      fetch(`${API_URL}?action=getHistory&token=${tokenParam}&${bust}`, {
        method: "GET",
        redirect: "follow",
        cache: "no-store"
      })
    ]);

    if (!resCargos.ok || !resHistory.ok) {
      throw new Error(`Error HTTP (${resCargos.status} / ${resHistory.status})`);
    }

    const jsonCargos = await resCargos.json();
    const jsonHistory = await resHistory.json();

    if (jsonCargos.status === "error") throw new Error(jsonCargos.message);
    if (jsonHistory.status === "error") throw new Error(jsonHistory.message);

    if (Array.isArray(jsonCargos.data)) {
      await SyncEngine.saveCache('cargosActivos', jsonCargos.data);
    }
    if (Array.isArray(jsonHistory.data)) {
      await SyncEngine.saveCache('historial', jsonHistory.data);
    }

    handleRemoteSyncUpdate({
      cargosActivos: jsonCargos.data,
      historial: jsonHistory.data
    });

    renderizarCargosFiltrados();
    renderizarHistorico();

    mostrarToast("Datos sincronizados con Google Sheets.");
  } catch (err) {
    console.error("[SyncManual] Error:", err);
    mostrarToast(`Error al sincronizar: ${err.message}`, "error");
  } finally {
    isManualSyncRunning = false;
    if (iconDesktop) iconDesktop.classList.remove('animate-spin-sync');
    if (iconMobile) iconMobile.classList.remove('animate-spin-sync');

    let pendingCount = 0;
    try {
      if (typeof SyncEngine !== 'undefined' && typeof SyncEngine.getQueueItems === 'function') {
        const q = await SyncEngine.getQueueItems();
        pendingCount = Array.isArray(q) ? q.length : 0;
      }
    } catch (_) { }

    actualizarBadgeSync(pendingCount, navigator.onLine);
  }
};

// ==========================================
// 4. INICIALIZACIÓN (STALE-WHILE-REVALIDATE)
// ==========================================
async function initApp() {
  const cachedMaestros = await SyncEngine.getCache('maestros');
  const cachedCargos = await SyncEngine.getCache('cargosActivos');
  const cachedHistorial = await SyncEngine.getCache('historial');

  if (cachedMaestros) {
    procesarMaestrosEnMemoria(cachedMaestros);
    construirUI();
    initSignaturePad();
  }
 if (cachedCargos) {
    AppState.cargosActivos = cachedCargos
      .filter(esViajeSinRetorno)
      .map(c => ({ ...c, _horaSort: estandarizarFecha(c.hora) }));
  }
  if (cachedHistorial) {
    AppState.historial = cachedHistorial;
  }

  if (!navigator.onLine) {
    if (!cachedMaestros) mostrarAlerta("Sin conexión y sin caché local. Conéctate a internet la primera vez.", "error", "Modo Offline");
    return;
  }

  try {
    const res = await fetch(`${API_URL}?action=getInitData&token=${encodeURIComponent(API_SECRET_TOKEN)}&_t=${Date.now()}`, {
      method: "GET",
      redirect: "follow",
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.status === "error") throw new Error(json.message);

    await SyncEngine.saveCache('maestros', json.data);
    procesarMaestrosEnMemoria(json.data);

    if (!cachedMaestros) {
      construirUI();
      initSignaturePad();
    }

    SyncEngine.pullLatestState();
  } catch (err) {
    console.warn("[InitApp] Falló actualización remota, operando con caché local:", err.message);
    if (!cachedMaestros) {
      mostrarAlerta("No se pudo descargar la BD inicial: " + err.message, "error", "Error de Red");
    }
  }
}

function procesarMaestrosEnMemoria(rawData) {
  AppState.datos = {
    choferes: (rawData.choferes || []).map(c => ({ ...c, ID_CHFR: cleanId(c.ID_CHFR) })),
    vehiculos: (rawData.vehiculos || []).map(v => ({
      ...v,
      PLACA: cleanId(v.PLACA),
      DISPLAY_NAME: `${cleanId(v.PLACA)} ${v.MARCA || ''}`.trim()
    })),
    destinos: (rawData.destinos || []).map(d => ({ ...d, ID_DSTN: cleanId(d.ID_DSTN) })),
    materiales: (rawData.materiales || []).map(m => ({ ...m, ID_MEMB: cleanId(m.ID_MEMB) })),
    areas: []
  };
  AppState.datos.areas = AppState.datos.destinos.filter(d => d.EMISOR && String(d.EMISOR).trim().toUpperCase() === "SI");
}

// ==========================================
// 5. MOTOR DE FIRMA DIGITAL (CANVAS)
// ==========================================
let signaturePad, signatureCtx;
let isDrawing = false;
let isSignatureEmpty = true;
let isSignatureInitialized = false;

function initSignaturePad() {
  if (isSignatureInitialized) return;
  signaturePad = document.getElementById('signaturePad');
  if (!signaturePad) return;
  signatureCtx = signaturePad.getContext('2d');

  function resizeCanvas() {
    const rect = signaturePad.parentElement.getBoundingClientRect();
    if (rect.width === 0) return;
    signaturePad.width = rect.width;
    signaturePad.height = rect.height;
    signatureCtx.lineCap = 'round';
    signatureCtx.lineJoin = 'round';
    signatureCtx.lineWidth = 3;
    signatureCtx.strokeStyle = '#000000';
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const getPos = (e) => {
    const rect = signaturePad.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const startDrawing = (e) => {
    isDrawing = true;
    isSignatureEmpty = false;
    signatureCtx.beginPath();
    const pos = getPos(e);
    signatureCtx.moveTo(pos.x, pos.y);
    e.preventDefault();
  };

  const draw = (e) => {
    if (!isDrawing) return;
    const pos = getPos(e);
    signatureCtx.lineTo(pos.x, pos.y);
    signatureCtx.stroke();
    e.preventDefault();
  };

  const stopDrawing = () => {
    isDrawing = false;
    signatureCtx.closePath();
  };

  signaturePad.addEventListener('mousedown', startDrawing);
  signaturePad.addEventListener('mousemove', draw);
  signaturePad.addEventListener('mouseup', stopDrawing);
  signaturePad.addEventListener('mouseout', stopDrawing);
  signaturePad.addEventListener('touchstart', startDrawing, { passive: false });
  signaturePad.addEventListener('touchmove', draw, { passive: false });
  signaturePad.addEventListener('touchend', stopDrawing);

  document.getElementById('btnClearSignature')?.addEventListener('click', limpiarFirma);
  isSignatureInitialized = true;
}

function limpiarFirma() {
  if (!signatureCtx) return;
  signatureCtx.clearRect(0, 0, signaturePad.width, signaturePad.height);
  isSignatureEmpty = true;
}

// ==========================================
// 6. SISTEMA DE NOTIFICACIONES (TOASTS Y ALERTAS)
// ==========================================
function mostrarToast(mensaje, tipo = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const isError = tipo === 'error';
  const bgClass = isError
    ? 'bg-red-600 text-white border-red-500'
    : 'bg-gray-900 dark:bg-gray-800 text-white border-gray-700 dark:border-gray-600';

  const iconSvg = isError
    ? `<svg class="w-5 h-5 text-red-200 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`
    : `<svg class="w-5 h-5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>`;

  toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3.5 rounded-2xl shadow-2xl border ${bgClass} text-xs font-semibold transform translate-y-4 opacity-0 transition-all duration-300`;
  toast.innerHTML = `${iconSvg}<span class="leading-snug">${escapeHTML(mensaje)}</span>`;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function mostrarAlerta(mensaje, tipo = "warning", titulo = "") {
  const modal = document.getElementById("customAlert");
  const content = document.getElementById("customAlertContent");
  const icon = document.getElementById("alertIcon");
  const title = document.getElementById("alertTitle");
  const msg = document.getElementById("alertMessage");
  const btn = document.getElementById("btnAlertClose");

  msg.textContent = mensaje;
  title.textContent = titulo || "Dato Requerido";
  icon.innerHTML = `<div class="w-16 h-16 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center text-red-600 dark:text-red-500 border-4 border-red-200 dark:border-red-500/20"><svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg></div>`;
  btn.className = "w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold transition-all shadow-lg focus:outline-none";

  modal.classList.remove("hidden");
  setTimeout(() => {
    modal.classList.remove("opacity-0");
    content.classList.remove("scale-95");
    btn.focus();
  }, 10);
}

window.cerrarAlerta = function () {
  const modal = document.getElementById("customAlert");
  const content = document.getElementById("customAlertContent");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("opacity-0");
  content.classList.add("scale-95");
  setTimeout(() => modal.classList.add("hidden"), 300);
};

// ==========================================
// 6.1 MOTOR DE DIÁLOGOS ASÍNCRONOS (GenDialog)
// ==========================================
const GenDialog = (() => {
  let modalEl = null;

  function ensureDOM() {
    if (modalEl) return modalEl;

    modalEl = document.createElement('div');
    modalEl.id = 'gen-custom-dialog';
    modalEl.className = 'fixed inset-0 z-[120] hidden flex items-center justify-center p-4 bg-gray-950/75 backdrop-blur-sm opacity-0 transition-opacity duration-200';
    modalEl.innerHTML = `
      <div id="gen-dialog-card" class="w-full max-w-md bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700/80 rounded-2xl shadow-2xl overflow-hidden transform scale-95 transition-all duration-200">
        <div class="p-5 sm:p-6">
          <div class="flex items-start gap-4">
            <div id="gen-dialog-icon" class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"></div>
            <div class="flex-1 min-w-0">
              <span id="gen-dialog-badge" class="inline-block text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded mb-1"></span>
              <h3 id="gen-dialog-title" class="text-base font-extrabold text-gray-900 dark:text-white leading-snug"></h3>
              <p id="gen-dialog-msg" class="text-xs text-gray-600 dark:text-gray-300 mt-1.5 leading-relaxed"></p>
            </div>
          </div>

          <div id="gen-dialog-inputs" class="hidden mt-5 pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3"></div>
        </div>

        <div class="px-5 py-3.5 bg-gray-50 dark:bg-gray-800/70 border-t border-gray-200 dark:border-gray-800 flex items-center justify-end gap-2.5">
          <button type="button" id="gen-dialog-cancel" class="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 transition-colors focus:outline-none">
            Cancelar
          </button>
          <button type="button" id="gen-dialog-confirm" class="px-5 py-2.5 rounded-xl text-xs font-bold text-white shadow-lg transition-all focus:outline-none flex items-center gap-1.5">
            Confirmar
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    return modalEl;
  }

  function close(resolver, value) {
    const card = document.getElementById('gen-dialog-card');
    modalEl.classList.add('opacity-0');
    card.classList.add('scale-95');
    setTimeout(() => {
      modalEl.classList.add('hidden');
      resolver(value);
    }, 180);
  }

  function confirm({ title, message, badge = 'Confirmación', confirmText = 'Sí, eliminar', variant = 'danger' }) {
    return new Promise((resolve) => {
      ensureDOM();
      const iconBox = document.getElementById('gen-dialog-icon');
      const badgeEl = document.getElementById('gen-dialog-badge');
      const titleEl = document.getElementById('gen-dialog-title');
      const msgEl = document.getElementById('gen-dialog-msg');
      const inputsBox = document.getElementById('gen-dialog-inputs');
      const btnCancel = document.getElementById('gen-dialog-cancel');
      const btnConfirm = document.getElementById('gen-dialog-confirm');

      inputsBox.classList.add('hidden');
      inputsBox.innerHTML = '';

      if (variant === 'danger') {
        iconBox.className = 'w-11 h-11 rounded-xl flex items-center justify-center shrink-0 bg-red-100 dark:bg-red-500/15 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30';
        iconBox.innerHTML = `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>`;
        badgeEl.className = 'inline-block text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded mb-1 bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300';
        btnConfirm.className = 'px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-red-600 hover:bg-red-500 shadow-lg shadow-red-600/25 transition-all focus:outline-none';
      } else {
        iconBox.className = 'w-11 h-11 rounded-xl flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30';
        iconBox.innerHTML = `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>`;
        badgeEl.className = 'inline-block text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded mb-1 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300';
        btnConfirm.className = 'px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-amber-600 hover:bg-amber-500 shadow-lg shadow-amber-600/25 transition-all focus:outline-none';
      }

      badgeEl.textContent = badge;
      titleEl.textContent = title;
      msgEl.innerHTML = message;
      btnConfirm.textContent = confirmText;

      const onConfirm = () => { cleanup(); close(resolve, true); };
      const onCancel = () => { cleanup(); close(resolve, false); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
      };

      function cleanup() {
        btnConfirm.removeEventListener('click', onConfirm);
        btnCancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true);
      }

      btnConfirm.addEventListener('click', onConfirm);
      btnCancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true);

      modalEl.classList.remove('hidden');
      requestAnimationFrame(() => {
        modalEl.classList.remove('opacity-0');
        document.getElementById('gen-dialog-card').classList.remove('scale-95');
        btnConfirm.focus();
      });
    });
  }

  function editQuantities({ idDetalle, llevaActual, devuelveActual }) {
    return new Promise((resolve) => {
      ensureDOM();
      const iconBox = document.getElementById('gen-dialog-icon');
      const badgeEl = document.getElementById('gen-dialog-badge');
      const titleEl = document.getElementById('gen-dialog-title');
      const msgEl = document.getElementById('gen-dialog-msg');
      const inputsBox = document.getElementById('gen-dialog-inputs');
      const btnCancel = document.getElementById('gen-dialog-cancel');
      const btnConfirm = document.getElementById('gen-dialog-confirm');

      iconBox.className = 'w-11 h-11 rounded-xl flex items-center justify-center shrink-0 bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/30';
      iconBox.innerHTML = `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>`;
      badgeEl.className = 'inline-block text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded mb-1 bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300';
      badgeEl.textContent = `Línea ${idDetalle}`;
      titleEl.textContent = 'Corregir Cantidades del Movimiento';
      msgEl.textContent = 'Ajusta las unidades despachadas o retornadas. El saldo de deuda se recalculará automáticamente.';

      inputsBox.classList.remove('hidden');
      inputsBox.innerHTML = `
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-gray-50 dark:bg-gray-800/80 p-3 rounded-xl border border-gray-200 dark:border-gray-700">
            <label class="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">Lleva (Salida)</label>
            <input id="dlg-in-lleva" type="number" min="0" inputmode="numeric" value="${llevaActual}"
              class="w-full bg-white dark:bg-gray-950 border-2 border-gray-300 dark:border-gray-600 focus:border-blue-500 rounded-xl px-3 py-2 text-center text-lg font-black text-gray-900 dark:text-white outline-none transition-colors">
          </div>
          <div class="bg-gray-50 dark:bg-gray-800/80 p-3 rounded-xl border border-gray-200 dark:border-gray-700">
            <label class="block text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5">Devuelto (Retorno)</label>
            <input id="dlg-in-devuelve" type="number" min="0" inputmode="numeric" value="${devuelveActual}"
              class="w-full bg-white dark:bg-gray-950 border-2 border-gray-300 dark:border-gray-600 focus:border-emerald-500 rounded-xl px-3 py-2 text-center text-lg font-black text-emerald-600 dark:text-emerald-400 outline-none transition-colors">
          </div>
        </div>
        <div class="flex items-center justify-between px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-800/50 text-xs">
          <span class="text-gray-500 font-semibold">Nueva Deuda Resultante:</span>
          <span id="dlg-preview-deuda" class="font-mono font-black text-sm text-gray-900 dark:text-white">${llevaActual - devuelveActual} und.</span>
        </div>
      `;

      btnConfirm.className = 'px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/25 transition-all focus:outline-none';
      btnConfirm.textContent = 'Guardar Cambios';

      const inLleva = document.getElementById('dlg-in-lleva');
      const inDev = document.getElementById('dlg-in-devuelve');
      const previewEl = document.getElementById('dlg-preview-deuda');

      const updatePreview = () => {
        const l = parseInt(inLleva.value, 10) || 0;
        const d = parseInt(inDev.value, 10) || 0;
        const diff = l - d;
        previewEl.textContent = `${diff} und.`;
        previewEl.className = `font-mono font-black text-sm ${diff > 0 ? 'text-red-600 dark:text-red-400' : diff < 0 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400'}`;
      };

      inLleva.addEventListener('input', updatePreview);
      inDev.addEventListener('input', updatePreview);

      const onConfirm = () => {
        const l = parseInt(inLleva.value, 10);
        const d = parseInt(inDev.value, 10);
        if (isNaN(l) || l < 0 || isNaN(d) || d < 0) {
          mostrarToast('Ingresa cantidades válidas (0 o mayor).', 'error');
          return;
        }
        cleanup();
        close(resolve, { lleva: l, devuelve: d });
      };

      const onCancel = () => { cleanup(); close(resolve, null); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
      };

      function cleanup() {
        btnConfirm.removeEventListener('click', onConfirm);
        btnCancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true);
      }

      btnConfirm.addEventListener('click', onConfirm);
      btnCancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true);

      modalEl.classList.remove('hidden');
      requestAnimationFrame(() => {
        modalEl.classList.remove('opacity-0');
        document.getElementById('gen-dialog-card').classList.remove('scale-95');
        inLleva.focus();
        inLleva.select();
      });
    });
  }

  return { confirm, editQuantities };
})();

// ==========================================
// 7. AUTOCOMPLETADO Y LISTA DE MATERIALES
// ==========================================
let isUIBuilt = false;
function construirUI() {
  if (isUIBuilt) return;
  setupAutocomplete("inArea", "hdArea", "listArea", () => AppState.datos.areas, "REFERENCIA", "ID_DSTN", "inChofer");
  setupAutocomplete("inChofer", "hdChofer", "listChofer", () => AppState.datos.choferes, "NOMBRE", "ID_CHFR", "inVehiculo");
  setupAutocomplete("inVehiculo", "hdVehiculo", "listVehiculo", () => AppState.datos.vehiculos, "DISPLAY_NAME", "PLACA", "inDestino");
  setupAutocomplete("inDestino", "hdDestino", "listDestino", () => AppState.datos.destinos, "REFERENCIA", "ID_DSTN", "inMaterial");
  setupAutocomplete("inMaterial", "hdMaterial", "listMaterial", () => AppState.datos.materiales, "DESCRIPCION", "ID_MEMB", "inCantidad");

  setupAutocomplete("inExtraDestino", "hdExtraDestino", "listExtraDestino", () => AppState.datos.destinos, "REFERENCIA", "ID_DSTN", "inExtraMaterial");
  setupAutocomplete("inExtraMaterial", "hdExtraMaterial", "listExtraMaterial", () => AppState.datos.materiales, "DESCRIPCION", "ID_MEMB", "inExtraCantidad");

  document.getElementById("btnSubmit").disabled = false;
  document.getElementById("btnSubmit").addEventListener("click", handleFormSubmit);
  document.getElementById("btnAddMaterial").addEventListener("click", agregarItemLista);

  document.getElementById("cargoForm").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });

  document.getElementById("inCantidad").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      agregarItemLista();
      document.getElementById("inMaterial").focus();
    }
  });

  document.getElementById("inExtraCantidad")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("btnGuardarExtraModal")?.click();
    }
  });

  document.addEventListener("click", (e) => {
    document.querySelectorAll('ul[id^="list"]').forEach((ul) => {
      if (!ul.contains(e.target) && e.target.tagName !== "INPUT") ul.classList.add("hidden");
    });
  });
  isUIBuilt = true;
}

function setupAutocomplete(inputId, hiddenId, listId, getDataFn, displayField, valueField, nextInputId = null) {
  const input = document.getElementById(inputId);
  const hidden = document.getElementById(hiddenId);
  const list = document.getElementById(listId);
  if (!input || !hidden || !list) return;
  let currentFocus = -1;

  input.disabled = false;

  input.addEventListener("input", (e) => {
    const val = e.target.value.toLowerCase().trim();
    list.innerHTML = "";
    currentFocus = -1;
    hidden.value = "";

    if (!val) { list.classList.add("hidden"); return; }

    const dataArray = getDataFn();
    const matches = dataArray.filter((item) => {
      const text = item[displayField] ? String(item[displayField]).toLowerCase() : "";
      return text.includes(val);
    });

    if (matches.length === 0) { list.classList.add("hidden"); return; }

    matches.forEach((item) => {
      const li = document.createElement("li");
      li.className = "px-4 py-2 text-gray-700 dark:text-gray-200 cursor-pointer text-sm border-b border-gray-200 dark:border-gray-700 last:border-0 transition-colors hover:bg-blue-50 dark:hover:bg-blue-600 hover:text-blue-700 dark:hover:text-white";
      li.textContent = item[displayField];

      const selectAction = () => {
        input.value = item[displayField];
        hidden.value = item[valueField];
        list.classList.add("hidden");
        list.innerHTML = "";
        if (nextInputId) document.getElementById(nextInputId)?.focus();
      };

      li.addEventListener("mousedown", (e) => { e.preventDefault(); selectAction(); });
      li._selectTrigger = selectAction;
      list.appendChild(li);
    });
    list.classList.remove("hidden");
  });

  input.addEventListener("keydown", function (e) {
    const items = list.getElementsByTagName("li");
    if (list.classList.contains("hidden") || items.length === 0) return;

    if (e.key === "ArrowDown") { currentFocus++; addActive(items); }
    else if (e.key === "ArrowUp") { currentFocus--; addActive(items); }
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (currentFocus > -1) items[currentFocus]._selectTrigger();
      else items[0]._selectTrigger();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!hidden.value) { input.value = ""; list.classList.add("hidden"); }
    }, 150);
  });

  function addActive(items) {
    if (!items) return false;
    removeActive(items);
    if (currentFocus >= items.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = items.length - 1;
    items[currentFocus].classList.add("bg-blue-100", "dark:bg-blue-600", "text-blue-900", "dark:text-white");
  }

  function removeActive(items) {
    for (let i = 0; i < items.length; i++) {
      items[i].classList.remove("bg-blue-100", "dark:bg-blue-600", "text-blue-900", "dark:text-white");
    }
  }
}

function agregarItemLista() {
  const destinoId = document.getElementById("hdDestino").value;
  const destinoText = document.getElementById("inDestino").value;
  const materialId = document.getElementById("hdMaterial").value;
  const materialText = document.getElementById("inMaterial").value;
  const cantidad = parseInt(document.getElementById("inCantidad").value, 10);

  if (!destinoId) return mostrarAlerta("Selecciona un DESTINO válido.", "warning", "Falta Destino");
  if (!materialId) return mostrarAlerta("Especifica el TIPO DE MATERIAL.", "warning", "Falta Material");
  if (isNaN(cantidad) || cantidad <= 0) return mostrarAlerta("Ingresa CANTIDAD mayor a cero.", "warning", "Cantidad Inválida");

  const materialObj = AppState.datos.materiales.find((m) => m.ID_MEMB === materialId);
  const m3Unitario = materialObj && materialObj.M3 ? parseFloat(String(materialObj.M3).replace(",", ".")) : 0;

  AppState.cargoItems.push({
    destinoId, destinoName: destinoText, materialId, materialName: materialText,
    cantidad, m3Unitario, m3Total: m3Unitario * cantidad
  });

  document.getElementById("hdMaterial").value = "";
  document.getElementById("inMaterial").value = "";
  document.getElementById("inCantidad").value = "";
  renderizarListaItems();
}

function renderizarListaItems() {
  const container = document.getElementById("listaMaterialesAgregados");
  const emptyState = document.getElementById("emptyState");
  const displayTotalM3 = document.getElementById("lblTotalM3");
  const boxResumen = document.getElementById("lblResumenTipos");

  Array.from(container.children).forEach((child) => {
    if (child.id !== "emptyState") child.remove();
  });

  let sumatoriaM3 = 0;
  let conteoTipos = {};

  if (AppState.cargoItems.length === 0) {
    emptyState.style.display = "block";
    displayTotalM3.textContent = "0.000";
    boxResumen.innerHTML = '<span class="text-sm text-gray-500 italic">No hay materiales añadidos</span>';
    return;
  }

  emptyState.style.display = "none";

  AppState.cargoItems.forEach((item, idx) => {
    sumatoriaM3 += item.m3Total;
    conteoTipos[item.materialName] = (conteoTipos[item.materialName] || 0) + item.cantidad;

    const safeMat = escapeHTML(item.materialName);
    const safeDest = escapeHTML(item.destinoName);

    const row = `
      <div class="flex items-center justify-between bg-white dark:bg-gray-800/80 p-3 rounded-xl border border-gray-200 dark:border-gray-600 gap-2 shadow-sm">
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <span class="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-bold w-6 h-6 flex items-center justify-center rounded-md text-xs shrink-0">${idx + 1}</span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-gray-800 dark:text-white truncate" title="${safeMat}">${safeMat}</p>
            <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 truncate">
              <span title="${safeDest}">A: <span class="text-gray-700 dark:text-gray-300">${safeDest}</span></span>
              <span class="text-gray-300 dark:text-gray-600">|</span>
              <span class="text-emerald-600 dark:text-emerald-400 font-mono" title="Cubicaje">${item.m3Total.toFixed(3)} m³</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 md:gap-3 shrink-0">
          <span class="bg-gray-100 dark:bg-gray-900 px-2 py-1 md:px-3 md:py-1 rounded-lg text-xs md:text-sm text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700 whitespace-nowrap">${item.cantidad} und.</span>
          <button type="button" onclick="removerItemLista(${idx})" class="text-red-400 hover:text-red-600 dark:hover:text-red-300 p-1 shrink-0 transition-colors">
            <svg class="w-5 h-5 md:w-6 md:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>`;
    container.insertAdjacentHTML("beforeend", row);
  });

  displayTotalM3.textContent = sumatoriaM3.toFixed(3);

  boxResumen.innerHTML = Object.keys(conteoTipos).map((tipo) => `
    <div class="flex justify-between items-center text-sm border-b border-gray-200 dark:border-gray-700/50 last:border-0 pb-1 mb-1 last:pb-0 last:mb-0">
      <span class="text-gray-600 dark:text-gray-300 truncate pr-3" title="${escapeHTML(tipo)}">${escapeHTML(tipo)}</span>
      <span class="text-emerald-700 dark:text-emerald-400 font-bold bg-emerald-100 dark:bg-emerald-900/30 px-2 rounded">${conteoTipos[tipo]}</span>
    </div>
  `).join("");
}

window.removerItemLista = function (index) {
  AppState.cargoItems.splice(index, 1);
  renderizarListaItems();
};

// ==========================================
// 8. EMISIÓN OPTIMISTA DE CARGOS (LATENCIA 0ms)
// ==========================================
async function handleFormSubmit(e) {
  e.preventDefault();

  const chofer = cleanId(document.getElementById("hdChofer").value);
  const vehiculo = cleanId(document.getElementById("hdVehiculo").value);
  const area = cleanId(document.getElementById("hdArea").value || document.getElementById("inArea").value);

  if (!area) return mostrarAlerta("Es obligatorio especificar el ÁREA RESPONSABLE.", "error", "Falta Área");
  if (!chofer) return mostrarAlerta("Es obligatorio seleccionar un CHOFER.", "error", "Falta Chofer");
  if (!vehiculo) return mostrarAlerta("Es obligatorio seleccionar la PLACA.", "error", "Falta Vehículo");
  if (AppState.cargoItems.length === 0) return mostrarAlerta("Añade al menos un MATERIAL a la lista.", "error", "Lista Vacía");
  if (isSignatureEmpty) return mostrarAlerta("El chofer debe firmar la conformidad.", "error", "Firma Requerida");

  const firmaComprimida = SyncEngine.compressSignature(signaturePad);
  if (!firmaComprimida) return mostrarAlerta("El trazo de firma es demasiado corto.", "error", "Firma Inválida");

  const idLocal = `LOC-${Date.now().toString(36).toUpperCase()}`;
  const choferCat = AppState.datos.choferes.find(c => cleanId(c.ID_CHFR) === chofer);
  const fechaFormat = formatFechaLimaLocal();

  const materialesPayload = AppState.cargoItems.map((i) => ({
    id_memb: i.materialId,
    materialName: i.materialName,
    cantidad: i.cantidad,
    destino: i.destinoId
  }));

  const nuevoCargoOptimista = {
    idCargo: idLocal,
    isLocalSyncPending: true,
    choferId: chofer,
    choferNombre: choferCat ? choferCat.NOMBRE : chofer,
    placa: vehiculo,
    hora: fechaFormat,
    _horaSort: estandarizarFecha(fechaFormat),
    gestor: AppState.user ? AppState.user.nombre : 'Operador Local',
    firmaCargo: firmaComprimida,
    detalles: AppState.cargoItems.map((i, idx) => ({
      ID_DETALLE: `${idLocal}-D${idx + 1}`,
      LLEVA: i.cantidad,
      DEVUELVE: 0,
      DEUDA: i.cantidad,
      DESTINO: i.destinoId,
      MATERIAL: i.materialId,
      EMISOR: area,
      'GESTOR CARGO': AppState.user ? AppState.user.nombre : 'Operador Local',
      RESPONSABLE: chofer
    }))
  };

  AppState.cargosActivos.unshift(nuevoCargoOptimista);
  await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);

  await SyncEngine.enqueueMutation('saveCargo', {
    data: {
      localIdRef: idLocal,
      chofer,
      vehiculo,
      area,
      firma: firmaComprimida,
      gestorNombre: AppState.user ? AppState.user.nombre : 'Usuario Desconocido',
      gestorRol: AuthRules.currentUserRole(),
      gestorCorreo: AppState.user ? AppState.user.usuario : 'almacenpt@lagenovesa.com.pe',
      materiales: materialesPayload
    }
  });

const quiereAutoPrint = Boolean(document.getElementById("chkAutoPrint")?.checked);

  if (quiereAutoPrint) {
    AppState.pendingAutoPrint.push({
      localId: idLocal,
      choferId: chofer,
      placa: vehiculo,
      totalItems: materialesPayload.length,
      totalUnidades: materialesPayload.reduce((acc, m) => acc + (parseInt(m.cantidad, 10) || 0), 0),
      createdAt: Date.now()
    });
  }

  mostrarToast(
    quiereAutoPrint
      ? `Cargo ${idLocal} guardado. Validando código oficial para imprimir...`
      : `Cargo ${idLocal} registrado. Sincronizando en segundo plano...`
  );
  
  document.getElementById("cargoForm").reset();
  ["hdArea", "hdChofer", "hdVehiculo", "hdDestino", "hdMaterial"].forEach((id) => (document.getElementById(id).value = ""));
  AppState.cargoItems = [];
  renderizarListaItems();
  limpiarFirma();
}

// ==========================================
// 9. MOTOR DE FILTROS CRUZADOS, KPIs Y DESCARGOS
// ==========================================
function switchTab(target) {
  const views = {
    emitir: document.getElementById("viewEmitir"),
    descargo: document.getElementById("viewDescargo"),
    historico: document.getElementById("viewHistorico")
  };
  const tabs = {
    emitir: document.getElementById("tabEmitir"),
    descargo: document.getElementById("tabDescargo"),
    historico: document.getElementById("tabHistorico")
  };

  const inactiveClass = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
  const activeBlueClass = "flex-1 lg:flex-none px-4 md:px-5 py-2 bg-blue-600 rounded-xl text-xs md:text-sm font-bold text-white shadow-md transition-all";
  const activeEmeraldClass = "flex-1 lg:flex-none px-4 md:px-5 py-2 bg-emerald-600 rounded-xl text-xs md:text-sm font-bold text-white shadow-md transition-all";

  Object.keys(views).forEach(k => views[k]?.classList.toggle("hidden", k !== target));
  if (tabs.emitir) tabs.emitir.className = target === 'emitir' ? activeBlueClass : inactiveClass;
  if (tabs.descargo) tabs.descargo.className = target === 'descargo' ? activeEmeraldClass : inactiveClass;
  if (tabs.historico) tabs.historico.className = target === 'historico' ? activeBlueClass : inactiveClass;

  if (target === 'descargo') {
    renderizarCargosFiltrados();
    SyncEngine.pullLatestState();
  } else if (target === 'historico') {
    renderizarHistorico();
    SyncEngine.pullLatestState();
  }
}

document.getElementById("tabEmitir")?.addEventListener("click", () => switchTab("emitir"));
document.getElementById("tabDescargo")?.addEventListener("click", () => switchTab("descargo"));
document.getElementById("tabHistorico")?.addEventListener("click", () => switchTab("historico"));

document.getElementById("inBuscarCargo")?.addEventListener("input", renderizarCargosFiltrados);
document.getElementById("selFiltroColumna")?.addEventListener("change", renderizarCargosFiltrados);

function sincronizarFechasGlobales(tipo, valor) {
  if (tipo === "desde") {
    AppState.filtrosGlobales.fechaDesde = valor;
    const elDesc = document.getElementById("inDesdeDescargos") || document.getElementById("inDesdeActivos");
    const elHist = document.getElementById("inDesdeHistorico");
    if (elDesc && elDesc.value !== valor) elDesc.value = valor;
    if (elHist && elHist.value !== valor) elHist.value = valor;
  } else {
    AppState.filtrosGlobales.fechaHasta = valor;
    const elDesc = document.getElementById("inHastaDescargos") || document.getElementById("inHastaActivos");
    const elHist = document.getElementById("inHastaHistorico");
    if (elDesc && elDesc.value !== valor) elDesc.value = valor;
    if (elHist && elHist.value !== valor) elHist.value = valor;
  }
  renderizarCargosFiltrados();
  renderizarHistorico();
}

document.getElementById("inDesdeDescargos")?.addEventListener("change", (e) => sincronizarFechasGlobales("desde", e.target.value));
document.getElementById("inHastaDescargos")?.addEventListener("change", (e) => sincronizarFechasGlobales("hasta", e.target.value));
document.getElementById("inDesdeActivos")?.addEventListener("change", (e) => sincronizarFechasGlobales("desde", e.target.value));
document.getElementById("inHastaActivos")?.addEventListener("change", (e) => sincronizarFechasGlobales("hasta", e.target.value));
document.getElementById("inDesdeHistorico")?.addEventListener("change", (e) => sincronizarFechasGlobales("desde", e.target.value));
document.getElementById("inHastaHistorico")?.addEventListener("change", (e) => sincronizarFechasGlobales("hasta", e.target.value));

window.toggleFiltroMaterialGlobal = function (materialId) {
  AppState.filtrosGlobales.materialId = (AppState.filtrosGlobales.materialId === materialId) ? null : materialId;
  renderizarCargosFiltrados();
  renderizarHistorico();
};

window.toggleFiltroCriticosSLA = function () {
  AppState.filtrosGlobales.soloCriticosSLA = !AppState.filtrosGlobales.soloCriticosSLA;
  renderizarCargosFiltrados();
  renderizarHistorico();
};

window.limpiarFiltrosGlobales = function () {
  AppState.filtrosGlobales.materialId = null;
  AppState.filtrosGlobales.soloCriticosSLA = false;
  AppState.filtrosGlobales.fechaDesde = "";
  AppState.filtrosGlobales.fechaHasta = "";

  ["inDesdeDescargos", "inHastaDescargos", "inDesdeActivos", "inHastaActivos", "inDesdeHistorico", "inHastaHistorico"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  renderizarCargosFiltrados();
  renderizarHistorico();
};

window.setSort = function (key) {
  if (AppState.sortConfig.key === key) AppState.sortConfig.asc = !AppState.sortConfig.asc;
  else { AppState.sortConfig.key = key; AppState.sortConfig.asc = true; }
  renderizarCargosFiltrados();
};

function getSortIcon(key) {
  if (AppState.sortConfig.key !== key) return `<span class="text-gray-400 dark:text-gray-600 ml-1">↕</span>`;
  return AppState.sortConfig.asc ? `<span class="text-emerald-600 dark:text-emerald-400 ml-1">↑</span>` : `<span class="text-emerald-600 dark:text-emerald-400 ml-1">↓</span>`;
}

function estandarizarFecha(fechaLatina) {
  if (!fechaLatina) return "0000-00-00 00:00:00";
  const partes = String(fechaLatina).split(/[ \/:-]+/);
  if (partes.length >= 3) {
    return `${partes[2]}-${partes[1].padStart(2, "0")}-${partes[0].padStart(2, "0")} ${(partes[3] || "00").padStart(2, "0")}:${(partes[4] || "00").padStart(2, "0")}:${(partes[5] || "00").padStart(2, "0")}`;
  }
  return String(fechaLatina);
}

function extraerFechaISO(fechaLatina) {
  if (!fechaLatina) return "";
  const datePart = String(fechaLatina).split(" ")[0];
  const parts = datePart.split("/");
  if (parts.length !== 3) return "";
  return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
}

function cumpleRangoFechas(fechaLatina) {
  const { fechaDesde, fechaHasta } = AppState.filtrosGlobales;
  if (!fechaDesde && !fechaHasta) return true;
  const iso = extraerFechaISO(fechaLatina);
  if (!iso) return false;
  if (fechaDesde && iso < fechaDesde) return false;
  if (fechaHasta && iso > fechaHasta) return false;
  return true;
}

function calcularHorasTranscurridas(fechaLatina) {
  if (!fechaLatina) return 0;
  const p = String(fechaLatina).split(/[ \/:-]+/);
  if (p.length < 3) return 0;
  const f = new Date(
    parseInt(p[2], 10),
    parseInt(p[1], 10) - 1,
    parseInt(p[0], 10),
    parseInt(p[3] || 0, 10),
    parseInt(p[4] || 0, 10)
  );
  return Math.max(0, Math.floor((Date.now() - f.getTime()) / 3600000));
}

function getBadgeSLA(fechaLatina) {
  const horas = calcularHorasTranscurridas(fechaLatina);
  if (horas >= 48) {
    const dias = Math.floor(horas / 24);
    return `<span class="ml-1.5 px-1.5 py-0.5 text-[10px] font-black rounded bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/30">+${dias}d</span>`;
  }
  if (horas >= 24) {
    return `<span class="ml-1.5 px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30">+24h</span>`;
  }
  return `<span class="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 dark:bg-gray-800 text-gray-500">${horas}h</span>`;
}

window.filtrarPorChoferKPI = function (nombreChofer) {
  const input = document.getElementById("inBuscarCargo");
  const select = document.getElementById("selFiltroColumna");
  if (input.value === nombreChofer) {
    input.value = "";
    select.value = "todos";
  } else {
    select.value = "choferNombre";
    input.value = nombreChofer;
  }
  renderizarCargosFiltrados();
};

function renderizarKPIsDescargos() {
  const container = document.getElementById("kpiDescargosContainer");
  const matContainer = document.getElementById("kpiMaterialesCalle");
  if (!container || !matContainer) return;

  let totalUnidadesCalle = 0;
  let totalM3Calle = 0;
  let viajesCriticos48h = 0;
  const deudaPorChofer = {};
  const deudaPorMaterialMap = new Map();

  const matCatalogMap = new Map(AppState.datos.materiales.map(m => [m.ID_MEMB, m]));

  AppState.cargosActivos.forEach(cargo => {
    const horas = calcularHorasTranscurridas(cargo.hora);
    if (horas >= 48) viajesCriticos48h++;

    let deudaViaje = 0;
    cargo.detalles.forEach(d => {
      const lleva = parseInt(d.LLEVA || 0, 10);
      const devuelve = parseInt(d.DEVUELVE || 0, 10);
      const deuda = (d.DEUDA !== undefined && d.DEUDA !== "") ? parseInt(d.DEUDA, 10) : (lleva - devuelve);

      if (deuda > 0) {
        deudaViaje += deuda;
        totalUnidadesCalle += deuda;

        const matId = d.MATERIAL || "OTRO";
        const matObj = matCatalogMap.get(matId);
        const m3Unit = matObj && matObj.M3 ? parseFloat(String(matObj.M3).replace(",", ".")) : 0;
        const matNombre = matObj ? matObj.DESCRIPCION : matId;

        totalM3Calle += (m3Unit * deuda);

        const actual = deudaPorMaterialMap.get(matId) || { id: matId, nombre: matNombre, cantidad: 0 };
        actual.cantidad += deuda;
        deudaPorMaterialMap.set(matId, actual);
      }
    });

    if (deudaViaje > 0) {
      const ch = cargo.choferNombre || "Desconocido";
      deudaPorChofer[ch] = (deudaPorChofer[ch] || 0) + deudaViaje;
    }
  });

  let topChofer = "Sin deuda";
  let topDeuda = 0;
  Object.entries(deudaPorChofer).forEach(([chofer, cant]) => {
    if (cant > topDeuda) { topDeuda = cant; topChofer = chofer; }
  });

  const { soloCriticosSLA, materialId: filtroMatActivo } = AppState.filtrosGlobales;
  const safeTopChoferAttr = topChofer.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  container.innerHTML = `
    <div class="bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 rounded-2xl p-4 shadow-sm">
      <p class="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Stock en Ruta</p>
      <div class="flex items-baseline justify-between mt-1">
        <span class="text-2xl font-black text-gray-900 dark:text-white">${totalUnidadesCalle.toLocaleString()} <span class="text-xs font-medium text-gray-500">und.</span></span>
        <span class="text-xs font-mono font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded">${totalM3Calle.toFixed(2)} m³</span>
      </div>
    </div>

    <div class="bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 rounded-2xl p-4 shadow-sm">
      <p class="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Viajes Activos</p>
      <div class="flex items-baseline justify-between mt-1">
        <span class="text-2xl font-black text-emerald-600 dark:text-emerald-400">${AppState.cargosActivos.length}</span>
        <span class="text-[11px] text-gray-500">Pendientes de retorno</span>
      </div>
    </div>

    <div onclick="toggleFiltroCriticosSLA()" title="Clic para filtrar viajes con +48h en ambas vistas" class="cursor-pointer transition-all rounded-2xl p-4 shadow-sm border ${soloCriticosSLA ? 'bg-red-100 dark:bg-red-900/40 border-red-500 ring-2 ring-red-500/40' : 'bg-gray-50 dark:bg-gray-900/70 border-gray-200 dark:border-gray-700/80 hover:border-red-400'}">
      <div class="flex justify-between items-center">
        <p class="text-[10px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400">Alerta SLA (+48h)</p>
        <span class="text-[10px] text-gray-400">${soloCriticosSLA ? 'Filtro activo ✕' : 'Filtrar'}</span>
      </div>
      <div class="flex items-baseline justify-between mt-1">
        <span class="text-2xl font-black ${viajesCriticos48h > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-200'}">${viajesCriticos48h}</span>
        <span class="text-[11px] text-gray-500">Retorno demorado</span>
      </div>
    </div>

    <div onclick="${topDeuda > 0 ? `filtrarPorChoferKPI('${safeTopChoferAttr}')` : ''}" title="Clic para filtrar este chofer" class="cursor-pointer bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 hover:border-pink-400 rounded-2xl p-4 shadow-sm transition-all">
      <p class="text-[10px] font-bold uppercase tracking-wider text-pink-600 dark:text-pink-400">Mayor Retención</p>
      <div class="flex items-baseline justify-between mt-1 gap-2">
        <span class="text-sm font-extrabold text-gray-900 dark:text-white truncate" title="${escapeHTML(topChofer)}">${escapeHTML(topChofer)}</span>
        <span class="text-xs font-black text-pink-600 dark:text-pink-400 shrink-0">${topDeuda} und.</span>
      </div>
    </div>
  `;

  if (deudaPorMaterialMap.size === 0) {
    matContainer.innerHTML = "";
  } else {
    const chipsHTML = Array.from(deudaPorMaterialMap.values()).map(item => {
      const isSelected = filtroMatActivo === item.id;
      const btnClasses = isSelected
        ? "bg-blue-600 text-white border-blue-600 ring-2 ring-blue-500/40 shadow-md"
        : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-blue-400";
      const badgeClasses = isSelected
        ? "text-white font-black"
        : "text-blue-600 dark:text-blue-400 font-bold";

      return `
        <button type="button" onclick="toggleFiltroMaterialGlobal('${escapeHTML(item.id)}')" title="Clic para filtrar por ${escapeHTML(item.nombre)} en Descargos e Histórico"
                class="inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-xl transition-all cursor-pointer shadow-sm active:scale-95 ${btnClasses}">
          <span class="truncate max-w-[190px]">${escapeHTML(item.nombre)}</span>
          <span class="font-mono ${badgeClasses}">${item.cantidad}</span>
          ${isSelected ? '<span class="ml-0.5 text-[10px]">✕</span>' : ''}
        </button>
      `;
    }).join("");

    matContainer.innerHTML = `<span class="text-[10px] font-bold uppercase text-gray-400 mr-1">En ruta (Filtrar):</span>` + chipsHTML;
  }
}

function renderizarCargosFiltrados() {
  renderizarKPIsDescargos();

  // Filtro maestro: solo viajes sin ningún retorno registrado
  let filtrados = AppState.cargosActivos.filter(esViajeSinRetorno);
  const searchTerm = (document.getElementById("inBuscarCargo")?.value || "").toLowerCase().trim();
  const filtroColumna = document.getElementById("selFiltroColumna")?.value || "todos";
  const { soloCriticosSLA, materialId } = AppState.filtrosGlobales;

  filtrados = filtrados.filter(c => cumpleRangoFechas(c.hora));

  if (soloCriticosSLA) {
    filtrados = filtrados.filter(c => calcularHorasTranscurridas(c.hora) >= 48);
  }

  if (materialId) {
    filtrados = filtrados.filter(c => c.detalles.some(d => d.MATERIAL === materialId && (parseInt(d.LLEVA || 0, 10) > 0)));
  }

  if (searchTerm) {
    filtrados = filtrados.filter((c) => {
      const valPlaca = String(c.placa || "").toLowerCase();
      const valChofer = String(c.choferNombre || "").toLowerCase();
      const valId = String(c.idCargo || "").toLowerCase();

      if (filtroColumna === "placa") return valPlaca.includes(searchTerm);
      if (filtroColumna === "choferNombre") return valChofer.includes(searchTerm);
      if (filtroColumna === "idCargo") return valId.includes(searchTerm);
      return valPlaca.includes(searchTerm) || valChofer.includes(searchTerm) || valId.includes(searchTerm);
    });
  }

  const { key, asc } = AppState.sortConfig;
  filtrados.sort((a, b) => {
    const sortKey = key === "hora" || key === "fecha" ? "_horaSort" : key;
    let valA = String(a[sortKey] || "").toLowerCase();
    let valB = String(b[sortKey] || "").toLowerCase();
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
  });

  renderizarTablaUI(filtrados);
}

function renderizarTablaUI(cargos) {
  const grid = document.getElementById("gridCargos");
  if (!grid) return;

  if (!cargos || cargos.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 py-8 font-bold bg-white dark:bg-gray-800/40 rounded-2xl border border-gray-200 dark:border-gray-700/50 mx-4 md:mx-0">No se encontraron viajes pendientes.</div>`;
    return;
  }

  let html = `
    <div class="overflow-x-auto no-scrollbar md:rounded-xl border-y md:border border-gray-200 dark:border-gray-700/80 shadow-sm dark:shadow-inner">
      <table class="min-w-max w-full text-left text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
        <thead class="bg-gray-100 dark:bg-gray-900/80 text-xs uppercase text-gray-500 dark:text-gray-400 select-none border-b border-gray-200 dark:border-gray-700">
          <tr>
            <th class="px-4 py-4 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setSort('idCargo')">ID Cargo ${getSortIcon("idCargo")}</th>
            <th class="px-4 py-4 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setSort('placa')">Placa ${getSortIcon("placa")}</th>
            <th class="px-4 py-4 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setSort('choferNombre')">Chofer ${getSortIcon("choferNombre")}</th>
            <th class="px-4 py-4 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setSort('fecha')">Hora Salida / SLA ${getSortIcon("hora")}</th>
            <th class="px-4 py-4 text-center">Estado</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-800/60 bg-white dark:bg-transparent">
  `;

  cargos.forEach((cargo) => {
    let totalDeuda = 0;
    cargo.detalles.forEach((d) => {
      const lleva = parseInt(d.LLEVA || 0, 10);
      const devuelve = parseInt(d.DEVUELVE || 0, 10);
      totalDeuda += parseInt(d.DEUDA !== undefined && d.DEUDA !== "" ? d.DEUDA : lleva - devuelve, 10);
    });

    const horaSalida = cargo.hora || "--/--/---- --:--:--";
    const isLocal = String(cargo.idCargo).startsWith("LOC-");
    const safeId = escapeHTML(cargo.idCargo);
    let badgeEstadoHTML = "";

    if (totalDeuda > 0) {
      badgeEstadoHTML = `<span class="bg-pink-50 dark:bg-pink-600/20 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-500/30 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 justify-center w-fit mx-auto shadow-sm">
        <span class="w-1.5 h-1.5 rounded-full bg-pink-500 animate-pulse"></span>Debe ${totalDeuda}
      </span>`;
    } else if (totalDeuda < 0) {
      badgeEstadoHTML = `<span class="bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 justify-center w-fit mx-auto">
        Excedente: ${Math.abs(totalDeuda)}
      </span>`;
    } else {
      badgeEstadoHTML = `<span class="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30 px-3 py-1 rounded-full text-xs font-bold flex items-center justify-center w-fit mx-auto">
        Completado
      </span>`;
    }

    html += `
      <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors group cursor-pointer" onclick="abrirDetalle('${safeId}')" title="Clic para ver detalles, liquidar o imprimir">
        <td class="px-4 py-3 font-mono text-xs flex items-center gap-1.5 ${isLocal ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-500 dark:text-gray-400'}">
          ${isLocal ? `<span class="w-2 h-2 rounded-full bg-blue-500 animate-ping" title="Pendiente de sincronización"></span>` : ''}
          ${safeId}
        </td>
        <td class="px-4 py-3"><span class="bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/50 px-2 py-1 rounded text-xs font-bold">${escapeHTML(cargo.placa || "S/N")}</span></td>
        <td class="px-4 py-3 font-bold text-gray-800 dark:text-gray-200 truncate max-w-[200px]">${escapeHTML(cargo.choferNombre)}</td>
        <td class="px-4 py-3 text-emerald-600 dark:text-emerald-400/80 font-mono text-xs tracking-wider">${escapeHTML(horaSalida)}${getBadgeSLA(horaSalida)}</td>
        <td class="px-4 py-3 text-center align-middle">${badgeEstadoHTML}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  grid.innerHTML = html;
}

// ==========================================
// 10. MODAL DETALLE, EXCEDENTES AUTOMÁTICOS, AÑADIR, EDITAR Y ELIMINAR
// ==========================================
const FALLBACK_TRUCK_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 450'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%231e293b'/%3E%3Cstop offset='100%25' stop-color='%230f172a'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='450' fill='url(%23g)'/%3E%3Cg transform='translate(280,115)' fill='none' stroke='%2338bdf8' stroke-width='10' stroke-linecap='round' stroke-linejoin='round' opacity='0.35'%3E%3Crect x='10' y='30' width='140' height='100' rx='10'/%3E%3Cpath d='M150 65h45l30 35v30h-75z'/%3E%3Ccircle cx='55' cy='145' r='22'/%3E%3Ccircle cx='185' cy='145' r='22'/%3E%3C/g%3E%3C/svg%3E";

function resolverUrlImagenVehiculo(rawUrl) {
  if (!rawUrl) return FALLBACK_TRUCK_SVG;
  const url = String(rawUrl).trim();
  if (!url) return FALLBACK_TRUCK_SVG;

  const matchId = url.match(/(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,})/);
  if (matchId && matchId[1]) {
    return `https://lh3.googleusercontent.com/d/${matchId[1]}=w800`;
  }
  return url;
}

window.togglePanelExtraModal = function () {
  const panel = document.getElementById("panelAddExtraModal");
  if (!panel) return;
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    document.getElementById("inExtraDestino")?.focus();
  }
};

window.autocompletarDevolucionTotal = function () {
  const inputs = document.querySelectorAll(".mdl-return-input:not([disabled])");
  if (inputs.length === 0) return;

  inputs.forEach((input) => {
    const deuda = parseInt(input.getAttribute("data-deuda") || "0", 10);
    if (deuda > 0) {
      input.value = deuda;
      input.dataset.splitAccepted = "false";
    }
  });
  document.querySelectorAll('[id^="excedente-alert-"]').forEach(el => {
    el.classList.add("hidden");
    el.innerHTML = "";
  });
  mostrarToast("Deuda completa autocompletada al 100%.");
};

window.evaluarExcedenteDetalle = function (idDetalle, rawValue) {
  const siblings = document.querySelectorAll(`.mdl-return-input[data-id="${idDetalle}"]`);
  if (siblings.length === 0) return;

  const refInput = siblings[0];
  const lleva = parseInt(refInput.getAttribute("data-lleva") || "0", 10);
  const maxDeuda = parseInt(refInput.getAttribute("data-deuda") || "0", 10);
  const materialName = escapeHTML(refInput.getAttribute("data-material-name") || "Material");
  const destinoName = escapeHTML(refInput.getAttribute("data-destino-name") || "Destino");
  const val = parseInt(String(rawValue || "").trim(), 10);

  const boxDesktop = document.getElementById(`excedente-alert-desk-${idDetalle}`);
  const boxMobile = document.getElementById(`excedente-alert-mob-${idDetalle}`);

  if (!isNaN(val) && val > maxDeuda && lleva > 0) {
    const diferencia = val - maxDeuda;
    const isAccepted = refInput.dataset.splitAccepted === "true";

    const bannerHTML = isAccepted
      ? `
        <div class="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-700/70 text-xs text-emerald-900 dark:text-emerald-200 flex flex-wrap items-center justify-between gap-2 shadow-sm">
          <div class="flex items-center gap-2">
            <span class="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[11px] font-black shrink-0">✓</span>
            <span>
              <strong>Desdoblamiento activo:</strong> Se liquidan <b>${maxDeuda} und.</b> exactas en esta línea y se creará una fila nueva con <b>+${diferencia} und.</b> (${materialName} → ${destinoName}).
            </span>
          </div>
          <button type="button" onclick="toggleAceptarExcedente('${escapeHTML(idDetalle)}', false)"
            class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-white dark:bg-gray-900 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 shrink-0 transition-colors">
            Deshacer
          </button>
        </div>
      `
      : `
        <div class="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-600/60 text-xs text-amber-950 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-sm">
          <div class="leading-snug">
            <span class="font-black text-amber-700 dark:text-amber-400">⚠️ Excedente de +${diferencia} und. (Deuda: ${maxDeuda}):</span>
            ¿Dejar esta línea exacta en <b>${lleva}</b> y registrar <b>+${diferencia}</b> en una fila nueva de devolución (<b>${materialName}</b> • ${destinoName})?
          </div>
          <button type="button" onclick="toggleAceptarExcedente('${escapeHTML(idDetalle)}', true)"
            class="px-3 py-1.5 text-xs font-extrabold rounded-xl bg-amber-600 hover:bg-amber-500 text-white shadow-md shrink-0 transition-all active:scale-95">
            Sí, crear fila (+${diferencia})
          </button>
        </div>
      `;

    if (boxDesktop) {
      boxDesktop.classList.remove("hidden");
      boxDesktop.innerHTML = bannerHTML;
    }
    if (boxMobile) {
      boxMobile.classList.remove("hidden");
      boxMobile.innerHTML = bannerHTML;
    }
  } else {
    siblings.forEach(inp => { inp.dataset.splitAccepted = "false"; });
    if (boxDesktop) { boxDesktop.classList.add("hidden"); boxDesktop.innerHTML = ""; }
    if (boxMobile) { boxMobile.classList.add("hidden"); boxMobile.innerHTML = ""; }
  }
};

window.toggleAceptarExcedente = function (idDetalle, aceptar) {
  const siblings = document.querySelectorAll(`.mdl-return-input[data-id="${idDetalle}"]`);
  if (siblings.length === 0) return;

  siblings.forEach(inp => {
    inp.dataset.splitAccepted = aceptar ? "true" : "false";
  });

  evaluarExcedenteDetalle(idDetalle, siblings[0].value);
  if (aceptar) {
    mostrarToast("Excedente programado en nueva fila de devolución.");
  }
};

// 10.1 AÑADIR MATERIAL NO LISTADO A UN CARGO EXISTENTE (OPTIMISTIC UI)
document.getElementById("btnGuardarExtraModal")?.addEventListener("click", async () => {
  if (!cargoActualModalId) return;
  if (String(cargoActualModalId).startsWith("LOC-")) {
    return mostrarAlerta("Espera unos segundos a que el cargo obtenga su código oficial GCM antes de añadir líneas.", "warning", "Sincronizando");
  }

  const destinoId = cleanId(document.getElementById("hdExtraDestino").value);
  const materialId = cleanId(document.getElementById("hdExtraMaterial").value);
  const tipoMov = document.getElementById("selExtraTipo").value;
  const cantidad = parseInt(document.getElementById("inExtraCantidad").value, 10);

  if (!destinoId) return mostrarAlerta("Selecciona un DESTINO válido.", "warning", "Falta Destino");
  if (!materialId) return mostrarAlerta("Selecciona un MATERIAL válido.", "warning", "Falta Material");
  if (isNaN(cantidad) || cantidad <= 0) return mostrarAlerta("Ingresa una CANTIDAD mayor a 0.", "warning", "Cantidad Inválida");

  const lleva = tipoMov === "LLEVA" ? cantidad : 0;
  const devuelve = tipoMov === "DEVUELVE" ? cantidad : 0;
  const deuda = lleva - devuelve;
  const idDetalleTemp = `LOC-DET-${Date.now().toString(36).toUpperCase()}`;

  let cargo = AppState.cargosActivos.find(c => c.idCargo === cargoActualModalId);
  let responsableId = "";

  if (!cargo) {
    const lineasHist = AppState.historial.filter(h => h.idCargo === cargoActualModalId);
    if (lineasHist.length > 0) {
      const ref = lineasHist[0];
      responsableId = cleanId(ref.chofer);
      const choferObj = AppState.datos.choferes.find(c => cleanId(c.ID_CHFR) === responsableId);
      cargo = {
        idCargo: ref.idCargo,
        choferId: responsableId,
        choferNombre: choferObj ? choferObj.NOMBRE : (responsableId || "Desconocido"),
        placa: ref.placa || "S/N",
        hora: ref.horaCargo || "--",
        _horaSort: estandarizarFecha(ref.horaCargo),
        gestor: ref.gestorCargo || "No registrado",
        detalles: lineasHist.map(h => ({
          ID_DETALLE: h.idDetalle,
          LLEVA: h.lleva,
          DEVUELVE: h.devuelve,
          DEUDA: h.deuda,
          DESTINO: h.destino,
          MATERIAL: h.material,
          EMISOR: h.emisor,
          RESPONSABLE: responsableId
        }))
      };
      if (deuda > 0) {
        AppState.cargosActivos.unshift(cargo);
      }
    }
  } else {
    responsableId = cleanId(cargo.choferId || cargo.detalles[0]?.RESPONSABLE);
  }

  const emisorActual = cargo?.detalles[0]?.EMISOR || "Almacén PT";
  const nuevoDetalle = {
    ID_DETALLE: idDetalleTemp,
    LLEVA: lleva,
    DEVUELVE: devuelve,
    DEUDA: deuda,
    DESTINO: destinoId,
    MATERIAL: materialId,
    EMISOR: emisorActual,
    RESPONSABLE: responsableId
  };

  if (cargo) {
    cargo.detalles.push(nuevoDetalle);
    // Si todo quedó cerrado (deuda <= 0 en todas las líneas), asegurar que no permanezca en Viajes Pendientes
    const quedaPendiente = cargo.detalles.some(d => parseInt(d.DEUDA || 0, 10) > 0);
    if (!quedaPendiente) {
      AppState.cargosActivos = AppState.cargosActivos.filter(c => c.idCargo !== cargoActualModalId);
    }
    await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);
  }

  const fechaFormat = formatFechaLimaLocal();
  AppState.historial.unshift({
    idCargo: cargoActualModalId,
    idDetalle: idDetalleTemp,
    material: materialId,
    destino: destinoId,
    emisor: emisorActual,
    lleva,
    devuelve,
    deuda,
    estado: deuda > 0 ? 'Pendiente' : (deuda < 0 ? 'Excedente' : 'Devolución completa'),
    horaCargo: cargo?.hora || fechaFormat,
    gestorCargo: cargo?.gestor || (AppState.user ? AppState.user.nombre : 'Operador'),
    horaDescargo: devuelve > 0 ? fechaFormat : '',
    gestorDescargo: devuelve > 0 ? (AppState.user ? AppState.user.nombre : 'Operador') : '',
    chofer: responsableId,
    placa: cargo?.placa || 'S/N'
  });
  await SyncEngine.saveCache('historial', AppState.historial);

  await SyncEngine.enqueueMutation('addDetalleCargo', {
    data: {
      idCargo: cargoActualModalId,
      localDetalleRef: idDetalleTemp,
      destino: destinoId,
      material: materialId,
      lleva,
      devuelve,
      emisor: emisorActual,
      responsable: responsableId,
      gestorNombre: AppState.user ? AppState.user.nombre : 'Operador',
      gestorRol: AuthRules.currentUserRole()
    }
  });

  ["inExtraDestino", "hdExtraDestino", "inExtraMaterial", "hdExtraMaterial", "inExtraCantidad"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("panelAddExtraModal").classList.add("hidden");

  mostrarToast("Material añadido al cargo. Sincronizando...");
  abrirDetalle(cargoActualModalId, materialId);
  renderizarCargosFiltrados();
  if (!document.getElementById('viewHistorico').classList.contains('hidden')) renderizarHistorico();
});

// 10.2 CORREGIR CANTIDADES ERRADAS DE UNA LÍNEA (GenDialog)
window.corregirLineaDetalle = async function (idCargo, idDetalle, llevaActual, devuelveActual) {
  if (String(idDetalle).startsWith("LOC-")) {
    return mostrarAlerta("Espera unos segundos a que esta línea termine de sincronizarse con la nube.", "warning", "Sincronizando");
  }

  const resultado = await GenDialog.editQuantities({
    idDetalle,
    llevaActual,
    devuelveActual
  });

  if (!resultado) return;

  const { lleva: nuevoLleva, devuelve: nuevoDevuelve } = resultado;
  const nuevaDeuda = nuevoLleva - nuevoDevuelve;

 let cargoIdx = AppState.cargosActivos.findIndex(c => c.idCargo === idCargo);
  if (cargoIdx !== -1) {
    const det = AppState.cargosActivos[cargoIdx].detalles.find(d => d.ID_DETALLE === idDetalle);
    if (det) {
      det.LLEVA = nuevoLleva;
      det.DEVUELVE = nuevoDevuelve;
      det.DEUDA = nuevaDeuda;
    }
    if (!esViajeSinRetorno(AppState.cargosActivos[cargoIdx])) {
      AppState.cargosActivos.splice(cargoIdx, 1);
    }
    await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);
  } else {
    const lineasHist = AppState.historial.filter(h => h.idCargo === idCargo);
    if (lineasHist.length > 0) {
      const ref = lineasHist[0];
      const respId = cleanId(ref.chofer);
      const choferObj = AppState.datos.choferes.find(c => cleanId(c.ID_CHFR) === respId);
      const cargoReconstruido = {
        idCargo: ref.idCargo,
        choferId: respId,
        choferNombre: choferObj ? choferObj.NOMBRE : (respId || "Desconocido"),
        placa: ref.placa || "S/N",
        hora: ref.horaCargo || "--",
        _horaSort: estandarizarFecha(ref.horaCargo),
        gestor: ref.gestorCargo || "No registrado",
        detalles: lineasHist.map(h => ({
          ID_DETALLE: h.idDetalle,
          LLEVA: h.idDetalle === idDetalle ? nuevoLleva : h.lleva,
          DEVUELVE: h.idDetalle === idDetalle ? nuevoDevuelve : h.devuelve,
          DEUDA: h.idDetalle === idDetalle ? nuevaDeuda : h.deuda,
          DESTINO: h.destino,
          MATERIAL: h.material,
          EMISOR: h.emisor,
          RESPONSABLE: respId
        }))
      };
      if (esViajeSinRetorno(cargoReconstruido)) {
        AppState.cargosActivos.unshift(cargoReconstruido);
        await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);
      }
    }
  }

  const histItem = AppState.historial.find(h => h.idDetalle === idDetalle);
  if (histItem) {
    histItem.lleva = nuevoLleva;
    histItem.devuelve = nuevoDevuelve;
    histItem.deuda = nuevaDeuda;
    histItem.estado = nuevaDeuda > 0 ? "Pendiente" : (nuevaDeuda < 0 ? "Excedente" : "Devolución completa");
    await SyncEngine.saveCache('historial', AppState.historial);
  }

  await SyncEngine.enqueueMutation('editDetalleCargo', {
    data: {
      idCargo,
      idDetalle,
      lleva: nuevoLleva,
      devuelve: nuevoDevuelve,
      gestorNombre: AppState.user ? AppState.user.nombre : 'Operador',
      gestorRol: AuthRules.currentUserRole()
    }
  });

  mostrarToast(`Registro ${idDetalle} corregido.`);
  abrirDetalle(idCargo);
  renderizarCargosFiltrados();
  if (!document.getElementById('viewHistorico').classList.contains('hidden')) renderizarHistorico();
};

// 10.3 ELIMINAR LÍNEA ERRADA O CARGO COMPLETO (GenDialog)
window.eliminarLineaDetalle = async function (idCargo, idDetalle, nombreMaterial) {
  if (String(idDetalle).startsWith("LOC-")) {
    return mostrarAlerta("Espera unos segundos a que la línea se sincronice antes de eliminarla.", "warning", "Sincronizando");
  }

  const confirmado = await GenDialog.confirm({
    badge: 'Eliminar Ítem',
    title: `¿Eliminar "${nombreMaterial}"?`,
    message: `Se removerá la línea <strong class="font-mono text-gray-900 dark:text-white">${escapeHTML(idDetalle)}</strong> del cargo <strong class="font-mono text-gray-900 dark:text-white">${escapeHTML(idCargo)}</strong> y se recalculará el saldo en Google Sheets.`,
    confirmText: 'Sí, eliminar ítem',
    variant: 'danger'
  });

  if (!confirmado) return;

  let cargoVacio = false;
  const cargoIdx = AppState.cargosActivos.findIndex(c => c.idCargo === idCargo);
  if (cargoIdx !== -1) {
    AppState.cargosActivos[cargoIdx].detalles = AppState.cargosActivos[cargoIdx].detalles.filter(d => d.ID_DETALLE !== idDetalle);
    if (AppState.cargosActivos[cargoIdx].detalles.length === 0) {
      AppState.cargosActivos.splice(cargoIdx, 1);
      cargoVacio = true;
    } else {
      const tieneSaldo = AppState.cargosActivos[cargoIdx].detalles.some(d => parseInt(d.DEUDA || 0, 10) > 0);
      if (!tieneSaldo) AppState.cargosActivos.splice(cargoIdx, 1);
    }
    await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);
  }

  AppState.historial = AppState.historial.filter(h => h.idDetalle !== idDetalle);
  await SyncEngine.saveCache('historial', AppState.historial);

  if (AppState.historial.filter(h => h.idCargo === idCargo).length === 0) {
    cargoVacio = true;
  }

  await SyncEngine.enqueueMutation('deleteDetalleCargo', {
    data: {
      idCargo,
      idDetalle,
      gestorNombre: AppState.user ? AppState.user.nombre : 'Operador',
      gestorRol: AuthRules.currentUserRole()
    }
  });

  mostrarToast(`Ítem eliminado del cargo ${idCargo}.`);
  if (cargoVacio) {
    cerrarDetalle();
  } else if (document.getElementById("modalDetalle") && !document.getElementById("modalDetalle").classList.contains("hidden")) {
    abrirDetalle(idCargo);
  }
  renderizarCargosFiltrados();
  if (!document.getElementById('viewHistorico').classList.contains('hidden')) renderizarHistorico();
};

window.eliminarCargoCompleto = async function (idCargo) {
  if (String(idCargo).startsWith("LOC-")) {
    return mostrarAlerta("El cargo aún se está subiendo a la nube. Espera unos segundos.", "warning", "Sincronizando");
  }

  const confirmado = await GenDialog.confirm({
    badge: 'Acción Destructiva',
    title: `¿Eliminar por completo el cargo ${idCargo}?`,
    message: 'Esta operación eliminará permanentemente la cabecera y <strong>todos los materiales asociados</strong> en la base de datos de Google Sheets.',
    confirmText: 'Eliminar Cargo Completo',
    variant: 'danger'
  });

  if (!confirmado) return;

  AppState.cargosActivos = AppState.cargosActivos.filter(c => c.idCargo !== idCargo);
  AppState.historial = AppState.historial.filter(h => h.idCargo !== idCargo);

  await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);
  await SyncEngine.saveCache('historial', AppState.historial);

  await SyncEngine.enqueueMutation('deleteCargo', {
    data: {
      idCargo,
      gestorNombre: AppState.user ? AppState.user.nombre : 'Operador',
      gestorRol: AuthRules.currentUserRole()
    }
  });

  cerrarDetalle();
  renderizarCargosFiltrados();
  if (!document.getElementById('viewHistorico').classList.contains('hidden')) renderizarHistorico();
  mostrarToast(`Cargo ${idCargo} eliminado correctamente.`);
};

function abrirDetalle(idCargo, highlightMaterialId = null) {
  let cargo = AppState.cargosActivos.find((c) => c.idCargo === idCargo);

  if (!cargo) {
    const lineasHistorico = AppState.historial.filter((h) => h.idCargo === idCargo);
    if (lineasHistorico.length === 0) return;

    const ref = lineasHistorico[0];
    const idChoferLimpio = cleanId(ref.chofer);
    const choferObj = AppState.datos.choferes.find((c) => cleanId(c.ID_CHFR) === idChoferLimpio);

    cargo = {
      idCargo: ref.idCargo,
      choferId: idChoferLimpio,
      choferNombre: choferObj ? choferObj.NOMBRE : (idChoferLimpio || "Desconocido"),
      placa: ref.placa || "S/N",
      hora: ref.horaCargo || "--",
      gestor: ref.gestorCargo || "No registrado",
      detalles: lineasHistorico.map((h) => ({
        ID_DETALLE: h.idDetalle,
        LLEVA: h.lleva,
        DEVUELVE: h.devuelve,
        DEUDA: h.deuda,
        DESTINO: h.destino,
        MATERIAL: h.material,
        EMISOR: h.emisor,
        'GESTOR CARGO': h.gestorCargo,
        RESPONSABLE: idChoferLimpio
      }))
    };
  }

  cargoActualModalId = cargo.idCargo;
  const btnDelCargo = document.getElementById("btnEliminarCargoModal");
  if (btnDelCargo) {
    const puedeBorrarCargo = AuthRules.canDeleteCargo(cargo);
    btnDelCargo.classList.toggle("hidden", !puedeBorrarCargo);
    btnDelCargo.onclick = puedeBorrarCargo ? () => eliminarCargoCompleto(cargo.idCargo) : null;
  }

  const selExtraTipo = document.getElementById("selExtraTipo");
  if (selExtraTipo) {
    const optLleva = selExtraTipo.querySelector('option[value="LLEVA"]');
    if (optLleva) {
      const puedeAgregarSalida = AuthRules.canAddSalidaExtra(cargo);
      optLleva.disabled = !puedeAgregarSalida;
      if (!puedeAgregarSalida) selExtraTipo.value = "DEVUELVE";
    }
  }

  document.getElementById("panelAddExtraModal")?.classList.add("hidden");

  let totalMaterialesLlevados = 0, totalDeudaViaje = 0, totalM3Llevado = 0;
  const destinosSet = new Set(), resumenTipos = {};

  const detallesProcesados = cargo.detalles.map((d) => {
    const lleva = parseInt(d.LLEVA || 0, 10), devuelve = parseInt(d.DEVUELVE || 0, 10);
    const deuda = parseInt(d.DEUDA !== undefined && d.DEUDA !== "" ? d.DEUDA : lleva - devuelve, 10);
    const destinoCat = AppState.datos.destinos.find((x) => cleanId(x.ID_DSTN) === cleanId(d.DESTINO));
    const materialCat = AppState.datos.materiales.find((m) => cleanId(m.ID_MEMB) === cleanId(d.MATERIAL));
    const m3Llevado = (materialCat && materialCat.M3 ? parseFloat(String(materialCat.M3).replace(",", ".")) : 0) * lleva;
    return {
      ...d,
      lleva,
      devuelve,
      deuda,
      nombreDestino: destinoCat ? destinoCat.REFERENCIA : d.DESTINO || "Desconocido",
      nombreMaterial: materialCat ? materialCat.DESCRIPCION : d.MATERIAL || "Desconocido",
      m3Llevado
    };
  });

  detallesProcesados.forEach((d) => {
    totalMaterialesLlevados += d.lleva; totalDeudaViaje += d.deuda; totalM3Llevado += d.m3Llevado;
    destinosSet.add(d.nombreDestino);
    resumenTipos[d.nombreMaterial] = (resumenTipos[d.nombreMaterial] || 0) + d.lleva;
  });

  document.getElementById("mdlTitleCargo").textContent = cargo.idCargo;
  document.getElementById("mdlChofer").textContent = cargo.choferNombre;
  document.getElementById("mdlHora").textContent = cargo.hora || "--";

  const areaRaw = cargo.detalles[0]?.EMISOR || cargo.area || "Almacén PT";
  const areaCat = AppState.datos.destinos.find((x) => cleanId(x.ID_DSTN) === cleanId(areaRaw));
  document.getElementById("mdlDespacho").textContent = areaCat ? areaCat.REFERENCIA : areaRaw;
  document.getElementById("mdlGestor").textContent = cargo.gestor || "No registrado";

  const vehiculoObj = AppState.datos.vehiculos.find(v => cleanId(v.PLACA) === cleanId(cargo.placa));
  const imgEl = document.getElementById("imgVehiculoModal");
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = FALLBACK_TRUCK_SVG; };
  imgEl.src = resolverUrlImagenVehiculo(vehiculoObj?.FOTO_VEHICULO);

  document.getElementById("mdlPlaca").textContent = vehiculoObj ? vehiculoObj.DISPLAY_NAME : cargo.placa || "S/N";

  const mdlBadge = document.getElementById("mdlBadgeDeuda");
  if (totalDeudaViaje > 0) {
    mdlBadge.innerHTML = `<span class="bg-pink-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 w-fit shadow-lg"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Debe ${totalDeudaViaje} materiales</span>`;
  } else if (totalDeudaViaje < 0) {
    mdlBadge.innerHTML = `<span class="bg-amber-500 text-white font-bold px-3 py-1.5 rounded-lg text-xs w-fit shadow-lg">Excedente: ${Math.abs(totalDeudaViaje)}</span>`;
  } else {
    mdlBadge.innerHTML = `<span class="bg-emerald-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs w-fit shadow-lg">Completado / Sin deuda</span>`;
  }

  document.getElementById("mdlDestinosCount").textContent = `(${destinosSet.size})`;
  document.getElementById("mdlDestinosList").innerHTML = Array.from(destinosSet).map((dest) => `<div class="truncate" title="${escapeHTML(dest)}">${escapeHTML(dest)}</div>`).join("");
  document.getElementById("mdlTiposCount").textContent = `(${Object.keys(resumenTipos).length})`;
  document.getElementById("mdlTiposList").innerHTML = Object.keys(resumenTipos).map((tipo) => `<div class="flex justify-between gap-2"><span class="truncate" title="${escapeHTML(tipo)}">${escapeHTML(tipo)}</span><span class="text-emerald-600 dark:text-emerald-400 font-bold shrink-0">${resumenTipos[tipo]}</span></div>`).join("");

  const totalEl = document.getElementById("mdlTotalMateriales");
  if (totalEl) {
    totalEl.innerHTML = `
      <span class="bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white px-2.5 py-0.5 rounded-lg text-sm font-black">${totalMaterialesLlevados} und.</span>
      <span class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-600 text-emerald-600 dark:text-emerald-400 font-mono px-2.5 py-0.5 rounded-lg text-xs font-bold shadow-sm">
        ${totalM3Llevado.toFixed(3)} m³
      </span>
    `;
  }

  // 1. Renderizado Tabla Escritorio (Desktop)
  const tablaHTML = detallesProcesados.map((det) => {
    const safeJsName = det.nombreMaterial.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const safeMatAttr = escapeHTML(det.nombreMaterial);
    const safeDestAttr = escapeHTML(det.nombreDestino);
    const safeDetId = escapeHTML(det.ID_DETALLE);
    const safeCargoId = escapeHTML(cargo.idCargo);
    const puedeEditarFila = AuthRules.canModifyLinea(cargo, det);

    const botonesAccionDesktop = puedeEditarFila ? `
      <div class="flex items-center gap-1 shrink-0">
        <button type="button" onclick="corregirLineaDetalle('${safeCargoId}', '${safeDetId}', ${det.lleva}, ${det.devuelve})"
          title="Corregir cantidades (Lleva / Devuelto)"
          class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
        </button>
        <button type="button" onclick="eliminarLineaDetalle('${safeCargoId}', '${safeDetId}', '${escapeHTML(safeJsName)}')"
          title="Eliminar línea"
          class="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>` : `
      <span class="text-[10px] text-gray-400 dark:text-gray-500 font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800/80 shrink-0 select-none"
        title="Bloqueado: Solo el emisor original (sin retornos) o un Administrador puede modificar esta línea">🔒</span>`;

    return `
      <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${det.deuda <= 0 ? "opacity-75 bg-gray-50/70 dark:bg-gray-900/30" : ""} ${det.MATERIAL === highlightMaterialId ? "bg-blue-50/80 dark:bg-blue-900/25 ring-1 ring-inset ring-blue-500/40" : ""}">
        <td class="px-4 py-3.5 text-gray-600 dark:text-gray-400 font-medium">${safeDestAttr}</td>
        <td class="px-4 py-3.5">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="${det.deuda <= 0 ? "text-gray-600 dark:text-gray-400" : "text-gray-900 dark:text-gray-100"} font-bold">${safeMatAttr}</div>
              <div class="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono mt-0.5">Vol: ${det.m3Llevado.toFixed(3)} m³</div>
            </div>
            ${botonesAccionDesktop}
          </div>
        </td>
        <td class="px-4 py-3.5">
          <div class="flex items-center justify-center gap-3 text-xs bg-gray-50 dark:bg-gray-800/80 rounded-xl p-2 border border-gray-200 dark:border-gray-700 w-max mx-auto">
            <div class="flex flex-col items-center px-1"><span class="text-[9px] text-gray-500 uppercase font-bold">Lleva</span><span class="text-gray-900 dark:text-white font-black text-sm">${det.lleva}</span></div>
            <div class="w-px h-6 bg-gray-200 dark:bg-gray-700"></div>
            <div class="flex flex-col items-center px-1"><span class="text-[9px] text-gray-500 uppercase font-bold">Devuelto</span><span class="text-emerald-600 dark:text-emerald-400 font-black text-sm">${det.devuelve}</span></div>
            <div class="w-px h-6 bg-gray-200 dark:bg-gray-700"></div>
            <div class="flex flex-col items-center px-1"><span class="text-[9px] text-gray-500 uppercase font-bold">Deuda</span><span class="${det.deuda > 0 ? "text-red-600 dark:text-red-400" : det.deuda < 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-500"} font-black text-sm">${det.deuda}</span></div>
          </div>
        </td>
        <td class="px-4 py-3.5 w-32">
          <input type="number" min="0" inputmode="numeric"
                 data-id="${safeDetId}"
                 data-lleva="${det.lleva}"
                 data-deuda="${det.deuda}"
                 data-material-name="${safeMatAttr}"
                 data-destino-name="${safeDestAttr}"
                 data-split-accepted="false"
                 placeholder="${det.deuda <= 0 ? "-" : "0"}" 
                 class="w-full bg-white dark:bg-gray-950 border-2 border-gray-300 dark:border-gray-700 rounded-xl p-2 text-center text-base text-emerald-600 dark:text-emerald-400 font-black focus:border-emerald-500 outline-none mdl-return-input mdl-input-desktop transition-colors disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:opacity-50"
                 ${det.deuda <= 0 ? "disabled" : ""}>
        </td>
      </tr>
      <tr class="border-0">
        <td colspan="4" class="p-0">
          <div id="excedente-alert-desk-${safeDetId}" class="hidden px-4 pb-3"></div>
        </td>
      </tr>
    `;
  }).join("");
  document.getElementById("mdlTablaMateriales").innerHTML = tablaHTML;

  // 2. Renderizado Tarjetas Táctiles (Móvil)
  const cardsMobileHTML = detallesProcesados.map((det) => {
    const safeJsName = det.nombreMaterial.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const safeMatAttr = escapeHTML(det.nombreMaterial);
    const safeDestAttr = escapeHTML(det.nombreDestino);
    const safeDetId = escapeHTML(det.ID_DETALLE);
    const safeCargoId = escapeHTML(cargo.idCargo);
    const puedeEditarFila = AuthRules.canModifyLinea(cargo, det);

    const botonesAccionMobile = puedeEditarFila ? `
      <div class="flex items-center gap-1 shrink-0">
        <button type="button" onclick="corregirLineaDetalle('${safeCargoId}', '${safeDetId}', ${det.lleva}, ${det.devuelve})"
          class="p-1.5 text-gray-500 hover:text-blue-600 bg-gray-100 dark:bg-gray-800 rounded-lg">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
        </button>
        <button type="button" onclick="eliminarLineaDetalle('${safeCargoId}', '${safeDetId}', '${escapeHTML(safeJsName)}')"
          class="p-1.5 text-gray-500 hover:text-red-600 bg-gray-100 dark:bg-gray-800 rounded-lg">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>` : `
      <span class="text-[10px] text-gray-400 dark:text-gray-500 font-mono px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 shrink-0 select-none">🔒</span>`;

    return `
      <div class="pt-3 first:pt-0 ${det.deuda <= 0 ? "opacity-75" : ""}">
        <div class="flex justify-between items-start gap-2 mb-2">
          <div>
            <span class="text-[10px] font-bold uppercase text-blue-600 dark:text-blue-400">${safeDestAttr}</span>
            <h5 class="text-sm font-bold text-gray-900 dark:text-white leading-snug">${safeMatAttr}</h5>
            <span class="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">${det.m3Llevado.toFixed(3)} m³</span>
          </div>
          ${botonesAccionMobile}
        </div>
        <div class="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800/70 p-2.5 rounded-xl border border-gray-200 dark:border-gray-700">
          <div class="flex items-center gap-3 text-xs">
            <div><span class="text-[9px] text-gray-500 block uppercase">Lleva</span><strong class="text-gray-900 dark:text-white text-sm">${det.lleva}</strong></div>
            <div><span class="text-[9px] text-gray-500 block uppercase">Dev.</span><strong class="text-emerald-600 dark:text-emerald-400 text-sm">${det.devuelve}</strong></div>
            <div><span class="text-[9px] text-gray-500 block uppercase">Deuda</span><strong class="${det.deuda > 0 ? "text-red-600 dark:text-red-400" : det.deuda < 0 ? "text-amber-600" : "text-gray-500"} text-sm">${det.deuda}</strong></div>
          </div>
          <div class="w-24 shrink-0">
            <input type="number" min="0" inputmode="numeric"
                   data-id="${safeDetId}"
                   data-lleva="${det.lleva}"
                   data-deuda="${det.deuda}"
                   data-material-name="${safeMatAttr}"
                   data-destino-name="${safeDestAttr}"
                   data-split-accepted="false"
                   placeholder="${det.deuda <= 0 ? "-" : "Retorna"}"
                   class="w-full bg-white dark:bg-gray-950 border-2 border-gray-300 dark:border-gray-600 rounded-xl p-2 text-center text-base text-emerald-600 dark:text-emerald-400 font-black focus:border-emerald-500 outline-none mdl-return-input mdl-input-mobile disabled:opacity-50"
                   ${det.deuda <= 0 ? "disabled" : ""}>
          </div>
        </div>
        <div id="excedente-alert-mob-${safeDetId}" class="hidden mt-2"></div>
      </div>
    `;
  }).join("");
  document.getElementById("mdlCardsMaterialesMobile").innerHTML = cardsMobileHTML;

  // Sincronización bidireccional Desktop <-> Mobile + Evaluación de Excedentes en vivo
  document.querySelectorAll(".mdl-return-input").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const id = e.target.getAttribute("data-id");
      document.querySelectorAll(`.mdl-return-input[data-id="${id}"]`).forEach(sibling => {
        if (sibling !== e.target) sibling.value = e.target.value;
      });
      evaluarExcedenteDetalle(id, e.target.value);
    });
  });

  const esCargoLocalSinSincronizar = String(cargo.idCargo).startsWith("LOC-");
  const btnLiq = document.getElementById("btnLiquidarModal");
  const btnTodo = document.getElementById("btnDevolverTodoModal");
  const btnAddExtra = document.getElementById("btnToggleAddExtra");
  const avisoLocal = document.getElementById("mdlAvisoLocalSync");

  if (esCargoLocalSinSincronizar) {
    btnLiq.disabled = true;
    btnLiq.classList.add("opacity-50", "cursor-not-allowed");
    btnTodo.disabled = true;
    btnTodo.classList.add("opacity-50", "cursor-not-allowed");
    if (btnAddExtra) { btnAddExtra.disabled = true; btnAddExtra.classList.add("opacity-50", "cursor-not-allowed"); }
    if (avisoLocal) avisoLocal.classList.remove("hidden");
  } else {
    btnLiq.disabled = false;
    btnLiq.classList.remove("opacity-50", "cursor-not-allowed");
    btnTodo.disabled = false;
    btnTodo.classList.remove("opacity-50", "cursor-not-allowed");
    if (btnAddExtra) { btnAddExtra.disabled = false; btnAddExtra.classList.remove("opacity-50", "cursor-not-allowed"); }
    if (avisoLocal) avisoLocal.classList.add("hidden");
  }

  btnLiq.setAttribute("onclick", `procesarLiquidacionModal('${escapeHTML(cargo.idCargo)}')`);

  // Botones directos de impresión sobre la vista preliminar (sin pasos intermedios)
  const btnPrintA4 = document.getElementById("btnPrintA4Modal") || document.getElementById("btnPrintModal");
  if (btnPrintA4) btnPrintA4.onclick = () => generarDocumentoImpresion(cargo.idCargo, 'A4');

  const btnPrintTicket = document.getElementById("btnPrintTicketModal");
  if (btnPrintTicket) btnPrintTicket.onclick = () => generarDocumentoImpresion(cargo.idCargo, 'TICKET');

  const inputsDesktop = document.querySelectorAll(".mdl-input-desktop:not([disabled])");
  inputsDesktop.forEach((input, index) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (index < inputsDesktop.length - 1) inputsDesktop[index + 1].focus();
        else btnLiq.focus();
      }
    });
  });

  const modal = document.getElementById("modalDetalle");
  const modalContent = document.getElementById("modalDetalleContent");
  modal.classList.remove("hidden");

  setTimeout(() => {
    modal.classList.remove("opacity-0");
    modalContent.classList.remove("scale-95");
    if (window.innerWidth >= 768 && inputsDesktop.length > 0 && !esCargoLocalSinSincronizar) {
      inputsDesktop[0].focus();
    }
  }, 50);
}

// ==========================================
// 10.4 LIQUIDACIÓN DE DESCARGOS (CIERRE AUTOMÁTICO CON FALTANTE / EXCEDENTE)
// ==========================================
async function procesarLiquidacionModal(idCargo) {
  if (String(idCargo).startsWith("LOC-")) {
    return mostrarAlerta("Este cargo aún está pendiente de sincronización inicial. Espera a que obtenga su código oficial GCM.", "warning", "Sincronización en Curso");
  }

  const inputs = document.querySelectorAll(".mdl-input-desktop:not([disabled])");
  const payloadDevolucion = [];
  const excedentesSinAceptar = [];
  let errorValidacion = null;

  inputs.forEach((input) => {
    const rawVal = input.value.trim();
    if (!rawVal) return;

    const idDet = input.getAttribute("data-id");
    const qty = parseInt(rawVal, 10);
    const maxDeuda = parseInt(input.getAttribute("data-deuda") || "0", 10);
    const splitAccepted = input.dataset.splitAccepted === "true";

    if (isNaN(qty) || qty < 0) {
      errorValidacion = "No se permiten cantidades negativas o inválidas.";
      return;
    }

    if (qty > maxDeuda && !splitAccepted) {
      excedentesSinAceptar.push({
        idDetalle: idDet,
        material: input.getAttribute("data-material-name") || "Material",
        destino: input.getAttribute("data-destino-name") || "Destino",
        deuda: maxDeuda,
        excedente: qty - maxDeuda
      });
    }

    if (qty > 0) {
      payloadDevolucion.push({
        id_detalle: idDet,
        qty: qty,
        splitExcedente: qty > maxDeuda ? splitAccepted : false
      });
    }
  });

  if (errorValidacion) {
    return mostrarAlerta(errorValidacion, "error", "Cantidad Inválida");
  }

  if (payloadDevolucion.length === 0) {
    return mostrarAlerta("Ingresa al menos una cantidad mayor a 0 en la columna 'Retorna'.", "warning", "Datos Insuficientes");
  }

  if (excedentesSinAceptar.length > 0) {
    const resumenHtml = excedentesSinAceptar
      .map(e => `• <strong>${escapeHTML(e.material)}</strong> (${escapeHTML(e.destino)}): deuda <b>${e.deuda}</b> + fila nueva <b>+${e.excedente}</b>`)
      .join("<br>");

    const aceptarDesdoblamiento = await GenDialog.confirm({
      badge: "Excedente Detectado",
      title: "¿Generar fila nueva por la diferencia?",
      message: `Se detectaron retornos mayores a la deuda. Al aceptar, la fila original quedará exacta y la diferencia se registrará en una nueva fila:<br><br>${resumenHtml}`,
      confirmText: "Sí, desdoblar y guardar",
      variant: "warning"
    });

    if (!aceptarDesdoblamiento) return;

    const setIds = new Set(excedentesSinAceptar.map(e => e.idDetalle));
    payloadDevolucion.forEach(item => {
      if (setIds.has(item.id_detalle)) item.splitExcedente = true;
    });
  }

  // Actualización Optimista en Memoria e IndexedDB ($O(1)$)
  const fechaFormat = formatFechaLimaLocal();
  const gestorNombre = AppState.user ? AppState.user.nombre : 'Usuario Desconocido';

  const cargoIndex = AppState.cargosActivos.findIndex(c => c.idCargo === idCargo);
  let totalFilasExcedenteCreadas = 0;
  let totalFaltanteResidual = 0;
  let totalExcedenteResidual = 0;

  if (cargoIndex !== -1) {
    const cargo = AppState.cargosActivos[cargoIndex];
    const nuevasFilasOptimistasCargo = [];

    cargo.detalles.forEach(det => {
      const mov = payloadDevolucion.find(p => p.id_detalle === det.ID_DETALLE);
      const lleva = parseInt(det.LLEVA || 0, 10);
      const devPrevio = parseInt(det.DEVUELVE || 0, 10);

      if (mov) {
        const deudaPend = Math.max(0, lleva - devPrevio);

        if (mov.splitExcedente && mov.qty > deudaPend && lleva > 0) {
          const excedenteQty = mov.qty - deudaPend;
          det.DEVUELVE = lleva;
          det.DEUDA = 0;
          totalFilasExcedenteCreadas++;
          totalExcedenteResidual += excedenteQty;

          const tempExcId = `LOC-EXC-${Date.now().toString(36).toUpperCase()}-${totalFilasExcedenteCreadas}`;
          nuevasFilasOptimistasCargo.push({
            ID_DETALLE: tempExcId,
            LLEVA: 0,
            DEVUELVE: excedenteQty,
            DEUDA: -excedenteQty,
            DESTINO: det.DESTINO,
            MATERIAL: det.MATERIAL,
            EMISOR: det.EMISOR,
            RESPONSABLE: det.RESPONSABLE || cargo.choferId
          });

          AppState.historial.unshift({
            idCargo: cargo.idCargo,
            idDetalle: tempExcId,
            material: det.MATERIAL,
            destino: det.DESTINO,
            emisor: det.EMISOR || 'Almacén PT',
            lleva: 0,
            devuelve: excedenteQty,
            deuda: -excedenteQty,
            estado: 'Excedente',
            horaCargo: cargo.hora || fechaFormat,
            gestorCargo: cargo.gestor || gestorNombre,
            horaDescargo: fechaFormat,
            gestorDescargo: gestorNombre,
            chofer: cargo.choferId || '',
            placa: cargo.placa || 'S/N'
          });
        } else {
          det.DEVUELVE = devPrevio + mov.qty;
          det.DEUDA = lleva - det.DEVUELVE;
          if (det.DEUDA > 0) totalFaltanteResidual += det.DEUDA;
          if (det.DEUDA < 0) totalExcedenteResidual += Math.abs(det.DEUDA);
        }

        const histOrig = AppState.historial.find(h => h.idDetalle === det.ID_DETALLE);
        if (histOrig) {
          histOrig.devuelve = det.DEVUELVE;
          histOrig.deuda = det.DEUDA;
          histOrig.estado = det.DEUDA > 0 ? 'Faltante' : (det.DEUDA < 0 ? 'Excedente' : 'Devolución completa');
          histOrig.horaDescargo = fechaFormat;
          histOrig.gestorDescargo = gestorNombre;
        }
      } else {
        // Líneas no digitadas en el retorno también se cierran como faltante del viaje
        const deudaLinea = lleva - devPrevio;
        if (deudaLinea > 0) totalFaltanteResidual += deudaLinea;
        const histOrig = AppState.historial.find(h => h.idDetalle === det.ID_DETALLE);
        if (histOrig && deudaLinea > 0) {
          histOrig.estado = 'Faltante';
          histOrig.horaDescargo = fechaFormat;
          histOrig.gestorDescargo = gestorNombre;
        }
      }
    });

    if (nuevasFilasOptimistasCargo.length > 0) {
      cargo.detalles.push(...nuevasFilasOptimistasCargo);
    }

    // REGLA DE NEGOCIO: Todo descargo registrado (incluso con nota de faltante o excedente)
    // sale inmediatamente de Viajes Pendientes y pasa a Histórico.
    AppState.cargosActivos.splice(cargoIndex, 1);

    await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);
    await SyncEngine.saveCache('historial', AppState.historial);
  }

  await SyncEngine.enqueueMutation('updateDevolucion', {
    data: payloadDevolucion,
    gestorNombre,
    gestorRol: AuthRules.currentUserRole(),
    forzarCierreConNota: true
  });

  cerrarDetalle();
  renderizarCargosFiltrados();

  if (totalFaltanteResidual > 0 && totalExcedenteResidual > 0) {
    mostrarToast(`Cargo ${idCargo} cerrado con nota de faltante (${totalFaltanteResidual}) y excedente (${totalExcedenteResidual}).`);
  } else if (totalFaltanteResidual > 0) {
    mostrarToast(`Cargo ${idCargo} cerrado con nota de FALTANTE (${totalFaltanteResidual} und.). Movido a Histórico.`);
  } else if (totalExcedenteResidual > 0 || totalFilasExcedenteCreadas > 0) {
    mostrarToast(`Cargo ${idCargo} cerrado con nota de EXCEDENTE (+${totalExcedenteResidual} und.). Movido a Histórico.`);
  } else {
    mostrarToast(`Liquidación del cargo ${idCargo} guardada al 100%. Sincronizando...`);
  }

  if (!document.getElementById('viewHistorico').classList.contains('hidden')) renderizarHistorico();
}

window.cerrarDetalle = function () {
  const modal = document.getElementById("modalDetalle");
  const modalContent = document.getElementById("modalDetalleContent");
  if (!modal || modal.classList.contains("hidden")) return;

  modal.classList.add("opacity-0");
  modalContent.classList.add("scale-95");
  setTimeout(() => {
    modal.classList.add("hidden");
    cargoActualModalId = null;
  }, 300);
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    cerrarDetalle();
    cerrarAlerta();
  }
});

document.getElementById("modalDetalle")?.addEventListener("click", (e) => {
  if (e.target.id === "modalDetalle") cerrarDetalle();
});

// ==========================================
// 11. MÓDULO HISTÓRICO, KPIs Y EXPORTADOR CSV
// ==========================================
document.getElementById("inBuscarHistorico")?.addEventListener("input", renderizarHistorico);

window.setHistorySort = function (key) {
  if (AppState.sortHistoryConfig.key === key) AppState.sortHistoryConfig.asc = !AppState.sortHistoryConfig.asc;
  else { AppState.sortHistoryConfig.key = key; AppState.sortHistoryConfig.asc = true; }
  renderizarHistorico();
};

function getHistorySortIcon(key) {
  if (AppState.sortHistoryConfig.key !== key) return `<span class="text-gray-400 dark:text-gray-600 ml-1">↕</span>`;
  return AppState.sortHistoryConfig.asc ? `<span class="text-blue-600 dark:text-blue-400 ml-1">↑</span>` : `<span class="text-blue-600 dark:text-blue-400 ml-1">↓</span>`;
}

function renderizarKPIsHistorico(registrosFiltrados) {
  const container = document.getElementById("kpiHistoricoContainer");
  if (!container) return;

  let totalDespachado = 0;
  let totalDevuelto = 0;
  let totalPendiente = 0;

  registrosFiltrados.forEach(r => {
    totalDespachado += (parseInt(r.lleva, 10) || 0);
    totalDevuelto += (parseInt(r.devuelve, 10) || 0);
    const d = parseInt(r.deuda, 10) || 0;
    if (d > 0) totalPendiente += d;
  });

  const tasaRecuperacion = totalDespachado > 0
    ? ((totalDevuelto / totalDespachado) * 100).toFixed(1)
    : "100.0";

  container.innerHTML = `
    <div class="bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 rounded-2xl p-3.5 shadow-sm">
      <p class="text-[10px] font-bold uppercase tracking-wider text-gray-500">Despachado (Filtro)</p>
      <p class="text-xl font-black text-gray-900 dark:text-white mt-0.5">${totalDespachado.toLocaleString()} <span class="text-xs font-normal text-gray-500">und.</span></p>
    </div>

    <div class="bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 rounded-2xl p-3.5 shadow-sm">
      <p class="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Retornado</p>
      <p class="text-xl font-black text-emerald-600 dark:text-emerald-400 mt-0.5">${totalDevuelto.toLocaleString()} <span class="text-xs font-normal text-gray-500">und.</span></p>
    </div>

    <div class="bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 rounded-2xl p-3.5 shadow-sm">
      <p class="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">Tasa Recuperación</p>
      <p class="text-xl font-black text-blue-600 dark:text-blue-400 mt-0.5">${tasaRecuperacion}%</p>
    </div>

    <div class="bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 rounded-2xl p-3.5 shadow-sm">
      <p class="text-[10px] font-bold uppercase tracking-wider text-pink-600 dark:text-pink-400">Saldo Faltante</p>
      <p class="text-xl font-black text-pink-600 dark:text-pink-400 mt-0.5">${totalPendiente.toLocaleString()} <span class="text-xs font-normal text-gray-500">und.</span></p>
    </div>
  `;
}

let ultimoHistoricoExportable = [];

window.exportarHistoricoCSV = function () {
  if (!ultimoHistoricoExportable || ultimoHistoricoExportable.length === 0) {
    return mostrarAlerta("No hay registros filtrados para exportar.", "warning", "Tabla Vacía");
  }

  const headers = [
    "ID_CARGO", "ID_DETALLE", "FECHA_SALIDA", "EMISOR", "DESTINO",
    "CHOFER", "MATERIAL", "LLEVA", "DEVUELTO", "DEUDA", "ESTADO",
    "GESTOR_EMISION", "FECHA_DESCARGO", "GESTOR_DESCARGO"
  ];

  const escapeCSV = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;

  const rows = ultimoHistoricoExportable.map(r => [
    r.idCargo, r.idDetalle, r.horaCargo, r.emisorName, r.destinoName,
    r.choferName, r.materialName, r.lleva, r.devuelve, r.deuda, r.estado,
    r.gestorCargo, r.horaDescargo, r.gestorDescargo
  ].map(escapeCSV).join(","));

  const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const fechaHoy = new Date().toISOString().slice(0, 10);
  const link = document.createElement("a");
  link.href = url;
  link.download = `GenLogistics_Kardex_Embalajes_${fechaHoy}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  mostrarToast(`Exportados ${ultimoHistoricoExportable.length} registros a Excel (CSV).`);
};

function renderizarHistorico() {
  const grid = document.getElementById("gridHistorico");
  if (!grid) return;
  const searchTerm = (document.getElementById("inBuscarHistorico")?.value || "").toLowerCase().trim();
  const { materialId, soloCriticosSLA, fechaDesde, fechaHasta } = AppState.filtrosGlobales;

  const banner = document.getElementById("bannerFiltroGlobalHistorico");
  const bannerTxt = document.getElementById("textoFiltroGlobalHistorico");
  if (banner && bannerTxt) {
    const etiquetas = [];
    if (materialId) {
      const mObj = AppState.datos.materiales.find(m => cleanId(m.ID_MEMB) === cleanId(materialId));
      etiquetas.push(`Material: ${mObj ? mObj.DESCRIPCION : materialId}`);
    }
    if (soloCriticosSLA) etiquetas.push("Solo críticos (+48h)");
    if (fechaDesde || fechaHasta) etiquetas.push(`Fechas: ${fechaDesde || '...'} a ${fechaHasta || '...'}`);

    if (etiquetas.length > 0) {
      banner.classList.remove("hidden");
      bannerTxt.innerHTML = `<span>Filtros activos:</span> <span class="bg-blue-600 text-white px-2 py-0.5 rounded-md">${escapeHTML(etiquetas.join(" • "))}</span>`;
    } else {
      banner.classList.add("hidden");
    }
  }

  let filtrados = AppState.historial.map(det => {
    const materialObj = AppState.datos.materiales.find(m => cleanId(m.ID_MEMB) === cleanId(det.material));
    const destinoObj = AppState.datos.destinos.find(d => cleanId(d.ID_DSTN) === cleanId(det.destino));
    const emisorObj = AppState.datos.destinos.find(d => cleanId(d.ID_DSTN) === cleanId(det.emisor));
    const idChoferLimpio = cleanId(det.chofer);
    const choferObj = AppState.datos.choferes.find(c => cleanId(c.ID_CHFR) === idChoferLimpio);

    return {
      ...det,
      materialName: materialObj ? materialObj.DESCRIPCION : det.material,
      destinoName: destinoObj ? destinoObj.REFERENCIA : det.destino,
      emisorName: emisorObj ? emisorObj.REFERENCIA : (det.emisor || 'Almacén PT'),
      choferName: choferObj ? choferObj.NOMBRE : (idChoferLimpio || det.chofer)
    };
  });

  AppState.historialFiltrado = filtrados;

  filtrados = filtrados.filter(item => cumpleRangoFechas(item.horaCargo));

  if (materialId) {
    filtrados = filtrados.filter(item => cleanId(item.material) === cleanId(materialId));
  }

  if (soloCriticosSLA) {
    filtrados = filtrados.filter(item => (parseInt(item.deuda, 10) > 0) && calcularHorasTranscurridas(item.horaCargo) >= 48);
  }

  if (searchTerm) {
    filtrados = filtrados.filter(item => {
      return (item.idCargo || "").toLowerCase().includes(searchTerm) || (item.materialName || "").toLowerCase().includes(searchTerm) ||
        (item.destinoName || "").toLowerCase().includes(searchTerm) || (item.choferName || "").toLowerCase().includes(searchTerm) ||
        (item.horaCargo || "").toLowerCase().includes(searchTerm);
    });
  }

  const { key, asc } = AppState.sortHistoryConfig;
  filtrados.sort((a, b) => {
    let valA = a[key], valB = b[key];
    if (['lleva', 'devuelve', 'deuda'].includes(key)) {
      valA = parseFloat(valA) || 0; valB = parseFloat(valB) || 0;
      return asc ? valA - valB : valB - valA;
    } else if (key === 'horaCargo') {
      valA = estandarizarFecha(valA); valB = estandarizarFecha(valB);
    } else {
      valA = String(valA || "").toLowerCase(); valB = String(valB || "").toLowerCase();
    }
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
  });

  ultimoHistoricoExportable = filtrados;
  renderizarKPIsHistorico(filtrados);

  if (filtrados.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 py-12 font-bold bg-white dark:bg-gray-800/40 rounded-2xl border border-gray-200 dark:border-gray-700/50 italic mx-4 md:mx-0">No se encontraron movimientos que coincidan con los filtros.</div>`;
    return;
  }

  const idsActivosSet = new Set(AppState.cargosActivos.map(c => c.idCargo));

  let html = `
    <div class="overflow-x-auto no-scrollbar md:rounded-xl border-y md:border border-gray-200 dark:border-gray-700/80 shadow-sm dark:shadow-inner max-h-[600px] relative bg-white dark:bg-transparent">
      <table class="min-w-max w-full text-left text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
        <thead class="bg-gray-100 dark:bg-gray-900/95 sticky top-0 border-b border-gray-200 dark:border-gray-700 uppercase font-semibold text-gray-500 dark:text-gray-500 z-10 backdrop-blur-sm shadow-sm select-none">
          <tr>
            <th class="px-4 py-3 border-r border-gray-200 dark:border-gray-800/50 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setHistorySort('horaCargo')">Fecha/Hora ${getHistorySortIcon('horaCargo')}</th>
            <th class="px-4 py-3 border-r border-gray-200 dark:border-gray-800/50 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setHistorySort('idCargo')">ID Cargo ${getHistorySortIcon('idCargo')}</th>
            <th class="px-4 py-3 border-r border-gray-200 dark:border-gray-800/50 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setHistorySort('choferName')">Chofer ${getHistorySortIcon('choferName')}</th>
            <th class="px-4 py-3 border-r border-gray-200 dark:border-gray-800/50 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setHistorySort('materialName')">Material ${getHistorySortIcon('materialName')}</th>
            <th class="px-4 py-3 border-r border-gray-200 dark:border-gray-800/50 cursor-pointer hover:text-gray-900 dark:hover:text-white transition-colors" onclick="setHistorySort('destinoName')">Destino ${getHistorySortIcon('destinoName')}</th>
            <th class="px-3 py-3 text-center border-r border-gray-200 dark:border-gray-800/50 text-gray-800 dark:text-white cursor-pointer hover:text-black dark:hover:text-gray-300 transition-colors" onclick="setHistorySort('lleva')">Lleva ${getHistorySortIcon('lleva')}</th>
            <th class="px-3 py-3 text-center border-r border-gray-200 dark:border-gray-800/50 text-emerald-600 dark:text-emerald-400 cursor-pointer hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors" onclick="setHistorySort('devuelve')">Devuelto ${getHistorySortIcon('devuelve')}</th>
            <th class="px-3 py-3 text-center border-r border-gray-200 dark:border-gray-800/50 text-pink-600 dark:text-pink-400 cursor-pointer hover:text-pink-700 dark:hover:text-pink-300 transition-colors" onclick="setHistorySort('deuda')">Deuda ${getHistorySortIcon('deuda')}</th>
            <th class="px-4 py-3 text-center">Estado / Nota</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-800/60">
  `;

  filtrados.forEach(row => {
    let badgeEstadoHTML = "";
    const deuda = parseInt(row.deuda, 10);
    const sigueEnRuta = idsActivosSet.has(row.idCargo);
    const safeCargoId = escapeHTML(row.idCargo || '--');

    if (deuda > 0) {
      if (sigueEnRuta) {
        badgeEstadoHTML = `<span class="bg-pink-50 dark:bg-pink-600/20 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">En Ruta (-${deuda})</span>`;
      } else {
        badgeEstadoHTML = `<span class="bg-red-50 dark:bg-red-600/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-500/30 px-2 py-1 rounded text-[10px] font-extrabold uppercase tracking-wider">Nota Faltante (-${deuda})</span>`;
      }
    } else if (deuda < 0) {
      badgeEstadoHTML = `<span class="bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-500/30 px-2 py-1 rounded text-[10px] font-extrabold uppercase tracking-wider">Nota Excedente (+${Math.abs(deuda)})</span>`;
    } else {
      badgeEstadoHTML = `<span class="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Cerrado 100%</span>`;
    }

    html += `
      <tr onclick="abrirDetalle('${safeCargoId}', '${escapeHTML(row.material)}')" title="Clic para abrir el cargo, gestionar liquidación o imprimir" class="hover:bg-blue-50/40 dark:hover:bg-gray-800/70 transition-colors group cursor-pointer">
        <td class="px-4 py-3.5 font-mono text-gray-500 dark:text-gray-400 text-[11px] hover:bg-blue-100/60 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-300 transition-colors celda-trazabilidad border-l-2 border-transparent hover:border-blue-500" onclick="event.stopPropagation(); abrirTrazabilidad(event, '${escapeHTML(row.idDetalle)}')">
          <div class="flex items-center gap-1.5" title="Click para ver auditoría">
            <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            ${escapeHTML(row.horaCargo || '--')}
          </div>
        </td>
        <td class="px-4 py-3.5 font-mono text-blue-600 dark:text-blue-400 font-bold tracking-tight">${safeCargoId}</td>
        <td class="px-4 py-3.5 truncate max-w-[150px] font-medium text-gray-800 dark:text-gray-200" title="${escapeHTML(row.choferName)}">${escapeHTML(row.choferName)}</td>
        <td class="px-4 py-3.5 truncate max-w-[200px]" title="${escapeHTML(row.materialName)}">${escapeHTML(row.materialName)}</td>
        <td class="px-4 py-3.5 truncate max-w-[150px] text-gray-500 dark:text-gray-400" title="${escapeHTML(row.destinoName)}">${escapeHTML(row.destinoName)}</td>
        <td class="px-3 py-3.5 text-center text-gray-900 dark:text-white font-black bg-gray-50 dark:bg-gray-900/30">${row.lleva}</td>
        <td class="px-3 py-3.5 text-center text-emerald-600 dark:text-emerald-400 font-black bg-emerald-50 dark:bg-emerald-900/10">${row.devuelve}</td>
        <td class="px-3 py-3.5 text-center ${deuda > 0 ? 'text-pink-600 dark:text-pink-400 bg-pink-50 dark:bg-pink-900/10' : 'text-gray-500'} font-black">${deuda}</td>
        <td class="px-4 py-3.5 text-center">${badgeEstadoHTML}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  grid.innerHTML = html;
}

// ==========================================
// 12. MINIMODAL TRAZABILIDAD
// ==========================================
window.abrirTrazabilidad = function (e, idDetalle) {
  const row = AppState.historialFiltrado.find(r => r.idDetalle === idDetalle);
  if (!row) return;

  let globo = document.getElementById('globo-trazabilidad');
  if (!globo) {
    globo = document.createElement('div');
    globo.id = 'globo-trazabilidad';
    globo.className = 'absolute z-[100] hidden bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-600 p-4 w-80 text-left transform transition-opacity opacity-0';
    globo.innerHTML = `
      <div id="trazabilidad-contenido" class="space-y-3"></div>
      <div id="trazabilidad-flecha" class="absolute w-4 h-4 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-600 rotate-45 transition-all"></div>
    `;
    document.body.appendChild(globo);

    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.celda-trazabilidad') && !globo.contains(ev.target)) {
        globo.classList.add('hidden');
        globo.classList.remove('opacity-100');
      }
    });
  }

  const contenido = document.getElementById('trazabilidad-contenido');
  const flecha = document.getElementById('trazabilidad-flecha');

  contenido.innerHTML = `
    <div class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-500/30 p-3 rounded-lg shadow-sm">
      <p class="text-[10px] text-blue-600 dark:text-blue-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>
        1. Despacho / Emisión
      </p>
      <p class="text-xs text-gray-700 dark:text-gray-200 mb-1"><span class="text-gray-500 mr-1">Gestor:</span> ${escapeHTML(row.gestorCargo || 'No registrado')}</p>
      <p class="text-xs text-gray-700 dark:text-gray-200 mb-2"><span class="text-gray-500 mr-1">Ruta:</span> <span class="font-bold text-gray-900 dark:text-gray-100">${escapeHTML(row.emisorName)}</span> ➔ <span class="font-bold text-gray-900 dark:text-gray-100">${escapeHTML(row.destinoName)}</span></p>
      <p class="text-[10px] text-blue-700 dark:text-blue-300 font-mono bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded w-fit">${escapeHTML(row.horaCargo || '--')}</p>
    </div>
    
    <div class="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-500/30 p-3 rounded-lg shadow-sm">
      <p class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
        2. Descargo / Devolución
      </p>
      ${row.horaDescargo ? `
         <p class="text-xs text-gray-700 dark:text-gray-200 mb-2"><span class="text-gray-500 mr-1">Receptor:</span> ${escapeHTML(row.gestorDescargo || 'No registrado')}</p>
         <p class="text-[10px] text-emerald-700 dark:text-emerald-300 font-mono bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 rounded w-fit">${escapeHTML(row.horaDescargo)}</p>
      ` : `
         <p class="text-xs text-gray-500 italic mt-1 flex items-center gap-1.5"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Bandejas aún en ruta...</p>
      `}
    </div>
  `;

  globo.classList.remove('hidden');
  globo.classList.remove('opacity-100');

  const rect = e.currentTarget.getBoundingClientRect();
  const globoRect = globo.getBoundingClientRect();

  let top = rect.top + window.scrollY - globoRect.height - 10;
  let left = rect.left + window.scrollX + (rect.width / 2) - (globoRect.width / 2);

  flecha.className = "absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-4 h-4 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-600 rotate-45 transition-all";

  if (top < window.scrollY + 10) {
    top = rect.bottom + window.scrollY + 10;
    flecha.className = "absolute -top-2 left-1/2 transform -translate-x-1/2 w-4 h-4 bg-white dark:bg-gray-900 border-t border-l border-gray-200 dark:border-gray-600 rotate-45 transition-all";
  }

  if (left < 10) left = 10;
  if (left + globoRect.width > window.innerWidth - 10) left = window.innerWidth - globoRect.width - 10;

  globo.style.top = top + 'px';
  globo.style.left = left + 'px';

  setTimeout(() => globo.classList.add('opacity-100'), 10);
};

// ==========================================
// 13. MOTOR DE IMPRESIÓN DIRECTA DUAL (A4 Y TICKET 80MM AGRUPADOS POR DESTINO)
// ==========================================
window.generarDocumentoImpresion = function (idCargo, formato = 'A4') {
if (String(idCargo || "").startsWith("LOC-")) {
    return mostrarAlerta(
      "Este cargo aún tiene un código temporal (LOC). Espera unos segundos a que se valide su código oficial GCM para imprimir.",
      "warning",
      "Validando Correlativo Oficial"
    );
  }
  
  let cargo = AppState.cargosActivos.find((c) => c.idCargo === idCargo);

  if (!cargo) {
    const lineasHist = AppState.historial.filter((h) => h.idCargo === idCargo);
    if (lineasHist.length === 0) return mostrarToast("No se encontraron datos del cargo para imprimir.", "error");

    const ref = lineasHist[0];
    const idChoferLimpio = cleanId(ref.chofer);
    const choferObj = AppState.datos.choferes.find((c) => cleanId(c.ID_CHFR) === idChoferLimpio);

    cargo = {
      idCargo: ref.idCargo,
      choferNombre: choferObj ? choferObj.NOMBRE : (idChoferLimpio || "Desconocido"),
      placa: ref.placa || "S/N",
      hora: ref.horaCargo || "--",
      gestor: ref.gestorCargo || "No registrado",
      firmaCargo: null,
      detalles: lineasHist.map((h) => ({
        LLEVA: h.lleva,
        DEVUELVE: h.devuelve,
        DESTINO: h.destino,
        MATERIAL: h.material,
        EMISOR: h.emisor
      }))
    };
  }

  let totalLlevado = 0;
  let totalM3Llevado = 0;
  const destinosSet = new Set();
  const resumenTipos = {};
  const gruposPorDestino = new Map();

  cargo.detalles.forEach((d) => {
    const lleva = parseInt(d.LLEVA || 0, 10);
    const devuelve = parseInt(d.DEVUELVE || 0, 10);
    totalLlevado += lleva;

    const destinoCat = AppState.datos.destinos.find((x) => cleanId(x.ID_DSTN) === cleanId(d.DESTINO));
    const nombreDestino = destinoCat ? destinoCat.REFERENCIA : d.DESTINO || "Sin Destino";
    const materialCat = AppState.datos.materiales.find((m) => cleanId(m.ID_MEMB) === cleanId(d.MATERIAL));
    const nombreMaterial = materialCat ? materialCat.DESCRIPCION : d.MATERIAL || "Desconocido";

    const m3Unitario = materialCat && materialCat.M3 ? parseFloat(String(materialCat.M3).replace(",", ".")) : 0;
    totalM3Llevado += (m3Unitario * lleva);

    destinosSet.add(nombreDestino);
    resumenTipos[nombreMaterial] = (resumenTipos[nombreMaterial] || 0) + lleva;

    const claveGrupo = nombreDestino.trim().toUpperCase();
    if (!gruposPorDestino.has(claveGrupo)) {
      gruposPorDestino.set(claveGrupo, {
        destino: nombreDestino,
        items: [],
        subtotalLleva: 0,
        subtotalDevuelve: 0
      });
    }
    const grupo = gruposPorDestino.get(claveGrupo);
    grupo.items.push({ nombreMaterial, lleva, devuelve });
    grupo.subtotalLleva += lleva;
    grupo.subtotalDevuelve += devuelve;
  });

  const areaRaw = cargo.detalles[0]?.EMISOR || cargo.area || "Almacén PT";
  const areaCat = AppState.datos.destinos.find((x) => cleanId(x.ID_DSTN) === cleanId(areaRaw));
  const areaResponsable = areaCat ? areaCat.REFERENCIA : areaRaw;

  const logoSvgUri = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='60 20 280 160'%3E%3Cpath d='m200 25 135 47v56l-135 47-135-47V72z' fill='%23C51D23' stroke='%23C51D23' stroke-width='8' stroke-linejoin='round'/%3E%3Cpath d='m200 25 135 47v56l-135 47-135-47V72z' fill='none' stroke='%23B08D57' stroke-width='1' stroke-linejoin='round'/%3E%3Ctext x='200' y='86' font-family='Times, serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%23404040'%3ELA%3C/text%3E%3Ctext x='200' y='85' font-family='Times, serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%23FFF'%3ELA%3C/text%3E%3Ctext x='200' y='121' font-family='Times, serif' font-size='42' font-weight='bold' text-anchor='middle' fill='%23404040'%3EGENOVESA%3C/text%3E%3Ctext x='200' y='120' font-family='Times, serif' font-size='42' font-weight='bold' text-anchor='middle' fill='%23FFF'%3EGENOVESA%3C/text%3E%3Ctext x='200' y='145' font-family='Arial, sans-serif' font-size='12' text-anchor='middle' fill='%23FFF' letter-spacing='3'%3EDESDE 1977%3C/text%3E%3C/svg%3E";

  let htmlPlantilla = "";

  if (formato === 'TICKET') {
    // Agrupación visual por Destino en Ticket 80mm
    let bloquesDestinosTicketHTML = "";
    gruposPorDestino.forEach((grupo) => {
      const filasItems = grupo.items.map((it) => `
        <tr style="border-bottom: 1px dotted #9ca3af;">
          <td style="padding: 3px 2px; vertical-align: top; font-weight: 600; font-size: 11px; line-height: 1.2;">
            ${escapeHTML(it.nombreMaterial)}
          </td>
          <td style="padding: 3px 2px; text-align: right; vertical-align: top; font-weight: 900; font-size: 11px; font-family: monospace; white-space: nowrap;">
            ${it.lleva} und
          </td>
        </tr>
      `).join("");

      bloquesDestinosTicketHTML += `
        <div style="margin-top: 6px; border: 1px solid #000; border-radius: 3px; overflow: hidden; page-break-inside: avoid;">
          <div style="background: #000; color: #fff; padding: 3px 5px; font-size: 10px; font-weight: 800; display: flex; justify-content: space-between; align-items: center;">
            <span>📍 ${escapeHTML(grupo.destino)}</span>
            <span style="font-family: monospace; background: #fff; color: #000; padding: 0 4px; border-radius: 2px;">Sub: ${grupo.subtotalLleva}</span>
          </div>
          <div style="padding: 2px 4px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tbody>${filasItems}</tbody>
            </table>
          </div>
        </div>
      `;
    });

    const resumenTicketHTML = Object.keys(resumenTipos).map((tipo) => `
      <div style="display: flex; justify-content: space-between; font-size: 10px; line-height: 1.35;">
        <span style="padding-right: 6px;">${escapeHTML(tipo)}</span>
        <span style="font-weight: 800; font-family: monospace;">${resumenTipos[tipo]}</span>
      </div>
    `).join("");

    htmlPlantilla = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Ticket_${escapeHTML(cargo.idCargo)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #ffffff;
      color: #000000;
      font-size: 11px;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .ticket-wrapper {
      width: 72mm;
      max-width: 100%;
      margin: 0 auto;
      background: #ffffff;
      padding: 2mm;
    }
    .center { text-align: center; }
    .divider-dashed { border-top: 1px dashed #000; margin: 6px 0; }
    .meta-row { display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 2px; gap: 4px; }
    .meta-label { font-weight: 700; text-transform: uppercase; }
    @media print {
      @page { size: 80mm auto; margin: 0; }
    }
  </style>
</head>
<body>
  <div class="ticket-wrapper">
    <div class="center">
      <img src="${logoSvgUri}" style="width: 90px; height: auto; margin: 0 auto 2px auto; display: block;" alt="La Genovesa">
      <div style="font-weight: 800; font-size: 11px;">LA GENOVESA AGROINDUSTRIAS S.A.</div>
      <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHTML(areaResponsable)}</div>
      <div style="font-weight: 900; font-size: 12px; margin-top: 4px; border: 1px solid #000; padding: 2px;">CARGO DE EMBALAJES</div>
    </div>

    <div class="divider-dashed"></div>

    <div class="meta-row"><span class="meta-label">N° Cargo:</span><span style="font-family: monospace; font-weight: 900; font-size: 12px;">${escapeHTML(cargo.idCargo)}</span></div>
    <div class="meta-row"><span class="meta-label">Emisión:</span><span style="font-family: monospace;">${escapeHTML(cargo.hora || "--")}</span></div>
    <div class="meta-row"><span class="meta-label">Vehículo:</span><span style="font-family: monospace; font-weight: 800;">${escapeHTML(cargo.placa || "S/N")}</span></div>
    <div style="font-size: 10px; margin-top: 2px;"><span class="meta-label">Chofer:</span> ${escapeHTML(cargo.choferNombre)}</div>
    <div style="font-size: 9px; margin-top: 1px;"><span class="meta-label">Despachó:</span> ${escapeHTML(cargo.gestor || "No registrado")}</div>

    <div style="font-size: 9px; font-weight: 800; text-transform: uppercase; margin-top: 6px; border-top: 1px solid #000; padding-top: 3px;">
      Detalle Agrupado por Destino (${gruposPorDestino.size}):
    </div>

    ${bloquesDestinosTicketHTML}

    <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 2px; margin-top: 6px; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; font-weight: 900; font-size: 12px;">
      <span>TOTAL UNIDADES:</span>
      <span style="font-family: monospace;">${totalLlevado} und (${totalM3Llevado.toFixed(2)} m³)</span>
    </div>

    <div style="margin-top: 5px;">
      <div style="font-size: 9px; font-weight: 800; text-transform: uppercase; margin-bottom: 2px;">Resumen por Material:</div>
      ${resumenTicketHTML}
    </div>

    <div class="divider-dashed"></div>

    <div class="center" style="margin-top: 6px;">
      <div style="min-height: 46px; display: flex; align-items: flex-end; justify-content: center; border-bottom: 1px solid #000; width: 85%; margin: 0 auto 3px auto;">
        ${cargo.firmaCargo ? `<img src="${cargo.firmaCargo}" style="max-height: 42px; object-fit: contain;">` : ''}
      </div>
      <div style="font-size: 10px; font-weight: 800; text-transform: uppercase;">${escapeHTML(cargo.choferNombre)}</div>
      <div style="font-size: 8px; text-transform: uppercase;">Firma de Conformidad</div>
    </div>

    <div class="center" style="margin-top: 8px; font-size: 8px; color: #374151;">
      GenLogistics • Control de Activos Retornables
    </div>
  </div>
</body>
</html>`;
  } else {
    // Agrupación visual por Destino en Formato A4
    let bloquesDestinosA4HTML = "";
    gruposPorDestino.forEach((grupo) => {
      const filasGrupo = grupo.items.map((it) => `
        <tr>
          <td style="padding: 5px 8px; border-bottom: 1px solid #e5e7eb; font-weight: 500; color: #1f2937;">${escapeHTML(it.nombreMaterial)}</td>
          <td style="padding: 5px 8px; border-bottom: 1px solid #e5e7eb; text-align: center; font-weight: 700; color: #111827;">${it.lleva}</td>
          <td style="padding: 5px 8px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #059669; font-weight: 600;">${it.devuelve > 0 ? it.devuelve : ''}</td>
        </tr>
      `).join("");

      bloquesDestinosA4HTML += `
        <div style="margin-bottom: 12px; border: 1px solid #d1d5db; border-radius: 6px; overflow: hidden; page-break-inside: avoid;">
          <div style="background: #1f2937; color: #ffffff; padding: 5px 10px; font-size: 11px; font-weight: 700; display: flex; justify-content: space-between; align-items: center;">
            <span>DESTINO: ${escapeHTML(grupo.destino)}</span>
            <span style="font-family: monospace; background: #374151; padding: 1px 6px; border-radius: 4px;">Subtotal: ${grupo.subtotalLleva} und</span>
          </div>
          <table style="width: 100%; border-collapse: collapse; margin: 0;">
            <thead>
              <tr style="background: #f3f4f6; color: #4b5563; font-size: 9px; text-transform: uppercase;">
                <th style="padding: 4px 8px; text-align: left; width: 66%;">Material / Embalaje</th>
                <th style="padding: 4px 8px; text-align: center; width: 17%;">Lleva</th>
                <th style="padding: 4px 8px; text-align: center; width: 17%;">Devolución</th>
              </tr>
            </thead>
            <tbody>${filasGrupo}</tbody>
          </table>
        </div>
      `;
    });

    const destinosHTML = Array.from(destinosSet).map((dest) => `<div>• ${escapeHTML(dest)}</div>`).join("");
    const tiposHTML = Object.keys(resumenTipos).map((tipo) => `<div><span style="font-weight:700; margin-right:4px;">${resumenTipos[tipo]}</span> ${escapeHTML(tipo)}</div>`).join("");

    htmlPlantilla = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Cargo_${escapeHTML(cargo.idCargo)}_${escapeHTML(cargo.choferNombre.replace(/\s+/g, ""))}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background-color: #ffffff; color: #1f2937; font-size: 12px; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    .a4-container { max-width: 21cm; margin: 0 auto; background: white; padding: 0.5cm; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f2937; padding-bottom: 12px; margin-bottom: 14px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: #f9fafb; padding: 10px 12px; border-radius: 8px; border: 1px solid #e5e7eb; margin-bottom: 14px; }
    .footer-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 16px; }
    @media print {
      @page { size: A4 portrait; margin: 0.6cm; }
    }
  </style>
</head>
<body>
  <div class="a4-container">
    <div class="header">
      <div style="width: 140px;">
        <img src="${logoSvgUri}" style="width:100%; height:auto;" alt="Logo La Genovesa">
      </div>
      <div style="text-align: right; margin-top: 8px;">
        <h1 style="font-size: 18px; font-weight: 800; text-transform: uppercase;">Cargo de Embalajes</h1>
        <p style="font-weight: 600; color: #4b5563;">La Genovesa Agroindustrias S.A.</p>
        <p style="font-size: 10px; color: #6b7280; text-transform: uppercase;">${escapeHTML(areaResponsable)}</p>
      </div>
    </div>

    <div class="info-grid">
      <div>
        <p style="font-size: 10px; color: #6b7280; font-weight: bold; text-transform: uppercase; margin-bottom: 4px;">Documento</p>
        <p><strong>N° Cargo:</strong> <span style="font-family: monospace; background: white; border: 1px solid #d1d5db; padding: 2px 4px; border-radius: 4px;">${escapeHTML(cargo.idCargo)}</span></p>
        <p style="margin-top: 4px;"><strong>Emisión:</strong> ${escapeHTML(cargo.hora || "--")}</p>
      </div>
      <div>
        <p style="font-size: 10px; color: #6b7280; font-weight: bold; text-transform: uppercase; margin-bottom: 4px;">Transporte</p>
        <p><strong>Chofer:</strong> ${escapeHTML(cargo.choferNombre)}</p>
        <p style="margin-top: 4px;"><strong>Vehículo:</strong> <span style="font-family: monospace; background: white; border: 1px solid #d1d5db; padding: 2px 4px; border-radius: 4px;">${escapeHTML(cargo.placa || "S/N")}</span></p>
      </div>
    </div>

    ${bloquesDestinosA4HTML}

    <div style="background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;">
      <span style="font-weight: bold; color: #4b5563; font-size: 11px; text-transform: uppercase;">Total General del Viaje:</span>
      <div>
        <span style="font-weight: 900; color: #1d4ed8; font-size: 14px; margin-right: 14px;">${totalLlevado} und</span>
        <span style="font-family: monospace; color: #059669; font-weight: bold; font-size: 12px;">${totalM3Llevado.toFixed(3)} m³</span>
      </div>
    </div>

    <div class="footer-grid">
      <div>
        <h4 style="font-size: 10px; font-weight: bold; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; padding-bottom: 2px; margin-bottom: 4px;">Destinos (${destinosSet.size})</h4>
        <div style="font-size: 10px; color: #374151; line-height: 1.4;">${destinosHTML}</div>
      </div>
      <div>
        <h4 style="font-size: 10px; font-weight: bold; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; padding-bottom: 2px; margin-bottom: 4px;">Tipos de Material</h4>
        <div style="font-size: 10px; color: #374151; font-family: monospace; line-height: 1.4;">${tiposHTML}</div>
      </div>
      <div style="display: flex; flex-direction: column; justify-content: flex-end; align-items: center;">
        <div style="width: 100%; max-width: 180px; border-bottom: 1px dashed #1f2937; padding-bottom: 4px; display: flex; justify-content: center; align-items: flex-end; margin-bottom: 4px; min-height: 50px;">
          ${cargo.firmaCargo ? `<img src="${cargo.firmaCargo}" style="max-height: 45px; object-fit: contain;">` : ''}
        </div>
        <p style="font-size: 10px; font-weight: bold; text-transform: uppercase; text-align: center;">${escapeHTML(cargo.choferNombre)}</p>
        <p style="font-size: 9px; color: #6b7280; text-transform: uppercase; text-align: center;">Firma de Conformidad</p>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  // Impresión directa automática sobre la vista preliminar/actual mediante Iframe oculto (Zero Pop-Ups)
  const prevFrame = document.getElementById("gen-print-iframe");
  if (prevFrame) prevFrame.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "gen-print-iframe";
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(htmlPlantilla);
  doc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (err) {
      console.warn("[PrintEngine] Fallback a ventana emergente:", err);
      const printWindow = window.open("", "_blank");
      if (printWindow) {
        printWindow.document.open();
        printWindow.document.write(htmlPlantilla);
        printWindow.document.close();
        setTimeout(() => { printWindow.focus(); printWindow.print(); }, 200);
      }
    }
  }, 150);
};
