// Base de Datos IndexedDB - Coffee Break Food Metrics
const DB_NAME = 'NutriAppDB';
const DB_VERSION = 3;

// URL de tu Proxy Seguro en Cloudflare Workers
const WORKER_CHEF_URL = 'https://coffiachef.jyepsenc.workers.dev';

let db = null;
let alimentosCache = [];
let recetasCache = [];
let categoriasCache = ['Desayuno', 'Almuerzo', 'Once/Cena', 'Snacks'];
let metasActuales = { kcal: 2000, proteinas: 140, carbohidratos: 200, grasas: 65 };
let fechaSeleccionada = new Date().toISOString().split('T')[0];

// Estados de edición y selección
let recetaBorrador = [];
let recetaEditandoId = null;
let alimentosMezclador = [];
let categoriaModalDiario = null;
let recetaIAPendiente = null;

// Estados para Escalador y Modo Cocina
let recetaIABaseOriginal = null;
let factorEscalaActual = 1;
let pasoCocinaActual = 0;

// Estado temporal para Conversor Inverso
let conversionCalculadaTemp = null;

// ============================================================
// UTILIDADES: NORMALIZADOR Y LISTENERS SEGUROS
// ============================================================
function normalizarTexto(txt) {
  if (!txt) return '';
  return txt.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function safeOn(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

// 1. REGISTRO DE SERVICE WORKER PARA PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registrado:', reg.scope))
      .catch(err => console.log('Aviso Service Worker:', err));
  });
}

// 2. GESTIÓN INMEDIATA DE PESTAÑAS (NUNCA SE BLOQUEA)
function activarPestanas() {
  const botones = document.querySelectorAll('.tab-btn');
  const contenidos = document.querySelectorAll('.tab-content');

  botones.forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      botones.forEach(b => b.classList.remove('active'));
      contenidos.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetContenido = document.getElementById(targetId);
      if (targetContenido) targetContenido.classList.add('active');
    };
  });
}

// 3. INICIALIZACIÓN BLINDADA DE INDEXEDDB
function conectarDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const dbInstance = e.target.result;
      if (!dbInstance.objectStoreNames.contains('alimentos')) {
        dbInstance.createObjectStore('alimentos', { keyPath: 'id', autoIncrement: true });
      }
      if (!dbInstance.objectStoreNames.contains('recetas')) {
        dbInstance.createObjectStore('recetas', { keyPath: 'id', autoIncrement: true });
      }
      if (!dbInstance.objectStoreNames.contains('diario')) {
        const diarioStore = dbInstance.createObjectStore('diario', { keyPath: 'id', autoIncrement: true });
        diarioStore.createIndex('fecha', 'fecha', { unique: false });
      }
      if (!dbInstance.objectStoreNames.contains('config')) {
        dbInstance.createObjectStore('config', { keyPath: 'clave' });
      }
    };

    req.onsuccess = (e) => {
      db = e.target.result;
      db.onversionchange = () => {
        db.close();
        db = null;
      };
      resolve(db);
    };

    req.onerror = (e) => {
      console.error('Error DB:', e.target.error);
      reject(e.target.error);
    };
  });
}

async function cargarTodo() {
  const inputFecha = document.getElementById('diario-fecha');
  if (inputFecha) inputFecha.value = fechaSeleccionada;

  poblarFormMetas();
  poblarPinGuardado();

  try {
    const database = await conectarDB();
    const tx = database.transaction(['config', 'alimentos', 'recetas'], 'readonly');

    const reqMetas = tx.objectStore('config').get('metas_diarias');
    reqMetas.onsuccess = () => {
      if (reqMetas.result && reqMetas.result.valor) {
        metasActuales = reqMetas.result.valor;
        poblarFormMetas();
      }
    };

    const reqCat = tx.objectStore('config').get('categorias');
    reqCat.onsuccess = () => {
      if (reqCat.result && reqCat.result.valor) {
        categoriasCache = reqCat.result.valor;
      }
    };

    tx.objectStore('alimentos').getAll().onsuccess = (e) => {
      alimentosCache = e.target.result || [];
      actualizarVistasAlimentos();
      actualizarSelectoresGlobales();
    };

    tx.objectStore('recetas').getAll().onsuccess = (e) => {
      recetasCache = e.target.result || [];
      actualizarVistasRecetas();
      actualizarSelectoresGlobales();
    };

    tx.oncomplete = () => cargarDiario();
  } catch (err) {
    console.error('Error al abrir la base local:', err);
  }
}

