/**
 * @fileoverview Frontend AppLogic - Sistema de Embalajes y Cargos (GenLogistics)
 * @architecture Zero-Trust | Offline-First | Optimistic UI (O(1)) | Dual Theme
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
  sortConfig: { key: "fecha", asc: false },
  historial: [],
  historialFiltrado: [],
  sortHistoryConfig: { key: "horaCargo", asc: false } 
};

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

document.addEventListener('DOMContentLoaded', async () => {
    // Inicializar Motor IndexedDB y Worker en segundo plano
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
            if(statusDiv) {
                statusDiv.innerHTML = '⚠️ Acceso Restringido';
                statusDiv.className = "flex items-center gap-2 text-xs font-semibold text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-400/10 px-3.5 py-1.5 rounded-full border border-red-200 dark:border-red-400/20 backdrop-blur-md";
            }
            const btnSubmit = document.getElementById('btnSubmit');
            if(btnSubmit) btnSubmit.disabled = true;
        }
    }, 4000);
});

function actualizarUIUsuario() {
    if(!AppState.user) return;
    const statusDiv = document.getElementById('status-indicator');
    if (statusDiv) {
        statusDiv.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span> ${AppState.user.nombre} | ${AppState.user.area}`;
        statusDiv.className = "flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-400/10 px-3.5 py-1.5 rounded-full border border-emerald-200 dark:border-emerald-400/20 backdrop-blur-md";
    }
    const btnSubmit = document.getElementById('btnSubmit');
    if(btnSubmit) btnSubmit.disabled = false;
}

// ==========================================
// 3. UI DE SINCRONIZACIÓN TIPO APPSHEET
// ==========================================
function actualizarBadgeSync(pendingCount, isOnline) {
    const badgeDesktop = document.getElementById('sync-badge');
    const iconDesktop = document.getElementById('sync-icon');
    const textDesktop = document.getElementById('sync-text');
    const btnMobile = document.getElementById('btnSyncMobile');

    if (!badgeDesktop || !btnMobile) return;

    if (!isOnline) {
        // Estado Offline
        badgeDesktop.className = "flex items-center gap-2 text-xs font-bold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30";
        iconDesktop.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"></path>`;
        iconDesktop.classList.remove('animate-spin-sync');
        textDesktop.textContent = pendingCount > 0 ? `Offline (${pendingCount} en cola)` : `Modo Offline`;

        btnMobile.className = "lg:hidden flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-all bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/20";
        btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span><span>Offline${pendingCount > 0 ? ` (${pendingCount})` : ''}</span>`;
    } else if (pendingCount > 0) {
        // Sincronizando en segundo plano
        badgeDesktop.className = "flex items-center gap-2 text-xs font-bold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-500/30";
        iconDesktop.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>`;
        iconDesktop.classList.add('animate-spin-sync');
        textDesktop.textContent = `Sincronizando (${pendingCount})...`;

        btnMobile.className = "lg:hidden flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-all bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/20";
        btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-500 animate-ping"></span><span>Subiendo (${pendingCount})</span>`;
    } else {
        // Todo al día
        badgeDesktop.className = "flex items-center gap-2 text-xs font-bold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30 hover:opacity-80";
        iconDesktop.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>`;
        iconDesktop.classList.remove('animate-spin-sync');
        textDesktop.textContent = `Sincronizado`;

        btnMobile.className = "lg:hidden flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-all bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20";
        btnMobile.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Al día</span>`;
    }
}

function handleRemoteSyncUpdate({ cargosActivos, historial }) {
    if (cargosActivos) {
        AppState.cargosActivos = cargosActivos.map(cargo => ({
            ...cargo,
            _horaSort: estandarizarFecha(cargo.hora)
        }));
        if (!document.getElementById('viewDescargo').classList.contains('hidden')) {
            renderizarCargosFiltrados();
        }
    }
    if (historial) {
        AppState.historial = historial;
        if (!document.getElementById('viewHistorico').classList.contains('hidden')) {
            renderizarHistorico();
        }
    }
}

// ==========================================
// 4. INICIALIZACIÓN (STALE-WHILE-REVALIDATE)
// ==========================================
async function initApp() {
  // Paso A: Hidratación instantánea (0ms) desde IndexedDB
  const cachedMaestros = await SyncEngine.getCache('maestros');
  const cachedCargos = await SyncEngine.getCache('cargosActivos');
  const cachedHistorial = await SyncEngine.getCache('historial');

  if (cachedMaestros) {
      procesarMaestrosEnMemoria(cachedMaestros);
      construirUI();
      initSignaturePad();
  }
  if (cachedCargos) {
      AppState.cargosActivos = cachedCargos.map(c => ({ ...c, _horaSort: estandarizarFecha(c.hora) }));
  }
  if (cachedHistorial) {
      AppState.historial = cachedHistorial;
  }

  // Paso B: Actualización silenciosa desde red (Background Revalidate)
  if (!navigator.onLine) {
      if (!cachedMaestros) mostrarAlerta("Sin conexión y sin caché local. Conéctate a internet la primera vez.", "error", "Modo Offline");
      return;
  }

  try {
    const res = await fetch(`${API_URL}?action=getInitData&token=${API_SECRET_TOKEN}`, { method: "GET", redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.status === "error") throw new Error(json.message);

    await SyncEngine.saveCache('maestros', json.data);
    procesarMaestrosEnMemoria(json.data);

    // Si no había caché previo, construir UI ahora
    if (!cachedMaestros) {
        construirUI();
        initSignaturePad();
    }

    // Pre-cargar datos operativos en segundo plano
    SyncEngine.pullLatestState();
    
  } catch (err) {
    console.warn("[InitApp] Falló actualización remota, operando con caché local:", err.message);
    if (!cachedMaestros) {
        mostrarAlerta("No se pudo descargar la BD inicial: " + err.message, "error", "Error de Red");
    }
  }
}

function procesarMaestrosEnMemoria(rawData) {
    AppState.datos = rawData;
    AppState.datos.areas = AppState.datos.destinos.filter(d => d.EMISOR && String(d.EMISOR).trim().toUpperCase() === "SI");
    AppState.datos.vehiculos = AppState.datos.vehiculos.map(v => ({
        ...v,
        DISPLAY_NAME: `${v.PLACA} ${v.MARCA || ''}`.trim()
    }));
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

  document.getElementById('btnClearSignature').addEventListener('click', limpiarFirma);
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
    toast.innerHTML = `${iconSvg}<span class="leading-snug">${mensaje}</span>`;

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
  modal.classList.add("opacity-0");
  content.classList.add("scale-95");
  setTimeout(() => modal.classList.add("hidden"), 300);
};

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
        if (nextInputId) document.getElementById(nextInputId).focus();
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
  const cantidad = parseInt(document.getElementById("inCantidad").value);

  if (!destinoId) return mostrarAlerta("Selecciona un DESTINO válido.", "warning", "Falta Destino");
  if (!materialId) return mostrarAlerta("Especifica el TIPO DE MATERIAL.", "warning", "Falta Material");
  if (isNaN(cantidad) || cantidad <= 0) return mostrarAlerta("Ingresa CANTIDAD mayor a cero.", "warning", "Cantidad Inválida");

  const materialObj = AppState.datos.materiales.find((m) => m.ID_MEMB === materialId);
  const m3Unitario = materialObj && materialObj.M3 ? parseFloat(String(materialObj.M3).replace(",", ".")) : 0;
  
  AppState.cargoItems.push({
    destinoId, destinoName: destinoText, materialId, materialName: materialText,
    cantidad, m3Unitario, m3Total: m3Unitario * cantidad
  });

  document.getElementById("hdMaterial").value = ""; document.getElementById("inMaterial").value = ""; document.getElementById("inCantidad").value = "";
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

    const row = `
      <div class="flex items-center justify-between bg-white dark:bg-gray-800/80 p-3 rounded-xl border border-gray-200 dark:border-gray-600 gap-2 shadow-sm">
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <span class="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-bold w-6 h-6 flex items-center justify-center rounded-md text-xs shrink-0">${idx + 1}</span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-gray-800 dark:text-white truncate" title="${item.materialName}">${item.materialName}</p>
            <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 truncate">
              <span title="${item.destinoName}">A: <span class="text-gray-700 dark:text-gray-300">${item.destinoName}</span></span>
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
      <span class="text-gray-600 dark:text-gray-300 truncate pr-3" title="${tipo}">${tipo}</span>
      <span class="text-emerald-700 dark:text-emerald-400 font-bold bg-emerald-100 dark:bg-emerald-900/30 px-2 rounded">${conteoTipos[tipo]}</span>
    </div>
  `).join("");
}

function removerItemLista(index) {
  AppState.cargoItems.splice(index, 1);
  renderizarListaItems();
}

// ==========================================
// 8. EMISIÓN OPTIMISTA DE CARGOS (LATENCIA 0ms)
// ==========================================
async function handleFormSubmit(e) {
  e.preventDefault();

  const chofer = document.getElementById("hdChofer").value;
  const vehiculo = document.getElementById("hdVehiculo").value;
  const area = document.getElementById("hdArea").value || document.getElementById("inArea").value.trim();

  if (!area) return mostrarAlerta("Es obligatorio especificar el ÁREA RESPONSABLE.", "error", "Falta Área");
  if (!chofer) return mostrarAlerta("Es obligatorio seleccionar un CHOFER.", "error", "Falta Chofer");
  if (!vehiculo) return mostrarAlerta("Es obligatorio seleccionar la PLACA.", "error", "Falta Vehículo");
  if (AppState.cargoItems.length === 0) return mostrarAlerta("Añade al menos un MATERIAL a la lista.", "error", "Lista Vacía");
  if (isSignatureEmpty) return mostrarAlerta("El chofer debe firmar la conformidad.", "error", "Firma Requerida");

  // 1. Compresión Edge de la firma (< 8KB)
  const firmaComprimida = SyncEngine.compressSignature(signaturePad);
  if (!firmaComprimida) return mostrarAlerta("El trazo de firma es demasiado corto.", "error", "Firma Inválida");

  // 2. Generación de ID Local Optimista (LOC-XXXXXX)
  const idLocal = `LOC-${Date.now().toString().slice(-6)}`;
  const choferCat = AppState.datos.choferes.find(c => c.ID_CHFR === chofer);
  const vehiculoCat = AppState.datos.vehiculos.find(v => v.PLACA === vehiculo);
  const ahora = new Date();
  const fechaFormat = `${ahora.getDate().toString().padStart(2, '0')}/${(ahora.getMonth()+1).toString().padStart(2, '0')}/${ahora.getFullYear()} ${ahora.getHours().toString().padStart(2, '0')}:${ahora.getMinutes().toString().padStart(2, '0')}:${ahora.getSeconds().toString().padStart(2, '0')}`;

  const materialesPayload = AppState.cargoItems.map((i) => ({
      id_memb: i.materialId,
      materialName: i.materialName,
      cantidad: i.cantidad,
      destino: i.destinoId
  }));

  // 3. Actualización Instantánea de Estado Local e IndexedDB
  const nuevoCargoOptimista = {
      idCargo: idLocal,
      isLocalSyncPending: true,
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
          EMISOR: area
      }))
  };

  AppState.cargosActivos.unshift(nuevoCargoOptimista);
  await SyncEngine.saveCache('cargosActivos', AppState.cargosActivos);

  // 4. Encolar en Outbox (Fire & Forget en segundo plano)
  await SyncEngine.enqueueMutation('saveCargo', {
      data: {
          localIdRef: idLocal,
          chofer,
          vehiculo,
          area,
          firma: firmaComprimida,
          gestorNombre: AppState.user ? AppState.user.nombre : 'Usuario Desconocido',
          gestorCorreo: AppState.user ? AppState.user.usuario : 'almacenpt@lagenovesa.com.pe',
          materiales: materialesPayload
      }
  });

  // 5. Impresión opcional inmediata (sin esperar a Google Sheets)
  if (document.getElementById("chkAutoPrint")?.checked) {
      generarDocumentoImpresion(idLocal);
  }

  // 6. Limpieza instantánea de UI y Feedback Toast
  mostrarToast(`Cargo ${idLocal} registrado. Sincronizando en segundo plano...`);
  document.getElementById("cargoForm").reset();
  ["hdArea", "hdChofer", "hdVehiculo", "hdDestino", "hdMaterial"].forEach((id) => (document.getElementById(id).value = ""));
  AppState.cargoItems = [];
  renderizarListaItems();
  limpiarFirma();
}

// ==========================================
// 9. MÓDULO DE DESCARGOS + SEMÁFORO SLA
// ==========================================
document.getElementById("tabEmitir").addEventListener("click", () => {
  document.getElementById("viewEmitir").classList.remove("hidden");
  document.getElementById("viewDescargo").classList.add("hidden");
  document.getElementById("viewHistorico").classList.add("hidden");
  document.getElementById("tabEmitir").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 bg-blue-600 rounded-xl text-xs md:text-sm font-bold text-white shadow-md transition-all";
  document.getElementById("tabDescargo").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
  document.getElementById("tabHistorico").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
});

document.getElementById("tabDescargo").addEventListener("click", () => {
  document.getElementById("viewDescargo").classList.remove("hidden");
  document.getElementById("viewEmitir").classList.add("hidden");
  document.getElementById("viewHistorico").classList.add("hidden");
  document.getElementById("tabDescargo").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 bg-emerald-600 rounded-xl text-xs md:text-sm font-bold text-white shadow-md transition-all";
  document.getElementById("tabEmitir").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
  document.getElementById("tabHistorico").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
  
  renderizarCargosFiltrados();
  SyncEngine.pullLatestState();
});

document.getElementById("tabHistorico").addEventListener("click", () => {
  document.getElementById("viewHistorico").classList.remove("hidden");
  document.getElementById("viewEmitir").classList.add("hidden");
  document.getElementById("viewDescargo").classList.add("hidden");
  document.getElementById("tabHistorico").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 bg-blue-600 rounded-xl text-xs md:text-sm font-bold text-white shadow-md transition-all";
  document.getElementById("tabEmitir").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
  document.getElementById("tabDescargo").className = "flex-1 lg:flex-none px-4 md:px-5 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-xs md:text-sm font-bold transition-all";
  
  renderizarHistorico();
  SyncEngine.pullLatestState();
});

document.getElementById("btnRefreshCargos").addEventListener("click", () => {
    mostrarToast("Sincronizando viajes...");
    SyncEngine.processQueue().then(() => SyncEngine.pullLatestState());
});
document.getElementById("inBuscarCargo").addEventListener("input", renderizarCargosFiltrados);
document.getElementById("selFiltroColumna").addEventListener("change", renderizarCargosFiltrados);

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

/**
 * Calcula antigüedad del viaje en horas y devuelve badge SLA (O(1))
 */
