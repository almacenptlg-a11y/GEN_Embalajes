/**
 * @fileoverview Frontend AppLogic - Sistema de Embalajes y Cargos (GenLogistics)
 */

// ¡REEMPLAZA ESTA URL SI CAMBIAS TU BACKEND!
const API_URL = "https://script.google.com/macros/s/AKfycbzhPAhH-K2qURzzW69xoH-QJ6RZdmQw3gJIt80Y6f4iTKyS7BqhXrgHTGWrO0PiSj4m/exec";

const AppState = {
  datos: {
    choferes: [],
    vehiculos: [],
    destinos: [],
    materiales: [],
    areas: []
  },
  cargoItems: [],
  cargosActivos: [],
  historial: [],
  sortConfig: { key: "fecha", asc: false }
};

// ==========================================
// SISTEMA DE ALERTAS PERSONALIZADO
// ==========================================
function mostrarAlerta(mensaje, tipo = "warning", titulo = "") {
  const modal = document.getElementById("customAlert");
  const content = document.getElementById("customAlertContent");
  const icon = document.getElementById("alertIcon");
  const title = document.getElementById("alertTitle");
  const msg = document.getElementById("alertMessage");
  const btn = document.getElementById("btnAlertClose");

  msg.textContent = mensaje;

  if (tipo === "warning" || tipo === "error") {
    icon.innerHTML = `<div class="w-20 h-20 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 border-4 border-red-500/20"><svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg></div>`;
    title.textContent = titulo || "Dato Requerido";
    btn.className = "w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold transition-all shadow-lg shadow-red-900/40 ring-red-500/50";
  } else if (tipo === "success") {
    icon.innerHTML = `<div class="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-400 border-4 border-emerald-500/20"><svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></div>`;
    title.textContent = titulo || "¡Operación Exitosa!";
    btn.className = "w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold transition-all shadow-lg shadow-emerald-900/40 ring-emerald-500/50";
  }

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
// INICIALIZACIÓN
// ==========================================
document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
  try {
    const res = await fetch(`${API_URL}?action=getInitData`, { method: "GET", redirect: "follow" });
    if (!res.ok) throw new Error(`Error de Servidor: Código ${res.status}`);

    const json = await res.json();
    if (json.status === "error") throw new Error(`El servidor devolvió: ${json.message}`);

    AppState.datos = json.data;

    // Filtramos áreas dinámicamente
    AppState.datos.areas = AppState.datos.destinos.filter((destino) => {
      return destino.EMISOR && String(destino.EMISOR).trim().toUpperCase() === "SI";
    });

    // Fusión de Placa y Marca
    AppState.datos.vehiculos = AppState.datos.vehiculos.map(v => {
      v.DISPLAY_NAME = `${v.PLACA} ${v.MARCA || ''}`.trim();
      return v;
    });

    construirUI();
    actualizarStatus("Conectado y Listo", "emerald");
  } catch (err) {
    actualizarStatus("Error Interno", "red");
    const panelError = document.getElementById("emptyState");
    if (panelError) {
      panelError.innerHTML = `
        <div class="text-red-400 font-bold mb-2">🚨 SE DETECTÓ UN ERROR 🚨</div>
        <div class="text-gray-300 text-xs text-left bg-gray-900 p-3 rounded-lg border border-red-500/50 font-mono">${err.message}</div>
      `;
      panelError.style.display = "block";
    }
  }
}

function construirUI() {
  setupAutocomplete("inArea", "hdArea", "listArea", AppState.datos.areas, "REFERENCIA", "ID_DSTN", "inChofer");
  setupAutocomplete("inChofer", "hdChofer", "listChofer", AppState.datos.choferes, "NOMBRE", "ID_CHFR", "inVehiculo");
  setupAutocomplete("inVehiculo", "hdVehiculo", "listVehiculo", AppState.datos.vehiculos, "DISPLAY_NAME", "PLACA", "inDestino");
  setupAutocomplete("inDestino", "hdDestino", "listDestino", AppState.datos.destinos, "REFERENCIA", "ID_DSTN", "inMaterial");
  setupAutocomplete("inMaterial", "hdMaterial", "listMaterial", AppState.datos.materiales, "DESCRIPCION", "ID_MEMB", "inCantidad");

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
}