/* ============================================================
   SECCIÓN: SINCRONIZACIÓN CON CLOUDFLARE D1 (CON TIMEOUT)
   ============================================================ */
function obtenerPin() {
  return localStorage.getItem('coffeebreak_user_pin') || '';
}

function poblarPinGuardado() {
  const inputPin = document.getElementById('sync-input-pin');
  if (inputPin) inputPin.value = obtenerPin();
}

safeOn('btn-sync-guardar-pin', 'click', () => {
  const val = document.getElementById('sync-input-pin').value.trim();
  if (!val) return alert('Ingresa un PIN válido.');
  localStorage.setItem('coffeebreak_user_pin', val);
  alert('✓ PIN guardado en este dispositivo.');
  sincronizarConLaNube();
});

async function subirDatosALaNube(mostrarAlerta = true) {
  const pin = obtenerPin();
  if (!pin) {
    if (mostrarAlerta) alert('Configura tu PIN en la pestaña "Nube & Respaldo" primero.');
    return;
  }

  const indicator = document.getElementById('sync-status-indicator');
  const statusMsg = document.getElementById('sync-status-msg');
  if (indicator) indicator.textContent = '🔄';
  if (statusMsg) statusMsg.textContent = 'Subiendo datos a la nube...';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const data = await generarObjetoRespaldo();
    const resp = await fetch(`${WORKER_CHEF_URL}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Pin': pin
      },
      body: JSON.stringify({ data }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const resJson = await resp.json();
    if (!resp.ok) throw new Error(resJson.error || `HTTP ${resp.status}`);

    if (indicator) indicator.textContent = '☁️';
    if (statusMsg) statusMsg.textContent = `✓ Sincronizado en la nube: ${new Date().toLocaleTimeString()}`;
    if (mostrarAlerta) alert('✓ ¡Datos subidos exitosamente a Cloudflare D1!');
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error push D1:', err);
    if (indicator) indicator.textContent = '⚠️';
    const msg = (err.name === 'AbortError') ? 'Tiempo de espera agotado al conectar con Cloudflare.' : err.message;
    if (statusMsg) statusMsg.textContent = `Error al subir: ${msg}`;
    if (mostrarAlerta) alert(`Error al sincronizar con la nube: ${msg}`);
  }
}

async function descargarDatosDeLaNube(mostrarAlerta = true) {
  const pin = obtenerPin();
  if (!pin) {
    if (mostrarAlerta) alert('Configura tu PIN en la pestaña "Nube & Respaldo" primero.');
    return;
  }

  const indicator = document.getElementById('sync-status-indicator');
  const statusMsg = document.getElementById('sync-status-msg');
  if (indicator) indicator.textContent = '🔄';
  if (statusMsg) statusMsg.textContent = 'Consultando la nube...';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch(`${WORKER_CHEF_URL}/sync/pull?pin=${encodeURIComponent(pin)}`, {
      method: 'GET',
      headers: { 'X-User-Pin': pin },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const resJson = await resp.json();
    if (!resp.ok) throw new Error(resJson.error || `HTTP ${resp.status}`);

    if (indicator) indicator.textContent = '☁️';

    if (!resJson.data) {
      if (statusMsg) statusMsg.textContent = 'No hay datos guardados aún en la nube con este PIN.';
      if (mostrarAlerta) alert('Aún no has subido datos para este PIN.');
      return;
    }

    await procesarEInsertarDatos(resJson.data);
    if (statusMsg) statusMsg.textContent = `✓ Datos descargados y actualizados: ${new Date().toLocaleTimeString()}`;
    if (mostrarAlerta) alert('✓ ¡Datos sincronizados y descargados con éxito!');
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Error pull D1:', err);
    if (indicator) indicator.textContent = '⚠️';
    const msg = (err.name === 'AbortError') ? 'Tiempo de espera agotado al consultar Cloudflare.' : err.message;
    if (statusMsg) statusMsg.textContent = `Error al descargar: ${msg}`;
    if (mostrarAlerta) alert(`Error al consultar la nube: ${msg}`);
  }
}

function sincronizarConLaNube() {
  descargarDatosDeLaNube(false).then(() => {
    subirDatosALaNube(false);
  });
}

safeOn('btn-sync-subir-nube', 'click', () => subirDatosALaNube(true));
safeOn('btn-sync-descargar-nube', 'click', () => descargarDatosDeLaNube(true));
safeOn('sync-status-indicator', 'click', () => sincronizarConLaNube());

/* ============================================================
   SECCIÓN: FILTROS Y SELECTORES INTELIGENTES (SIN TILDES)
   ============================================================ */
function actualizarSelectoresGlobales() {
  poblarSelectCalculadora();
  poblarSelectRecetaIngredientes();
  poblarSelectMezclador();
  poblarSelectIngredienteUrgente();
  poblarSelectRecetasPlantilla();
  poblarSelectConversorAlimentos();
}

function poblarSelectIngredienteUrgente() {
  const sel = document.getElementById('ai-select-ingrediente-urgente');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Selecciona alimento --</option>';
  alimentosCache.forEach(a => {
    sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, a.id));
  });
}

function poblarSelectRecetasPlantilla() {
  const sel = document.getElementById('ai-select-receta-plantilla');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Elige la receta base a replicar --</option>';
  recetasCache.forEach(r => {
    sel.appendChild(new Option(`${r.nombre} (${r.kcalPor100g.toFixed(0)} kcal/100g)`, r.id));
  });
}

safeOn('ai-check-urgente', 'change', () => {
  const check = document.getElementById('ai-check-urgente');
  const cont = document.getElementById('ai-contenedor-urgente');
  if (check && cont) cont.classList.toggle('hidden', !check.checked);
});

safeOn('ai-check-replicar', 'change', () => {
  const check = document.getElementById('ai-check-replicar');
  const cont = document.getElementById('ai-contenedor-replicar');
  if (check && cont) cont.classList.toggle('hidden', !check.checked);
});

safeOn('calc-filtro-nombre', 'input', (e) => poblarSelectCalculadora(e.target.value));

function poblarSelectCalculadora(filtro = '') {
  const select = document.getElementById('select-alimento');
  if (!select) return;
  select.innerHTML = '<option value="">-- Elige un elemento --</option>';
  const fNorm = normalizarTexto(filtro);

  const alisFiltrados = alimentosCache.filter(a => normalizarTexto(a.nombre).includes(fNorm));
  if (alisFiltrados.length > 0) {
    const gAli = document.createElement('optgroup');
    gAli.label = 'Alimentos Individuales';
    alisFiltrados.forEach(a => gAli.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, `ali_${a.id}`)));
    select.appendChild(gAli);
  }

  const recsFiltradas = recetasCache.filter(r => normalizarTexto(r.nombre).includes(fNorm));
  if (recsFiltradas.length > 0) {
    const gRec = document.createElement('optgroup');
    gRec.label = 'Recetas Compuestas';
    recsFiltradas.forEach(r => gRec.appendChild(new Option(`${r.nombre} [Receta] (${r.kcalPor100g.toFixed(1)} kcal/100g)`, `rec_${r.id}`)));
    select.appendChild(gRec);
  }
}

safeOn('receta-filtro-ingrediente', 'input', (e) => poblarSelectRecetaIngredientes(e.target.value));

function poblarSelectRecetaIngredientes(filtro = '') {
  const select = document.getElementById('receta-select-alimento');
  if (!select) return;
  select.innerHTML = '<option value="">-- Elige un alimento base --</option>';
  const fNorm = normalizarTexto(filtro);

  const alisFiltrados = alimentosCache.filter(a => normalizarTexto(a.nombre).includes(fNorm));
  alisFiltrados.forEach(a => select.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, a.id)));
}

safeOn('buscador-alimentos-guardados', 'input', (e) => renderizarListaAlimentosGuardados(e.target.value));

function renderizarListaAlimentosGuardados(filtro = '') {
  const lista = document.getElementById('lista-alimentos');
  if (!lista) return;
  lista.innerHTML = '';
  const fNorm = normalizarTexto(filtro);

  const filtrados = alimentosCache.filter(a => normalizarTexto(a.nombre).includes(fNorm) || (a.marca && normalizarTexto(a.marca).includes(fNorm)));
  if (filtrados.length === 0) {
    lista.innerHTML = '<li style="color: var(--text-muted);">No se encontraron alimentos.</li>';
    return;
  }

  filtrados.forEach(a => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${a.nombre}</strong> ${a.marca ? `(${a.marca})` : ''}<br>
        <small style="color: var(--text-muted);">${a.kcal} kcal | P: ${a.proteinas}g | C: ${a.carbohidratos}g | G: ${a.grasas}g</small>
      </div>
      <button class="btn-del" onclick="eliminarAlimento(${a.id})">Borrar</button>
    `;
    lista.appendChild(li);
  });
}