function calcularBadgeSLA(fechaLatina) {
  if (!fechaLatina) return '';
  const partes = String(fechaLatina).split(/[ \/:-]+/);
  if (partes.length < 3) return '';

  const fechaSalida = new Date(
    parseInt(partes[2], 10),
    parseInt(partes[1], 10) - 1,
    parseInt(partes[0], 10),
    parseInt(partes[3] || 0, 10),
    parseInt(partes[4] || 0, 10),
    parseInt(partes[5] || 0, 10)
  );

  const diffHoras = Math.floor((Date.now() - fechaSalida.getTime()) / (1000 * 60 * 60));
  if (isNaN(diffHoras) || diffHoras < 0) return '';

  if (diffHoras >= 48) {
    const dias = Math.floor(diffHoras / 24);
    return `<span class="bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-300 dark:border-red-500/30 px-2 py-0.5 rounded text-[10px] font-bold font-mono" title="Retorno crítico (+48h)">⚠️ ${dias}d ${diffHoras % 24}h</span>`;
  }
  if (diffHoras >= 24) {
    return `<span class="bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-500/30 px-2 py-0.5 rounded text-[10px] font-bold font-mono" title="Retorno demorado (+24h)">⏳ ${diffHoras}h</span>`;
  }
  return `<span class="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 px-2 py-0.5 rounded text-[10px] font-mono">${diffHoras}h</span>`;
}