function setupAutocomplete(inputId, hiddenId, listId, dataArray, displayField, valueField, nextInputId = null) {
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

    if (!val) {
      list.classList.add("hidden");
      return;
    }

    const matches = dataArray.filter((item) => {
      const text = item[displayField] ? String(item[displayField]).toLowerCase() : "";
      return text.includes(val);
    });

    if (matches.length === 0) {
      list.classList.add("hidden");
      return;
    }

    matches.forEach((item) => {
      const li = document.createElement("li");
      li.className = "px-4 py-2 text-gray-200 cursor-pointer text-sm border-b border-gray-700 last:border-0 transition-colors hover:bg-blue-600 hover:text-white";
      li.textContent = item[displayField];

      const selectAction = () => {
        input.value = item[displayField];
        hidden.value = item[valueField];
        list.classList.add("hidden");
        list.innerHTML = "";
        if (nextInputId) document.getElementById(nextInputId).focus();
      };

      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectAction();
      });

      li._selectTrigger = selectAction;
      list.appendChild(li);
    });

    list.classList.remove("hidden");
  });

  input.addEventListener("keydown", function (e) {
    const items = list.getElementsByTagName("li");
    if (list.classList.contains("hidden") || items.length === 0) return;

    if (e.key === "ArrowDown") {
      currentFocus++;
      addActive(items);
    } else if (e.key === "ArrowUp") {
      currentFocus--;
      addActive(items);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (currentFocus > -1) items[currentFocus]._selectTrigger();
      else items[0]._selectTrigger();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!hidden.value) {
        input.value = "";
        list.classList.add("hidden");
      }
    }, 150);
  });

  function addActive(items) {
    if (!items) return false;
    removeActive(items);
    if (currentFocus >= items.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = items.length - 1;
    items[currentFocus].classList.add("bg-blue-600", "text-white");
    items[currentFocus].scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function removeActive(items) {
    for (let i = 0; i < items.length; i++) items[i].classList.remove("bg-blue-600", "text-white");
  }
}

// ==========================================
// MÓDULO EMISIÓN DE CARGOS
// ==========================================
function agregarItemLista() {
  const destinoId = document.getElementById("hdDestino").value;
  const destinoText = document.getElementById("inDestino").value;
  const materialId = document.getElementById("hdMaterial").value;
  const materialText = document.getElementById("inMaterial").value;
  const cantidad = parseInt(document.getElementById("inCantidad").value);

  if (!destinoId) return mostrarAlerta("Por favor, selecciona un DESTINO válido de la lista desplegable.", "warning", "Falta Destino");
  if (!materialId) return mostrarAlerta("Debes especificar el TIPO DE MATERIAL de la lista desplegable.", "warning", "Falta Material");
  if (isNaN(cantidad) || cantidad <= 0) return mostrarAlerta("Ingresa una CANTIDAD numérica mayor a cero (0).", "warning", "Cantidad Inválida");

  const materialObj = AppState.datos.materiales.find((m) => m.ID_MEMB === materialId);
  const m3Unitario = materialObj && materialObj.M3 ? parseFloat(String(materialObj.M3).replace(",", ".")) : 0;
  const m3TotalLinea = m3Unitario * cantidad;

  AppState.cargoItems.push({
    destinoId,
    destinoName: destinoText,
    materialId,
    materialName: materialText,
    cantidad,
    m3Unitario,
    m3Total: m3TotalLinea
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

    const row = `
      <div class="flex items-center justify-between bg-gray-800/80 p-3 rounded-xl border border-gray-600 gap-2 overflow-hidden">
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <span class="bg-blue-900 text-blue-300 font-bold w-6 h-6 flex items-center justify-center rounded-md text-xs shrink-0">${idx + 1}</span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-white truncate" title="${item.materialName}">${item.materialName}</p>
            <div class="flex items-center gap-2 text-xs text-gray-400 truncate">
              <span title="${item.destinoName}">A: <span class="text-gray-300">${item.destinoName}</span></span>
              <span class="text-gray-600">|</span>
              <span class="text-emerald-400 font-mono" title="Cubicaje">${item.m3Total.toFixed(3)} m³</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 md:gap-3 shrink-0">
          <span class="bg-gray-900 px-2 py-1 md:px-3 md:py-1 rounded-lg text-xs md:text-sm text-gray-200 border border-gray-700 whitespace-nowrap">${item.cantidad} und.</span>
          <button type="button" onclick="removerItemLista(${idx})" class="text-red-400 hover:text-red-300 p-1 shrink-0 transition-colors">
            <svg class="w-5 h-5 md:w-6 md:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>`;
    container.insertAdjacentHTML("beforeend", row);
  });

  displayTotalM3.textContent = sumatoriaM3.toFixed(3);

  const tiposKeys = Object.keys(conteoTipos);
  boxResumen.innerHTML = tiposKeys.map((tipo) => `
    <div class="flex justify-between items-center text-sm border-b border-gray-700/50 last:border-0 pb-1 mb-1 last:pb-0 last:mb-0">
      <span class="text-gray-300 truncate pr-3" title="${tipo}">${tipo}</span>
      <span class="text-emerald-400 font-bold bg-emerald-900/30 px-2 rounded">${conteoTipos[tipo]}</span>
    </div>
  `).join("");
}

function removerItemLista(index) {
  AppState.cargoItems.splice(index, 1);
  renderizarListaItems();
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const chofer = document.getElementById("hdChofer").value;
  const vehiculo = document.getElementById("hdVehiculo").value;
  const area = document.getElementById("hdArea").value || document.getElementById("inArea").value.trim();

  // VALIDACIONES
  if (!area) return mostrarAlerta("Es obligatorio especificar el ÁREA RESPONSABLE que emite el cargo.", "error", "Falta Área");
  if (!chofer) return mostrarAlerta("Es obligatorio seleccionar un CHOFER para emitir el cargo.", "error", "Falta Chofer");
  if (!vehiculo) return mostrarAlerta("Es obligatorio seleccionar la PLACA del vehículo.", "error", "Falta Vehículo");
  if (AppState.cargoItems.length === 0) return mostrarAlerta("Debes añadir al menos un MATERIAL a la lista de viaje antes de emitir el cargo.", "error", "Lista de Viaje Vacía");

  // TRUCO ANTI-POPUP BLOCKER: Abrimos la pestaña antes de consultar al servidor
  const printTab = window.open("", "_blank");
  printTab.document.write(`
    <style>
      body { background-color: #111827; color: #f3f4f6; font-family: system-ui, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .spinner { border: 4px solid rgba(255,255,255,0.1); width: 45px; height: 45px; border-radius: 50%; border-left-color: #3b82f6; animation: spin 1s linear infinite; margin-bottom: 1.5rem; }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
    <div class="spinner"></div>
    <h2 style="margin:0 0 0.5rem 0;">Emitiendo Cargo Oficial...</h2>
    <p style="color:#9ca3af; font-size: 0.875rem;">Conectando con el servidor. No cierre esta pestaña.</p>
  `);

  const btn = document.getElementById("btnSubmit");
  const txt = btn.innerHTML;
  btn.innerHTML = `<svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Procesando...`;
  btn.disabled = true;

  const payload = {
    action: "saveCargo",
    data: {
      chofer,
      vehiculo,
      area,
      materiales: AppState.cargoItems.map((i) => ({
        id_memb: i.materialId,
        materialName: i.materialName,
        cantidad: i.cantidad,
        destino: i.destinoId
      }))
    }
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    if (result.status === "success") {
      const idGenerado = result.data.idCargo;

      // 1. CONSTRUIR CARGO TEMPORAL (Para imprimir instantáneamente sin hacer otro fetch)
      const choferCat = AppState.datos.choferes.find(c => c.ID_CHFR === chofer);
      const vehiculoCat = AppState.datos.vehiculos.find(v => v.PLACA === vehiculo);
      
      const ahora = new Date();
      const fechaFormat = `${ahora.getDate().toString().padStart(2, '0')}/${(ahora.getMonth()+1).toString().padStart(2, '0')}/${ahora.getFullYear()} ${ahora.getHours().toString().padStart(2, '0')}:${ahora.getMinutes().toString().padStart(2, '0')}:${ahora.getSeconds().toString().padStart(2, '0')}`;

      AppState.cargosActivos.push({
        idCargo: idGenerado,
        choferNombre: choferCat ? choferCat.NOMBRE : chofer,
        placa: vehiculoCat ? vehiculoCat.DISPLAY_NAME : vehiculo,
        hora: fechaFormat,
        detalles: AppState.cargoItems.map(i => ({
          LLEVA: i.cantidad,
          DESTINO: i.destinoId,
          MATERIAL: i.materialId,
          AREA: area
        }))
      });

      // 2. LANZAR LA IMPRESIÓN A LA PESTAÑA ABIERTA
      generarDocumentoImpresion(idGenerado, printTab);

      // 3. LIMPIAR INTERFAZ
      mostrarAlerta(`El viaje ha sido registrado con el ID: ${idGenerado}`, "success", "¡Cargo Emitido!");
      document.getElementById("cargoForm").reset();
      ["hdArea", "hdChofer", "hdVehiculo", "hdDestino", "hdMaterial"].forEach((id) => (document.getElementById(id).value = ""));
      AppState.cargoItems = [];
      renderizarListaItems();

    } else {
      if(printTab && !printTab.closed) printTab.close(); // Si falla, cerramos la pestaña
      throw new Error(result.message);
    }
  } catch (err) {
    if(printTab && !printTab.closed) printTab.close(); // Si falla, cerramos la pestaña
    mostrarAlerta("Error del servidor: " + err.message, "error", "Fallo de Emisión");
  } finally {
    btn.innerHTML = txt;
    btn.disabled = false;
  }
}

function actualizarStatus(t, c) {
  document.getElementById("status-indicator").innerHTML = `<span class="relative flex h-2 w-2 mr-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-${c}-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-${c}-500"></span></span>${t}`;
}

// ==========================================
// MÓDULO DE DESCARGOS Y DASHBOARD
// ==========================================
// CONTROL DE PESTAÑAS
document.getElementById("tabEmitir").addEventListener("click", () => {
  document.getElementById("viewEmitir").classList.remove("hidden");
  document.getElementById("viewDescargo").classList.add("hidden");
  document.getElementById("viewHistorico").classList.add("hidden");
  
  document.getElementById("tabEmitir").className = "px-5 py-2 bg-blue-600 rounded-xl text-sm font-bold text-white shadow-lg transition-all";
  document.getElementById("tabDescargo").className = "px-5 py-2 hover:bg-gray-700 rounded-xl text-sm font-bold text-gray-400 transition-all";
  document.getElementById("tabHistorico").className = "px-5 py-2 hover:bg-gray-700 rounded-xl text-sm font-bold text-gray-400 transition-all";
});

document.getElementById("tabDescargo").addEventListener("click", () => {
  document.getElementById("viewDescargo").classList.remove("hidden");
  document.getElementById("viewEmitir").classList.add("hidden");
  document.getElementById("viewHistorico").classList.add("hidden");
  
  document.getElementById("tabDescargo").className = "px-5 py-2 bg-emerald-600 rounded-xl text-sm font-bold text-white shadow-lg transition-all";
  document.getElementById("tabEmitir").className = "px-5 py-2 hover:bg-gray-700 rounded-xl text-sm font-bold text-gray-400 transition-all";
  document.getElementById("tabHistorico").className = "px-5 py-2 hover:bg-gray-700 rounded-xl text-sm font-bold text-gray-400 transition-all";
  cargarViajesPendientes();
});

document.getElementById("tabHistorico").addEventListener("click", () => {
  document.getElementById("viewHistorico").classList.remove("hidden");
  document.getElementById("viewEmitir").classList.add("hidden");
  document.getElementById("viewDescargo").classList.add("hidden");
  
  document.getElementById("tabHistorico").className = "px-5 py-2 bg-blue-600 rounded-xl text-sm font-bold text-white shadow-lg transition-all";
  document.getElementById("tabEmitir").className = "px-5 py-2 hover:bg-gray-700 rounded-xl text-sm font-bold text-gray-400 transition-all";
  document.getElementById("tabDescargo").className = "px-5 py-2 hover:bg-gray-700 rounded-xl text-sm font-bold text-gray-400 transition-all";
  cargarHistorico();
});

document.getElementById("btnRefreshCargos").addEventListener("click", cargarViajesPendientes);
document.getElementById("inBuscarCargo").addEventListener("input", renderizarCargosFiltrados);
document.getElementById("selFiltroColumna").addEventListener("change", renderizarCargosFiltrados);

async function cargarViajesPendientes() {
  const grid = document.getElementById("gridCargos");
  grid.innerHTML = `<div class="text-center text-emerald-400 py-8 animate-pulse font-bold">Consultando base de datos...</div>`;

  try {
    const res = await fetch(`${API_URL}?action=getActiveCargos`, { method: "GET", redirect: "follow" });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message);

    AppState.cargosActivos = json.data.map((cargo) => {
      cargo._horaSort = estandarizarFecha(cargo.hora);
      return cargo;
    });

    renderizarCargosFiltrados();
  } catch (err) {
    grid.innerHTML = `<div class="text-center text-red-500 py-8 border border-red-500/50 rounded-xl bg-red-500/10">Error: ${err.message}</div>`;
  }
}