safeOn('buscador-recetas-guardadas', 'input', (e) => renderizarListaRecetasGuardadas(e.target.value));

function renderizarListaRecetasGuardadas(filtro = '') {
  const lista = document.getElementById('lista-recetas');
  if (!lista) return;
  lista.innerHTML = '';
  const fNorm = normalizarTexto(filtro);

  const filtradas = recetasCache.filter(r => normalizarTexto(r.nombre).includes(fNorm));
  if (filtradas.length === 0) {
    lista.innerHTML = '<li style="color: var(--text-muted);">No se encontraron recetas.</li>';
    return;
  }

  filtradas.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${r.nombre}</strong><br>
        <small style="color: var(--text-muted);">${r.kcalPor100g.toFixed(1)} kcal/100g (Total: ${r.pesoTotal}g ${r.pesoCocinadoFinal ? `[Cocido: ${r.pesoCocinadoFinal}g]` : ''} - ${r.kcalTotal.toFixed(0)} kcal)</small>
      </div>
      <div style="display: flex; gap: 0.4rem;">
        <button class="btn-secondary" onclick="cargarRecetaParaEditar(${r.id})">Editar</button>
        <button class="btn-del" onclick="eliminarReceta(${r.id})">Borrar</button>
      </div>
    `;
    lista.appendChild(li);
  });
}

/* ============================================================
   SECCIÓN: CONVERSOR INVERSO (PESO COCINADO A CRUDO)
   ============================================================ */
safeOn('conv-filtro-alimento', 'input', (e) => poblarSelectConversorAlimentos(e.target.value));

function poblarSelectConversorAlimentos(filtro = '') {
  const sel = document.getElementById('conv-select-alimento');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Selecciona alimento base crudo --</option>';
  const fNorm = normalizarTexto(filtro);

  const filtrados = alimentosCache.filter(a => normalizarTexto(a.nombre).includes(fNorm));
  filtrados.forEach(a => sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g en crudo)`, a.id)));
}