function renderizarCargosFiltrados() {
  renderizarKPIsDescargos();

  let filtrados = [...AppState.cargosActivos];
  const searchTerm = document.getElementById("inBuscarCargo").value.toLowerCase().trim();
  const filtroColumna = document.getElementById("selFiltroColumna").value;

  if (filtroSoloCriticosSLA) {
    filtrados = filtrados.filter(c => calcularHorasTranscurridas(c.hora) >= 48);
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

    let filtroSoloCriticosSLA = false;

window.toggleFiltroCriticosSLA = function() {
  filtroSoloCriticosSLA = !filtroSoloCriticosSLA;
  renderizarCargosFiltrados();
};

window.filtrarPorChoferKPI = function(nombreChofer) {
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

function calcularHorasTranscurridas(fechaLatina) {
  if (!fechaLatina) return 0;
  const p = String(fechaLatina).split(/[ \/:-]+/);
  if (p.length < 3) return 0;
  const f = new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10), parseInt(p[3] || 0, 10), parseInt(p[4] || 0, 10));
  return Math.max(0, Math.floor((Date.now() - f.getTime()) / 3600000));
}

function renderizarKPIsDescargos() {
  const container = document.getElementById("kpiDescargosContainer");
  const matContainer = document.getElementById("kpiMaterialesCalle");
  if (!container || !matContainer) return;

  let totalUnidadesCalle = 0;
  let totalM3Calle = 0;
  let viajesCriticos48h = 0;
  const deudaPorChofer = {};
  const deudaPorMaterial = {};

  // Mapa rápido O(1) de materiales
  const matMap = new Map(AppState.datos.materiales.map(m => [m.ID_MEMB, m]));

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

        const matObj = matMap.get(d.MATERIAL);
        const m3Unit = matObj && matObj.M3 ? parseFloat(String(matObj.M3).replace(",", ".")) : 0;
        const matNombre = matObj ? matObj.DESCRIPCION : (d.MATERIAL || "Otro");

        totalM3Calle += (m3Unit * deuda);
        deudaPorMaterial[matNombre] = (deudaPorMaterial[matNombre] || 0) + deuda;
      }
    });

    if (deudaViaje > 0) {
      const ch = cargo.choferNombre || "Desconocido";
      deudaPorChofer[ch] = (deudaPorChofer[ch] || 0) + deudaViaje;
    }
  });

  // Top deudor
  let topChofer = "Sin deuda";
  let topDeuda = 0;
  Object.entries(deudaPorChofer).forEach(([chofer, cant]) => {
    if (cant > topDeuda) { topDeuda = cant; topChofer = chofer; }
  });

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

    <div onclick="toggleFiltroCriticosSLA()" title="Clic para filtrar viajes con +48h" class="cursor-pointer transition-all rounded-2xl p-4 shadow-sm border ${filtroSoloCriticosSLA ? 'bg-red-100 dark:bg-red-900/40 border-red-500 ring-2 ring-red-500/40' : 'bg-gray-50 dark:bg-gray-900/70 border-gray-200 dark:border-gray-700/80 hover:border-red-400'}">
      <div class="flex justify-between items-center">
        <p class="text-[10px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400">Alerta SLA (+48h)</p>
        <span class="text-[10px] text-gray-400">${filtroSoloCriticosSLA ? 'Filtro activo ✕' : 'Filtrar'}</span>
      </div>
      <div class="flex items-baseline justify-between mt-1">
        <span class="text-2xl font-black ${viajesCriticos48h > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-200'}">${viajesCriticos48h}</span>
        <span class="text-[11px] text-gray-500">Retorno demorado</span>
      </div>
    </div>

    <div onclick="${topDeuda > 0 ? `filtrarPorChoferKPI('${topChofer.replace(/'/g, "\\'")}')` : ''}" title="Clic para filtrar este chofer" class="cursor-pointer bg-gray-50 dark:bg-gray-900/70 border border-gray-200 dark:border-gray-700/80 hover:border-pink-400 rounded-2xl p-4 shadow-sm transition-all">
      <p class="text-[10px] font-bold uppercase tracking-wider text-pink-600 dark:text-pink-400">Mayor Retención</p>
      <div class="flex items-baseline justify-between mt-1 gap-2">
        <span class="text-sm font-extrabold text-gray-900 dark:text-white truncate" title="${topChofer}">${topChofer}</span>
        <span class="text-xs font-black text-pink-600 dark:text-pink-400 shrink-0">${topDeuda} und.</span>
      </div>
    </div>
  `;

  // Chips por tipo de embalaje fuera de planta
  const materialesKeys = Object.keys(deudaPorMaterial);
  if (materialesKeys.length === 0) {
    matContainer.innerHTML = "";
  } else {
    matContainer.innerHTML = `<span class="text-[10px] font-bold uppercase text-gray-400 mr-1">En ruta:</span>` +
      materialesKeys.map(mat => `
        <span class="inline-flex items-center gap-1.5 text-xs bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-2.5 py-1 rounded-lg text-gray-700 dark:text-gray-300 shadow-sm">
          <span class="truncate max-w-[180px]" title="${mat}">${mat}</span>
          <strong class="text-blue-600 dark:text-blue-400 font-mono">${deudaPorMaterial[mat]}</strong>
        </span>
      `).join("");
  }
}

  renderizarTablaUI(filtrados);
}