window.setSort = function (key) {
  if (AppState.sortConfig.key === key) {
    AppState.sortConfig.asc = !AppState.sortConfig.asc;
  } else {
    AppState.sortConfig.key = key;
    AppState.sortConfig.asc = true;
  }
  renderizarCargosFiltrados();
};

function getSortIcon(key) {
  if (AppState.sortConfig.key !== key) return `<span class="text-gray-600 ml-1">↕</span>`;
  return AppState.sortConfig.asc ? `<span class="text-emerald-400 ml-1">↑</span>` : `<span class="text-emerald-400 ml-1">↓</span>`;
}

function estandarizarFecha(fechaLatina) {
  if (!fechaLatina) return "0000-00-00 00:00:00";
  const partes = String(fechaLatina).split(/[ \/:-]+/);
  if (partes.length >= 3) {
    const d = partes[0].padStart(2, "0");
    const m = partes[1].padStart(2, "0");
    const y = partes[2];
    const hr = (partes[3] || "00").padStart(2, "0");
    const min = (partes[4] || "00").padStart(2, "0");
    const sec = (partes[5] || "00").padStart(2, "0");
    return `${y}-${m}-${d} ${hr}:${min}:${sec}`;
  }
  return String(fechaLatina);
}

function renderizarCargosFiltrados() {
  let filtrados = [...AppState.cargosActivos];
  const searchTerm = document.getElementById("inBuscarCargo").value.toLowerCase().trim();
  const filtroColumna = document.getElementById("selFiltroColumna").value;

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

  if (!cargos || cargos.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-400 py-8 font-bold bg-gray-800/40 rounded-2xl border border-gray-700/50">No se encontraron viajes pendientes.</div>`;
    return;
  }

  let html = `
    <div class="overflow-x-auto rounded-xl border border-gray-700/80 shadow-inner">
      <table class="w-full text-left text-sm text-gray-300 whitespace-nowrap">
        <thead class="bg-gray-900/80 text-xs uppercase text-gray-400 select-none border-b border-gray-700">
          <tr>
            <th class="px-4 py-4 cursor-pointer hover:text-white transition-colors" onclick="setSort('idCargo')">ID Cargo ${getSortIcon("idCargo")}</th>
            <th class="px-4 py-4 cursor-pointer hover:text-white transition-colors" onclick="setSort('placa')">Placa ${getSortIcon("placa")}</th>
            <th class="px-4 py-4 cursor-pointer hover:text-white transition-colors" onclick="setSort('choferNombre')">Chofer ${getSortIcon("choferNombre")}</th>
            <th class="px-4 py-4 cursor-pointer hover:text-white transition-colors" onclick="setSort('fecha')">Hora Salida ${getSortIcon("hora")}</th>
            <th class="px-4 py-4 text-center">Estado</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800/60">
  `;

  cargos.forEach((cargo) => {
    let totalDeuda = 0;

    cargo.detalles.forEach((d) => {
      const lleva = parseInt(d.LLEVA || 0);
      const devuelve = parseInt(d.DEVUELVE || 0);
      const deudaLinea = parseInt(d.DEUDA !== undefined && d.DEUDA !== "" ? d.DEUDA : lleva - devuelve);
      totalDeuda += deudaLinea;
    });

    const horaSalida = cargo.hora || "--/--/---- --:--:--";
    let badgeEstadoHTML = "";
    
    if (totalDeuda > 0) {
      badgeEstadoHTML = `<span class="bg-pink-600/20 text-pink-400 border border-pink-500/30 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 justify-center w-fit mx-auto shadow-[0_0_10px_rgba(219,39,119,0.1)]">
        <span class="w-1.5 h-1.5 rounded-full bg-pink-500 animate-pulse"></span>Debe ${totalDeuda}
      </span>`;
    } else if (totalDeuda < 0) {
      badgeEstadoHTML = `<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 justify-center w-fit mx-auto">
        Excedente: ${Math.abs(totalDeuda)}
      </span>`;
    } else {
      badgeEstadoHTML = `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded-full text-xs font-bold flex items-center justify-center w-fit mx-auto">
        Completado
      </span>`;
    }

    html += `
      <tr class="hover:bg-gray-800/60 transition-colors group cursor-pointer" onclick="abrirDetalle('${cargo.idCargo}')" title="Clic para ver detalles">
        <td class="px-4 py-3 font-mono text-gray-400 text-xs">${cargo.idCargo}</td>
        <td class="px-4 py-3"><span class="bg-blue-900/40 text-blue-300 border border-blue-800/50 px-2 py-1 rounded text-xs font-bold">${cargo.placa || "S/N"}</span></td>
        <td class="px-4 py-3 font-bold text-gray-200 truncate max-w-[200px]">${cargo.choferNombre}</td>
        <td class="px-4 py-3 text-emerald-400/80 font-mono text-xs tracking-wider">${horaSalida}</td>
        <td class="px-4 py-3 text-center align-middle">${badgeEstadoHTML}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  grid.innerHTML = html;
}

// ==========================================
// CONTROLADOR DEL MODAL DETALLE Y LIQUIDACIÓN
// ==========================================
function abrirDetalle(idCargo) {
  const cargo = AppState.cargosActivos.find((c) => c.idCargo === idCargo);
  if (!cargo) return;

  let totalMaterialesLlevados = 0;
  let totalDeudaViaje = 0;
  let totalM3Llevado = 0;

  const destinosSet = new Set();
  const resumenTipos = {};

  const detallesProcesados = cargo.detalles.map((d) => {
    const lleva = parseInt(d.LLEVA || 0);
    const devuelve = parseInt(d.DEVUELVE || 0);
    const deuda = parseInt(d.DEUDA !== undefined && d.DEUDA !== "" ? d.DEUDA : lleva - devuelve);

    const destinoCat = AppState.datos.destinos.find((x) => x.ID_DSTN === d.DESTINO);
    const nombreDestino = destinoCat ? destinoCat.REFERENCIA : d.DESTINO || "Desconocido";

    const materialCat = AppState.datos.materiales.find((m) => m.ID_MEMB === d.MATERIAL);
    const nombreMaterial = materialCat ? materialCat.DESCRIPCION : d.MATERIAL || "Desconocido";

    const m3Unitario = materialCat && materialCat.M3 ? parseFloat(String(materialCat.M3).replace(",", ".")) : 0;
    const m3Llevado = m3Unitario * lleva;

    return { ...d, lleva, devuelve, deuda, nombreDestino, nombreMaterial, m3Llevado };
  });

  detallesProcesados.forEach((d) => {
    totalMaterialesLlevados += d.lleva;
    totalDeudaViaje += d.deuda;
    totalM3Llevado += d.m3Llevado;

    destinosSet.add(d.nombreDestino);

    if (!resumenTipos[d.nombreMaterial]) resumenTipos[d.nombreMaterial] = 0;
    resumenTipos[d.nombreMaterial] += d.lleva;
  });

  document.getElementById("mdlTitleCargo").textContent = cargo.idCargo;
  document.getElementById("mdlChofer").textContent = cargo.choferNombre;
  document.getElementById("mdlHora").textContent = cargo.hora || "--";
  // Traductor del Área en el Modal
  const areaRaw = cargo.detalles[0]?.AREA || cargo.area || "Almacén PT";
  const areaCat = AppState.datos.destinos.find((x) => x.ID_DSTN === areaRaw);
  document.getElementById("mdlDespacho").textContent = areaCat ? areaCat.REFERENCIA : areaRaw;
  document.getElementById("mdlGestor").textContent = cargo.gestor || "No registrado";

  const vehiculoObj = AppState.datos.vehiculos.find(v => v.PLACA === cargo.placa);
  let fotoUrl = "https://images.unsplash.com/photo-1601584115197-04ecc0da31d7?auto=format&fit=crop&q=80&w=800";
  let nombreVehiculo = cargo.placa || "S/N";

  if (vehiculoObj) {
    nombreVehiculo = vehiculoObj.DISPLAY_NAME || cargo.placa;
    if (vehiculoObj.FOTO_VEHICULO) {
      fotoUrl = String(vehiculoObj.FOTO_VEHICULO).trim();
    }
  }

  document.getElementById("imgVehiculoModal").src = fotoUrl;
  document.getElementById("mdlPlaca").textContent = nombreVehiculo;

  const mdlBadge = document.getElementById("mdlBadgeDeuda");
  if (totalDeudaViaje > 0) {
    mdlBadge.innerHTML = `<span class="bg-pink-600 text-white font-bold px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 w-fit shadow-lg shadow-pink-900/50"><svg class="w-4 h-4 animate-spin-slow" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Debe ${totalDeudaViaje} materiales</span>`;
  } else if (totalDeudaViaje < 0) {
    mdlBadge.innerHTML = `<span class="bg-amber-600 text-white font-bold px-3 py-1.5 rounded-lg text-sm w-fit shadow-lg shadow-amber-900/50">Excedente: ${Math.abs(totalDeudaViaje)}</span>`;
  } else {
    mdlBadge.innerHTML = `<span class="bg-emerald-600 text-white font-bold px-3 py-1.5 rounded-lg text-sm w-fit shadow-lg shadow-emerald-900/50">Completado / Sin deuda</span>`;
  }

  const arrDestinos = Array.from(destinosSet);
  document.getElementById("mdlDestinosCount").textContent = `(${arrDestinos.length})`;
  document.getElementById("mdlDestinosList").innerHTML = arrDestinos.map((dest) => `<div class="truncate" title="${dest}">${dest}</div>`).join("");

  const arrTiposKeys = Object.keys(resumenTipos);
  document.getElementById("mdlTiposCount").textContent = `(${arrTiposKeys.length})`;
  document.getElementById("mdlTiposList").innerHTML = arrTiposKeys.map((tipo) => `<div class="truncate" title="${tipo}"><span class="text-emerald-400 font-bold mr-1">${resumenTipos[tipo]}</span> ${tipo}</div>`).join("");

 // TOTALES EN EL ENCABEZADO DE LA TABLA DEL MODAL
  document.getElementById("mdlTotalMateriales").outerHTML = `
    <span id="mdlTotalMateriales" class="flex items-center gap-2">
      <span class="bg-gray-700 text-white px-2 py-0.5 rounded text-sm">${totalMaterialesLlevados}</span>
      <span class="bg-gray-900 border border-gray-600 text-emerald-400 font-mono px-2 py-0.5 rounded text-xs shadow-inner">
        Volumen: ${totalM3Llevado.toFixed(3)} m³
      </span>
    </span>
  `;

  // CORRECCIÓN: Se eliminó 'truncate', 'max-w-[]' y 'whitespace-nowrap'. 
  // Ahora el texto fluye naturalmente hacia abajo y la tabla respeta el ancho del modal.
  const tablaHTML = detallesProcesados.map((det) => `
    <tr class="hover:bg-gray-800/50 transition-colors border-b border-gray-800 last:border-0 ${det.deuda <= 0 ? "opacity-60 bg-gray-900/30" : ""}">
      <td class="px-3 py-3 text-gray-400 align-middle">${det.nombreDestino}</td>
      <td class="px-3 py-3 align-middle">
        <div class="${det.deuda <= 0 ? "text-gray-500" : "text-gray-200"} font-medium leading-snug">${det.nombreMaterial}</div>
        <div class="text-[10px] text-emerald-400/80 font-mono mt-1">Vol: ${det.m3Llevado.toFixed(3)} m³</div>
      </td>
      <td class="px-3 py-3 align-middle">
         <div class="flex items-center justify-center gap-2 md:gap-3 text-xs bg-gray-900/50 rounded-lg p-1.5 border border-gray-700 w-max mx-auto">
            <div class="flex flex-col items-center"><span class="text-[9px] text-gray-500 uppercase">Lleva</span><span class="text-white font-bold">${det.lleva}</span></div>
            <div class="w-px h-6 bg-gray-700"></div>
            <div class="flex flex-col items-center"><span class="text-[9px] text-gray-500 uppercase">Devuelto</span><span class="text-emerald-400 font-bold">${det.devuelve}</span></div>
            <div class="w-px h-6 bg-gray-700"></div>
            <div class="flex flex-col items-center"><span class="text-[9px] text-gray-500 uppercase">Deuda</span><span class="${det.deuda > 0 ? "text-red-400" : det.deuda < 0 ? "text-amber-400" : "text-gray-500"} font-bold">${det.deuda}</span></div>
         </div>
      </td>
      <td class="px-3 py-3 align-middle w-24">
        <input type="number" min="0" data-id="${det.ID_DETALLE}" placeholder="${det.deuda <= 0 ? "-" : "0"}" 
               class="w-full bg-gray-900 border border-gray-600 rounded p-1.5 text-center text-emerald-400 font-bold focus:border-emerald-500 outline-none mdl-return-input transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-800"
               ${det.deuda <= 0 ? "disabled" : ""}>
      </td>
    </tr>
  `).join("");
  
  // CORRECCIÓN: Quitamos 'whitespace-nowrap' de la etiqueta <table>
  document.getElementById("mdlTablaMateriales").parentNode.className = "w-full text-left text-xs text-gray-300";
  document.getElementById("mdlTablaMateriales").innerHTML = tablaHTML;

  document.getElementById("btnLiquidarModal").setAttribute("onclick", `procesarLiquidacionModal(this, '${cargo.idCargo}')`);
  document.getElementById("btnPrintModal").onclick = () => generarDocumentoImpresion(cargo.idCargo);

  const inputsRetorna = document.querySelectorAll(".mdl-return-input:not([disabled])");
  
  inputsRetorna.forEach((input, index) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (index < inputsRetorna.length - 1) {
          inputsRetorna[index + 1].focus();
        } else {
          document.getElementById("btnLiquidarModal").focus();
        }
      }
    });
  });

  const modal = document.getElementById("modalDetalle");
  const modalContent = document.getElementById("modalDetalleContent");
  modal.classList.remove("hidden");

  setTimeout(() => {
    modal.classList.remove("opacity-0");
    modalContent.classList.remove("scale-95");

    if (inputsRetorna.length > 0) {
      inputsRetorna[0].focus();
    }
  }, 50);
  }

async function procesarLiquidacionModal(btnElement, idCargo) {
  const inputs = document.querySelectorAll(".mdl-return-input:not([disabled])");

  const payloadDevolucion = [];
  inputs.forEach((input) => {
    const qty = parseInt(input.value);
    if (qty > 0) {
      payloadDevolucion.push({
        id_detalle: input.getAttribute("data-id"),
        qty: qty
      });
    }
  });

  if (payloadDevolucion.length === 0) return mostrarAlerta("Ingresa al menos una cantidad mayor a 0 en la columna 'Retorna'.", "warning", "Datos Insuficientes");

  const textoOriginal = btnElement.innerHTML;
  btnElement.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Procesando...`;
  btnElement.disabled = true;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "updateDevolucion",
        data: payloadDevolucion
      })
    });
    
    const result = await res.json();

    if (result.status === "success") {
      mostrarAlerta(`Liquidación procesada correctamente. Se actualizaron ${result.data.procesados} registros.`, "success", "¡Guardado Exitoso!");
      cerrarDetalle();
      cargarViajesPendientes();
    } else {
      throw new Error(result.message);
    }
  } catch (err) {
    mostrarAlerta("Error del servidor: " + err.message, "error", "Fallo de Conexión");
  } finally {
    btnElement.innerHTML = textoOriginal;
    btnElement.disabled = false;
  }
}

