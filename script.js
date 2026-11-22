/**
 * ============================================================================
 * GENLOGISTICS | CONTROLADOR DE LÓGICA DE NEGOCIO Y UI (script.js)
 * Versión: 2.0.0-OPT | Arquitectura: Headless Offline-First + Optimistic UI
 * ----------------------------------------------------------------------------
 * Responsabilidades:
 * 1. Indexación relacional en memoria O(1) (Map<id_cargo, Detalles[]>).
 * 2. Arranque paralelo desde IndexedDB con hidratación silenciosa de red.
 * 3. Optimistic UI instantánea (Fire & Forget) con detección de excedentes.
 * 4. Control de acceso Zero-Trust (AuthRules) y motor de diálogos (GenDialog).
 * 5. Exportación CSV (UTF-8 BOM) e impresión dual (A4 y Ticket Térmico 80mm).
 * ============================================================================
 */

const APP_CONFIG = {
  GAS_ENDPOINT: 'https://script.google.com/macros/s/AKfycbzhPAhH-K2qURzzW69xoH-QJ6RZdmQw3gJIt80Y6f4iTKyS7BqhXrgHTGWrO0PiSj4m/exec',
  VERSION: '2.0.0-OPT'
};

// Diccionario estático de estilos para evitar purga de Tailwind CSS en producción
const BADGE_STYLES = {
  PENDIENTE: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  PARCIAL: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  CERRADO: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  DEVUELTO: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  EXCEDENTE: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800',
  ANULADO: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
};

// ============================================================================
// ESTADO GLOBAL EN MEMORIA (SINGLE SOURCE OF TRUTH EN CLIENTE)
// ============================================================================
const AppState = {
  usuarioActual: null, // { nombre, area, puede_anular, puede_liquidar }
  clientes: [],
  materiales: [],
  areas: [],
  cargos: [],
  detalles: [],

  // Índices O(1) para evitar cruces cuadráticos O(N * M)
  mapDetallesPorCargo: new Map(),
  mapClientesPorId: new Map(),
  mapMaterialesPorId: new Map(),

  // Carrito temporal de emisión
  itemsCarrito: [],
  cargoEnLiquidacion: null
};

// ============================================================================
// 1. ARRANQUE E HIDRATACIÓN OFFLINE-FIRST
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  enforceIframeSecurity();
  inicializarSignaturePad();
  inicializarEventosUI();
  iniciarApp();
});

function enforceIframeSecurity() {
  if (window.top !== window.self) {
    try {
      window.top.location = window.self.location;
    } catch (e) {
      document.body.innerHTML = '<div class="p-8 text-center text-rose-600 font-bold">Acceso denegado: Ejecución embebida no autorizada.</div>';
    }
  }
}

async function iniciarApp() {
  try {
    await SyncEngine.init(APP_CONFIG.GAS_ENDPOINT);

    // 1. Carga instantánea desde IndexedDB (Latencia 0)
    await cargarEstadoDesdeCacheLocal();

    // 2. Escuchar finalización de sincronización en segundo plano
    window.addEventListener('genlogistics:sync-completed', async () => {
      await cargarEstadoDesdeCacheLocal();
      mostrarToast('Datos sincronizados con el servidor.', 'success');
    });

    // 3. Hidratación silenciosa desde GAS si hay conectividad
    if (navigator.onLine) {
      SyncEngine.pullAllFromServer().then(async (huboActualizacion) => {
        if (huboActualizacion) {
          await cargarEstadoDesdeCacheLocal();
        }
      });
    }
  } catch (err) {
    console.error('[App] Error en inicialización:', err);
    mostrarToast('Error iniciando almacenamiento local.', 'error');
  }
}

async function cargarEstadoDesdeCacheLocal() {
  const [clientes, materiales, areas, cargos, detalles] = await Promise.all([
    SyncEngine.getTable(SyncEngine.TABLAS.CLIENTES),
    SyncEngine.getTable(SyncEngine.TABLAS.MATERIALES),
    SyncEngine.getTable(SyncEngine.TABLAS.AREAS),
    SyncEngine.getTable(SyncEngine.TABLAS.CARGOS),
    SyncEngine.getTable(SyncEngine.TABLAS.DETALLES)
  ]);

  AppState.clientes = clientes || [];
  AppState.materiales = materiales || [];
  AppState.areas = areas || [];
  AppState.cargos = cargos || [];
  AppState.detalles = detalles || [];

  reconstruirIndices();
  poblarSelectoresMaestros();
  restaurarSesionUsuario();
  renderizarTodasLasVistas();
}

/**
 * Construye índices Hash O(1) en memoria para eliminar búsquedas lineales en el DOM.
 */
function reconstruirIndices() {
  AppState.mapDetallesPorCargo.clear();
  AppState.mapClientesPorId.clear();
  AppState.mapMaterialesPorId.clear();

  for (const c of AppState.clientes) {
    AppState.mapClientesPorId.set(String(c.id_cliente), c);
  }

  for (const m of AppState.materiales) {
    AppState.mapMaterialesPorId.set(String(m.id_material), m);
  }

  for (const d of AppState.detalles) {
    const idCargo = String(d.id_cargo);
    if (!AppState.mapDetallesPorCargo.has(idCargo)) {
      AppState.mapDetallesPorCargo.set(idCargo, []);
    }
    AppState.mapDetallesPorCargo.get(idCargo).push(d);
  }
}