function renderizarTablaUI(cargos) {
  const grid = document.getElementById("gridCargos");

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
      const lleva = parseInt(d.LLEVA || 0);
      const devuelve = parseInt(d.DEVUELVE || 0);
      totalDeuda += parseInt(d.DEUDA !== undefined && d.DEUDA !== "" ? d.DEUDA : lleva - devuelve);
    });

    const horaSalida = cargo.hora || "--/--/---- --:--:--";
    const isLocal = String(cargo.idCargo).startsWith("LOC-");
    const slaBadge = calcularBadgeSLA(horaSalida);
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
      <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors group cursor-pointer" onclick="abrirDetalle('${cargo.idCargo}')" title="Clic para liquidar o auditar">
        <td class="px-4 py-3 font-mono text-xs ${isLocal ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-500 dark:text-gray-400'}">
          <div class="flex items-center gap-1.5">
            ${isLocal ? `<span class="w-2 h-2 rounded-full bg-blue-500" title="Pendiente de sincronización"></span>` : ''}
            ${cargo.idCargo}
          </div>
        </td>
        <td class="px-4 py-3"><span class="bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/50 px-2 py-1 rounded text-xs font-bold">${cargo.placa || "S/N"}</span></td>
        <td class="px-4 py-3 font-bold text-gray-800 dark:text-gray-200 truncate max-w-[200px]">${cargo.choferNombre}</td>
        <td class="px-4 py-3 font-mono text-xs tracking-wider">
          <div class="flex items-center gap-2">
            <span class="text-emerald-600 dark:text-emerald-400/80">${horaSalida}</span>
            ${slaBadge}
          </div>
        </td>
        <td class="px-4 py-3 text-center align-middle">${badgeEstadoHTML}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  grid.innerHTML = html;
}