function cerrarDetalle() {
  const modal = document.getElementById("modalDetalle");
  const modalContent = document.getElementById("modalDetalleContent");

  modal.classList.add("opacity-0");
  modalContent.classList.add("scale-95");

  setTimeout(() => {
    modal.classList.add("hidden");
  }, 300); 
}

// ==========================================
// MOTOR DE IMPRESIÓN Y PDF (FORMATO COMPACTO / MEDIA HOJA)
// ==========================================
function generarDocumentoImpresion(idCargo, targetWindow = null) {
  const cargo = AppState.cargosActivos.find((c) => c.idCargo === idCargo);
  if (!cargo) return;

  let totalLlevado = 0;
  let totalM3Llevado = 0;
  const destinosSet = new Set();
  const resumenTipos = {};

  // TABLA COMPACTADA: py-1 px-2 en lugar de py-2 px-4
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
        <td class="py-1 px-2 border-b border-gray-200 text-gray-600">${nombreDestino}</td>
        <td class="py-1 px-2 border-b border-gray-200 font-medium text-gray-800">${nombreMaterial}</td>
        <td class="py-1 px-2 border-b border-gray-200 text-center font-bold text-gray-900">${lleva}</td>
        <td class="py-1 px-2 border-b border-gray-200 text-center"></td>
      </tr>
    `;
    }).join("");

  const destinosHTML = Array.from(destinosSet).map((dest) => `<div>• ${dest}</div>`).join("");
  const tiposHTML = Object.keys(resumenTipos).map((tipo) => `<div><span class="font-bold mr-1">${resumenTipos[tipo]}</span> ${tipo}</div>`).join("");
  
  // Traductor del Área
  const areaRaw = cargo.detalles[0]?.AREA || cargo.area || "Almacén PT";
  const areaCat = AppState.datos.destinos.find((x) => x.ID_DSTN === areaRaw);
  const areaResponsable = areaCat ? areaCat.REFERENCIA : areaRaw;

  const htmlPlantilla = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Cargo_${cargo.idCargo}_${cargo.choferNombre.replace(/\s+/g, "")}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #f3f4f6; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        /* COMPRESIÓN: Quitamos el min-height:29.7cm para que ocupe solo lo necesario. Padding reducido a 1cm */
        .a4-container { max-width: 21cm; margin: 1rem auto; background: white; padding: 1cm; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); }
        #lista tr:nth-child(even) { background-color: #f9fafb; }
        @media print {
            body { background-color: white; }
            .a4-container { margin: 0; padding: 0; box-shadow: none; max-width: 100%; }
            .no-print { display: none !important; }
            /* COMPRESIÓN: Margen de hoja de 0.5cm */
            @page { size: A4 portrait; margin: 0.5cm; }
        }
    </style>
</head>
<body class="text-gray-800 antialiased text-xs">

    <div class="fixed bottom-6 right-6 flex flex-col gap-3 no-print z-50">
        <button onclick="window.print()" class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white px-5 py-3 rounded-full shadow-lg font-semibold transition-transform transform hover:scale-105">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
            Imprimir
        </button>
        <button id="generatePdfButton" class="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-5 py-3 rounded-full shadow-lg font-semibold transition-transform transform hover:scale-105">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            Descargar PDF
        </button>
    </div>

    <div class="a4-container relative" id="pdf-content">
        <header class="flex justify-between items-start border-b border-gray-800 pb-3 mb-4">
            <div class="w-36 shrink-0">
                <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='60 20 280 160'%3E%3Cpath d='m200 25 135 47v56l-135 47-135-47V72z' fill='%23C51D23' stroke='%23C51D23' stroke-width='8' stroke-linejoin='round'/%3E%3Cpath d='m200 25 135 47v56l-135 47-135-47V72z' fill='none' stroke='%23B08D57' stroke-width='1' stroke-linejoin='round'/%3E%3Ctext x='200' y='86' font-family='Times, serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%23404040'%3ELA%3C/text%3E%3Ctext x='200' y='85' font-family='Times, serif' font-size='36' font-weight='bold' text-anchor='middle' fill='%23FFF'%3ELA%3C/text%3E%3Ctext x='200' y='121' font-family='Times, serif' font-size='42' font-weight='bold' text-anchor='middle' fill='%23404040'%3EGENOVESA%3C/text%3E%3Ctext x='200' y='120' font-family='Times, serif' font-size='42' font-weight='bold' text-anchor='middle' fill='%23FFF'%3EGENOVESA%3C/text%3E%3Ctext x='200' y='145' font-family='Arial, sans-serif' font-size='12' text-anchor='middle' fill='%23FFF' letter-spacing='3'%3EDESDE 1977%3C/text%3E%3C/svg%3E" class="w-full h-auto" alt="Logo La Genovesa">
            </div>
            <div class="text-right flex flex-col justify-center mt-2">
                <h1 class="text-lg font-bold text-gray-900 uppercase tracking-tight">Cargo de Embalajes</h1>
                <p class="text-xs font-semibold text-gray-600 mt-0.5">La Genovesa Agroindustrias S.A.</p>
                <p class="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">${areaResponsable}</p>
            </div>
        </header>

        <section class="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 bg-gray-50 p-3 rounded-lg border border-gray-200">
            <div>
                <p class="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-0.5">Documento</p>
                <p class="text-xs"><span class="font-semibold text-gray-900">N° Cargo:</span> <span class="font-mono bg-white border border-gray-300 px-1 py-0.5 rounded ml-1">${cargo.idCargo}</span></p>
                <p class="text-xs mt-1"><span class="font-semibold text-gray-900">Emisión:</span> ${cargo.hora || "--"}</p>
            </div>
            <div>
                <p class="text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-0.5">Transporte</p>
                <p class="text-xs"><span class="font-semibold text-gray-900">Chofer:</span> <span class="capitalize">${cargo.choferNombre}</span></p>
                <p class="text-xs mt-1"><span class="font-semibold text-gray-900">Vehículo:</span> <span class="font-mono bg-white border border-gray-300 px-1 py-0.5 rounded ml-1">${cargo.placa || "S/N"}</span></p>
            </div>
        </section>

        <section class="mb-4">
            <table class="w-full text-left border-collapse text-xs">
                <thead>
                    <tr class="bg-gray-800 text-white text-[10px] uppercase tracking-wider">
                        <th class="py-1.5 px-2 rounded-tl w-1/3">Destino</th>
                        <th class="py-1.5 px-2 w-1/3">Material</th>
                        <th class="py-1.5 px-2 text-center">Lleva</th>
                        <th class="py-1.5 px-2 text-center rounded-tr">Devolución</th>
                    </tr>
                </thead>
                <tbody id="lista" class="border border-gray-200">
                    ${filasTablaHTML}
                </tbody>
                <tfoot>
                    <tr class="bg-gray-100 border-t border-gray-300">
                        <td colspan="2" class="py-2 px-2 text-right font-bold text-gray-600 uppercase text-[10px] tracking-wider">
                            Total General del Viaje:
                        </td>
                        <td class="py-2 px-2 text-center font-black text-blue-700 text-base">
                            ${totalLlevado} <span class="text-[9px] text-gray-500 font-bold uppercase">und</span>
                        </td>
                        <td class="py-2 px-2 text-center font-mono text-emerald-600 font-bold text-xs">
                            ${totalM3Llevado.toFixed(3)} m³
                        </td>
                    </tr>
                </tfoot>
            </table>
        </section>

        <section class="grid grid-cols-12 gap-4 mt-4">
            <div class="col-span-4">
                <h4 class="text-[10px] font-bold text-gray-500 uppercase border-b border-gray-200 pb-0.5 mb-1">Destinos</h4>
                <div class="text-[10px] text-gray-700 space-y-0.5 leading-snug">${destinosHTML}</div>
            </div>
            <div class="col-span-4">
                <h4 class="text-[10px] font-bold text-gray-500 uppercase border-b border-gray-200 pb-0.5 mb-1">Tipos de Material</h4>
                <div class="text-[10px] text-gray-700 space-y-0.5 font-mono leading-snug">${tiposHTML}</div>
            </div>
            <div class="col-span-4 flex flex-col justify-end items-center pt-2">
                <div class="w-full max-w-[180px] border-b border-gray-800 border-dashed pb-1 flex justify-center mb-1 min-h-[50px]"></div>
                <p class="text-[10px] font-bold text-gray-900 uppercase text-center w-full truncate" title="${cargo.choferNombre}">${cargo.choferNombre}</p>
                <p class="text-[9px] text-gray-500 uppercase text-center mt-0.5">Firma de Conformidad</p>
            </div>
        </section>
        
        <div class="absolute bottom-2 left-0 w-full text-center text-[9px] text-gray-400 no-print" style="display: none;">
            Documento generado por Sistema GenLogistics
        </div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
    <script>
        document.getElementById('generatePdfButton').addEventListener('click', function () {
            const btnContainer = document.querySelector('.fixed.bottom-6');
            btnContainer.style.display = 'none';
            const element = document.getElementById('pdf-content');
            const opt = {
                margin: [5, 5, 5, 5], // COMPRESIÓN: Márgenes de hoja a 5mm
                filename: document.title + '.pdf',
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 2, useCORS: true, letterRendering: true }, 
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };
            html2pdf().set(opt).from(element).save().then(() => {
                btnContainer.style.display = 'flex';
            });
        });
    </script>
</body>
</html>`;

  const printWindow = targetWindow || window.open("", "_blank");
  if(printWindow) {
    printWindow.document.open();
    printWindow.document.write(htmlPlantilla);
    printWindow.document.close();
  }
}