// ============================================================================
// 2. CONTROL DE ACCESO ZERO-TRUST (AuthRules)
// ============================================================================
const AuthRules = {
  puedeLiquidar() {
    if (!AppState.usuarioActual) return false;
    return Boolean(AppState.usuarioActual.puede_liquidar);
  },
  puedeAnular() {
    if (!AppState.usuarioActual) return false;
    return Boolean(AppState.usuarioActual.puede_anular);
  }
};

function restaurarSesionUsuario() {
  const saved = localStorage.getItem('genlogistics_user_session');
  if (saved) {
    try {
      AppState.usuarioActual = JSON.parse(saved);
    } catch (e) {
      AppState.usuarioActual = null;
    }
  }

  // Si no hay sesión o el área cambió en catálogo, sincronizar permisos
  if (!AppState.usuarioActual && AppState.areas.length > 0) {
    const areaDefault = AppState.areas[0];
    AppState.usuarioActual = {
      nombre: 'OPERADOR PLANTA',
      area: String(areaDefault.nombre_area || areaDefault.area || 'ALMACÉN'),
      puede_liquidar: parseBool(areaDefault.puede_liquidar ?? true),
      puede_anular: parseBool(areaDefault.puede_anular ?? false)
    };
  } else if (AppState.usuarioActual && AppState.areas.length > 0) {
    const areaMeta = AppState.areas.find(
      a => String(a.nombre_area || a.area || '').toUpperCase() === AppState.usuarioActual.area.toUpperCase()
    );
    if (areaMeta) {
      AppState.usuarioActual.puede_liquidar = parseBool(areaMeta.puede_liquidar ?? true);
      AppState.usuarioActual.puede_anular = parseBool(areaMeta.puede_anular ?? false);
    }
  }

  actualizarHeaderUsuario();
}

function parseBool(val) {
  return val === true || String(val).toUpperCase() === 'TRUE' || String(val).toUpperCase() === 'SI' || val === 1;
}

function actualizarHeaderUsuario() {
  const elUser = document.getElementById('header-user-name');
  const elArea = document.getElementById('header-user-area');
  if (elUser && AppState.usuarioActual) elUser.textContent = AppState.usuarioActual.nombre;
  if (elArea && AppState.usuarioActual) elArea.textContent = AppState.usuarioActual.area;
}

// ============================================================================
// 3. EMISIÓN DE CARGOS (OPTIMISTIC UI + FIRMA EDGE COMPRESSED)
// ============================================================================
function agregarItemCarrito() {
  const selMat = document.getElementById('select-material');
  const inputCant = document.getElementById('input-cantidad-material');
  const inputObs = document.getElementById('input-obs-material');

  const idMaterial = selMat ? selMat.value : '';
  const cantidad = Number(inputCant ? inputCant.value : 0);
  const observacion = inputObs ? inputObs.value.trim() : '';

  if (!idMaterial || cantidad <= 0) {
    mostrarToast('Selecciona un material y una cantidad mayor a cero.', 'warning');
    return;
  }

  const matObj = AppState.mapMaterialesPorId.get(String(idMaterial));
  if (!matObj) return;

  // Acumular si ya existe en el carrito
  const existente = AppState.itemsCarrito.find(i => String(i.id_material) === String(idMaterial));
  if (existente) {
    existente.cantidad_entregada += cantidad;
    if (observacion) existente.observacion_linea = observacion;
  } else {
    AppState.itemsCarrito.push({
      id_material: String(matObj.id_material),
      descripcion_material: String(matObj.descripcion || matObj.nombre || idMaterial),
      unidad_medida: String(matObj.unidad_medida || matObj.unidad || 'UND'),
      cantidad_entregada: cantidad,
      observacion_linea: observacion
    });
  }

  if (inputCant) inputCant.value = '';
  if (inputObs) inputObs.value = '';
  renderizarCarrito();
}

function eliminarItemCarrito(index) {
  AppState.itemsCarrito.splice(index, 1);
  renderizarCarrito();
}

