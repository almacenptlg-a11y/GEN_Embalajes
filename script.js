/**
 * @fileoverview Controlador Frontend & UI Optimista - GenLogistics Embalajes
 * @version 1.4.0
 * @architecture Zero-Latency Optimistic UI | Offline-First IndexedDB | Single Source of Truth
 */

// ==========================================
// 1. CONFIGURACIÓN GLOBAL Y ESTADO REACTIVO
// ==========================================
const API_URL = "https://script.google.com/macros/s/AKfycby8v3690-wU2hY9W-H2kI46uA-p_lV23qS-7b6mB7P18zX2qK4p4_vM6iN_e8q_p3A/exec";
const API_TOKEN = "GEN_EMB_2026_SECURE_KEY";

const AppState = {
  usuario: null,        // { nombre: string, rol: string }
  choferes: [],
  vehiculos: [],
  destinos: [],
  materiales: [],
  cargosActivos: [],
  historial: [],
  cargoSeleccionado: null,
  filtroHistorial: 'todos',
  busquedaHistorial: '',
  busquedaActivos: ''
};

// ==========================================
// 2. HELPERS CENTRALIZADOS (FECHA LIMA, ROLES, UNIFICACIÓN)
// ==========================================
function ahoraLimaStr() {
  const ahora = new Date();
  const dd = String(ahora.getDate()).padStart(2, '0');
  const mm = String(ahora.getMonth() + 1).padStart(2, '0');
  const yyyy = ahora.getFullYear();
  const hh = String(ahora.getHours()).padStart(2, '0');
  const min = String(ahora.getMinutes()).padStart(2, '0');
  const ss = String(ahora.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
}

function fechaLimaStr() {
  return ahoraLimaStr().split(' ')[0];
}

function esAdministrador() {
  const rol = String(AppState.usuario?.rol || '').trim().toUpperCase();
  return ['ADMIN', 'ADMINISTRADOR', 'SUPERADMIN', 'SISTEMAS'].includes(rol);
}

function mismoUsuario(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
}

function resolverNombreChofer(idOrName) {
  const clean = String(idOrName || '').replace(/^'+/, '').trim();
  const found = AppState.choferes.find(c => String(c.ID_CHFR || '').replace(/^'+/, '').trim() === clean);
  return found ? String(found.NOMBRE || '').trim() : (clean || 'Chofer Desconocido');
}

function resolverNombreMaterial(idMat) {
  const clean = String(idMat || '').trim();
  const found = AppState.materiales.find(m => String(m.ID_MEMB || '').trim() === clean);
  return found ? String(found.DESCRIPCION || found.MATERIAL || clean).trim() : clean;
}

/**
 * Fuente Única de Verdad (Single Source of Truth) para obtener cualquier cargo,
 * ya sea activo (con deuda != 0) o liquidado (reconstruido desde AppState.historial).
 */
function obtenerCargoUnificado(idCargo) {
  const targetId = String(idCargo || '').trim();
  if (!targetId) return null;

  const activo = AppState.cargosActivos.find(c => String(c.idCargo).trim() === targetId);
  if (activo) return activo;

  const filasHist = AppState.historial.filter(h => String(h.idCargo).trim() === targetId);
  if (filasHist.length === 0) return null;

  const base = filasHist[0];
  const detallesReconstruidos = filasHist.map(h => ({
    ID_DETALLE: h.idDetalle,
    ID_CARGO: h.idCargo,
    MATERIAL: h.material,
    LLEVA: Number(h.lleva || 0),
    DEVUELVE: Number(h.devuelve || 0),
    DEUDA: Number(h.deuda || 0),
    ESTADO: h.estado,
    EMISOR: h.emisor,
    DESTINO: h.destino,
    'HORA CARGO': h.horaCargo,
    'GESTOR CARGO': h.gestorCargo,
    'HORA DESCARGO': h.horaDescargo,
    'GESTOR DESCARGO': h.gestorDescargo,
    RESPONSABLE: h.chofer
  }));

  const tieneDeuda = detallesReconstruidos.some(d => Number(d.DEUDA) !== 0);

  return {
    idCargo: targetId,
    fecha: (base.horaCargo || '').split(' ')[0] || '',
    hora: base.horaCargo || '',
    choferId: base.chofer || '',
    choferNombre: resolverNombreChofer(base.chofer),
    placa: base.placa || 'S/N',
    gestor: base.gestorCargo || 'No registrado',
    firmaCargo: '',
    detalles: detallesReconstruidos,
    tieneDeuda
  };
}

/**
 * Sincroniza AppState.cargosActivos tras cualquier mutación optimista en un cargo
 * y persiste ambos stores en IndexedDB en O(1).
 */
async function recalcularEstadoCargoOptimista(cargo) {
  if (!cargo) return;
  cargo.tieneDeuda = cargo.detalles.some(d => {
    const lleva = Number(d.LLEVA || 0);
    const dev = Number(d.DEVUELVE || 0);
    const deuda = d.DEUDA !== undefined && d.DEUDA !== '' ? Number(d.DEUDA) : (lleva - dev);
    return deuda !== 0;
  });

  const idxActivo = AppState.cargosActivos.findIndex(c => c.idCargo === cargo.idCargo);
  if (cargo.tieneDeuda) {
    if (idxActivo === -1) AppState.cargosActivos.unshift(cargo);
    else AppState.cargosActivos[idxActivo] = cargo;
  } else if (idxActivo !== -1) {
    AppState.cargosActivos.splice(idxActivo, 1);
  }

  await Promise.all([
    SyncEngine.saveCache('cargosActivos', AppState.cargosActivos),
    SyncEngine.saveCache('historial', AppState.historial)
  ]);
}

// ==========================================
// 3. NOTIFICACIONES TOAST & ESTADO DE RED
// ==========================================
function mostrarToast(mensaje, tipo = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const estilos = {
    success: 'bg-emerald-600 text-white border-emerald-700',
    error: 'bg-rose-600 text-white border-rose-700',
    warning: 'bg-amber-500 text-slate-950 border-amber-600',
    info: 'bg-slate-800 text-white border-slate-700'
  };

  const toast = document.createElement('div');
  toast.className = `px-4 py-3 rounded-xl shadow-lg border text-sm font-medium flex items-center gap-2 transition-all duration-300 transform translate-y-2 opacity-0 ${estilos[tipo] || estilos.info}`;
  toast.innerHTML = `<span>${escapeHTML(mensaje)}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function actualizarIndicadorRed(pendingCount, isOnline) {
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;

  if (!isOnline) {
    badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300';
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> Offline (${pendingCount} en cola)`;
  } else if (pendingCount > 0) {
    badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-300';
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-600 animate-ping"></span> Sincronizando (${pendingCount})`;
  } else {
    badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300';
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span> En línea`;
  }
}

// ==========================================
// 4. INICIALIZACIÓN & HIDRATACIÓN OFFLINE-FIRST
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  registrarServiceWorker();
  inicializarSesion();
  inicializarCanvasFirma();
  configurarEventosUI();

  await SyncEngine.init({
    apiUrl: API_URL,
    token: API_TOKEN,
    onQueueChange: (count, online) => actualizarIndicadorRed(count, online),
    onRemoteDataSync: ({ cargosActivos, historial }) => {
      if (Array.isArray(cargosActivos)) AppState.cargosActivos = cargosActivos;
      if (Array.isArray(historial)) AppState.historial = historial;
      renderizarTodo();

      // Si el modal de detalle está abierto, refrescar sus líneas con la versión consolidada
      if (AppState.cargoSeleccionado) {
        const actualizado = obtenerCargoUnificado(AppState.cargoSeleccionado.idCargo);
        if (actualizado) {
          AppState.cargoSeleccionado = actualizado;
          renderizarDetalleModal(actualizado);
        }
      }
    },
    onSyncError: (msg) => mostrarToast(`Sincronización: ${msg}`, 'error')
  });

  await cargarDatosIniciales();
});

function registrarServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[SW] Registro omitido:', err);
    });
  }
}

function inicializarSesion() {
  const savedUser = localStorage.getItem('genlogistics_user');
  if (savedUser) {
    try {
      AppState.usuario = JSON.parse(savedUser);
      actualizarHeaderUsuario();
    } catch (_) {
      localStorage.removeItem('genlogistics_user');
    }
  }
  if (!AppState.usuario) {
    document.getElementById('modalLogin')?.classList.remove('hidden');
  }
}

function actualizarHeaderUsuario() {
  const elNombre = document.getElementById('userNombreDisplay');
  const elRol = document.getElementById('userRolDisplay');
  if (elNombre && AppState.usuario) elNombre.textContent = AppState.usuario.nombre;
  if (elRol && AppState.usuario) elRol.textContent = AppState.usuario.rol;
}

async function cargarDatosIniciales() {
  // 1. Hidratación instantánea desde IndexedDB (0ms latencia)
  const [cachedInit, cachedActivos, cachedHist] = await Promise.all([
    SyncEngine.getCache('initData'),
    SyncEngine.getCache('cargosActivos'),
    SyncEngine.getCache('historial')
  ]);

  if (cachedInit) aplicarInitData(cachedInit);
  if (Array.isArray(cachedActivos)) AppState.cargosActivos = cachedActivos;
  if (Array.isArray(cachedHist)) AppState.historial = cachedHist;

  renderizarTodo();

  // 2. Actualización silenciosa en segundo plano si hay red
  if (navigator.onLine) {
    try {
      const resInit = await fetch(`${API_URL}?action=getInitData&token=${encodeURIComponent(API_TOKEN)}&_t=${Date.now()}`, {
        redirect: 'follow',
        cache: 'no-store'
      });
      const jsonInit = await resInit.json();
      if (jsonInit.status === 'success' && jsonInit.data) {
        aplicarInitData(jsonInit.data);
        await SyncEngine.saveCache('initData', jsonInit.data);
      }
      await SyncEngine.pullLatestState(false);
    } catch (err) {
      console.debug('[Init] Operando con caché local IndexedDB:', err.message);
    }
  }
}

function aplicarInitData(data) {
  AppState.choferes = data.choferes || [];
  AppState.vehiculos = data.vehiculos || [];
  AppState.destinos = data.destinos || [];
  AppState.materiales = data.materiales || [];
  poblarSelectores();
}

// ==========================================
// 5. SINCRONIZACIÓN MANUAL (DELEGADA A SYNCENGINE)
// ==========================================
window.forzarSincronizacionManual = async function () {
  const btn = document.getElementById('btnForceSync');
  const icon = btn?.querySelector('svg');
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add('animate-spin');

  try {
    // Descargar catálogos frescos (bypass caché GAS) + estado operativo
    const tokenParam = encodeURIComponent(API_TOKEN);
    const resInit = await fetch(`${API_URL}?action=getInitData&token=${tokenParam}&nocache=1&_t=${Date.now()}`, {
      redirect: 'follow',
      cache: 'no-store'
    });
    const jsonInit = await resInit.json();
    if (jsonInit.status === 'success' && jsonInit.data) {
      aplicarInitData(jsonInit.data);
      await SyncEngine.saveCache('initData', jsonInit.data);
    }

    await SyncEngine.pullLatestState(true);
    mostrarToast('Datos sincronizados con Google Sheets.', 'success');
  } catch (err) {
    mostrarToast(err.message || 'No se pudo completar la sincronización.', 'warning');
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.classList.remove('animate-spin');
  }
};

// ==========================================
// 6. POBLADO DE SELECTORES Y FILAS DINÁMICAS
// ==========================================
function poblarSelectores() {
  const selChofer = document.getElementById('selectChofer');
  const selVehiculo = document.getElementById('selectVehiculo');

  if (selChofer) {
    selChofer.innerHTML = '<option value="">Seleccione Chofer / Responsable...</option>' +
      AppState.choferes.map(c => {
        const id = String(c.ID_CHFR || '').replace(/^'+/, '').trim();
        return `<option value="${escapeHTML(id)}">${escapeHTML(c.NOMBRE)} (${escapeHTML(id)})</option>`;
      }).join('');
  }

  if (selVehiculo) {
    selVehiculo.innerHTML = '<option value="">Seleccione Vehículo / Placa...</option>' +
      AppState.vehiculos.map(v => {
        const placa = String(v.PLACA || v.ID_VHCL || '').trim();
        return `<option value="${escapeHTML(placa)}">${escapeHTML(placa)} - ${escapeHTML(v.DESCRIPCION || v.TIPO || '')}</option>`;
      }).join('');
  }

  // Inicializar primera fila de material si la tabla está vacía
  const tbody = document.getElementById('tablaMaterialesBody');
  if (tbody && tbody.children.length === 0) {
    agregarFilaMaterial();
  }
}

function generarOpcionesMaterial() {
  return '<option value="">Material...</option>' +
    AppState.materiales.map(m => {
      const id = String(m.ID_MEMB || '').trim();
      return `<option value="${escapeHTML(id)}">${escapeHTML(m.DESCRIPCION || id)}</option>`;
    }).join('');
}

function generarOpcionesDestino() {
  return '<option value="">Destino / Cliente...</option>' +
    AppState.destinos.map(d => {
      const nombre = String(d.DESTINO || d.NOMBRE || d.ID_DEST || '').trim();
      return `<option value="${escapeHTML(nombre)}">${escapeHTML(nombre)}</option>`;
    }).join('');
}

function agregarFilaMaterial() {
  const tbody = document.getElementById('tablaMaterialesBody');
  if (!tbody) return;

  const tr = document.createElement('tr');
  tr.className = 'border-b border-slate-100 hover:bg-slate-50/60 transition-colors';
  tr.innerHTML = `
    <td class="p-2">
      <select class="mat-select w-full rounded-lg border-slate-300 text-sm focus:ring-blue-500 focus:border-blue-500" required>
        ${generarOpcionesMaterial()}
      </select>
    </td>
    <td class="p-2">
      <select class="dest-select w-full rounded-lg border-slate-300 text-sm focus:ring-blue-500 focus:border-blue-500" required>
        ${generarOpcionesDestino()}
      </select>
    </td>
    <td class="p-2 w-28">
      <input type="number" min="1" step="1" placeholder="0" class="cant-input w-full rounded-lg border-slate-300 text-sm text-center font-semibold focus:ring-blue-500 focus:border-blue-500" required />
    </td>
    <td class="p-2 w-12 text-center">
      <button type="button" class="btn-remove-row text-slate-400 hover:text-rose-600 p-1.5 rounded-lg transition-colors" title="Quitar fila">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </td>
  `;

  tr.querySelector('.btn-remove-row').addEventListener('click', () => {
    if (tbody.children.length > 1) tr.remove();
    else mostrarToast('Debe haber al menos una línea de material.', 'warning');
  });

  tbody.appendChild(tr);
}

// ==========================================
// 7. FIRMA DIGITAL EN CANVAS (EDGE COMPRESSION)
// ==========================================
let firmaPad = { canvas: null, ctx: null, dibujando: false };

function inicializarCanvasFirma() {
  const canvas = document.getElementById('canvasFirma');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0f172a';
  firmaPad = { canvas, ctx, dibujando: false };

  const getCoords = (e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const iniciar = (e) => {
    e.preventDefault();
    firmaPad.dibujando = true;
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const trazar = (e) => {
    if (!firmaPad.dibujando) return;
    e.preventDefault();
    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const terminar = () => { firmaPad.dibujando = false; };

  canvas.addEventListener('mousedown', iniciar);
  canvas.addEventListener('mousemove', trazar);
  window.addEventListener('mouseup', terminar);
  canvas.addEventListener('touchstart', iniciar, { passive: false });
  canvas.addEventListener('touchmove', trazar, { passive: false });
  canvas.addEventListener('touchend', terminar);

  document.getElementById('btnLimpiarFirma')?.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
}

// ==========================================
// 8. REGISTRO DE NUEVO CARGO (OPTIMISTIC UI)
// ==========================================
async function handleFormSubmit(e) {
  e.preventDefault();
  if (!AppState.usuario) {
    document.getElementById('modalLogin')?.classList.remove('hidden');
    return;
  }

  const chofer = document.getElementById('selectChofer')?.value.trim();
  const vehiculo = document.getElementById('selectVehiculo')?.value.trim();
  const area = document.getElementById('selectArea')?.value.trim() || 'DESPACHO';

  const filas = Array.from(document.querySelectorAll('#tablaMaterialesBody tr'));
  const materiales = filas.map(tr => ({
    id_memb: tr.querySelector('.mat-select')?.value.trim(),
    destino: tr.querySelector('.dest-select')?.value.trim(),
    cantidad: Number(tr.querySelector('.cant-input')?.value || 0)
  })).filter(m => m.id_memb && m.destino && m.cantidad > 0);

  if (!chofer || !vehiculo || materiales.length === 0) {
    mostrarToast('Complete chofer, placa y al menos un material válido.', 'warning');
    return;
  }

  const firmaBase64 = firmaPad.canvas ? (SyncEngine.compressSignature(firmaPad.canvas) || '') : '';
  const timestamp = ahoraLimaStr();
  const localId = `LOCAL-${Date.now().toString().slice(-6)}`;

  const detallesOptimistas = materiales.map((item, idx) => {
    const idDet = `${localId}-L${String(idx + 1).padStart(3, '0')}`;
    return {
      ID_DETALLE: idDet,
      ID_CARGO: localId,
      MATERIAL: item.id_memb,
      LLEVA: item.cantidad,
      DEVUELVE: 0,
      DEUDA: item.cantidad,
      ESTADO: 'Pendiente',
      EMISOR: area,
      DESTINO: item.destino,
      'HORA CARGO': timestamp,
      'GESTOR CARGO': AppState.usuario.nombre,
      'HORA DESCARGO': '',
      'GESTOR DESCARGO': '',
      RESPONSABLE: chofer
    };
  });

  const nuevoCargoOptimista = {
    idCargo: localId,
    fecha: fechaLimaStr(),
    hora: timestamp,
    choferId: chofer,
    choferNombre: resolverNombreChofer(chofer),
    placa: vehiculo,
    gestor: AppState.usuario.nombre,
    firmaCargo: firmaBase64,
    detalles: detallesOptimistas,
    tieneDeuda: true
  };

  // 1. Actualizar estado en memoria y caché IndexedDB instantáneamente
  AppState.cargosActivos.unshift(nuevoCargoOptimista);
  detallesOptimistas.slice().reverse().forEach(d => {
    AppState.historial.unshift({
      idCargo: localId,
      idDetalle: d.ID_DETALLE,
      material: d.MATERIAL,
      destino: d.DESTINO,
      emisor: area,
      lleva: d.LLEVA,
      devuelve: 0,
      deuda: d.DEUDA,
      estado: 'Pendiente',
      horaCargo: timestamp,
      gestorCargo: AppState.usuario.nombre,
      horaDescargo: '',
      gestorDescargo: '',
      chofer: chofer,
      placa: vehiculo
    });
  });

  await Promise.all([
    SyncEngine.saveCache('cargosActivos', AppState.cargosActivos),
    SyncEngine.saveCache('historial', AppState.historial)
  ]);

  // 2. Encolar mutación en SyncEngine (Fire & Forget)
  await SyncEngine.enqueueMutation('saveCargo', {
    data: {
      localIdRef: localId,
      chofer,
      vehiculo,
      area,
      gestorNombre: AppState.usuario.nombre,
      firma: firmaBase64,
      materiales
    }
  });

  // 3. Resetear formulario y actualizar UI al instante
  e.target.reset();
  const tbody = document.getElementById('tablaMaterialesBody');
  if (tbody) {
    tbody.innerHTML = '';
    agregarFilaMaterial();
  }
  if (firmaPad.ctx && firmaPad.canvas) {
    firmaPad.ctx.clearRect(0, 0, firmaPad.canvas.width, firmaPad.canvas.height);
  }

  renderizarTodo();
  mostrarToast(`Cargo ${localId} registrado y encolado.`, 'success');
}

// ==========================================
// 9. MODAL DE DETALLE, LIQUIDACIÓN Y EDICIÓN
// ==========================================
function abrirDetalle(idCargo) {
  const cargo = obtenerCargoUnificado(idCargo);
  if (!cargo) {
    mostrarToast('No se encontró el detalle del cargo solicitado.', 'error');
    return;
  }

  AppState.cargoSeleccionado = cargo;
  renderizarDetalleModal(cargo);
  document.getElementById('modalDetalleCargo')?.classList.remove('hidden');
}

function renderizarDetalleModal(cargo) {
  const titulo = document.getElementById('modalCargoTitulo');
  const subtitulo = document.getElementById('modalCargoSubtitulo');
  const tbody = document.getElementById('modalDetalleBody');
  if (!tbody) return;

  if (titulo) titulo.textContent = `Cargo ${cargo.idCargo}`;
  if (subtitulo) {
    subtitulo.textContent = `${cargo.choferNombre} • Placa: ${cargo.placa} • Emitido: ${cargo.hora}`;
  }

  const admin = esAdministrador();

  tbody.innerHTML = cargo.detalles.map(det => {
    const lleva = Number(det.LLEVA || 0);
    const devuelve = Number(det.DEVUELVE || 0);
    const deuda = det.DEUDA !== undefined && det.DEUDA !== '' ? Number(det.DEUDA) : (lleva - devuelve);
    const pendiente = Math.max(0, deuda);

    const puedeEditar = admin || (mismoUsuario(det['GESTOR CARGO'] || cargo.gestor, AppState.usuario?.nombre) && devuelve === 0);

    let badgeEstado = '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">Pendiente</span>';
    if (deuda === 0) badgeEstado = '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">Completo</span>';
    else if (deuda < 0) badgeEstado = '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-800">Excedente</span>';

    return `
      <tr class="border-b border-slate-100" data-id-detalle="${escapeHTML(det.ID_DETALLE)}">
        <td class="p-2.5 text-sm font-medium text-slate-800">${escapeHTML(resolverNombreMaterial(det.MATERIAL))}</td>
        <td class="p-2.5 text-xs text-slate-600">${escapeHTML(det.DESTINO)}</td>
        <td class="p-2.5 text-center text-sm font-semibold">${lleva}</td>
        <td class="p-2.5 text-center text-sm text-emerald-700 font-semibold">${devuelve}</td>
        <td class="p-2.5 text-center text-sm font-bold ${deuda > 0 ? 'text-rose-600' : 'text-slate-700'}">${deuda}</td>
        <td class="p-2.5 text-center">${badgeEstado}</td>
        <td class="p-2.5 w-24">
          <input type="number" min="0" value="${pendiente > 0 ? pendiente : 0}"
            class="input-devolver w-full rounded-lg border-slate-300 text-sm text-center font-semibold"
            data-id-detalle="${escapeHTML(det.ID_DETALLE)}"
            ${pendiente === 0 ? 'placeholder="0"' : ''} />
        </td>
        <td class="p-2.5 text-right whitespace-nowrap">
          ${puedeEditar ? `
            <button type="button" onclick="corregirLineaDetalle('${escapeHTML(cargo.idCargo)}', '${escapeHTML(det.ID_DETALLE)}')"
              class="text-blue-600 hover:text-blue-800 text-xs font-semibold mr-2">Editar</button>
            <button type="button" onclick="eliminarLineaDetalle('${escapeHTML(cargo.idCargo)}', '${escapeHTML(det.ID_DETALLE)}')"
              class="text-rose-600 hover:text-rose-800 text-xs font-semibold">Eliminar</button>
          ` : '<span class="text-xs text-slate-400">Bloqueado</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

async function procesarLiquidacionModal() {
  if (!AppState.cargoSeleccionado || !AppState.usuario) return;
  const cargo = AppState.cargoSeleccionado;
  const inputs = Array.from(document.querySelectorAll('#modalDetalleBody .input-devolver'));
  const splitExcedente = Boolean(document.getElementById('chkSplitExcedente')?.checked);

  const itemsLiquidar = [];
  const now = ahoraLimaStr();

  inputs.forEach(inp => {
    const idDetalle = inp.dataset.idDetalle;
    const qty = Number(inp.value || 0);
    if (qty <= 0) return;

    const det = cargo.detalles.find(d => d.ID_DETALLE === idDetalle);
    if (!det) return;

    const lleva = Number(det.LLEVA || 0);
    const devAnt = Number(det.DEVUELVE || 0);
    const deudaPend = Math.max(0, lleva - devAnt);

    let nuevoDev = devAnt + qty;
    let excCrear = 0;

    if (splitExcedente && qty > deudaPend && lleva > 0) {
      nuevoDev = lleva;
      excCrear = qty - deudaPend;
    }

    const nuevaDeuda = lleva - nuevoDev;
    det.DEVUELVE = nuevoDev;
    det.DEUDA = nuevaDeuda;
    det.ESTADO = nuevaDeuda === 0 ? 'Devolución completa' : (nuevaDeuda < 0 ? 'Excedente' : 'Pendiente');
    det['HORA DESCARGO'] = now;
    det['GESTOR DESCARGO'] = AppState.usuario.nombre;

    // Actualizar espejo en AppState.historial
    const hItem = AppState.historial.find(h => h.idDetalle === idDetalle);
    if (hItem) {
      hItem.devuelve = nuevoDev;
      hItem.deuda = nuevaDeuda;
      hItem.estado = det.ESTADO;
      hItem.horaDescargo = now;
      hItem.gestorDescargo = AppState.usuario.nombre;
    }

    if (excCrear > 0) {
      const idExc = `${cargo.idCargo}-L${String(cargo.detalles.length + 1).padStart(3, '0')}`;
      const filaExc = {
        ID_DETALLE: idExc,
        ID_CARGO: cargo.idCargo,
        MATERIAL: det.MATERIAL,
        LLEVA: 0,
        DEVUELVE: excCrear,
        DEUDA: -excCrear,
        ESTADO: 'Excedente',
        EMISOR: det.EMISOR,
        DESTINO: det.DESTINO,
        'HORA CARGO': det['HORA CARGO'] || now,
        'GESTOR CARGO': det['GESTOR CARGO'] || AppState.usuario.nombre,
        'HORA DESCARGO': now,
        'GESTOR DESCARGO': AppState.usuario.nombre,
        RESPONSABLE: cargo.choferId
      };
      cargo.detalles.push(filaExc);
      AppState.historial.unshift({
        idCargo: cargo.idCargo,
        idDetalle: idExc,
        material: det.MATERIAL,
        destino: det.DESTINO,
        emisor: det.EMISOR,
        lleva: 0,
        devuelve: excCrear,
        deuda: -excCrear,
        estado: 'Excedente',
        horaCargo: filaExc['HORA CARGO'],
        gestorCargo: filaExc['GESTOR CARGO'],
        horaDescargo: now,
        gestorDescargo: AppState.usuario.nombre,
        chofer: cargo.choferId,
        placa: cargo.placa
      });
    }

    itemsLiquidar.push({ id_detalle: idDetalle, qty, splitExcedente });
  });

  if (itemsLiquidar.length === 0) {
    mostrarToast('Ingrese al menos una cantidad mayor a 0 para descargar.', 'warning');
    return;
  }

  await recalcularEstadoCargoOptimista(cargo);

  await SyncEngine.enqueueMutation('updateDevolucion', {
    gestorNombre: AppState.usuario.nombre,
    data: itemsLiquidar
  });

  renderizarTodo();
  if (!cargo.tieneDeuda) {
    cerrarModalDetalle();
    mostrarToast(`Cargo ${cargo.idCargo} liquidado por completo.`, 'success');
  } else {
    renderizarDetalleModal(cargo);
    mostrarToast('Devolución parcial registrada.', 'success');
  }
}

async function btnGuardarExtraModal() {
  if (!AppState.cargoSeleccionado || !AppState.usuario) return;
  const cargo = obtenerCargoUnificado(AppState.cargoSeleccionado.idCargo);
  if (!cargo) return;

  const mat = document.getElementById('extraMaterialSelect')?.value.trim();
  const dest = document.getElementById('extraDestinoSelect')?.value.trim();
  const lleva = Number(document.getElementById('extraLlevaInput')?.value || 0);
  const devuelve = Number(document.getElementById('extraDevuelveInput')?.value || 0);

  if (!mat || !dest || (lleva === 0 && devuelve === 0)) {
    mostrarToast('Complete material, destino y una cantidad válida.', 'warning');
    return;
  }

  const now = ahoraLimaStr();
  const idDetNuevo = `${cargo.idCargo}-L${String(cargo.detalles.length + 1).padStart(3, '0')}`;
  const deuda = lleva - devuelve;
  const estado = deuda === 0 ? 'Devolución completa' : (deuda < 0 ? 'Excedente' : 'Pendiente');

  const nuevaLinea = {
    ID_DETALLE: idDetNuevo,
    ID_CARGO: cargo.idCargo,
    MATERIAL: mat,
    LLEVA: lleva,
    DEVUELVE: devuelve,
    DEUDA: deuda,
    ESTADO: estado,
    EMISOR: cargo.detalles[0]?.EMISOR || 'DESPACHO',
    DESTINO: dest,
    'HORA CARGO': cargo.hora || now,
    'GESTOR CARGO': cargo.gestor || AppState.usuario.nombre,
    'HORA DESCARGO': devuelve > 0 ? now : '',
    'GESTOR DESCARGO': devuelve > 0 ? AppState.usuario.nombre : '',
    RESPONSABLE: cargo.choferId
  };

  cargo.detalles.push(nuevaLinea);
  AppState.historial.unshift({
    idCargo: cargo.idCargo,
    idDetalle: idDetNuevo,
    material: mat,
    destino: dest,
    emisor: nuevaLinea.EMISOR,
    lleva,
    devuelve,
    deuda,
    estado,
    horaCargo: nuevaLinea['HORA CARGO'],
    gestorCargo: nuevaLinea['GESTOR CARGO'],
    horaDescargo: nuevaLinea['HORA DESCARGO'],
    gestorDescargo: nuevaLinea['GESTOR DESCARGO'],
    chofer: cargo.choferId,
    placa: cargo.placa
  });

  await recalcularEstadoCargoOptimista(cargo);

  await SyncEngine.enqueueMutation('addDetalleCargo', {
    data: {
      localDetalleRef: idDetNuevo,
      idCargo: cargo.idCargo,
      material: mat,
      destino: dest,
      lleva,
      devuelve,
      emisor: nuevaLinea.EMISOR,
      responsable: cargo.choferId,
      gestorNombre: AppState.usuario.nombre,
      gestorRol: AppState.usuario.rol
    }
  });

  AppState.cargoSeleccionado = cargo;
  renderizarDetalleModal(cargo);
  renderizarTodo();
  mostrarToast('Movimiento adicional añadido al cargo.', 'success');
}

window.corregirLineaDetalle = async function (idCargo, idDetalle) {
  const cargo = obtenerCargoUnificado(idCargo);
  if (!cargo) return;
  const det = cargo.detalles.find(d => d.ID_DETALLE === idDetalle);
  if (!det) return;

  const nuevaLlevaStr = prompt(`Corregir cantidad LLEVADA para ${resolverNombreMaterial(det.MATERIAL)}:`, det.LLEVA);
  if (nuevaLlevaStr === null) return;
  const nuevaLleva = Number(nuevaLlevaStr);
  if (isNaN(nuevaLleva) || nuevaLleva < 0) {
    mostrarToast('Cantidad inválida.', 'warning');
    return;
  }

  let nuevoDevuelve = Number(det.DEVUELVE || 0);
  if (esAdministrador()) {
    const nuevoDevStr = prompt('Corregir cantidad DEVUELTA:', nuevoDevuelve);
    if (nuevoDevStr !== null && !isNaN(Number(nuevoDevStr)) && Number(nuevoDevStr) >= 0) {
      nuevoDevuelve = Number(nuevoDevStr);
    }
  }

  const nuevaDeuda = nuevaLleva - nuevoDevuelve;
  det.LLEVA = nuevaLleva;
  det.DEVUELVE = nuevoDevuelve;
  det.DEUDA = nuevaDeuda;
  det.ESTADO = nuevaDeuda === 0 ? 'Devolución completa' : (nuevaDeuda < 0 ? 'Excedente' : 'Pendiente');

  const hItem = AppState.historial.find(h => h.idDetalle === idDetalle);
  if (hItem) {
    hItem.lleva = nuevaLleva;
    hItem.devuelve = nuevoDevuelve;
    hItem.deuda = nuevaDeuda;
    hItem.estado = det.ESTADO;
  }

  await recalcularEstadoCargoOptimista(cargo);

  await SyncEngine.enqueueMutation('editDetalleCargo', {
    data: {
      idDetalle,
      lleva: nuevaLleva,
      devuelve: nuevoDevuelve,
      gestorNombre: AppState.usuario.nombre,
      gestorRol: AppState.usuario.rol
    }
  });

  renderizarDetalleModal(cargo);
  renderizarTodo();
  mostrarToast('Línea actualizada.', 'success');
};

window.eliminarLineaDetalle = async function (idCargo, idDetalle) {
  if (!confirm('¿Eliminar permanentemente esta línea del cargo?')) return;

  const cargo = obtenerCargoUnificado(idCargo);
  if (!cargo) return;

  cargo.detalles = cargo.detalles.filter(d => d.ID_DETALLE !== idDetalle);
  AppState.historial = AppState.historial.filter(h => h.idDetalle !== idDetalle);

  await recalcularEstadoCargoOptimista(cargo);

  await SyncEngine.enqueueMutation('deleteDetalleCargo', {
    data: {
      idCargo,
      idDetalle,
      gestorNombre: AppState.usuario.nombre,
      gestorRol: AppState.usuario.rol
    }
  });

  renderizarTodo();

  // Cerrar modal si el cargo quedó sin líneas o ya no tiene deuda pendiente
  if (cargo.detalles.length === 0 || !cargo.tieneDeuda) {
    cerrarModalDetalle();
    mostrarToast('Línea eliminada. Cargo actualizado.', 'success');
  } else {
    renderizarDetalleModal(cargo);
    mostrarToast('Línea eliminada.', 'success');
  }
};

async function eliminarCargoActual() {
  if (!AppState.cargoSeleccionado || !AppState.usuario) return;
  const idCargo = AppState.cargoSeleccionado.idCargo;
  if (!confirm(`¿Eliminar por completo el cargo ${idCargo} y todas sus líneas?`)) return;

  AppState.cargosActivos = AppState.cargosActivos.filter(c => c.idCargo !== idCargo);
  AppState.historial = AppState.historial.filter(h => h.idCargo !== idCargo);

  await Promise.all([
    SyncEngine.saveCache('cargosActivos', AppState.cargosActivos),
    SyncEngine.saveCache('historial', AppState.historial)
  ]);

  await SyncEngine.enqueueMutation('deleteCargo', {
    data: {
      idCargo,
      gestorNombre: AppState.usuario.nombre,
      gestorRol: AppState.usuario.rol
    }
  });

  cerrarModalDetalle();
  renderizarTodo();
  mostrarToast(`Cargo ${idCargo} eliminado.`, 'success');
}

function cerrarModalDetalle() {
  AppState.cargoSeleccionado = null;
  document.getElementById('modalDetalleCargo')?.classList.add('hidden');
}

// ==========================================
// 10. RENDERIZADO DE VISTAS Y COMPROBANTE
// ==========================================
function renderizarTodo() {
  renderizarCargosActivos();
  renderizarHistorial();
  actualizarKPIs();
}

function actualizarKPIs() {
  const elActivos = document.getElementById('kpiCargosActivos');
  const elBandejas = document.getElementById('kpiBandejasCalle');
  if (elActivos) elActivos.textContent = AppState.cargosActivos.length;
  if (elBandejas) {
    const totalDeuda = AppState.cargosActivos.reduce((acc, c) => {
      return acc + c.detalles.reduce((s, d) => s + Math.max(0, Number(d.DEUDA || 0)), 0);
    }, 0);
    elBandejas.textContent = totalDeuda;
  }
}

function renderizarCargosActivos() {
  const container = document.getElementById('listaCargosActivos');
  if (!container) return;

  const q = AppState.busquedaActivos.toLowerCase();
  const filtrados = AppState.cargosActivos.filter(c =>
    !q ||
    String(c.idCargo).toLowerCase().includes(q) ||
    String(c.choferNombre).toLowerCase().includes(q) ||
    String(c.placa).toLowerCase().includes(q)
  );

  if (filtrados.length === 0) {
    container.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400 text-sm">No hay cargos pendientes de retorno.</div>`;
    return;
  }

  container.innerHTML = filtrados.map(c => {
    const totalDeuda = c.detalles.reduce((acc, d) => acc + Number(d.DEUDA || 0), 0);
    return `
      <div onclick="abrirDetalle('${escapeHTML(c.idCargo)}')"
        class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm hover:shadow-md hover:border-blue-300 transition-all cursor-pointer">
        <div class="flex items-center justify-between mb-2">
          <span class="font-bold text-slate-900 text-sm">${escapeHTML(c.idCargo)}</span>
          <span class="px-2.5 py-0.5 rounded-full text-xs font-bold ${totalDeuda > 0 ? 'bg-rose-100 text-rose-700' : 'bg-purple-100 text-purple-700'}">
            Saldo: ${totalDeuda}
          </span>
        </div>
        <p class="text-sm font-semibold text-slate-700 truncate">${escapeHTML(c.choferNombre)}</p>
        <div class="flex items-center justify-between mt-3 pt-2 border-t border-slate-100 text-xs text-slate-500">
          <span>Placa: <strong class="text-slate-700">${escapeHTML(c.placa)}</strong></span>
          <span>${escapeHTML((c.hora || '').split(' ')[0])}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderizarHistorial() {
  const tbody = document.getElementById('tablaHistorialBody');
  if (!tbody) return;

  const q = AppState.busquedaHistorial.toLowerCase();
  const filtro = AppState.filtroHistorial;

  const filtrados = AppState.historial.filter(h => {
    if (filtro === 'pendientes' && Number(h.deuda) <= 0) return false;
    if (filtro === 'completos' && Number(h.deuda) !== 0) return false;
    if (filtro === 'excedentes' && Number(h.deuda) >= 0) return false;
    if (!q) return true;
    return (
      String(h.idCargo).toLowerCase().includes(q) ||
      String(h.destino).toLowerCase().includes(q) ||
      String(resolverNombreChofer(h.chofer)).toLowerCase().includes(q) ||
      String(resolverNombreMaterial(h.material)).toLowerCase().includes(q)
    );
  }).slice(0, 200);

  tbody.innerHTML = filtrados.map(h => `
    <tr onclick="abrirDetalle('${escapeHTML(h.idCargo)}')" class="border-b border-slate-100 hover:bg-blue-50/40 cursor-pointer transition-colors">
      <td class="p-3 text-xs font-bold text-blue-700 whitespace-nowrap">${escapeHTML(h.idCargo)}</td>
      <td class="p-3 text-xs text-slate-700 whitespace-nowrap">${escapeHTML(resolverNombreChofer(h.chofer))}</td>
      <td class="p-3 text-xs font-medium text-slate-800">${escapeHTML(resolverNombreMaterial(h.material))}</td>
      <td class="p-3 text-xs text-slate-600">${escapeHTML(h.destino)}</td>
      <td class="p-3 text-xs text-center font-semibold">${h.lleva}</td>
      <td class="p-3 text-xs text-center text-emerald-700 font-semibold">${h.devuelve}</td>
      <td class="p-3 text-xs text-center font-bold ${h.deuda > 0 ? 'text-rose-600' : 'text-slate-700'}">${h.deuda}</td>
      <td class="p-3 text-xs text-slate-500 whitespace-nowrap">${escapeHTML(h.horaCargo)}</td>
    </tr>
  `).join('');
}

function generarDocumentoImpresion() {
  if (!AppState.cargoSeleccionado) return;
  const cargo = obtenerCargoUnificado(AppState.cargoSeleccionado.idCargo);
  if (!cargo) return;

  const win = window.open('', '_blank', 'width=420,height=650');
  if (!win) {
    mostrarToast('Permita las ventanas emergentes para imprimir el ticket.', 'warning');
    return;
  }

  const filasHtml = cargo.detalles.map(d => `
    <tr>
      <td style="padding:4px 0;border-bottom:1px dashed #ccc;">${escapeHTML(resolverNombreMaterial(d.MATERIAL))}<br><small>${escapeHTML(d.DESTINO)}</small></td>
      <td style="text-align:center;border-bottom:1px dashed #ccc;">${d.LLEVA}</td>
      <td style="text-align:center;border-bottom:1px dashed #ccc;">${d.DEVUELVE}</td>
      <td style="text-align:center;border-bottom:1px dashed #ccc;"><strong>${d.DEUDA}</strong></td>
    </tr>
  `).join('');

  win.document.write(`
    <!DOCTYPE html>
    <html><head><title>Ticket ${escapeHTML(cargo.idCargo)}</title>
    <style>
      body { font-family: monospace; font-size: 12px; width: 76mm; margin: 0 auto; padding: 8px; color: #000; }
      h2, p { margin: 2px 0; text-align: center; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th { border-bottom: 1px solid #000; font-size: 11px; }
      .sig { margin-top: 16px; text-align: center; }
      img { max-width: 180px; max-height: 70px; }
    </style></head><body>
      <h2>LA GENOVESA AGROINDUSTRIAS S.A.</h2>
      <p>CONTROL DE EMBALAJES Y BANDEJAS</p>
      <hr>
      <p><strong>CARGO: ${escapeHTML(cargo.idCargo)}</strong></p>
      <p>Fecha: ${escapeHTML(cargo.hora)}</p>
      <p>Chofer: ${escapeHTML(cargo.choferNombre)}</p>
      <p>Placa: ${escapeHTML(cargo.placa)} | Gestor: ${escapeHTML(cargo.gestor)}</p>
      <table>
        <thead><tr><th style="text-align:left;">Material/Dest</th><th>Llev</th><th>Dev</th><th>Sald</th></tr></thead>
        <tbody>${filasHtml}</tbody>
      </table>
      ${cargo.firmaCargo ? `<div class="sig"><img src="${cargo.firmaCargo}" /><br><small>Firma Conformidad Chofer</small></div>` : ''}
      <script>window.onload = () => { window.print(); window.close(); };</script>
    </body></html>
  `);
  win.document.close();
}

// ==========================================
// 11. REGISTRO DE EVENTOS DOM
// ==========================================
function configurarEventosUI() {
  document.getElementById('formNuevoCargo')?.addEventListener('submit', handleFormSubmit);
  document.getElementById('btnAgregarFila')?.addEventListener('click', agregarFilaMaterial);
  document.getElementById('btnCerrarModalDetalle')?.addEventListener('click', cerrarModalDetalle);
  document.getElementById('btnProcesarLiquidacion')?.addEventListener('click', procesarLiquidacionModal);
  document.getElementById('btnGuardarExtraModal')?.addEventListener('click', btnGuardarExtraModal);
  document.getElementById('btnEliminarCargoModal')?.addEventListener('click', eliminarCargoActual);
  document.getElementById('btnPrintModal')?.addEventListener('click', generarDocumentoImpresion);

  document.getElementById('inputBuscarActivos')?.addEventListener('input', (e) => {
    AppState.busquedaActivos = e.target.value;
    renderizarCargosActivos();
  });

  document.getElementById('inputBuscarHistorial')?.addEventListener('input', (e) => {
    AppState.busquedaHistorial = e.target.value;
    renderizarHistorial();
  });

  document.getElementById('selectFiltroHistorial')?.addEventListener('change', (e) => {
    AppState.filtroHistorial = e.target.value;
    renderizarHistorial();
  });

  document.getElementById('formLogin')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = document.getElementById('loginNombre')?.value.trim();
    const rol = document.getElementById('loginRol')?.value.trim() || 'OPERADOR';
    if (!nombre) return;
    AppState.usuario = { nombre, rol };
    localStorage.setItem('genlogistics_user', JSON.stringify(AppState.usuario));
    actualizarHeaderUsuario();
    document.getElementById('modalLogin')?.classList.add('hidden');
    mostrarToast(`Sesión iniciada: ${nombre} (${rol})`, 'success');
  });
}