// ==========================================
// 10. MODAL DETALLE, AUDITORÍA DE FIRMA Y LIQUIDACIÓN 1-TAP
// ==========================================
function abrirDetalle(idCargo) {
  const cargo = AppState.cargosActivos.find((c) => c.idCargo === idCargo);
  if (!cargo) return;

  let totalMaterialesLlevados = 0, totalDeudaViaje = 0, totalM3Llevado = 0;
  const destinosSet = new Set(), resumenTipos = {};

  const detallesProcesados = cargo.detalles.map((d) => {
    const lleva = parseInt(d.LLEVA || 0), devuelve = parseInt(d.DEVUELVE || 0);
    const deuda = parseInt(d.DEUDA !== undefined && d.DEUDA !== "" ? d.DEUDA : lleva - devuelve);
    const destinoCat = AppState.datos.destinos.find((x) => x.ID_DSTN === d.DESTINO);
    const materialCat = AppState.datos.materiales.find((m) => m.ID_MEMB === d.MATERIAL);
    const m3Llevado = (materialCat && materialCat.M3 ? parseFloat(String(materialCat.M3).replace(",", ".")) : 0) * lleva;
    return { ...d, lleva, devuelve, deuda, nombreDestino: destinoCat ? destinoCat.REFERENCIA : d.DESTINO || "Desconocido", nombreMaterial: materialCat ? materialCat.DESCRIPCION : d.MATERIAL || "Desconocido", m3Llevado };
  });

  detallesProcesados.forEach((d) => {
    totalMaterialesLlevados += d.lleva; totalDeudaViaje += d.deuda; totalM3Llevado += d.m3Llevado;
    destinosSet.add(d.nombreDestino);
    resumenTipos[d.nombreMaterial] = (resumenTipos[d.nombreMaterial] || 0) + d.lleva;
  });

  document.getElementById("mdlTitleCargo").textContent = cargo.idCargo;
  document.getElementById("mdlBadgeSLA").innerHTML = calcularBadgeSLA(cargo.hora);
  document.getElementById("mdlChofer").textContent = cargo.choferNombre;
  document.getElementById("mdlHora").textContent = cargo.hora || "--";
  
  const areaRaw = cargo.detalles[0]?.EMISOR || cargo.area || "Almacén PT";
  const areaCat = AppState.datos.destinos.find((x) => x.ID_DSTN === areaRaw);
  document.getElementById("mdlDespacho").textContent = areaCat ? areaCat.REFERENCIA : areaRaw;
  document.getElementById("mdlGestor").textContent = cargo.gestor || "No registrado";

  // Visor de Firma Digital Capturada
  const firmaContainer = document.getElementById("mdlFirmaContainer");
  const imgFirma = document.getElementById("mdlImgFirma");
  if (cargo.firmaCargo && cargo.firmaCargo.length > 20) {
    imgFirma.src = cargo.firmaCargo;
    firmaContainer.classList.remove("hidden");
  } else {
    firmaContainer.classList.add("hidden");
  }

  const vehiculoObj = AppState.datos.vehiculos.find(v => v.PLACA === cargo.placa);
  let fotoUrl = "https://images.unsplash.com/photo-1601584115197-04ecc0da31d7?auto=format&fit=crop&q=80&w=800";
  if (vehiculoObj && vehiculoObj.FOTO_VEHICULO) fotoUrl = String(vehiculoObj.FOTO_VEHICULO).trim();

  document.getElementById("imgVehiculoModal").src = fotoUrl;
  document.getElementById("mdlPlaca").textContent = vehiculoObj ? vehiculoObj.DISPLAY_NAME : cargo.placa || "S/N";

  const mdlBadge = document.getElementById("mdlBadgeDeuda");
  if (totalDeudaViaje > 0) {
    mdlBadge.innerHTML = `<span class="bg-pink-600 text-white font-bold px-3 py-1 rounded-lg text-xs flex items-center gap-1.5 w-fit shadow-lg"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Debe ${totalDeudaViaje} und.</span>`;
  } else if (totalDeudaViaje < 0) {
    mdlBadge.innerHTML = `<span class="bg-amber-500 text-white font-bold px-3 py-1 rounded-lg text-xs w-fit shadow-lg">Excedente: ${Math.abs(totalDeudaViaje)}</span>`;
  } else {
    mdlBadge.innerHTML = `<span class="bg-emerald-600 text-white font-bold px-3 py-1 rounded-lg text-xs w-fit shadow-lg">Completado / Sin deuda</span>`;
  }

  document.getElementById("mdlDestinosCount").textContent = `(${destinosSet.size})`;
  document.getElementById("mdlDestinosList").innerHTML = Array.from(destinosSet).map((dest) => `<div class="truncate" title="${dest}">${dest}</div>`).join("");
  document.getElementById("mdlTiposCount").textContent = `(${Object.keys(resumenTipos).length})`;
  document.getElementById("mdlTiposList").innerHTML = Object.keys(resumenTipos).map((tipo) => `<div class="truncate" title="${tipo}"><span class="text-emerald-600 dark:text-emerald-400 font-bold mr-1">${resumenTipos[tipo]}</span> ${tipo}</div>`).join("");

  document.getElementById("mdlTotalMateriales").outerHTML = `
    <span id="mdlTotalMateriales" class="flex items-center gap-2">
      <span class="bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-white px-2 py-0.5 rounded text-xs font-bold">${totalMaterialesLlevados}</span>
      <span class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-600 text-emerald-600 dark:text-emerald-400 font-mono px-2 py-0.5 rounded text-[11px] shadow-sm">
        ${totalM3Llevado.toFixed(3)} m³
      </span>
    </span>
  `;

  const tablaHTML = detallesProcesados.map((det) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors border-b border-gray-200 dark:border-gray-800 last:border-0 ${det.deuda <= 0 ? "opacity-60 bg-gray-50 dark:bg-gray-900/30" : ""}">
      <td class="px-3 py-3 text-gray-600 dark:text-gray-400 align-middle">${det.nombreDestino}</td>
      <td class="px-3 py-3 align-middle">
        <div class="${det.deuda <= 0 ? "text-gray-500" : "text-gray-800 dark:text-gray-200"} font-medium leading-snug">${det.nombreMaterial}</div>
        <div class="text-[10px] text-emerald-600 dark:text-emerald-400/80 font-mono mt-0.5">Vol: ${det.m3Llevado.toFixed(3)} m³</div>
      </td>
      <td class="px-3 py-3 align-middle">
         <div class="flex items-center justify-center gap-2 text-xs bg-gray-50 dark:bg-gray-900/50 rounded-lg p-1.5 border border-gray-200 dark:border-gray-700 w-max mx-auto">
            <div class="flex flex-col items-center"><span class="text-[9px] text-gray-500 uppercase">Lleva</span><span class="text-gray-800 dark:text-white font-bold">${det.lleva}</span></div>
            <div class="w-px h-6 bg-gray-200 dark:bg-gray-700"></div>
            <div class="flex flex-col items-center"><span class="text-[9px] text-gray-500 uppercase">Devuelto</span><span class="text-emerald-600 dark:text-emerald-400 font-bold">${det.devuelve}</span></div>
            <div class="w-px h-6 bg-gray-200 dark:bg-gray-700"></div>
            <div class="flex flex-col items-center"><span class="text-[9px] text-gray-500 uppercase">Deuda</span><span class="${det.deuda > 0 ? "text-red-600 dark:text-red-400" : det.deuda < 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-500"} font-bold">${det.deuda}</span></div>
         </div>
      </td>
      <td class="px-3 py-3 align-middle w-28">
        <div class="flex items-center gap-1">
          <input type="number" min="0" inputmode="numeric" data-id="${det.ID_DETALLE}" data-deuda="${det.deuda}" placeholder="${det.deuda <= 0 ? "-" : "0"}" 
                 class="w-16 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded p-1.5 text-center text-emerald-600 dark:text-emerald-400 font-bold focus:border-emerald-500 outline-none mdl-return-input transition-colors disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                 ${det.deuda <= 0 ? "disabled" : ""}>
          ${det.deuda > 0 ? `<button type="button" onclick="setMaxInput(this, ${det.deuda})" title="Completar deuda (${det.deuda})" class="px-1.5 py-1.5 text-[10px] font-bold bg-gray-100 dark:bg-gray-800 hover:bg-emerald-600 hover:text-white text-gray-600 dark:text-gray-300 rounded border border-gray-300 dark:border-gray-600 transition-colors">Max</button>` : ''}
        </div>
      </td>
    </tr>
  `).join("");
  
  const tb = document.getElementById("mdlTablaMateriales");
  tb.innerHTML = tablaHTML;

  document.getElementById("btnLiquidarModal").setAttribute("onclick", `procesarLiquidacionModal('${cargo.idCargo}')`);
  document.getElementById("btnPrintModal").onclick = () => generarDocumentoImpresion(cargo.idCargo);

  const inputsRetorna = document.querySelectorAll(".mdl-return-input:not([disabled])");
  inputsRetorna.forEach((input, index) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (index < inputsRetorna.length - 1) inputsRetorna[index + 1].focus();
        else document.getElementById("btnLiquidarModal").focus();
      }
    });
  });

  const modal = document.getElementById("modalDetalle");
  const modalContent = document.getElementById("modalDetalleContent");
  modal.classList.remove("hidden");

  setTimeout(() => {
    modal.classList.remove("opacity-0");
    modalContent.classList.remove("scale-95");
    if (inputsRetorna.length > 0) inputsRetorna[0].focus();
  }, 50);
}

// ==========================================
// HELPERS DE LIQUIDACIÓN 1-TAP
// ==========================================
window.setMaxInput = function(btn, deuda) {
  const input = btn.parentElement.querySelector('input');
  if (input && !input.disabled) {
    input.value = deuda;
    input.classList.add('border-emerald-500');
  }
};

window.autollenarDevolucionTotal = function() {
  const inputs = document.querySelectorAll(".mdl-return-input:not([disabled])");
  let count = 0;
  inputs.forEach(input => {
    const deuda = parseInt(input.getAttribute("data-deuda") || 0, 10);
    if (deuda > 0) {
      input.value = deuda;
      count++;
    }
  });
  if (count > 0) {
    mostrarToast(`Autocompletadas ${count} líneas al 100%. Presiona Guardar.`);
    document.getElementById("btnLiquidarModal").focus();
  }
};

window.limpiarInputsLiquidacion = function() {
  document.querySelectorAll(".mdl-return-input:not([disabled])").forEach(input => {
    input.value = "";
  });
};

// ==========================================
// 11. MÓDULO HISTÓRICO (LECTURA INSTANTÁNEA)
// ==========================================
document.getElementById("btnRefreshHistorico").addEventListener("click", () => {
    mostrarToast("Actualizando histórico...");
    SyncEngine.processQueue().then(() => SyncEngine.pullLatestState());
});
document.getElementById("inBuscarHistorico").addEventListener("input", renderizarHistorico);
document.getElementById("inDesdeHistorico").addEventListener("change", renderizarHistorico);
document.getElementById("inHastaHistorico").addEventListener("change", renderizarHistorico);

window.setHistorySort = function (key) {
  if (AppState.sortHistoryConfig.key === key) AppState.sortHistoryConfig.asc = !AppState.sortHistoryConfig.asc;
  else { AppState.sortHistoryConfig.key = key; AppState.sortHistoryConfig.asc = true; }
  renderizarHistorico();
};

function getHistorySortIcon(key) {
  if (AppState.sortHistoryConfig.key !== key) return `<span class="text-gray-400 dark:text-gray-600 ml-1">↕</span>`;
  return AppState.sortHistoryConfig.asc ? `<span class="text-blue-600 dark:text-blue-400 ml-1">↑</span>` : `<span class="text-blue-600 dark:text-blue-400 ml-1">↓</span>`;
}

function renderizarHistorico() {
  const grid = document.getElementById("gridHistorico");
  const searchTerm = document.getElementById("inBuscarHistorico").value.toLowerCase().trim();
  const fechaDesde = document.getElementById("inDesdeHistorico").value; 
  const fechaHasta = document.getElementById("inHastaHistorico").value; 

  let filtrados = AppState.historial.map(det => {
    const materialObj = AppState.datos.materiales.find(m => m.ID_MEMB === det.material);
    const destinoObj = AppState.datos.destinos.find(d => d.ID_DSTN === det.destino);
    const emisorObj = AppState.datos.destinos.find(d => d.ID_DSTN === det.emisor);
    const idChoferLimpio = det.chofer ? String(det.chofer).replace(/'/g, '') : '';
    const choferObj = AppState.datos.choferes.find(c => c.ID_CHFR === idChoferLimpio);

    return {
      ...det,
      materialName: materialObj ? materialObj.DESCRIPCION : det.material,
      destinoName: destinoObj ? destinoObj.REFERENCIA : det.destino,
      emisorName: emisorObj ? emisorObj.REFERENCIA : (det.emisor || 'Almacén PT'),
      choferName: choferObj ? choferObj.NOMBRE : det.chofer
    };
  });

  AppState.historialFiltrado = filtrados;

  if (fechaDesde || fechaHasta) {
    filtrados = filtrados.filter(item => {
      if (!item.horaCargo) return false;
      const datePart = item.horaCargo.split(' ')[0], parts = datePart.split('/');
      if(parts.length !== 3) return true; 
      const itemDateISO = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      let pasaDesde = true, pasaHasta = true;
      if (fechaDesde) pasaDesde = itemDateISO >= fechaDesde;
      if (fechaHasta) pasaHasta = itemDateISO <= fechaHasta;
      return pasaDesde && pasaHasta;
    });
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

  if (filtrados.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-500 dark:text-gray-400 py-12 font-bold bg-white dark:bg-gray-800/40 rounded-2xl border border-gray-200 dark:border-gray-700/50 italic mx-4 md:mx-0">No se encontraron movimientos que coincidan con los filtros.</div>`;
    return;
  }

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
            <th class="px-4 py-3 text-center">Estado</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-800/60">
  `;

  filtrados.forEach(row => {
    let badgeEstadoHTML = "";
    const deuda = parseInt(row.deuda);
    
    if (deuda > 0) {
      badgeEstadoHTML = `<span class="bg-pink-50 dark:bg-pink-600/20 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Pendiente</span>`;
    } else if (deuda < 0) {
      badgeEstadoHTML = `<span class="bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Excedente</span>`;
    } else {
      badgeEstadoHTML = `<span class="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Cerrado</span>`;
    }

    html += `
      <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors group">
        <td class="px-4 py-3.5 font-mono text-gray-500 dark:text-gray-400 text-[11px] cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-300 transition-colors celda-trazabilidad border-l-2 border-transparent hover:border-blue-500" onclick="abrirTrazabilidad(event, '${row.idDetalle}')">
          <div class="flex items-center gap-1.5" title="Click para ver auditoría">
            <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            ${row.horaCargo || '--'}
          </div>
        </td>
        <td class="px-4 py-3.5 font-mono text-blue-600 dark:text-blue-400 font-bold tracking-tight">${row.idCargo || '--'}</td>
        <td class="px-4 py-3.5 truncate max-w-[150px] font-medium text-gray-800 dark:text-gray-200" title="${row.choferName}">${row.choferName}</td>
        <td class="px-4 py-3.5 truncate max-w-[200px]" title="${row.materialName}">${row.materialName}</td>
        <td class="px-4 py-3.5 truncate max-w-[150px] text-gray-500 dark:text-gray-400" title="${row.destinoName}">${row.destinoName}</td>
        <td class="px-3 py-3.5 text-center text-gray-900 dark:text-white font-black bg-gray-50 dark:bg-gray-900/30">${row.lleva}</td>
        <td class="px-3 py-3.5 text-center text-emerald-600 dark:text-emerald-400 font-black bg-emerald-50 dark:bg-emerald-900/10">${row.devuelve}</td>
        <td class="px-3 py-3.5 text-center ${deuda > 0 ? 'text-pink-600 dark:text-pink-400 bg-pink-50 dark:bg-pink-900/10' : 'text-gray-500'} font-black">${deuda}</td>
        <td class="px-4 py-3.5 text-center">${badgeEstadoHTML}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  grid.innerHTML = html;

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
      <p class="text-[10px] font-bold uppercase tracking-wider text-pink-600 dark:text-pink-400">Saldo Pendiente</p>
      <p class="text-xl font-black text-pink-600 dark:text-pink-400 mt-0.5">${totalPendiente.toLocaleString()} <span class="text-xs font-normal text-gray-500">und.</span></p>
    </div>
  `;
}