// ==========================================
// MÓDULO: HISTÓRICO DE MOVIMIENTOS
// ==========================================
document.getElementById("btnRefreshHistorico").addEventListener("click", cargarHistorico);
document.getElementById("inBuscarHistorico").addEventListener("input", renderizarHistorico);
// NUEVO: Escuchadores para los rangos de fecha
document.getElementById("inDesdeHistorico").addEventListener("change", renderizarHistorico);
document.getElementById("inHastaHistorico").addEventListener("change", renderizarHistorico);

async function cargarHistorico() {
  const grid = document.getElementById("gridHistorico");
  grid.innerHTML = `<div class="text-center text-blue-400 py-12 animate-pulse font-bold text-lg"><svg class="animate-spin -ml-1 mr-3 h-6 w-6 inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Consultando matriz de movimientos...</div>`;

  try {
    const res = await fetch(`${API_URL}?action=getHistory`, { method: "GET", redirect: "follow" });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message);

    AppState.historial = json.data;
    renderizarHistorico();
  } catch (err) {
    grid.innerHTML = `<div class="text-center text-red-500 py-8 border border-red-500/50 rounded-xl bg-red-500/10">Error: ${err.message}</div>`;
  }
}

function renderizarHistorico() {
  const grid = document.getElementById("gridHistorico");
  const searchTerm = document.getElementById("inBuscarHistorico").value.toLowerCase().trim();
  const fechaDesde = document.getElementById("inDesdeHistorico").value; // Formato YYYY-MM-DD
  const fechaHasta = document.getElementById("inHastaHistorico").value; // Formato YYYY-MM-DD

  // 1. Traducción inteligente (IDs a Nombres Reales)
  let filtrados = AppState.historial.map(det => {
    const materialObj = AppState.datos.materiales.find(m => m.ID_MEMB === det.material);
    const destinoObj = AppState.datos.destinos.find(d => d.ID_DSTN === det.destino);
    const idChoferLimpio = det.chofer ? String(det.chofer).replace(/'/g, '') : '';
    const choferObj = AppState.datos.choferes.find(c => c.ID_CHFR === idChoferLimpio);

    return {
      ...det,
      materialName: materialObj ? materialObj.DESCRIPCION : det.material,
      destinoName: destinoObj ? destinoObj.REFERENCIA : det.destino,
      choferName: choferObj ? choferObj.NOMBRE : det.chofer
    };
  });

  // 2. Filtro por Rango de Fechas
  if (fechaDesde || fechaHasta) {
    filtrados = filtrados.filter(item => {
      if (!item.horaCargo) return false;
      
      // Parseo: Google Sheets envía "28/02/2026 15:30:00", lo convertimos a "YYYY-MM-DD"
      const datePart = item.horaCargo.split(' ')[0]; 
      const parts = datePart.split('/');
      if(parts.length !== 3) return true; // Si por error no tiene formato fecha, lo mostramos
      
      const itemDateISO = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      
      let pasaDesde = true;
      let pasaHasta = true;

      if (fechaDesde) pasaDesde = itemDateISO >= fechaDesde;
      if (fechaHasta) pasaHasta = itemDateISO <= fechaHasta;

      return pasaDesde && pasaHasta;
    });
  }

  // 3. Filtro de Búsqueda Global (Texto)
  if (searchTerm) {
    filtrados = filtrados.filter(item => {
      return (item.idCargo || "").toLowerCase().includes(searchTerm) ||
             (item.materialName || "").toLowerCase().includes(searchTerm) ||
             (item.destinoName || "").toLowerCase().includes(searchTerm) ||
             (item.choferName || "").toLowerCase().includes(searchTerm) ||
             (item.horaCargo || "").toLowerCase().includes(searchTerm);
    });
  }

  if (filtrados.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-400 py-12 font-bold bg-gray-800/40 rounded-2xl border border-gray-700/50 italic">No se encontraron movimientos que coincidan con los filtros.</div>`;
    return;
  }

  let html = `
    <div class="overflow-x-auto rounded-xl border border-gray-700/80 shadow-inner max-h-[600px] relative">
      <table class="w-full text-left text-xs text-gray-300 whitespace-nowrap">
        <thead class="bg-gray-900/95 sticky top-0 border-b border-gray-700 uppercase font-semibold text-gray-500 z-10 backdrop-blur-sm shadow-md">
          <tr>
            <th class="px-4 py-3 border-r border-gray-800/50">Fecha/Hora</th>
            <th class="px-4 py-3 border-r border-gray-800/50">ID Cargo</th>
            <th class="px-4 py-3 border-r border-gray-800/50">Chofer</th>
            <th class="px-4 py-3 border-r border-gray-800/50">Material</th>
            <th class="px-4 py-3 border-r border-gray-800/50">Destino</th>
            <th class="px-3 py-3 text-center border-r border-gray-800/50 text-white">Lleva</th>
            <th class="px-3 py-3 text-center border-r border-gray-800/50 text-emerald-400">Devuelto</th>
            <th class="px-3 py-3 text-center border-r border-gray-800/50 text-pink-400">Deuda</th>
            <th class="px-4 py-3 text-center">Estado</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800/60">
  `;

  filtrados.forEach(row => {
    let badgeEstadoHTML = "";
    const deuda = parseInt(row.deuda);
    
    if (deuda > 0) {
      badgeEstadoHTML = `<span class="bg-pink-600/20 text-pink-400 border border-pink-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Pendiente</span>`;
    } else if (deuda < 0) {
      badgeEstadoHTML = `<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Excedente</span>`;
    } else {
      badgeEstadoHTML = `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">Cerrado</span>`;
    }

    html += `
      <tr class="hover:bg-gray-800/60 transition-colors group">
        <td class="px-4 py-3.5 font-mono text-gray-500 text-[11px]">${row.horaCargo || '--'}</td>
        <td class="px-4 py-3.5 font-mono text-blue-400 font-bold tracking-tight">${row.idCargo || '--'}</td>
        <td class="px-4 py-3.5 truncate max-w-[150px] font-medium text-gray-200" title="${row.choferName}">${row.choferName}</td>
        <td class="px-4 py-3.5 truncate max-w-[200px]" title="${row.materialName}">${row.materialName}</td>
        <td class="px-4 py-3.5 truncate max-w-[150px] text-gray-400" title="${row.destinoName}">${row.destinoName}</td>
        <td class="px-3 py-3.5 text-center text-white font-black bg-gray-900/30">${row.lleva}</td>
        <td class="px-3 py-3.5 text-center text-emerald-400 font-black bg-emerald-900/10">${row.devuelve}</td>
        <td class="px-3 py-3.5 text-center ${deuda > 0 ? 'text-pink-400 bg-pink-900/10' : 'text-gray-500'} font-black">${deuda}</td>
        <td class="px-4 py-3.5 text-center">${badgeEstadoHTML}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  grid.innerHTML = html;
}