safeOn('btn-calcular-conversion', 'click', () => {
  const aliId = parseInt(document.getElementById('conv-select-alimento').value, 10);
  const crudoTotal = parseFloat(document.getElementById('conv-peso-crudo-total').value) || 0;
  const cocidoTotal = parseFloat(document.getElementById('conv-peso-cocido-total').value) || 0;
  const gramosPlato = parseFloat(document.getElementById('conv-gramos-plato').value) || 0;
  const boxRes = document.getElementById('resultado-conversion');

  if (!aliId || crudoTotal <= 0 || cocidoTotal <= 0 || gramosPlato <= 0) {
    alert('Por favor selecciona el alimento e ingresa el peso crudo total, el cocido total y los gramos que vas a servirte.');
    return;
  }

  const ali = alimentosCache.find(a => a.id === aliId);
  if (!ali) return;

  const factorRendimiento = crudoTotal / cocidoTotal;
  const gramosCrudosEquivalentes = gramosPlato * factorRendimiento;

  const f = gramosCrudosEquivalentes / 100;
  const kcalAporte = ali.kcal * f;
  const protAporte = ali.proteinas * f;
  const carbsAporte = ali.carbohidratos * f;
  const grasasAporte = ali.grasas * f;

  conversionCalculadaTemp = {
    nombre: `${ali.nombre} (cocido)`,
    gramosPlato: gramosPlato,
    gramosCrudos: gramosCrudosEquivalentes,
    kcal: kcalAporte,
    proteinas: protAporte,
    carbohidratos: carbsAporte,
    grasas: grasasAporte
  };

  document.getElementById('conv-res-crudo').textContent = gramosCrudosEquivalentes.toFixed(1);
  document.getElementById('conv-res-kcal').textContent = kcalAporte.toFixed(1);
  document.getElementById('conv-res-prot').textContent = protAporte.toFixed(1);
  document.getElementById('conv-res-carbs').textContent = carbsAporte.toFixed(1);
  document.getElementById('conv-res-grasas').textContent = grasasAporte.toFixed(1);

  if (boxRes) boxRes.classList.remove('hidden');
});