function renderizarCarrito() {
  const tbody = document.getElementById('tbody-carrito');
  if (!tbody) return;

  if (AppState.itemsCarrito.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-slate-400 text-sm">No hay embalajes agregados al cargo.</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.itemsCarrito.map((item, idx) => `
        <tr class="border-b border-slate-100 dark:border-slate-800">
            <td class="py-2.5 px-3 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(item.descripcion_material)}</td>
            <td class="py-2.5 px-3 text-center text-xs text-slate-500">${escapeHtml(item.unidad_medida)}</td>
            <td class="py-2.5 px-3 text-right font-bold text-slate-900 dark:text-white">${item.cantidad_entregada}</td>
            <td class="py-2.5 px-3 text-right">
                <button type="button" onclick="eliminarItemCarrito(${idx})" class="text-rose-500 hover:text-rose-700 text-xs font-semibold px-2 py-1 rounded">
                    Quitar
                </button>
            </td>
        </tr>
    `).join('');
}

async function confirmarEmisionCargo(event) {
  if (event) event.preventDefault();

  const idCliente = document.getElementById('select-cliente')?.value || '';
  const areaOrigen = document.getElementById('select-area')?.value || (AppState.usuarioActual?.area || '');
  const receptorNombre = document.getElementById('input-receptor-nombre')?.value.trim() || '';
  const receptorDni = document.getElementById('input-receptor-dni')?.value.trim() || '';
  const placa = document.getElementById('input-placa')?.value.trim().toUpperCase() || '';
  const observaciones = document.getElementById('input-observaciones')?.value.trim() || '';

  if (!idCliente || !receptorNombre || AppState.itemsCarrito.length === 0) {
    mostrarToast('Completa cliente, receptor y al menos un material.', 'warning');
    return;
  }

  // Compresión Edge de la firma (< 8KB JPEG)
  const canvasFirma = document.getElementById('signature-pad');
  const firmaComprimida = SyncEngine.compressSignatureCanvas(canvasFirma, 520, 0.72);
  if (!firmaComprimida) {
    mostrarToast('La firma digital del receptor es obligatoria.', 'warning');
    return;
  }

  const clienteObj = AppState.mapClientesPorId.get(String(idCliente));
  const nombreCliente = clienteObj ? String(clienteObj.razon_social || clienteObj.nombre || idCliente) : idCliente;

  const now = new Date();
  const idCargo = `CRG-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const fechaEmision = formatearFechaLocal(now);
  const clientUuid = SyncEngine.generarUUID();

  const itemsPreparados = AppState.itemsCarrito.map((it, idx) => ({
    id_detalle: `${idCargo}-D${idx + 1}`,
    id_cargo: idCargo,
    id_material: it.id_material,
    descripcion_material: it.descripcion_material,
    unidad_medida: it.unidad_medida,
    cantidad_entregada: Number(it.cantidad_entregada),
    cantidad_devuelta: 0,
    saldo_pendiente: Number(it.cantidad_entregada),
    estado_linea: 'PENDIENTE',
    ultima_fecha_descargo: '',
    usuario_descargo: '',
    observacion_linea: it.observacion_linea
  }));

  const nuevoCargo = {
    id_cargo: idCargo,
    fecha_emision: fechaEmision,
    id_cliente: idCliente,
    nombre_cliente: nombreCliente,
    area_origen: areaOrigen,
    usuario_emisor: AppState.usuarioActual?.nombre || 'OPERADOR',
    receptor_nombre: receptorNombre,
    receptor_dni: receptorDni,
    placa_vehiculo: placa,
    observaciones: observaciones,
    estado: 'PENDIENTE',
    firma_receptor: firmaComprimida,
    fecha_cierre: '',
    client_uuid: clientUuid
  };

  // 1. OPTIMISTIC UI: Mutar estado en memoria e IndexedDB instantáneamente (Latencia 0)
  AppState.cargos.unshift(nuevoCargo);
  AppState.detalles.push(...itemsPreparados);
  reconstruirIndices();

  await Promise.all([
    SyncEngine.saveTable(SyncEngine.TABLAS.CARGOS, AppState.cargos),
    SyncEngine.saveTable(SyncEngine.TABLAS.DETALLES, AppState.detalles)
  ]);

  // 2. FIRE AND FORGET: Encolar en FIFO para sincronización en segundo plano
  await SyncEngine.enqueue('registrarCargo', {
    ...nuevoCargo,
    items: itemsPreparados
  });

  // 3. Limpiar formulario y actualizar vistas sin bloqueos
  limpiarFormularioEmision();
  renderizarTodasLasVistas();
  mostrarToast(`Cargo ${idCargo} emitido correctamente.`, 'success');
}

// ============================================================================
// 4. DESCARGOS Y DETECCIÓN DE EXCEDENTES (OPTIMISTIC UI)
// ============================================================================
function abrirModalLiquidacion(idCargo) {
  if (!AuthRules.puedeLiquidar()) {
    mostrarToast('Tu perfil no tiene permisos para liquidar devoluciones.', 'error');
    return;
  }

  const cargo = AppState.cargos.find(c => String(c.id_cargo) === String(idCargo));
  if (!cargo) return;

  const detallesCargo = (AppState.mapDetallesPorCargo.get(String(idCargo)) || [])
    .filter(d => d.estado_linea !== 'EXCEDENTE' && d.estado_linea !== 'ANULADO');

  AppState.cargoEnLiquidacion = { cargo, detalles: detallesCargo };

  const modal = document.getElementById('modal-liquidacion');
  const title = document.getElementById('modal-liq-titulo');
  const sub = document.getElementById('modal-liq-subtitulo');
  const containerDesktop = document.getElementById('modal-liq-tbody');
  const containerMobile = document.getElementById('modal-liq-cards');

  if (title) title.textContent = `Liquidar Cargo ${cargo.id_cargo}`;
  if (sub) sub.textContent = `${cargo.nombre_cliente} • Emitido: ${cargo.fecha_emision}`;

  if (containerDesktop) {
    containerDesktop.innerHTML = detallesCargo.map(d => `
            <tr class="border-b border-slate-100 dark:border-slate-800">
                <td class="py-3 px-4 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(d.descripcion_material)}</td>
                <td class="py-3 px-4 text-center">${d.cantidad_entregada}</td>
                <td class="py-3 px-4 text-center text-emerald-600 font-semibold">${d.cantidad_devuelta}</td>
                <td class="py-3 px-4 text-center font-bold text-amber-600">${d.saldo_pendiente}</td>
                <td class="py-3 px-4">
                    <input type="number" min="0" step="1" value="${d.saldo_pendiente}"
                           data-id-detalle="${escapeHtml(d.id_detalle)}"
                           data-saldo="${d.saldo_pendiente}"
                           oninput="sincronizarInputLiquidacion(this)"
                           class="input-liq-cant w-24 text-right rounded-lg border-slate-300 dark:bg-slate-800 dark:border-slate-700 font-bold">
                </td>
            </tr>
        `).join('');
  }

  if (containerMobile) {
    containerMobile.innerHTML = detallesCargo.map(d => `
            <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900 space-y-2">
                <div class="font-semibold text-sm text-slate-900 dark:text-white">${escapeHtml(d.descripcion_material)}</div>
                <div class="flex justify-between text-xs text-slate-500">
                    <span>Entregado: <b>${d.cantidad_entregada}</b></span>
                    <span>Devuelto: <b class="text-emerald-600">${d.cantidad_devuelta}</b></span>
                    <span>Saldo: <b class="text-amber-600">${d.saldo_pendiente}</b></span>
                </div>
                <div class="pt-1 flex items-center justify-between">
                    <label class="text-xs font-medium text-slate-600 dark:text-slate-400">Cant. a devolver:</label>
                    <input type="number" min="0" step="1" value="${d.saldo_pendiente}"
                           data-id-detalle="${escapeHtml(d.id_detalle)}"
                           data-saldo="${d.saldo_pendiente}"
                           oninput="sincronizarInputLiquidacion(this)"
                           class="input-liq-cant-mobile w-28 text-right rounded-lg border-slate-300 dark:bg-slate-800 dark:border-slate-700 font-bold text-sm">
                </div>
            </div>
        `).join('');
  }

  if (modal) modal.classList.remove('hidden');
}

function sincronizarInputLiquidacion(inputEl) {
  const idDet = inputEl.dataset.idDetalle;
  const val = inputEl.value;
  document.querySelectorAll(`[data-id-detalle="${idDet}"]`).forEach(el => {
    if (el !== inputEl) el.value = val;
  });
}

async function confirmarLiquidacionCargo() {
  if (!AppState.cargoEnLiquidacion) return;
  const { cargo, detalles } = AppState.cargoEnLiquidacion;

  const movimientos = [];
  const excedentes = [];
  let huboCambio = false;

  // Leer valores únicos desde vista desktop (sincronizada con móvil)
  const inputs = document.querySelectorAll('.input-liq-cant');
  inputs.forEach(inp => {
    const idDetalle = inp.dataset.idDetalle;
    const cantIngresada = Math.max(0, Number(inp.value) || 0);
    if (cantIngresada <= 0) return;

    const detObj = detalles.find(d => String(d.id_detalle) === String(idDetalle));
    if (!detObj) return;

    huboCambio = true;
    const saldoActual = Number(detObj.saldo_pendiente) || 0;

    if (cantIngresada <= saldoActual) {
      movimientos.push({
        id_detalle: idDetalle,
        cantidad_abonada: cantIngresada
      });
    } else {
      // Desdoblamiento automático: cubre el saldo pendiente y registra el sobrante como EXCEDENTE
      if (saldoActual > 0) {
        movimientos.push({
          id_detalle: idDetalle,
          cantidad_abonada: saldoActual
        });
      }
      excedentes.push({
        id_detalle: `${cargo.id_cargo}-EXC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        id_material: detObj.id_material,
        descripcion_material: detObj.descripcion_material,
        unidad_medida: detObj.unidad_medida,
        cantidad_excedente: cantIngresada - saldoActual,
        observacion: `Excedente (+${cantIngresada - saldoActual}) en devolución`
      });
    }
  });

  if (!huboCambio) {
    mostrarToast('Ingresa al menos una cantidad mayor a cero para liquidar.', 'warning');
    return;
  }

  const fechaAhora = formatearFechaLocal(new Date());
  const usuario = AppState.usuarioActual?.nombre || 'OPERADOR';
  const areaUsuario = AppState.usuarioActual?.area || '';

  // 1. OPTIMISTIC UI: Actualizar detalles y estado de cargo en memoria e IndexedDB
  movimientos.forEach(mov => {
    const det = AppState.detalles.find(d => String(d.id_detalle) === String(mov.id_detalle));
    if (det) {
      det.cantidad_devuelta = Number(det.cantidad_devuelta) + Number(mov.cantidad_abonada);
      det.saldo_pendiente = Math.max(0, Number(det.cantidad_entregada) - det.cantidad_devuelta);
      det.estado_linea = det.saldo_pendiente === 0 ? 'DEVUELTO' : 'PARCIAL';
      det.ultima_fecha_descargo = fechaAhora;
      det.usuario_descargo = usuario;
    }
  });

  excedentes.forEach(exc => {
    AppState.detalles.push({
      id_detalle: exc.id_detalle,
      id_cargo: cargo.id_cargo,
      id_material: exc.id_material,
      descripcion_material: exc.descripcion_material,
      unidad_medida: exc.unidad_medida,
      cantidad_entregada: 0,
      cantidad_devuelta: exc.cantidad_excedente,
      saldo_pendiente: 0,
      estado_linea: 'EXCEDENTE',
      ultima_fecha_descargo: fechaAhora,
      usuario_descargo: usuario,
      observacion_linea: exc.observacion
    });
  });

  reconstruirIndices();

  const detallesActualizados = AppState.mapDetallesPorCargo.get(String(cargo.id_cargo)) || [];
  const saldoTotalRestante = detallesActualizados.reduce((acc, d) => acc + (Number(d.saldo_pendiente) || 0), 0);
  cargo.estado = saldoTotalRestante === 0 ? 'CERRADO' : 'PARCIAL';
  if (cargo.estado === 'CERRADO') cargo.fecha_cierre = fechaAhora;

  await Promise.all([
    SyncEngine.saveTable(SyncEngine.TABLAS.CARGOS, AppState.cargos),
    SyncEngine.saveTable(SyncEngine.TABLAS.DETALLES, AppState.detalles)
  ]);

  // 2. FIRE AND FORGET: Encolar mutación con client_uuid único
  await SyncEngine.enqueue('registrarDescargo', {
    id_cargo: cargo.id_cargo,
    usuario_descargo: usuario,
    area_usuario: areaUsuario,
    movimientos,
    excedentes
  });

  cerrarModalLiquidacion();
  renderizarTodasLasVistas();
  mostrarToast(`Descargo aplicado al cargo ${cargo.id_cargo}.`, 'success');
}

function cerrarModalLiquidacion() {
  AppState.cargoEnLiquidacion = null;
  document.getElementById('modal-liquidacion')?.classList.add('hidden');
}

// ============================================================================
// 5. ANULACIÓN DE CARGOS (ZERO-TRUST + AUDITORÍA INMUTABLE)
// ============================================================================
async function solicitarAnulacionCargo(idCargo) {
  if (!AuthRules.puedeAnular()) {
    mostrarToast('Acceso denegado: tu área no tiene privilegios de anulación.', 'error');
    return;
  }

  const motivo = await GenDialog.prompt({
    title: `Anular Cargo ${idCargo}`,
    message: 'Esta acción dejará el saldo pendiente en 0 y registrará tu usuario en la bitácora de auditoría. Indica el motivo:',
    placeholder: 'Ej. Error en digitación de cliente o guía duplicada...',
    confirmText: 'Confirmar Anulación',
    danger: true
  });

  if (!motivo || !motivo.trim()) return;

  const cargo = AppState.cargos.find(c => String(c.id_cargo) === String(idCargo));
  if (!cargo) return;

  const fechaAhora = formatearFechaLocal(new Date());
  const usuario = AppState.usuarioActual?.nombre || 'OPERADOR';
  const areaUsuario = AppState.usuarioActual?.area || '';

  // 1. OPTIMISTIC UI
  cargo.estado = 'ANULADO';
  cargo.fecha_cierre = fechaAhora;
  cargo.observaciones = `${cargo.observaciones || ''} | [ANULADO por ${usuario}: ${motivo.trim()}]`.trim();

  const dets = AppState.mapDetallesPorCargo.get(String(idCargo)) || [];
  dets.forEach(d => {
    d.saldo_pendiente = 0;
    d.estado_linea = 'ANULADO';
    d.ultima_fecha_descargo = fechaAhora;
    d.usuario_descargo = usuario;
  });

  reconstruirIndices();
  await Promise.all([
    SyncEngine.saveTable(SyncEngine.TABLAS.CARGOS, AppState.cargos),
    SyncEngine.saveTable(SyncEngine.TABLAS.DETALLES, AppState.detalles)
  ]);

  // 2. FIRE AND FORGET
  await SyncEngine.enqueue('anularCargo', {
    id_cargo: idCargo,
    motivo: motivo.trim(),
    usuario_anulacion: usuario,
    area_usuario: areaUsuario
  });

  renderizarTodasLasVistas();
  mostrarToast(`Cargo ${idCargo} anulado correctamente.`, 'info');
}

// ============================================================================
// 6. RENDERIZADO DE VISTAS, KPIs SLA Y FILTROS CRUZADOS (O(1) LOOKUPS)
// ============================================================================
function renderizarTodasLasVistas() {
  renderizarDescargosPendientes();
  renderizarHistorico();
}

function renderizarDescargosPendientes() {
  const tbody = document.getElementById('tbody-descargos');
  const busqueda = (document.getElementById('filtro-descargos-texto')?.value || '').toLowerCase().trim();
  const filtroSla = document.getElementById('filtro-descargos-sla')?.value || 'TODOS';

  let kpiActivos = 0;
  let kpi24h = 0;
  let kpi48h = 0;
  const ahoraMs = Date.now();

  const pendientes = AppState.cargos.filter(c => {
    if (c.estado !== 'PENDIENTE' && c.estado !== 'PARCIAL') return false;

    const horasTranscurridas = calcularHorasDesdeFecha(c.fecha_emision, ahoraMs);
    kpiActivos++;
    if (horasTranscurridas >= 48) kpi48h++;
    else if (horasTranscurridas >= 24) kpi24h++;

    if (filtroSla === '24H' && horasTranscurridas < 24) return false;
    if (filtroSla === '48H' && horasTranscurridas < 48) return false;

    if (busqueda) {
      const matchTexto = String(c.id_cargo).toLowerCase().includes(busqueda) ||
        String(c.nombre_cliente).toLowerCase().includes(busqueda) ||
        String(c.placa_vehiculo).toLowerCase().includes(busqueda);
      if (!matchTexto) return false;
    }
    return true;
  });

  // Actualizar KPIs SLA
  const elActivos = document.getElementById('kpi-pendientes-total');
  const el24 = document.getElementById('kpi-sla-24h');
  const el48 = document.getElementById('kpi-sla-48h');
  if (elActivos) elActivos.textContent = kpiActivos;
  if (el24) el24.textContent = kpi24h;
  if (el48) el48.textContent = kpi48h;

  if (!tbody) return;

  if (pendientes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-400 text-sm">No hay cargos pendientes con los filtros actuales.</td></tr>`;
    return;
  }

  tbody.innerHTML = pendientes.map(c => {
    // Lookup O(1) en Map
    const dets = AppState.mapDetallesPorCargo.get(String(c.id_cargo)) || [];
    const resumenItems = dets
      .filter(d => Number(d.saldo_pendiente) > 0)
      .map(d => `${d.saldo_pendiente} ${d.descripcion_material}`)
      .join(', ');

    const horas = calcularHorasDesdeFecha(c.fecha_emision, ahoraMs);
    const slaBadge = horas >= 48
      ? '<span class="px-2 py-0.5 text-[11px] font-bold rounded-full bg-rose-100 text-rose-700">+48h Crítico</span>'
      : horas >= 24
        ? '<span class="px-2 py-0.5 text-[11px] font-bold rounded-full bg-amber-100 text-amber-700">+24h Alerta</span>'
        : '<span class="px-2 py-0.5 text-[11px] font-medium rounded-full bg-slate-100 text-slate-600">En plazo</span>';

    const badgeClass = BADGE_STYLES[c.estado] || BADGE_STYLES.PENDIENTE;

    return `
            <tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/70 dark:hover:bg-slate-900/50 transition-colors">
                <td class="py-3 px-4 font-mono text-xs font-bold text-slate-900 dark:text-white">
                    <div>${escapeHtml(c.id_cargo)}</div>
                    <div class="text-[11px] font-sans font-normal text-slate-400">${escapeHtml(c.fecha_emision)}</div>
                </td>
                <td class="py-3 px-4">
                    <div class="font-semibold text-sm text-slate-800 dark:text-slate-200">${escapeHtml(c.nombre_cliente)}</div>
                    <div class="text-xs text-slate-500">Receptor: ${escapeHtml(c.receptor_nombre)} ${c.placa_vehiculo ? `• Placa: ${escapeHtml(c.placa_vehiculo)}` : ''}</div>
                </td>
                <td class="py-3 px-4 text-xs text-slate-600 dark:text-slate-300 max-w-xs truncate" title="${escapeHtml(resumenItems)}">
                    ${escapeHtml(resumenItems || 'Sin saldo')}
                </td>
                <td class="py-3 px-4 text-center">${slaBadge}</td>
                <td class="py-3 px-4 text-center">
                    <span class="px-2.5 py-1 text-xs font-bold rounded-full border ${badgeClass}">${escapeHtml(c.estado)}</span>
                </td>
                <td class="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                    <button type="button" onclick="abrirModalLiquidacion('${escapeHtml(c.id_cargo)}')"
                            class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-sm transition">
                        Liquidar
                    </button>
                    <button type="button" onclick="imprimirCargo('${escapeHtml(c.id_cargo)}', 'TICKET')"
                            class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition" title="Imprimir Ticket 80mm">
                        Ticket
                    </button>
                    ${AuthRules.puedeAnular() ? `
                    <button type="button" onclick="solicitarAnulacionCargo('${escapeHtml(c.id_cargo)}')"
                            class="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-semibold rounded-lg transition">
                        Anular
                    </button>` : ''}
                </td>
            </tr>
        `;
  }).join('');
}

function renderizarHistorico() {
  const tbody = document.getElementById('tbody-historico');
  if (!tbody) return;

  const busqueda = (document.getElementById('filtro-historico-texto')?.value || '').toLowerCase().trim();
  const estadoFiltro = document.getElementById('filtro-historico-estado')?.value || 'TODOS';

  const filtrados = AppState.cargos.filter(c => {
    if (estadoFiltro !== 'TODOS' && c.estado !== estadoFiltro) return false;
    if (busqueda) {
      return String(c.id_cargo).toLowerCase().includes(busqueda) ||
        String(c.nombre_cliente).toLowerCase().includes(busqueda) ||
        String(c.receptor_nombre).toLowerCase().includes(busqueda);
    }
    return true;
  });

  if (filtrados.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-slate-400 text-sm">Sin registros históricos para mostrar.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtrados.slice(0, 200).map(c => {
    const badgeClass = BADGE_STYLES[c.estado] || BADGE_STYLES.PENDIENTE;
    return `
            <tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/70 dark:hover:bg-slate-900/50">
                <td class="py-3 px-4 font-mono text-xs font-bold text-slate-900 dark:text-white">${escapeHtml(c.id_cargo)}</td>
                <td class="py-3 px-4 text-xs text-slate-500">${escapeHtml(c.fecha_emision)}</td>
                <td class="py-3 px-4 text-sm font-medium text-slate-800 dark:text-slate-200">${escapeHtml(c.nombre_cliente)}</td>
                <td class="py-3 px-4 text-center">
                    <span class="px-2.5 py-1 text-xs font-bold rounded-full border ${badgeClass}">${escapeHtml(c.estado)}</span>
                </td>
                <td class="py-3 px-4 text-right space-x-1.5">
                    <button type="button" onclick="imprimirCargo('${escapeHtml(c.id_cargo)}', 'A4')"
                            class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded">
                        A4
                    </button>
                    <button type="button" onclick="imprimirCargo('${escapeHtml(c.id_cargo)}', 'TICKET')"
                            class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded">
                        80mm
                    </button>
                </td>
            </tr>
        `;
  }).join('');
}

// ============================================================================
// 7. EXPORTACIÓN CSV (UTF-8 BOM) E IMPRESIÓN DUAL (A4 / TICKET 80MM)
// ============================================================================
function exportarHistoricoCSV() {
  if (AppState.cargos.length === 0) {
    mostrarToast('No hay datos para exportar.', 'warning');
    return;
  }

  const headers = ['ID_CARGO', 'FECHA_EMISION', 'CLIENTE', 'AREA_ORIGEN', 'RECEPTOR', 'DNI', 'PLACA', 'ESTADO', 'FECHA_CIERRE', 'OBSERVACIONES'];
  const rows = AppState.cargos.map(c => [
    c.id_cargo,
    c.fecha_emision,
    c.nombre_cliente,
    c.area_origen,
    c.receptor_nombre,
    c.receptor_dni,
    c.placa_vehiculo,
    c.estado,
    c.fecha_cierre,
    (c.observaciones || '').replace(/[\r\n]+/g, ' ')
  ].map(val => `"${String(val || '').replace(/"/g, '""')}"`).join(','));

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `GenLogistics_Embalajes_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function imprimirCargo(idCargo, formato = 'TICKET') {
  const cargo = AppState.cargos.find(c => String(c.id_cargo) === String(idCargo));
  if (!cargo) return;
  const dets = AppState.mapDetallesPorCargo.get(String(idCargo)) || [];

  const win = window.open('', '_blank', formato === 'TICKET' ? 'width=360,height=640' : 'width=840,height=900');
  if (!win) {
    mostrarToast('Habilita las ventanas emergentes para imprimir.', 'warning');
    return;
  }

  const isTicket = formato === 'TICKET';
  const itemsHtml = dets.map(d => `
        <tr>
            <td style="padding:4px 0; border-bottom:1px dashed #ccc;">${escapeHtml(d.descripcion_material)}</td>
            <td style="padding:4px 0; text-align:right; border-bottom:1px dashed #ccc;">${d.cantidad_entregada}</td>
            <td style="padding:4px 0; text-align:right; border-bottom:1px dashed #ccc;">${d.saldo_pendiente}</td>
        </tr>
    `).join('');

  win.document.write(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <title>Cargo ${escapeHtml(cargo.id_cargo)}</title>
            <style>
                body { font-family: 'Courier New', monospace; margin: 0; padding: ${isTicket ? '8px' : '24px'}; width: ${isTicket ? '76mm' : '100%'}; color: #000; font-size: ${isTicket ? '11px' : '13px'}; }
                h2 { margin: 0 0 4px; font-size: ${isTicket ? '14px' : '18px'}; text-align: center; }
                .meta { margin-bottom: 10px; line-height: 1.4; }
                table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                th { text-align: left; border-bottom: 1px solid #000; padding-bottom: 4px; }
                .firma { text-align: center; margin-top: 14px; }
                .firma img { max-width: 180px; max-height: 80px; border-bottom: 1px solid #000; }
            </style>
        </head>
        <body>
            <h2>LA GENOVESA AGROINDUSTRIAS</h2>
            <div style="text-align:center; font-weight:bold; margin-bottom:8px;">CONTROL DE EMBALAJES RETORNABLES</div>
            <div class="meta">
                <div><b>CARGO:</b> ${escapeHtml(cargo.id_cargo)}</div>
                <div><b>FECHA:</b> ${escapeHtml(cargo.fecha_emision)}</div>
                <div><b>CLIENTE:</b> ${escapeHtml(cargo.nombre_cliente)}</div>
                <div><b>RECEPTOR:</b> ${escapeHtml(cargo.receptor_nombre)} (${escapeHtml(cargo.receptor_dni || 'S/D')})</div>
                <div><b>PLACA:</b> ${escapeHtml(cargo.placa_vehiculo || 'N/A')} | <b>ESTADO:</b> ${escapeHtml(cargo.estado)}</div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Material</th>
                        <th style="text-align:right;">Ent.</th>
                        <th style="text-align:right;">Sal.</th>
                    </tr>
                </thead>
                <tbody>${itemsHtml}</tbody>
            </table>
            ${cargo.firma_receptor ? `<div class="firma"><img src="${cargo.firma_receptor}" alt="Firma"><div style="font-size:10px; margin-top:4px;">Firma de Conformidad</div></div>` : ''}
            <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 400); };</script>
        </body>
        </html>
    `);
  win.document.close();
}

// ============================================================================
// 8. UTILIDADES UI, SIGNATURE PAD Y DIÁLOGOS ASÍNCRONOS
// ============================================================================
function poblarSelectoresMaestros() {
  const selCli = document.getElementById('select-cliente');
  const selMat = document.getElementById('select-material');
  const selArea = document.getElementById('select-area');

  if (selCli) {
    selCli.innerHTML = '<option value="">Seleccionar cliente...</option>' +
      AppState.clientes.map(c => `<option value="${escapeHtml(c.id_cliente)}">${escapeHtml(c.razon_social || c.nombre)}</option>`).join('');
  }
  if (selMat) {
    selMat.innerHTML = '<option value="">Seleccionar embalaje...</option>' +
      AppState.materiales.map(m => `<option value="${escapeHtml(m.id_material)}">${escapeHtml(m.descripcion || m.nombre)} (${escapeHtml(m.unidad_medida || 'UND')})</option>`).join('');
  }
  if (selArea) {
    selArea.innerHTML = AppState.areas.map(a => {
      const nombre = a.nombre_area || a.area || '';
      return `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`;
    }).join('');
  }
}

function inicializarSignaturePad() {
  const canvas = document.getElementById('signature-pad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let dibujando = false;

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const start = (e) => {
    dibujando = true;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
  };

  const move = (e) => {
    if (!dibujando) return;
    if (e.cancelable) e.preventDefault();
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  };

  const end = () => { dibujando = false; };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end);
}

function limpiarFirmaCanvas() {
  const canvas = document.getElementById('signature-pad');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function limpiarFormularioEmision() {
  AppState.itemsCarrito = [];
  renderizarCarrito();
  limpiarFirmaCanvas();
  ['input-receptor-nombre', 'input-receptor-dni', 'input-placa', 'input-observaciones'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function inicializarEventosUI() {
  document.getElementById('form-emision-cargo')?.addEventListener('submit', confirmarEmisionCargo);
  document.getElementById('filtro-descargos-texto')?.addEventListener('input', renderizarDescargosPendientes);
  document.getElementById('filtro-descargos-sla')?.addEventListener('change', renderizarDescargosPendientes);
  document.getElementById('filtro-historico-texto')?.addEventListener('input', renderizarHistorico);
  document.getElementById('filtro-historico-estado')?.addEventListener('change', renderizarHistorico);
}

function formatearFechaLocal(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
}

function calcularHorasDesdeFecha(fechaStr, ahoraMs) {
  if (!fechaStr) return 0;
  const match = String(fechaStr).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return 0;
  const d = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  return Math.max(0, (ahoraMs - d.getTime()) / 3600000);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, ''');
}

function mostrarToast(mensaje, tipo = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const colors = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    warning: 'bg-amber-500 text-slate-950',
    info: 'bg-slate-800 text-white'
  };
  const toast = document.createElement('div');
  toast.className = `px-4 py-3 rounded-xl shadow-lg text-xs font-semibold transition-all duration-300 ${colors[tipo] || colors.info}`;
  toast.textContent = mensaje;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

const GenDialog = {
  prompt({ title, message, placeholder = '', confirmText = 'Aceptar', danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4';
      overlay.innerHTML = `
                <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
                    <h3 class="text-base font-bold text-slate-900 dark:text-white">${escapeHtml(title)}</h3>
                    <p class="text-xs text-slate-600 dark:text-slate-400">${escapeHtml(message)}</p>
                    <input type="text" id="gendialog-input" placeholder="${escapeHtml(placeholder)}"
                           class="w-full rounded-xl border-slate-300 dark:bg-slate-800 dark:border-slate-700 text-sm">
                    <div class="flex justify-end gap-2 pt-2">
                        <button type="button" id="gendialog-cancel" class="px-4 py-2 text-xs font-semibold rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200">Cancelar</button>
                        <button type="button" id="gendialog-ok" class="px-4 py-2 text-xs font-semibold rounded-xl text-white ${danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#gendialog-input');
      input.focus();

      const cerrar = (val) => {
        overlay.remove();
        resolve(val);
      };
      overlay.querySelector('#gendialog-cancel').onclick = () => cerrar(null);
      overlay.querySelector('#gendialog-ok').onclick = () => cerrar(input.value);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') cerrar(input.value);
        if (e.key === 'Escape') cerrar(null);
      };
    });
  }
};