// Guardamos el último subconjunto filtrado para exportación exacta
let ultimoHistoricoExportable = [];

window.exportarHistoricoCSV = function() {
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

  // BOM UTF-8 (\uFEFF) para apertura nativa perfecta en Microsoft Excel
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
    
}

// ==========================================
// 12. MINIMODAL TRAZABILIDAD
// ==========================================
window.abrirTrazabilidad = function(e, idDetalle) {
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
          <p class="text-xs text-gray-700 dark:text-gray-200 mb-1"><span class="text-gray-500 mr-1">Gestor:</span> ${row.gestorCargo || 'No registrado'}</p>
          <p class="text-xs text-gray-700 dark:text-gray-200 mb-2"><span class="text-gray-500 mr-1">Ruta:</span> <span class="font-bold text-gray-900 dark:text-gray-100">${row.emisorName}</span> ➔ <span class="font-bold text-gray-900 dark:text-gray-100">${row.destinoName}</span></p>
          <p class="text-[10px] text-blue-700 dark:text-blue-300 font-mono bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded w-fit">${row.horaCargo || '--'}</p>
        </div>
        
        <div class="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-500/30 p-3 rounded-lg shadow-sm">
          <p class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
            2. Descargo / Devolución
          </p>
          ${row.horaDescargo ? `
             <p class="text-xs text-gray-700 dark:text-gray-200 mb-2"><span class="text-gray-500 mr-1">Receptor:</span> ${row.gestorDescargo || 'No registrado'}</p>
             <p class="text-[10px] text-emerald-700 dark:text-emerald-300 font-mono bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 rounded w-fit">${row.horaDescargo}</p>
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
// 13. MOTOR DE IMPRESIÓN OFFLINE-READY
// ==========================================
function generarDocumentoImpresion(idCargo) {
  const cargo = AppState.cargosActivos.find((c) => c.idCargo === idCargo);
  if (!cargo) return;

  let totalLlevado = 0;
  let totalM3Llevado = 0;
  const destinosSet = new Set();
  const resumenTipos = {};

  const filasTablaHTML = cargo.detalles.map((d) => {
      const lleva = parseInt(d.LLEVA || 0);
      totalLlevado += lleva;
      const destinoCat = AppState.datos.destinos.find((x) => x.ID_DSTN === d.DESTINO);
      const nombreDestino = destinoCat ? destinoCat.REFERENCIA : d.DESTINO || "Desconocido";
      const materialCat = AppState.datos.materiales.find((m) => m.ID_MEMB === d.MATERIAL);
      const nombreMaterial = materialCat ? materialCat.DESCRIPCION : d.MATERIAL || "Desconocido";
      
      const m3Unitario = materialCat && materialCat.M3 ? parseFloat(String(materialCat.M3).replace(",", ".")) : 0;
      totalM3Llevado += (m3Unitario * lleva);

      destinosSet.add(nombreDestino);
      resumenTipos[nombreMaterial] = (resumenTipos[nombreMaterial] || 0) + lleva;

      return `
      <tr>
        <td style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb; color: #4b5563;">${nombreDestino}</td>
        <td style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb; font-weight: 500; color: #1f2937;">${nombreMaterial}</td>
        <td style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb; text-align: center; font-weight: 700; color: #111827;">${lleva}</td>
        <td style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb; text-align: center;"></td>
      </tr>
    `;
    }).join("");

  const destinosHTML = Array.from(destinosSet).map((dest) => `<div>• ${dest}</div>`).join("");
  const tiposHTML = Object.keys(resumenTipos).map((tipo) => `<div><span style="font-weight:700; margin-right:4px;">${resumenTipos[tipo]}</span> ${tipo}</div>`).join("");
  const areaRaw = cargo.detalles[0]?.AREA || cargo.area || "Almacén PT";
  const areaCat = AppState.datos.destinos.find((x) => x.ID_DSTN === areaRaw);
  const areaResponsable = areaCat ? areaCat.REFERENCIA : areaRaw;

  const htmlPlantilla = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Cargo_${cargo.idCargo}_${cargo.choferNombre.replace(/\s+/g, "")}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, -apple-system, sans-serif; background-color: #f3f4f6; color: #1f2937; font-size: 12px; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        .a4-container { max-width: 21cm; margin: 1rem auto; background: white; padding: 1cm; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f2937; padding-bottom: 12px; margin-bottom: 16px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: #f9fafb; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th { background: #1f2937; color: white; font-size: 10px; text-transform: uppercase; padding: 6px 8px; text-align: left; }
        tr:nth-child(even) { background-color: #f9fafb; }
        .footer-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 16px; }
        .btn-float { position: fixed; bottom: 24px; right: 24px; background: #1f2937; color: white; border: none; padding: 12px 24px; border-radius: 9999px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        @media print {
            body { background: white; }
            .a4-container { margin: 0; padding: 0; box-shadow: none; max-width: 100%; }
            .no-print { display: none !important; }
            @page { size: A4 portrait; margin: 0.5cm; }
        }
    </style>
</head>
<body>
    <button onclick="window.print()" class="btn-float no-print">🖨️ Imprimir / Guardar PDF</button>

    <div class="a4-container">
        <div class="header">
            <div style="width: 140px;">
                <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='60 20 280 160'%3E%3Cpath d='m200 25 135 47v56l-135 47-135-47V72z' fill='%23C51D23' stroke='%23C51D23' stroke-width='8' stroke-linejoin='round'/%3E%3Cpath d='m200 25 135 47v56l-135 47-135-47V72z' fill='none' stroke='%23B08D57' stroke-width='1' stroke-linejoin='round'/%3E%3Ctext x='200' y='86' font-family='Times, serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%23404040'%3ELA%3C/text%3E%3Ctext x='200' y='85' font-family='Times, serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%23FFF'%3ELA%3C/text%3E%3Ctext x='200' y='121' font-family='Times, serif' font-size='42' font-weight='bold' text-anchor='middle' fill='%23404040'%3EGENOVESA%3C/text%3E%3Ctext x='200' y='120' font-family='Times, serif' font-size='42' font-weight='bold' text-anchor='middle' fill='%23FFF'%3EGENOVESA%3C/text%3E%3Ctext x='200' y='145' font-family='Arial, sans-serif' font-size='12' text-anchor='middle' fill='%23FFF' letter-spacing='3'%3EDESDE 1977%3C/text%3E%3C/svg%3E" style="width:100%; height:auto;" alt="Logo La Genovesa">
            </div>
            <div style="text-align: right; margin-top: 8px;">
                <h1 style="font-size: 18px; font-weight: 800; text-transform: uppercase;">Cargo de Embalajes</h1>
                <p style="font-weight: 600; color: #4b5563;">La Genovesa Agroindustrias S.A.</p>
                <p style="font-size: 10px; color: #6b7280; text-transform: uppercase;">${areaResponsable}</p>
            </div>
        </div>

        <div class="info-grid">
            <div>
                <p style="font-size: 10px; color: #6b7280; font-weight: bold; text-transform: uppercase; margin-bottom: 4px;">Documento</p>
                <p><strong>N° Cargo:</strong> <span style="font-family: monospace; background: white; border: 1px solid #d1d5db; padding: 2px 4px; border-radius: 4px;">${cargo.idCargo}</span></p>
                <p style="margin-top: 4px;"><strong>Emisión:</strong> ${cargo.hora || "--"}</p>
            </div>
            <div>
                <p style="font-size: 10px; color: #6b7280; font-weight: bold; text-transform: uppercase; margin-bottom: 4px;">Transporte</p>
                <p><strong>Chofer:</strong> ${cargo.choferNombre}</p>
                <p style="margin-top: 4px;"><strong>Vehículo:</strong> <span style="font-family: monospace; background: white; border: 1px solid #d1d5db; padding: 2px 4px; border-radius: 4px;">${cargo.placa || "S/N"}</span></p>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 33%;">Destino</th>
                    <th style="width: 33%;">Material</th>
                    <th style="text-align: center;">Lleva</th>
                    <th style="text-align: center;">Devolución</th>
                </tr>
            </thead>
            <tbody style="border: 1px solid #e5e7eb;">
                ${filasTablaHTML}
            </tbody>
            <tfoot>
                <tr style="background: #f3f4f6; border-top: 1px solid #d1d5db;">
                    <td colspan="2" style="padding: 8px; text-align: right; font-weight: bold; color: #4b5563; font-size: 10px; text-transform: uppercase;">Total General del Viaje:</td>
                    <td style="padding: 8px; text-align: center; font-weight: 900; color: #1d4ed8; font-size: 14px;">${totalLlevado} und</td>
                    <td style="padding: 8px; text-align: center; font-family: monospace; color: #059669; font-weight: bold;">${totalM3Llevado.toFixed(3)} m³</td>
                </tr>
            </tfoot>
        </table>

        <div class="footer-grid">
            <div>
                <h4 style="font-size: 10px; font-weight: bold; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; padding-bottom: 2px; margin-bottom: 4px;">Destinos</h4>
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
                <p style="font-size: 10px; font-weight: bold; text-transform: uppercase; text-align: center;">${cargo.choferNombre}</p>
                <p style="font-size: 9px; color: #6b7280; text-transform: uppercase; text-align: center;">Firma de Conformidad</p>
            </div>
        </div>
    </div>
</body>
</html>`;

  const printWindow = window.open("", "_blank");
  if(printWindow) {
    printWindow.document.open();
    printWindow.document.write(htmlPlantilla);
    printWindow.document.close();
  }
}