safeOn('btn-agregar-conversion-diario', 'click', async () => {
  if (!conversionCalculadaTemp) return;
  const cat = prompt(`¿A qué categoría agregarlo? (${categoriasCache.join(', ')}):`, categoriasCache[0]);
  if (!cat || !categoriasCache.includes(cat.trim())) return;

  const entrada = {
    fecha: fechaSeleccionada,
    categoria: cat.trim(),
    nombre: `${conversionCalculadaTemp.nombre} [${conversionCalculadaTemp.gramosPlato}g coc.]`,
    gramos: conversionCalculadaTemp.gramosPlato,
    kcal: conversionCalculadaTemp.kcal,
    proteinas: conversionCalculadaTemp.proteinas,
    carbohidratos: conversionCalculadaTemp.carbohidratos,
    grasas: conversionCalculadaTemp.grasas
  };

  const database = await conectarDB();
  const tx = database.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').add(entrada);
  tx.oncomplete = () => {
    alert(`✓ ¡Añadido a ${cat}!`);
    cargarDiario();
    subirDatosALaNube(false);
  };
});

/* ============================================================
   SECCIÓN: ALIMENTOS Y CALCULADORA DINÁMICA
   ============================================================ */
function actualizarVistasAlimentos() {
  renderizarListaAlimentosGuardados();
}

safeOn('form-alimento', 'submit', async (e) => {
  e.preventDefault();
  const parseVal = (id) => parseFloat(document.getElementById(id).value) || 0;

  const alimento = {
    nombre: document.getElementById('nombre').value.trim(),
    marca: document.getElementById('marca').value.trim(),
    kcal: parseVal('kcal'),
    proteinas: parseVal('proteinas'),
    carbohidratos: parseVal('carbohidratos'),
    grasas: parseVal('grasas'),
    azucares: parseVal('azucares'),
    fibra: parseVal('fibra'),
    sat: parseVal('sat'),
    mono: parse