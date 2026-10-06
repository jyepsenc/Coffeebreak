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

// Estados de sesión
let sesionUsuarioActual = null; // { username, role, can_write }

// Control estricto anti-bucle infinito
let estaSincronizando = false;
let ultimaSincronizacionTimestamp = 0;

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

// Estado temporal para Conversor Inverso y Mifflin
let conversionCalculadaTemp = null;
let sugerenciaMifflinTemp = null;

// ============================================================
// 1. CAMBIO DE PESTAÑAS GLOBAL (DIRECTO)
// ============================================================
window.cambiarPestana = function(targetId, btnElement) {
  const botones = document.querySelectorAll('.tab-btn');
  const contenidos = document.querySelectorAll('.tab-content');

  botones.forEach(b => b.classList.remove('active'));
  contenidos.forEach(c => c.classList.remove('active'));

  if (btnElement) {
    btnElement.classList.add('active');
  } else {
    const matchingBtn = document.querySelector(`.tab-btn[data-tab="${targetId}"]`);
    if (matchingBtn) matchingBtn.classList.add('active');
  }

  const targetContenido = document.getElementById(targetId);
  if (targetContenido) targetContenido.classList.add('active');
};

function normalizarTexto(txt) {
  if (!txt) return '';
  return txt.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function safeOn(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

// 2. REGISTRO DE SERVICE WORKER PARA PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registrado:', reg.scope))
      .catch(err => console.log('Aviso Service Worker:', err));
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

async function refrescarDatosLocales() {
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
    console.error('Error al refrescar datos locales:', err);
  }
}

async function cargarTodo() {
  const inputFecha = document.getElementById('diario-fecha');
  if (inputFecha) inputFecha.value = fechaSeleccionada;

  poblarFormMetas();
  verificarSesionGuardada();
  await refrescarDatosLocales();
}

/* ============================================================
   SECCIÓN: AUTENTICACIÓN Y ROLES (ADMIN / MIEMBRO)
   ============================================================ */
function getAuthHeaders() {
  const creds = JSON.parse(localStorage.getItem('coffeebreak_creds') || 'null');
  if (!creds) return {};
  return {
    'X-Username': creds.username,
    'X-Password': creds.password
  };
}

function verificarSesionGuardada() {
  const user = JSON.parse(localStorage.getItem('coffeebreak_user') || 'null');
  const boxNo = document.getElementById('sesion-no-iniciada');
  const boxSi = document.getElementById('sesion-activa');
  const panelAdmin = document.getElementById('panel-admin-usuarios');

  if (user) {
    sesionUsuarioActual = user;
    if (boxNo) boxNo.classList.add('hidden');
    if (boxSi) boxSi.classList.remove('hidden');
    const uName = document.getElementById('user-display-name');
    const uRole = document.getElementById('user-display-role');
    if (uName) uName.textContent = user.username;
    if (uRole) uRole.textContent = user.role === 'admin' ? '👑 Administrador' : (user.can_write ? '✏️ Editor' : '👁️ Solo Lectura');

    if (user.role === 'admin' && panelAdmin) {
      panelAdmin.classList.remove('hidden');
      cargarListaUsuariosAdmin();
    } else if (panelAdmin) {
      panelAdmin.classList.add('hidden');
    }
  } else {
    sesionUsuarioActual = null;
    if (boxNo) boxNo.classList.remove('hidden');
    if (boxSi) boxSi.classList.add('hidden');
    if (panelAdmin) panelAdmin.classList.add('hidden');
  }
}

safeOn('btn-auth-login', 'click', async () => {
  const u = document.getElementById('auth-input-user')?.value.trim();
  const p = document.getElementById('auth-input-pass')?.value.trim();

  if (!u || !p) return alert('Ingresa usuario y contraseña.');

  try {
    const resp = await fetch(`${WORKER_CHEF_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error en login.');

    localStorage.setItem('coffeebreak_creds', JSON.stringify({ username: u, password: p }));
    localStorage.setItem('coffeebreak_user', JSON.stringify(data.user));

    alert(`✓ ¡Bienvenido, ${data.user.username}!`);
    verificarSesionGuardada();
    autoSyncCompletoSilencioso();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

safeOn('btn-auth-logout', 'click', () => {
  if (!confirm('¿Cerrar sesión en este dispositivo?')) return;
  localStorage.removeItem('coffeebreak_creds');
  localStorage.removeItem('coffeebreak_user');
  verificarSesionGuardada();
  alert('Sesión cerrada.');
});

/* ============================================================
   SECCIÓN: SINCRONIZACIÓN AUTOMÁTICA EN BACKGROUND (ANTI-BUCLE)
   ============================================================ */
async function autoSyncCompletoSilencioso() {
  if (!sesionUsuarioActual || estaSincronizando) return;

  const ahora = Date.now();
  if (ahora - ultimaSincronizacionTimestamp < 15000) return;

  estaSincronizando = true;
  const indicator = document.getElementById('sync-status-indicator');
  if (indicator) indicator.textContent = '🔄';

  try {
    await descargarCatalogoCompartido(false);
    await descargarDiarioPrivado(false);
    ultimaSincronizacionTimestamp = Date.now();
    if (indicator) indicator.textContent = '☁️';
  } catch (err) {
    console.error('Error auto-sync:', err);
    if (indicator) indicator.textContent = '⚠️';
  } finally {
    estaSincronizando = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    autoSyncCompletoSilencioso();
  }
});

/* ============================================================
   SECCIÓN: SINCRONIZACIÓN PRIVADA (DIARIO Y METAS)
   ============================================================ */
async function subirDiarioPrivado(mostrarAlerta = true) {
  if (!sesionUsuarioActual) {
    if (mostrarAlerta) alert('Debes iniciar sesión primero.');
    return;
  }

  const statusMsg = document.getElementById('sync-private-status-msg');
  if (statusMsg) statusMsg.textContent = 'Subiendo tu diario y metas a la nube...';

  try {
    const database = await conectarDB();
    const tx = database.transaction(['diario', 'config'], 'readonly');
    const privado = { diario: [], config: [] };

    tx.objectStore('diario').getAll().onsuccess = (e) => privado.diario = e.target.result || [];
    tx.objectStore('config').getAll().onsuccess = (e) => privado.config = e.target.result || [];

    await new Promise((resolve) => tx.oncomplete = resolve);

    const resp = await fetch(`${WORKER_CHEF_URL}/sync/private/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ data: privado })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Fallo al subir diario.');

    if (statusMsg) statusMsg.textContent = `✓ Diario personal sincronizado: ${new Date().toLocaleTimeString()}`;
    if (mostrarAlerta) alert('✓ ¡Tus comidas y metas privadas están a salvo en la nube!');
  } catch (err) {
    if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
    if (mostrarAlerta) alert(`Error: ${err.message}`);
  }
}

async function descargarDiarioPrivado(mostrarAlerta = true) {
  if (!sesionUsuarioActual) {
    if (mostrarAlerta) alert('Debes iniciar sesión primero.');
    return;
  }

  const statusMsg = document.getElementById('sync-private-status-msg');
  if (statusMsg) statusMsg.textContent = 'Descargando tu diario y metas...';

  try {
    const resp = await fetch(`${WORKER_CHEF_URL}/sync/private/pull`, {
      method: 'GET',
      headers: { ...getAuthHeaders() }
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Fallo al descargar.');

    if (!data.data) {
      if (statusMsg) statusMsg.textContent = 'Sin diario previo guardado en tu cuenta.';
      return;
    }

    const database = await conectarDB();
    const tx = database.transaction(['diario', 'config'], 'readwrite');

    if (Array.isArray(data.data.diario)) {
      const storeD = tx.objectStore('diario');
      data.data.diario.forEach(d => storeD.put(d));
    }
    if (Array.isArray(data.data.config)) {
      const storeC = tx.objectStore('config');
      data.data.config.forEach(c => storeC.put(c));
    }

    await new Promise((resolve) => tx.oncomplete = resolve);

    await refrescarDatosLocales();
    if (statusMsg) statusMsg.textContent = `✓ Diario actualizado desde la nube: ${new Date().toLocaleTimeString()}`;
    if (mostrarAlerta) alert('✓ ¡Diario y metas personales actualizados!');
  } catch (err) {
    if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
    if (mostrarAlerta) alert(`Error: ${err.message}`);
  }
}

safeOn('btn-sync-privado-subir', 'click', () => subirDiarioPrivado(true));
safeOn('btn-sync-privado-descargar', 'click', () => descargarDiarioPrivado(true));

/* ============================================================
   SECCIÓN: CATÁLOGO COMPARTIDO (ALIMENTOS Y RECETAS)
   ============================================================ */
async function subirCatalogoCompartido(mostrarAlerta = true) {
  if (!sesionUsuarioActual) {
    if (mostrarAlerta) alert('Inicia sesión para interactuar con el catálogo compartido.');
    return;
  }

  const statusMsg = document.getElementById('sync-catalog-status-msg');
  if (statusMsg) statusMsg.textContent = 'Publicando alimentos y recetas en el catálogo compartido...';

  try {
    const database = await conectarDB();
    const tx = database.transaction(['alimentos', 'recetas'], 'readonly');
    const catalogo = { alimentos: [], recetas: [] };

    tx.objectStore('alimentos').getAll().onsuccess = (e) => catalogo.alimentos = e.target.result || [];
    tx.objectStore('recetas').getAll().onsuccess = (e) => catalogo.recetas = e.target.result || [];

    await new Promise((resolve) => tx.oncomplete = resolve);

    const resp = await fetch(`${WORKER_CHEF_URL}/sync/catalog/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ data: catalogo })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Fallo al publicar.');

    if (statusMsg) statusMsg.textContent = `✓ Catálogo compartido actualizado: ${new Date().toLocaleTimeString()}`;
    if (mostrarAlerta) alert('✓ ¡Tus alimentos y recetas ahora están disponibles para todos los usuarios autorizados!');
  } catch (err) {
    if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
    if (mostrarAlerta) alert(`Error: ${err.message}`);
  }
}

async function descargarCatalogoCompartido(mostrarAlerta = true) {
  if (!sesionUsuarioActual) {
    if (mostrarAlerta) alert('Inicia sesión para descargar el catálogo compartido.');
    return;
  }

  const statusMsg = document.getElementById('sync-catalog-status-msg');
  if (statusMsg) statusMsg.textContent = 'Descargando despensa compartida...';

  try {
    const resp = await fetch(`${WORKER_CHEF_URL}/sync/catalog/pull`, {
      method: 'GET',
      headers: { ...getAuthHeaders() }
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Fallo al descargar.');

    if (!data.data) {
      if (statusMsg) statusMsg.textContent = 'El catálogo compartido está vacío.';
      return;
    }

    const database = await conectarDB();
    const tx = database.transaction(['alimentos', 'recetas'], 'readwrite');

    if (Array.isArray(data.data.alimentos)) {
      const storeA = tx.objectStore('alimentos');
      data.data.alimentos.forEach(a => storeA.put(a));
    }
    if (Array.isArray(data.data.recetas)) {
      const storeR = tx.objectStore('recetas');
      data.data.recetas.forEach(r => storeR.put(r));
    }

    await new Promise((resolve) => tx.oncomplete = resolve);

    await refrescarDatosLocales();
    if (statusMsg) statusMsg.textContent = `✓ Despensa compartida actualizada (${new Date().toLocaleTimeString()})`;
    if (mostrarAlerta) alert('✓ ¡Alimentos y recetas compartidas sincronizados!');
  } catch (err) {
    if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
    if (mostrarAlerta) alert(`Error: ${err.message}`);
  }
}

safeOn('btn-sync-catalog-subir', 'click', () => subirCatalogoCompartido(true));
safeOn('btn-sync-catalog-descargar', 'click', () => descargarCatalogoCompartido(true));

safeOn('sync-status-indicator', 'click', () => {
  if (!sesionUsuarioActual) return alert('Inicia sesión en la pestaña "Nube & Sesión".');
  ultimaSincronizacionTimestamp = 0;
  autoSyncCompletoSilencioso();
});

/* ============================================================
   SECCIÓN: PANEL DE ADMINISTRACIÓN DE USUARIOS (SOLO ADMIN)
   ============================================================ */
async function cargarListaUsuariosAdmin() {
  const contenedor = document.getElementById('contenedor-lista-usuarios-admin');
  if (!contenedor) return;
  contenedor.innerHTML = '<small style="color:var(--text-muted)">Cargando usuarios...</small>';

  try {
    const resp = await fetch(`${WORKER_CHEF_URL}/admin/users`, {
      method: 'GET',
      headers: { ...getAuthHeaders() }
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    contenedor.innerHTML = '';
    (data.users || []).forEach(u => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(120,120,128,0.08); padding:0.6rem 0.8rem; border-radius:8px; font-size:0.9rem;';

      const esAdmin = (u.role === 'admin');
      item.innerHTML = `
        <div>
          <strong>${u.username}</strong> ${esAdmin ? '<span style="color:#10b981;">(Admin)</span>' : '<span style="color:var(--text-muted);">(Miembro)</span>'}
        </div>
        <div>
          ${esAdmin ? '<span style="font-size:0.8rem; color:#10b981;">Acceso total</span>' : `
            <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.85rem; cursor:pointer;">
              <input type="checkbox" ${u.can_write ? 'checked' : ''} onchange="cambiarPermisoUsuario('${u.username}', this.checked)">
              Permitir agregar/editar recetas
            </label>
          `}
        </div>
      `;
      contenedor.appendChild(item);
    });
  } catch (err) {
    contenedor.innerHTML = `<small style="color:var(--danger)">Error: ${err.message}</small>`;
  }
}

window.cambiarPermisoUsuario = async function(targetUsername, canWrite) {
  try {
    const resp = await fetch(`${WORKER_CHEF_URL}/admin/users/permissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ targetUsername, canWrite })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    alert(`✓ Permisos de "${targetUsername}" actualizados.`);
  } catch (err) {
    alert(`Error: ${err.message}`);
    cargarListaUsuariosAdmin();
  }
};

safeOn('btn-admin-refrescar-usuarios', 'click', () => cargarListaUsuariosAdmin());

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
    subirDiarioPrivado(false);
  };
});

/* ============================================================
   SECCIÓN: OCR
   ============================================================ */
const inputFoto = document.getElementById('input-foto-tabla');
const imgPreview = document.getElementById('img-preview');
const ocrContainer = document.getElementById('ocr-preview-container');
const ocrStatus = document.getElementById('ocr-status');
const ocrRawText = document.getElementById('ocr-raw-text');

function optimizarFotoCelular(imageElement) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let width = imageElement.naturalWidth || imageElement.width;
  let height = imageElement.naturalHeight || imageElement.height;

  const MAX_DIM = 1600;
  if (width > MAX_DIM || height > MAX_DIM) {
    if (width > height) {
      height = Math.round((height * MAX_DIM) / width);
      width = MAX_DIM;
    } else {
      width = Math.round((width * MAX_DIM) / height);
      height = MAX_DIM;
    }
  }

  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(imageElement, 0, 0, width, height);

  const imgData = ctx.getImageData(0, 0, width, height);
  const d = imgData.data;

  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = lum;
    d[i + 1] = lum;
    d[i + 2] = lum;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.95);
}

if (inputFoto) {
  inputFoto.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      imgPreview.src = event.target.result;
      if (ocrContainer) ocrContainer.classList.remove('hidden');

      imgPreview.onload = async () => {
        if (typeof Tesseract === 'undefined') {
          alert('Se requiere internet la primera vez para cargar el motor OCR.');
          return;
        }

        try {
          if (ocrStatus) ocrStatus.textContent = 'Normalizando imagen...';
          const imagenOptimizada = optimizarFotoCelular(imgPreview);

          if (ocrStatus) ocrStatus.textContent = 'Analizando tabla...';
          const result = await Tesseract.recognize(
            imagenOptimizada,
            'spa',
            {
              logger: m => {
                if (m.status === 'recognizing text' && ocrStatus) {
                  ocrStatus.textContent = `Leyendo tabla: ${Math.round(m.progress * 100)}%`;
                }
              }
            }
          );

          const texto = result.data.text;
          if (ocrRawText) ocrRawText.textContent = texto;

          if (ocrStatus) ocrStatus.textContent = '✓ Lectura lista. Comprueba los campos abajo:';
          parsearTablaNutricionalRobusto(texto);

        } catch (err) {
          console.error('Error OCR:', err);
          if (ocrStatus) ocrStatus.textContent = 'Error al leer la imagen. Ingresa los datos manualmente.';
        }
      };
    };
    reader.readAsDataURL(file);
  });
}

function parsearTablaNutricionalRobusto(texto) {
  const lineas = texto.split('\n');

  const extraerNumerosConCoherencia = (linea, tipo = 'macro_comun') => {
    let limpia = linea.replace(/(\d+),(\d+)/g, '$1.$2');
    limpia = limpia.replace(/([0-9]+(\.[0-9]+)?)\s*(g|gr|mg|kcal|%)/gi, '$1 ');
    limpia = limpia.replace(/\b8\b/g, '');

    const matches = limpia.match(/\b\d+(\.\d+)?\b/g);
    if (!matches) return [];

    return matches.map(raw => {
      let n = parseFloat(raw);
      if (isNaN(n)) return null;

      if (tipo === 'carbos') {
        if (n >= 100 && n <= 999) n = n / 10;
      } else if (tipo === 'macro_comun') {
        if (n >= 100 && n <= 999) n = n / 100;
        else if (n > 50 && n < 100) n = n / 10;
      }
      return n;
    }).filter(n => n !== null);
  };

  const valores = {
    kcal: null, proteinas: null, carbohidratos: null, grasas: null,
    azucares: null, fibra: null, sat: null, mono: null, poli: null,
    trans: null, sodio: null, colesterol: null
  };

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const lLower = normalizarTexto(l);

    if ((lLower.includes('energ') || lLower.includes('kcal') || lLower.includes('calor')) && valores.kcal === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.kcal = nums.find(n => n >= 15) || nums[0];
    } else if ((lLower.includes('prot') || lLower.includes('prat')) && valores.proteinas === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.proteinas = nums[0];
    } else if ((lLower.includes('carb') || lLower.includes('h. de c') || lLower.includes('hidratos')) && valores.carbohidratos === null) {
      const nums = extraerNumerosConCoherencia(l, 'carbos');
      if (nums.length > 0) valores.carbohidratos = nums[0];
    } else if ((lLower.includes('grasa total') || lLower.includes('grasas totales') || lLower.includes('lipidos') || (lLower.includes('grasa') && !lLower.includes('sat') && !lLower.includes('mono') && !lLower.includes('trans'))) && valores.grasas === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.grasas = nums[0];
    } else if (lLower.includes('azuc')) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0 && valores.azucares === null) valores.azucares = nums[0];
    } else if (lLower.includes('fibra')) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0 && valores.fibra === null) valores.fibra = nums[0];
    } else if (lLower.includes('saturad') && valores.sat === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.sat = nums[0];
    } else if (lLower.includes('monoinsat') && valores.mono === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.mono = nums[0];
    } else if (lLower.includes('trans') && valores.trans === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.trans = nums[0];
    } else if (lLower.includes('sodio') && valores.sodio === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.sodio = nums[0];
    } else if (lLower.includes('colest') && valores.colesterol === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.colesterol = nums[0];
    }
  }

  const asignar = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== null) el.value = Number(val.toFixed(2));
  };

  asignar('kcal', valores.kcal);
  asignar('proteinas', valores.proteinas);
  asignar('carbohidratos', valores.carbohidratos);
  asignar('grasas', valores.grasas);
  asignar('azucares', valores.azucares);
  asignar('fibra', valores.fibra);
  asignar('sat', valores.sat);
  asignar('mono', valores.mono);
  asignar('poli', valores.poli);
  asignar('trans', valores.trans);
  asignar('sodio', valores.sodio);
  asignar('colesterol', valores.colesterol);

  const formAli = document.getElementById('form-alimento');
  if (formAli) formAli.scrollIntoView({ behavior: 'smooth' });
}

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
    mono: parseVal('mono'),
    poli: parseVal('poli'),
    trans: parseVal('trans'),
    sodio: parseVal('sodio'),
    colesterol: parseVal('colesterol')
  };

  const database = await conectarDB();
  const tx = database.transaction(['alimentos'], 'readwrite');
  tx.objectStore('alimentos').add(alimento);
  tx.oncomplete = () => {
    document.getElementById('form-alimento').reset();
    if (ocrContainer) ocrContainer.classList.add('hidden');
    alert(`¡"${alimento.nombre}" guardado con éxito!`);
    recargarAlimentos();
    subirCatalogoCompartido(false);
  };
});

async function recargarAlimentos() {
  const database = await conectarDB();
  database.transaction(['alimentos'], 'readonly').objectStore('alimentos').getAll().onsuccess = (e) => {
    alimentosCache = e.target.result || [];
    actualizarVistasAlimentos();
    actualizarSelectoresGlobales();
  };
}

window.eliminarAlimento = async function(id) {
  if (!confirm('¿Eliminar este alimento?')) return;
  const database = await conectarDB();
  const tx = database.transaction(['alimentos'], 'readwrite');
  tx.objectStore('alimentos').delete(id);
  tx.oncomplete = () => {
    recargarAlimentos();
    subirCatalogoCompartido(false);
  };
};

function calcularGramos() {
  const sel = document.getElementById('select-alimento');
  const gr = document.getElementById('input-gramos');
  const box = document.getElementById('resultado-calculo');
  if (!sel || !gr || !box) return;

  const val = sel.value;
  const gramos = parseFloat(gr.value) || 0;

  if (!val || gramos <= 0) {
    box.classList.add('hidden');
    return;
  }

  let base = null;
  if (val.startsWith('ali_')) {
    const id = parseInt(val.replace('ali_', ''), 10);
    base = alimentosCache.find(a => a.id === id);
  } else if (val.startsWith('rec_')) {
    const id = parseInt(val.replace('rec_', ''), 10);
    const rec = recetasCache.find(r => r.id === id);
    if (rec) {
      base = {
        kcal: rec.kcalPor100g,
        proteinas: rec.protPor100g,
        carbohidratos: rec.carbsPor100g,
        grasas: rec.grasasPor100g
      };
    }
  }

  if (!base) return;

  const f = gramos / 100;
  document.getElementById('calc-kcal').textContent = (base.kcal * f).toFixed(1);
  document.getElementById('calc-prot').textContent = (base.proteinas * f).toFixed(1);
  document.getElementById('calc-carbs').textContent = (base.carbohidratos * f).toFixed(1);
  document.getElementById('calc-grasas').textContent = (base.grasas * f).toFixed(1);
  box.classList.remove('hidden');
}

safeOn('select-alimento', 'change', calcularGramos);
safeOn('input-gramos', 'input', calcularGramos);

/* ============================================================
   SECCIÓN: RECETAS COMPUESTAS (CON AJUSTE DE PESO COCINADO)
   ============================================================ */
safeOn('btn-agregar-ingrediente', 'click', () => {
  const aliId = parseInt(document.getElementById('receta-select-alimento').value, 10);
  const gramos = parseFloat(document.getElementById('receta-gramos-ingrediente').value) || 0;

  if (!aliId || gramos <= 0) return alert('Selecciona un ingrediente y escribe los gramos.');

  const ali = alimentosCache.find(a => a.id === aliId);
  if (!ali) return;

  recetaBorrador.push({ alimentoId: ali.id, nombre: ali.nombre, gramos: gramos });
  document.getElementById('receta-gramos-ingrediente').value = '';
  actualizarVistaBorradorReceta();
});

function actualizarVistaBorradorReceta() {
  const lista = document.getElementById('receta-lista-ingredientes');
  const preview = document.getElementById('receta-totales-preview');

  if (recetaBorrador.length === 0) {
    if (lista) lista.innerHTML = '<li style="color: var(--text-muted);">Sin ingredientes aún.</li>';
    if (preview) preview.classList.add('hidden');
    return;
  }

  if (lista) lista.innerHTML = '';
  let totKcal = 0, totProt = 0, totCarbs = 0, totGrasas = 0, totPeso = 0;

  recetaBorrador.forEach((ing, idx) => {
    const ali = alimentosCache.find(a => a.id === ing.alimentoId);
    if (ali) {
      const f = ing.gramos / 100;
      totKcal += ali.kcal * f;
      totProt += ali.proteinas * f;
      totCarbs += ali.carbohidratos * f;
      totGrasas += ali.grasas * f;
      totPeso += ing.gramos;

      if (lista) {
        const li = document.createElement('li');
        li.innerHTML = `
          <span>${ing.nombre} - ${ing.gramos}g (${(ali.kcal * f).toFixed(1)} kcal)</span>
          <button class="btn-del" onclick="eliminarIngredienteReceta(${idx})">x</button>
        `;
        lista.appendChild(li);
      }
    }
  });

  document.getElementById('receta-total-kcal').textContent = totKcal.toFixed(1);
  document.getElementById('receta-total-peso').textContent = totPeso.toFixed(1);
  document.getElementById('receta-total-prot').textContent = totProt.toFixed(1);
  document.getElementById('receta-total-carbs').textContent = totCarbs.toFixed(1);
  document.getElementById('receta-total-grasas').textContent = totGrasas.toFixed(1);
  if (preview) preview.classList.remove('hidden');
}

window.eliminarIngredienteReceta = function(idx) {
  recetaBorrador.splice(idx, 1);
  actualizarVistaBorradorReceta();
};

window.cargarRecetaParaEditar = function(id) {
  const rec = recetasCache.find(r => r.id === id);
  if (!rec) return;

  recetaEditandoId = rec.id;
  document.getElementById('titulo-panel-receta').textContent = `Editando: ${rec.nombre}`;
  document.getElementById('receta-nombre').value = rec.nombre;
  document.getElementById('receta-peso-cocinado-final').value = rec.pesoCocinadoFinal || '';
  document.getElementById('btn-guardar-receta').textContent = 'Guardar Cambios';
  document.getElementById('btn-cancelar-edicion-receta').classList.remove('hidden');

  recetaBorrador = JSON.parse(JSON.stringify(rec.ingredientes || []));
  actualizarVistaBorradorReceta();

  document.getElementById('tab-recetas').scrollIntoView({ behavior: 'smooth' });
};

safeOn('btn-cancelar-edicion-receta', 'click', () => {
  resetearFormularioReceta();
});

function resetearFormularioReceta() {
  recetaEditandoId = null;
  recetaBorrador = [];
  document.getElementById('titulo-panel-receta').textContent = 'Crear Receta Compuesta';
  document.getElementById('receta-nombre').value = '';
  document.getElementById('receta-peso-cocinado-final').value = '';
  document.getElementById('btn-guardar-receta').textContent = 'Guardar Receta';
  document.getElementById('btn-cancelar-edicion-receta').classList.add('hidden');
  actualizarVistaBorradorReceta();
}

safeOn('btn-guardar-receta', 'click', async () => {
  const nombre = document.getElementById('receta-nombre').value.trim();
  if (!nombre || recetaBorrador.length === 0) {
    alert('Ingresa un nombre y al menos un ingrediente.');
    return;
  }

  let totKcal = 0, totProt = 0, totCarbs = 0, totGrasas = 0, totPeso = 0;
  recetaBorrador.forEach(ing => {
    const ali = alimentosCache.find(a => a.id === ing.alimentoId);
    if (ali) {
      const f = ing.gramos / 100;
      totKcal += ali.kcal * f;
      totProt += ali.proteinas * f;
      totCarbs += ali.carbohidratos * f;
      totGrasas += ali.grasas * f;
      totPeso += ing.gramos;
    }
  });

  const pesoCocinadoInput = parseFloat(document.getElementById('receta-peso-cocinado-final').value) || 0;
  const pesoReferencia100g = pesoCocinadoInput > 0 ? pesoCocinadoInput : totPeso;

  const objReceta = {
    nombre: nombre,
    ingredientes: [...recetaBorrador],
    pesoTotal: totPeso,
    pesoCocinadoFinal: pesoCocinadoInput > 0 ? pesoCocinadoInput : null,
    kcalTotal: totKcal,
    kcalPor100g: pesoReferencia100g > 0 ? (totKcal / pesoReferencia100g) * 100 : 0,
    protPor100g: pesoReferencia100g > 0 ? (totProt / pesoReferencia100g) * 100 : 0,
    carbsPor100g: pesoReferencia100g > 0 ? (totCarbs / pesoReferencia100g) * 100 : 0,
    grasasPor100g: pesoReferencia100g > 0 ? (totGrasas / pesoReferencia100g) * 100 : 0
  };

  const database = await conectarDB();
  const tx = database.transaction(['recetas'], 'readwrite');
  const store = tx.objectStore('recetas');

  if (recetaEditandoId !== null) {
    objReceta.id = recetaEditandoId;
    store.put(objReceta);
  } else {
    store.add(objReceta);
  }

  tx.oncomplete = () => {
    alert(`¡Receta "${objReceta.nombre}" guardada!`);
    resetearFormularioReceta();
    recargarRecetas();
    subirCatalogoCompartido(false);
  };
});

async function recargarRecetas() {
  const database = await conectarDB();
  database.transaction(['recetas'], 'readonly').objectStore('recetas').getAll().onsuccess = (e) => {
    recetasCache = e.target.result || [];
    actualizarVistasRecetas();
    actualizarSelectoresGlobales();
  };
}

function actualizarVistasRecetas() {
  renderizarListaRecetasGuardadas();
}

window.eliminarReceta = async function(id) {
  if (!confirm('¿Eliminar esta preparación?')) return;
  const database = await conectarDB();
  const tx = database.transaction(['recetas'], 'readwrite');
  tx.objectStore('recetas').delete(id);
  tx.oncomplete = () => {
    recargarRecetas();
    subirCatalogoCompartido(false);
  };
};

/* ============================================================
   SECCIÓN: METAS DIARIAS & CALCULADORA MIFFLIN-ST JEOR
   ============================================================ */
function poblarFormMetas() {
  const eKcal = document.getElementById('meta-kcal');
  const eProt = document.getElementById('meta-prot');
  const eCarbs = document.getElementById('meta-carbs');
  const eGrasas = document.getElementById('meta-grasas');
  const eMetaKcalDash = document.getElementById('dash-kcal-meta');

  if (eKcal) eKcal.value = metasActuales.kcal;
  if (eProt) eProt.value = metasActuales.proteinas;
  if (eCarbs) eCarbs.value = metasActuales.carbohidratos;
  if (eGrasas) eGrasas.value = metasActuales.grasas;
  if (eMetaKcalDash) eMetaKcalDash.textContent = metasActuales.kcal;
}

safeOn('form-calc-mifflin', 'submit', (e) => {
  e.preventDefault();

  const genero = document.getElementById('mifflin-genero')?.value || 'hombre';
  const edad = parseFloat(document.getElementById('mifflin-edad')?.value) || 0;
  const peso = parseFloat(document.getElementById('mifflin-peso')?.value) || 0;
  const talla = parseFloat(document.getElementById('mifflin-talla')?.value) || 0;
  const factorActividad = parseFloat(document.getElementById('mifflin-actividad')?.value) || 1.375;
  const objetivo = document.getElementById('mifflin-objetivo')?.value || 'mantenimiento';
  const ratioSeleccionado = document.getElementById('mifflin-ratio-prot')?.value || 'auto';

  if (peso <= 0 || talla <= 0 || edad <= 0) {
    alert('Ingresa edad, peso y estatura válidos.');
    return;
  }

  // Fórmula Mifflin-St Jeor para TMB
  let tmb = (10 * peso) + (6.25 * talla) - (5 * edad);
  if (genero === 'hombre') tmb += 5;
  else tmb -= 161;

  // Gasto energético total con Factor de Actividad y Efecto Térmico de Alimentos (ETA ~10%)
  const gastoActividad = tmb * factorActividad;
  const gastoTotalConEta = gastoActividad * 1.10;

  // Ajuste calórico por objetivo
  let caloriasObjetivo = gastoTotalConEta;
  let proteinaPorKg = 2.0;

  if (objetivo === 'deficit_moderado') {
    caloriasObjetivo = gastoTotalConEta * 0.80; // -20%
    proteinaPorKg = 2.0;
  } else if (objetivo === 'deficit_agresivo') {
    caloriasObjetivo = gastoTotalConEta * 0.75; // -25%
    proteinaPorKg = 2.2;
  } else if (objetivo === 'superavit_controlado') {
    caloriasObjetivo = gastoTotalConEta * 1.10; // +10%
    proteinaPorKg = 1.8;
  } else if (objetivo === 'superavit_fuerte') {
    caloriasObjetivo = gastoTotalConEta * 1.15; // +15%
    proteinaPorKg = 1.8;
  }

  // Si el usuario seleccionó un ratio proteico específico, lo respetamos estrictamente
  if (ratioSeleccionado !== 'auto') {
    proteinaPorKg = parseFloat(ratioSeleccionado);
  }

  // Cálculo de Macronutrientes
  const gramosProteina = Math.round(peso * proteinaPorKg);
  const kcalProteina = gramosProteina * 4;

  // Grasas hormonales esenciales (~0.9 g/kg)
  const gramosGrasas = Math.round(peso * 0.9);
  const kcalGrasas = gramosGrasas * 9;

  // Carbohidratos: Remanente calórico para rendimiento y glucógeno
  let kcalCarbos = caloriasObjetivo - (kcalProteina + kcalGrasas);
  if (kcalCarbos < 0) kcalCarbos = 0;
  const gramosCarbos = Math.round(kcalCarbos / 4);

  sugerenciaMifflinTemp = {
    kcal: Math.round(caloriasObjetivo),
    proteinas: gramosProteina,
    grasas: gramosGrasas,
    carbohidratos: gramosCarbos
  };

  document.getElementById('mifflin-res-tmb').textContent = Math.round(tmb);
  document.getElementById('mifflin-res-get').textContent = Math.round(gastoTotalConEta);
  document.getElementById('mifflin-res-target').textContent = Math.round(caloriasObjetivo);

  // Etiqueta dinámica transparente con los gramos y el ratio real aplicado
  document.getElementById('mifflin-sug-prot').textContent = `${gramosProteina}g (${proteinaPorKg.toFixed(1)} g/kg)`;
  document.getElementById('mifflin-sug-grasas').textContent = `${gramosGrasas}g (0.9 g/kg)`;
  document.getElementById('mifflin-sug-carbs').textContent = `${gramosCarbos}g`;

  const boxRes = document.getElementById('resultado-mifflin');
  if (boxRes) {
    boxRes.classList.remove('hidden');
    boxRes.scrollIntoView({ behavior: 'smooth' });
  }
});

safeOn('btn-aplicar-metas-mifflin', 'click', () => {
  if (!sugerenciaMifflinTemp) return;

  document.getElementById('meta-kcal').value = sugerenciaMifflinTemp.kcal;
  document.getElementById('meta-prot').value = sugerenciaMifflinTemp.proteinas;
  document.getElementById('meta-carbs').value = sugerenciaMifflinTemp.carbohidratos;
  document.getElementById('meta-grasas').value = sugerenciaMifflinTemp.grasas;

  const formMetas = document.getElementById('form-metas');
  if (formMetas) formMetas.scrollIntoView({ behavior: 'smooth' });
  alert('✓ Valores trasladados al formulario. Puedes modificarlos libremente antes de guardar.');
});

safeOn('form-metas', 'submit', async (e) => {
  e.preventDefault();
  metasActuales = {
    kcal: parseFloat(document.getElementById('meta-kcal').value) || 0,
    proteinas: parseFloat(document.getElementById('meta-prot').value) || 0,
    carbohidratos: parseFloat(document.getElementById('meta-carbs').value) || 0,
    grasas: parseFloat(document.getElementById('meta-grasas').value) || 0
  };

  const database = await conectarDB();
  const tx = database.transaction(['config'], 'readwrite');
  tx.objectStore('config').put({ clave: 'metas_diarias', valor: metasActuales });
  tx.oncomplete = () => {
    alert('✓ Metas actualizadas y guardadas.');
    cargarDiario();
    subirDiarioPrivado(false);
  };
});

/* ============================================================
   SECCIÓN: DIARIO NUTRICIONAL (ALTA VISIBILIDAD)
   ============================================================ */
safeOn('diario-fecha', 'change', (e) => {
  fechaSeleccionada = e.target.value;
  cargarDiario();
});

safeOn('btn-nueva-categoria', 'click', async () => {
  const nom = prompt('Nombre de la categoría (Ej: Merienda, Pre-entreno):');
  if (nom && !categoriasCache.includes(nom.trim())) {
    categoriasCache.push(nom.trim());
    const database = await conectarDB();
    const tx = database.transaction(['config'], 'readwrite');
    tx.objectStore('config').put({ clave: 'categorias', valor: categoriasCache });
    tx.oncomplete = () => {
      cargarDiario();
      subirDiarioPrivado(false);
    };
  }
});

async function cargarDiario() {
  const database = await conectarDB();
  const tx = database.transaction(['diario'], 'readonly');
  const index = tx.objectStore('diario').index('fecha');
  const req = index.getAll(IDBKeyRange.only(fechaSeleccionada));

  req.onsuccess = () => {
    renderizarEstructuraDiario(req.result || []);
  };
}

function renderizarEstructuraDiario(entradas) {
  const contenedor = document.getElementById('contenedor-categorias');
  if (!contenedor) return;
  contenedor.innerHTML = '';

  let totKcal = 0, totProt = 0, totCarbs = 0, totGrasas = 0;

  categoriasCache.forEach(cat => {
    const box = document.createElement('div');
    box.className = 'categoria-box';

    const entradasCat = entradas.filter(e => e.categoria === cat);
    let catKcal = 0, catProt = 0, catCarbs = 0, catGrasas = 0;

    let htmlEntradas = '';
    entradasCat.forEach(item => {
      totKcal += item.kcal;
      totProt += item.proteinas;
      totCarbs += item.carbohidratos;
      totGrasas += item.grasas;

      catKcal += item.kcal;
      catProt += item.proteinas;
      catCarbs += item.carbohidratos;
      catGrasas += item.grasas;

      htmlEntradas += `
        <div class="comida-item">
          <div>
            <strong>${item.nombre}</strong> (${item.gramos}g)<br>
            <small>${item.kcal.toFixed(0)} kcal • P: ${item.proteinas.toFixed(1)}g | C: ${item.carbohidratos.toFixed(1)}g | G: ${item.grasas.toFixed(1)}g</small>
          </div>
          <button class="btn-del" onclick="eliminarEntradaDiario(${item.id})">x</button>
        </div>
      `;
    });

    box.innerHTML = `
      <div class="categoria-header">
        <div>
          <h3>${cat}</h3>
          <div class="categoria-totales">
            <span class="cat-kcal-highlight">${catKcal.toFixed(0)} kcal</span>
            <span class="cat-macros-line">P: ${catProt.toFixed(1)}g • C: ${catCarbs.toFixed(1)}g • G: ${catGrasas.toFixed(1)}g</span>
          </div>
        </div>
        <button class="btn-secondary" onclick="abrirModalAgregarDiario('${cat}')">+ Agregar</button>
      </div>
      <div class="categoria-items">
        ${htmlEntradas || '<small style="color:var(--text-muted)">Sin registros</small>'}
      </div>
    `;
    contenedor.appendChild(box);
  });

  actualizarDashboard(totKcal, totProt, totCarbs, totGrasas);
}

function actualizarDashboard(kCons, pCons, cCons, gCons) {
  document.getElementById('dash-kcal-consumido').textContent = kCons.toFixed(0);
  document.getElementById('dash-kcal-meta').textContent = metasActuales.kcal;

  const kRest = metasActuales.kcal - kCons;
  const pRest = metasActuales.proteinas - pCons;
  const cRest = metasActuales.carbohidratos - cCons;
  const gRest = metasActuales.grasas - gCons;

  const elemKcalRest = document.getElementById('dash-kcal-restante');
  elemKcalRest.textContent = kRest.toFixed(0);
  if (kRest < 0) elemKcalRest.classList.add('alerta-exceso');
  else elemKcalRest.classList.remove('alerta-exceso');

  const setMacro = (idCol, idRest, idSub, rest, cons, meta) => {
    const rElem = document.getElementById(idRest);
    const sElem = document.getElementById(idSub);
    if (!rElem || !sElem) return;
    rElem.textContent = `${rest.toFixed(1)}g`;
    sElem.textContent = `${cons.toFixed(1)} / ${meta}g`;
    if (rest < 0) rElem.classList.add('alerta-exceso');
    else rElem.classList.remove('alerta-exceso');
  };

  setMacro('col-prot', 'dash-prot-restante', 'dash-prot-sub', pRest, pCons, metasActuales.proteinas);
  setMacro('col-carbs', 'dash-carbs-restante', 'dash-carbs-sub', cRest, cCons, metasActuales.carbohidratos);
  setMacro('col-grasas', 'dash-grasas-restante', 'dash-grasas-sub', gRest, gCons, metasActuales.grasas);

  window.restantesGlobales = { kcal: kRest, proteinas: pRest, carbohidratos: cRest, grasas: gRest };
}

window.abrirModalAgregarDiario = function(cat) {
  categoriaModalDiario = cat;
  const modal = document.getElementById('modal-agregar-diario');
  document.getElementById('modal-diario-titulo').textContent = `Agregar comida a ${cat}`;
  document.getElementById('diario-buscador').value = '';
  document.getElementById('diario-input-gramos').value = '';
  poblarSelectModalDiario('');
  modal.classList.remove('hidden');
  modal.scrollIntoView({ behavior: 'smooth' });
};

window.cerrarModalDiario = function() {
  const modal = document.getElementById('modal-agregar-diario');
  if (modal) modal.classList.add('hidden');
  categoriaModalDiario = null;
};

safeOn('diario-buscador', 'input', (e) => poblarSelectModalDiario(e.target.value));

function poblarSelectModalDiario(filtro = '') {
  const sel = document.getElementById('diario-select-item');
  if (!sel) return;
  sel.innerHTML = '';
  const fNorm = normalizarTexto(filtro);

  const alis = alimentosCache.filter(a => normalizarTexto(a.nombre).includes(fNorm));
  alis.forEach(a => sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, `ali_${a.id}`)));

  const recs = recetasCache.filter(r => normalizarTexto(r.nombre).includes(fNorm));
  recs.forEach(r => sel.appendChild(new Option(`${r.nombre} [Receta] (${r.kcalPor100g.toFixed(1)} kcal/100g)`, `rec_${r.id}`)));
}

safeOn('btn-confirmar-agregar-diario', 'click', async () => {
  const itemVal = document.getElementById('diario-select-item').value;
  const gramos = parseFloat(document.getElementById('diario-input-gramos').value) || 0;

  if (!itemVal || gramos <= 0) return alert('Selecciona un elemento y escribe los gramos consumidos.');

  let nombre = '', kcal100 = 0, p100 = 0, c100 = 0, g100 = 0;

  if (itemVal.startsWith('ali_')) {
    const id = parseInt(itemVal.replace('ali_', ''), 10);
    const a = alimentosCache.find(x => x.id === id);
    if (!a) return;
    nombre = a.nombre; kcal100 = a.kcal; p100 = a.proteinas; c100 = a.carbohidratos; g100 = a.grasas;
  } else if (itemVal.startsWith('rec_')) {
    const id = parseInt(itemVal.replace('rec_', ''), 10);
    const r = recetasCache.find(x => x.id === id);
    if (!r) return;
    nombre = r.nombre; kcal100 = r.kcalPor100g; p100 = r.protPor100g; c100 = r.carbsPor100g; g100 = r.grasasPor100g;
  }

  const f = gramos / 100;
  const entrada = {
    fecha: fechaSeleccionada,
    categoria: categoriaModalDiario,
    nombre: nombre,
    gramos: gramos,
    kcal: kcal100 * f,
    proteinas: p100 * f,
    carbohidratos: c100 * f,
    grasas: g100 * f
  };

  const database = await conectarDB();
  const tx = database.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').add(entrada);
  tx.oncomplete = () => {
    cerrarModalDiario();
    cargarDiario();
    subirDiarioPrivado(false);
  };
});

window.eliminarEntradaDiario = async function(id) {
  const database = await conectarDB();
  const tx = database.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').delete(id);
  tx.oncomplete = () => {
    cargarDiario();
    subirDiarioPrivado(false);
  };
};

/* ============================================================
   SECCIÓN: CHEF IA CON GEMINI + NUEVAS REGLAS TÉCNICAS
   ============================================================ */
safeOn('ai-objetivo-calorico', 'change', (e) => {
  const cont = document.getElementById('contenedor-ai-kcal-manual');
  if (cont) cont.classList.toggle('hidden', e.target.value !== 'manual');
});

async function fetchConReintento(url, opciones, maxReintentos = 3) {
  const aiStatus = document.getElementById('ai-status');
  for (let intento = 1; intento <= maxReintentos; intento++) {
    try {
      const resp = await fetch(url, opciones);
      const data = await resp.json();

      if (resp.ok) return data;

      if ((resp.status === 503 || resp.status === 429) && intento < maxReintentos) {
        if (aiStatus) aiStatus.textContent = `Servidores con alta demanda, reintentando automáticamente (${intento}/${maxReintentos})...`;
        await new Promise(r => setTimeout(r, 2000 * intento));
        continue;
      }

      const detalle = data?.error?.message || `Código ${resp.status}`;
      throw new Error(detalle);
    } catch (err) {
      if (intento === maxReintentos) throw err;
      await new Promise(r => setTimeout(r, 2000 * intento));
    }
  }
}

safeOn('btn-generar-receta-ia', 'click', async () => {
  if (alimentosCache.length < 2) {
    alert('Debes tener al menos 2 o 3 alimentos guardados en tu catálogo para que la IA arme una preparación.');
    return;
  }

  const rest = window.restantesGlobales || { kcal: 0, proteinas: 0, carbohidratos: 0, grasas: 0 };
  let metaKcal = 0;

  const selObj = document.getElementById('ai-objetivo-calorico');
  if (selObj && selObj.value === 'manual') {
    metaKcal = parseFloat(document.getElementById('ai-kcal-manual').value) || 0;
    if (metaKcal <= 0) return alert('Ingresa un valor válido de Kcal manuales.');
  } else {
    metaKcal = rest.kcal;
    if (metaKcal <= 20) {
      return alert('Ya has alcanzado tus Kcal restantes del día. Cambia la opción a "Fijar Kcal manuales".');
    }
  }

  const tipoComida = document.getElementById('ai-tipo-comida')?.value || 'Almuerzo salado';
  const metodoCoccion = document.getElementById('ai-metodo-coccion')?.value || 'Cualquiera';
  const protDeseada = parseFloat(document.getElementById('ai-prot-deseada')?.value) || 0;
  const antojoExtra = document.getElementById('ai-antojo-extra')?.value.trim() || '';

  let instruccionReplicar = '';
  const checkRep = document.getElementById('ai-check-replicar');
  if (checkRep && checkRep.checked) {
    const recId = parseInt(document.getElementById('ai-select-receta-plantilla').value, 10);
    const recBase = recetasCache.find(r => r.id === recId);
    if (recBase) {
      const ingBaseTexto = (recBase.ingredientes || []).map(i => `${i.nombre} (${i.gramos}g)`).join(', ');
      instruccionReplicar = `INSTRUCCIÓN DE REPLICACIÓN TÉCNICA: Debes inspirarte directamente en la receta "${recBase.nombre}" (compuesta por: ${ingBaseTexto}). Emula su estilo, texturas y balance gustativo, pero adaptándola para que cumpla con los macronutrientes solicitados y el método pedido, utilizando alimentos disponibles en la despensa.`;
    }
  }

  let instruccionUrgente = '';
  const checkUrg = document.getElementById('ai-check-urgente');
  if (checkUrg && checkUrg.checked) {
    const idUrg = parseInt(document.getElementById('ai-select-ingrediente-urgente').value, 10);
    const grUrg = parseFloat(document.getElementById('ai-gramos-urgente').value) || 0;
    const aliUrg = alimentosCache.find(a => a.id === idUrg);

    if (!aliUrg || grUrg <= 0) {
      return alert('Si activas el Modo Gastar Ingrediente, debes seleccionar el alimento y los gramos exactos a gastar.');
    }
    instruccionUrgente = `REQUISITO OBLIGATORIO Y PRIORITARIO: La receta DEBE incluir exactamente ${grUrg}g de "${aliUrg.nombre}" (id: ${aliUrg.id}). Cuadra el resto de las calorías con otros ingredientes de la despensa.`;
  }

  const despensaTexto = alimentosCache.map(a => 
    `{id: ${a.id}, nombre: "${a.nombre}", kcal100: ${a.kcal}, p100: ${a.proteinas}, c100: ${a.carbohidratos}, g100: ${a.grasas}}`
  ).join(',\n');

  const aiStatus = document.getElementById('ai-status');
  const aiBox = document.getElementById('ai-resultado-receta');
  if (aiStatus) {
    aiStatus.textContent = 'El Chef Gemini está diseñando tu receta culinaria con técnica profesional...';
    aiStatus.classList.remove('hidden');
  }
  if (aiBox) aiBox.classList.add('hidden');

  const promptSistema = `
Actúa como un Chef Ejecutivo y Nutricionista de alta cocina y nutrición deportiva.
Tu misión es diseñar una receta coherente, deliciosa y viable inspirada EXCLUSIVAMENTE en técnicas y preparaciones estándar de repositorios gastronómicos profesionales reconocidos (Larousse Gastronomique, alta pastelería francesa y cocina deportiva de precisión). Queda estrictamente prohibido inventar mezclas gastronómicamente absurdas.

DESPENSA DISPONIBLE (Usa EXCLUSIVAMENTE estos alimentos):
[
${despensaTexto}
]

REQUISITOS ESTRICTOS:
1. Objetivo calórico total: exactamente ${metaKcal.toFixed(0)} kcal (margen +- 15 kcal).
2. Perfil y momento culinario: "${tipoComida}". Respeta fielmente si es dulce o salado.
3. Método de preparación requerido: "${metodoCoccion}".
   - Si se especifica "Sin cocción / En frío", diseña un plato que se consuma inmediatamente tras mezclar/ensamblar (ej. preparaciones tipo porridge frío, bowl de yogurt con toppings, muesli, parfait o batidos). Bajo ninguna circunstancia uses alimentos crudos no aptos para consumo directo como huevo crudo o legumbres crudas.
   - Si se especifica "Requiere cocción", incluye técnicas culinarias reales de cocción (salteado, horneado, hervido, tostado).
${protDeseada > 0 ? `4. Requisito de proteína: La receta DEBE alcanzar como mínimo ${protDeseada}g de proteínas totales.` : ''}
${instruccionReplicar ? `5. ${instruccionReplicar}` : ''}
${instruccionUrgente ? `6. ${instruccionUrgente}` : ''}
${antojoExtra ? `7. Preferencia o antojo del usuario: "${antojoExtra}".` : ''}
8. NO inventes ingredientes no presentes en la despensa (puedes asumir agua, sal o especias secas comunes).
9. Calcula los gramos EXACTOS de cada ingrediente para sumar las Kcal y macros objetivo.
10. Responde ÚNICAMENTE en formato JSON válido con la siguiente estructura, sin texto antes ni después:
{
  "nombre": "Nombre profesional y apetitoso del plato",
  "descripcion": "Explicación sensorial de la textura, técnica y sabor",
  "ingredientes": [
    { "alimentoId": id_del_alimento, "nombre": "nombre_exacto", "gramos": numero_gramos }
  ],
  "pasos": [
    "Paso 1 técnico...",
    "Paso 2 técnico...",
    "Paso 3 técnico..."
  ]
}
`;

  try {
    const data = await fetchConReintento(WORKER_CHEF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptSistema }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawJson) throw new Error('No se recibió contenido válido del Chef IA.');

    const recetaGenerada = JSON.parse(rawJson);

    recetaIABaseOriginal = recetaGenerada;
    factorEscalaActual = 1;

    renderizarRecetaIAEscalada(1);

    if (aiStatus) aiStatus.classList.add('hidden');
    if (aiBox) {
      aiBox.classList.remove('hidden');
      aiBox.scrollIntoView({ behavior: 'smooth' });
    }

  } catch (err) {
    console.error(err);
    if (aiStatus) aiStatus.textContent = `❌ ${err.message}`;
  }
});

function renderizarRecetaIAEscalada(factor) {
  if (!recetaIABaseOriginal) return;
  factorEscalaActual = factor;

  document.querySelectorAll('.btn-scale').forEach(btn => {
    if (parseFloat(btn.getAttribute('data-scale')) === factor) {
      btn.style.background = '#6366f1';
      btn.style.color = '#fff';
    } else {
      btn.style.background = '';
      btn.style.color = '';
    }
  });

  let totKcal = 0, totProt = 0, totCarbs = 0, totGrasas = 0, totPeso = 0;
  const ingredientesEscalados = [];

  (recetaIABaseOriginal.ingredientes || []).forEach(ing => {
    const ali = alimentosCache.find(a => a.id === ing.alimentoId);
    if (ali) {
      const g = (parseFloat(ing.gramos) || 0) * factor;
      const f = g / 100;
      totKcal += ali.kcal * f;
      totProt += ali.proteinas * f;
      totCarbs += ali.carbohidratos * f;
      totGrasas += ali.grasas * f;
      totPeso += g;
      ingredientesEscalados.push({
        alimentoId: ali.id,
        nombre: ali.nombre,
        gramos: g,
        kcalAporte: ali.kcal * f
      });
    }
  });

  recetaIAPendiente = {
    nombre: factor > 1 ? `${recetaIABaseOriginal.nombre} (${factor} porciones)` : recetaIABaseOriginal.nombre,
    ingredientes: ingredientesEscalados.map(i => ({ alimentoId: i.alimentoId, nombre: i.nombre, gramos: i.gramos })),
    pesoTotal: totPeso,
    kcalTotal: totKcal,
    kcalPor100g: totPeso > 0 ? (totKcal / totPeso) * 100 : 0,
    protPor100g: totPeso > 0 ? (totProt / totPeso) * 100 : 0,
    carbsPor100g: totPeso > 0 ? (totCarbs / totPeso) * 100 : 0,
    grasasPor100g: totPeso > 0 ? (totGrasas / totPeso) * 100 : 0
  };

  document.getElementById('ai-receta-nombre').textContent = recetaIAPendiente.nombre;
  document.getElementById('ai-receta-calorias').textContent = `${totKcal.toFixed(0)} kcal`;
  document.getElementById('ai-receta-descripcion').textContent = recetaIABaseOriginal.descripcion || '';

  const infoPorcion = document.getElementById('ai-info-porcion');
  if (infoPorcion) {
    if (factor > 1) {
      infoPorcion.textContent = `⚖️ Servir por porción: ${(totPeso / factor).toFixed(0)}g en plato (${(totKcal / factor).toFixed(0)} kcal c/u)`;
    } else {
      infoPorcion.textContent = `⚖️ Peso total: ${totPeso.toFixed(0)}g`;
    }
  }

  const ulIng = document.getElementById('ai-receta-ingredientes');
  if (ulIng) {
    ulIng.innerHTML = '';
    ingredientesEscalados.forEach(ing => {
      const li = document.createElement('li');
      li.innerHTML = `<span><strong>${ing.nombre}</strong></span> <span class="sug-gramos">${ing.gramos.toFixed(1)} g</span> <small>(${ing.kcalAporte.toFixed(0)} kcal)</small>`;
      ulIng.appendChild(li);
    });
  }

  const olPasos = document.getElementById('ai-receta-pasos');
  if (olPasos) {
    olPasos.innerHTML = '';
    (recetaIABaseOriginal.pasos || []).forEach(paso => {
      const li = document.createElement('li');
      li.textContent = paso;
      olPasos.appendChild(li);
    });
  }

  const macrosTot = document.getElementById('ai-macros-totales');
  if (macrosTot) macrosTot.textContent = `Total: P: ${totProt.toFixed(1)}g | C: ${totCarbs.toFixed(1)}g | G: ${totGrasas.toFixed(1)}g`;
}

document.querySelectorAll('.btn-scale').forEach(btn => {
  btn.onclick = () => {
    const s = parseFloat(btn.getAttribute('data-scale')) || 1;
    renderizarRecetaIAEscalada(s);
  };
});

safeOn('btn-guardar-receta-ia', 'click', async () => {
  if (!recetaIAPendiente) return;

  const database = await conectarDB();
  const tx = database.transaction(['recetas'], 'readwrite');
  tx.objectStore('recetas').add(recetaIAPendiente);
  tx.oncomplete = () => {
    alert(`✓ ¡"${recetaIAPendiente.nombre}" guardada en Recetas!`);
    recargarRecetas();
    subirCatalogoCompartido(false);
  };
});

/* ============================================================
   SECCIÓN: MODO COCINA (VOZ)
   ============================================================ */
const modalCocina = document.getElementById('modal-modo-cocina');

safeOn('btn-iniciar-modo-cocina', 'click', () => {
  if (!recetaIABaseOriginal || !recetaIABaseOriginal.pasos || recetaIABaseOriginal.pasos.length === 0) {
    return alert('Genera una receta primero.');
  }
  pasoCocinaActual = 0;
  actualizarVistaModoCocina();
  if (modalCocina) modalCocina.classList.remove('hidden');
});

safeOn('btn-cerrar-cocina', 'click', () => {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (modalCocina) modalCocina.classList.add('hidden');
});

function actualizarVistaModoCocina() {
  const pasos = recetaIABaseOriginal.pasos || [];
  const tot = pasos.length;

  document.getElementById('cocina-receta-titulo').textContent = recetaIAPendiente.nombre;
  document.getElementById('cocina-paso-contador').textContent = `Paso ${pasoCocinaActual + 1} de ${tot}`;
  document.getElementById('cocina-paso-texto').textContent = pasos[pasoCocinaActual];

  const resIng = (recetaIAPendiente.ingredientes || []).map(i => `${i.nombre} (${i.gramos.toFixed(0)}g)`).join(' • ');
  document.getElementById('cocina-resumen-ingredientes').textContent = `Ingredientes: ${resIng}`;

  const btnAnt = document.getElementById('btn-cocina-anterior');
  const btnSig = document.getElementById('btn-cocina-siguiente');
  if (btnAnt) btnAnt.disabled = (pasoCocinaActual === 0);
  if (btnSig) btnSig.textContent = (pasoCocinaActual === tot - 1) ? '✓ ¡Listo!' : 'Siguiente ➡';
}

safeOn('btn-cocina-anterior', 'click', () => {
  if (pasoCocinaActual > 0) {
    pasoCocinaActual--;
    actualizarVistaModoCocina();
  }
});

safeOn('btn-cocina-siguiente', 'click', () => {
  const pasos = recetaIABaseOriginal?.pasos || [];
  if (pasoCocinaActual < pasos.length - 1) {
    pasoCocinaActual++;
    actualizarVistaModoCocina();
  } else {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (modalCocina) modalCocina.classList.add('hidden');
    alert('¡Buen provecho! Receta completada.');
  }
});

safeOn('btn-voz-paso', 'click', () => {
  if (!('speechSynthesis' in window)) {
    alert('La síntesis de voz no está disponible en este navegador.');
    return;
  }
  window.speechSynthesis.cancel();
  const texto = document.getElementById('cocina-paso-texto').textContent;
  const locucion = new SpeechSynthesisUtterance(texto);
  locucion.lang = 'es-ES';
  locucion.rate = 0.95;
  window.speechSynthesis.speak(locucion);
});

/* ============================================================
   SECCIÓN: MEZCLADOR PERSONALIZADO
   ============================================================ */
safeOn('mezclador-filtro', 'input', (e) => poblarSelectMezclador(e.target.value));

function poblarSelectMezclador(filtro = '') {
  const sel = document.getElementById('mezclador-select-alimento');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Selecciona alimento --</option>';
  const fNorm = normalizarTexto(filtro);

  const alis = alimentosCache.filter(a => normalizarTexto(a.nombre).includes(fNorm));
  alis.forEach(a => sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g | P:${a.proteinas}g)`, a.id)));
}

safeOn('mezclador-tipo-objetivo', 'change', (e) => {
  const cont = document.getElementById('contenedor-kcal-manual');
  if (cont) cont.classList.toggle('hidden', e.target.value !== 'manual');
});

safeOn('btn-agregar-alimento-mezcla', 'click', () => {
  const sel = document.getElementById('mezclador-select-alimento');
  const id = parseInt(sel.value, 10);
  if (!id) return;

  if (alimentosMezclador.includes(id)) return alert('Este alimento ya está en la selección.');

  alimentosMezclador.push(id);
  renderizarSeleccionMezclador();
});

function renderizarSeleccionMezclador() {
  const lista = document.getElementById('mezclador-lista-seleccionados');
  const contador = document.getElementById('mezclador-contador-items');
  if (contador) contador.textContent = alimentosMezclador.length;
  if (!lista) return;

  if (alimentosMezclador.length === 0) {
    lista.innerHTML = '<li style="color: var(--text-muted);">Ningún alimento seleccionado (mínimo 2).</li>';
    return;
  }

  lista.innerHTML = '';
  alimentosMezclador.forEach((id, idx) => {
    const a = alimentosCache.find(x => x.id === id);
    if (a) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span><strong>${a.nombre}</strong> (${a.kcal} kcal/100g - Prot: ${a.proteinas}g)</span>
        <button class="btn-del" onclick="quitarDeMezclador(${idx})">x</button>
      `;
      lista.appendChild(li);
    }
  });
}

window.quitarDeMezclador = function(idx) {
  alimentosMezclador.splice(idx, 1);
  renderizarSeleccionMezclador();
};

safeOn('btn-calcular-mezcla-personalizada', 'click', () => {
  const rest = window.restantesGlobales || { kcal: 0, proteinas: 0, carbohidratos: 0, grasas: 0 };
  const cont = document.getElementById('contenedor-sugerencias-personalizadas');
  if (!cont) return;
  cont.innerHTML = '';

  if (alimentosMezclador.length < 2) {
    cont.innerHTML = '<p style="color: var(--danger); font-weight: bold;">Debes seleccionar al menos 2 alimentos para la mezcla.</p>';
    return;
  }

  const tipoObj = document.getElementById('mezclador-tipo-objetivo')?.value;
  let totalKcal = 0;

  if (tipoObj === 'manual') {
    totalKcal = parseFloat(document.getElementById('mezclador-kcal-manual')?.value) || 0;
    if (totalKcal <= 0) {
      cont.innerHTML = '<p style="color: var(--danger); font-weight: bold;">Ingresa una cantidad válida de Kcal mayor a 0.</p>';
      return;
    }
  } else {
    totalKcal = rest.kcal;
    if (totalKcal <= 0) {
      cont.innerHTML = '<p style="color: var(--text-muted);">Ya has alcanzado tus Kcal restantes del día. Cambia la opción a "Fijar Kcal personalizadas".</p>';
      return;
    }
  }

  const items = alimentosMezclador.map(id => alimentosCache.find(a => a.id === id)).filter(Boolean);
  if (items.some(i => i.kcal <= 0)) {
    cont.innerHTML = '<p style="color: var(--danger);">Todos los alimentos seleccionados deben tener Kcal mayores a 0.</p>';
    return;
  }

  const num = items.length;
  const estrategias = [];

  const calcularTotalesMezcla = (pesos) => {
    let p = 0, c = 0, g = 0;
    pesos.forEach((gr, idx) => {
      const f = gr / 100;
      p += items[idx].proteinas * f;
      c += items[idx].carbohidratos * f;
      g += items[idx].grasas * f;
    });
    return { p, c, g };
  };

  const ordenDesc = [...items].sort((a, b) => b.kcal - a.kcal);
  let pesosE1 = [];
  let sumaPonderadores = 0;
  for (let i = 0; i < num; i++) sumaPonderadores += (num - i);

  items.forEach(item => {
    const rank = ordenDesc.findIndex(x => x.id === item.id);
    const porcionKcal = totalKcal * ((num - rank) / sumaPonderadores);
    const gr = Number(((porcionKcal / item.kcal) * 100).toFixed(1));
    pesosE1.push(gr);
  });
  const totE1 = calcularTotalesMezcla(pesosE1);

  estrategias.push({
    titulo: 'Estrategia 1: Alimento más Denso Dominante',
    tipo: 'Mayor aporte calórico del alimento denso',
    desglose: items.map((it, idx) => `• <strong>${it.nombre}</strong>: <span class="sug-gramos">${pesosE1[idx]} g</span> (${((it.kcal * pesosE1[idx])/100).toFixed(0)} kcal)`).join('<br>'),
    totales: totE1
  });

  let pesosE2 = [];
  const kcalPorItem = totalKcal / num;
  items.forEach(item => {
    const gr = Number(((kcalPorItem / item.kcal) * 100).toFixed(1));
    pesosE2.push(gr);
  });
  const totE2 = calcularTotalesMezcla(pesosE2);

  estrategias.push({
    titulo: 'Estrategia 2: Balance Parejo',
    tipo: 'Aporte calórico equitativo entre todos los alimentos',
    desglose: items.map((it, idx) => `• <strong>${it.nombre}</strong>: <span class="sug-gramos">${pesosE2[idx]} g</span> (${((it.kcal * pesosE2[idx])/100).toFixed(0)} kcal)`).join('<br>'),
    totales: totE2
  });

  let pesosE3 = [];
  items.forEach(item => {
    const rank = ordenDesc.findIndex(x => x.id === item.id);
    const porcionKcal = totalKcal * ((rank + 1) / sumaPonderadores);
    const gr = Number(((porcionKcal / item.kcal) * 100).toFixed(1));
    pesosE3.push(gr);
  });
  const totE3 = calcularTotalesMezcla(pesosE3);

  estrategias.push({
    titulo: 'Estrategia 3: Menor Kcal Dominante (Mayor Volumen)',
    tipo: 'Mayor porción del alimento ligero para volumen y saciedad',
    desglose: items.map((it, idx) => `• <strong>${it.nombre}</strong>: <span class="sug-gramos">${pesosE3[idx]} g</span> (${((it.kcal * pesosE3[idx])/100).toFixed(0)} kcal)`).join('<br>'),
    totales: totE3
  });

  let kcalRestanteCascada = totalKcal;
  let pesosE4Map = {};

  ordenDesc.forEach((item, idx) => {
    const esUltimo = (idx === ordenDesc.length - 1);
    let gr = 0;

    if (!esUltimo) {
      const tope = (totalKcal * 0.25) / (item.kcal / 100);
      const sugerido = Math.min(15, Math.max(5, tope));
      const aportado = (item.kcal * sugerido) / 100;

      if (aportado >= kcalRestanteCascada) {
        gr = Number(((kcalRestanteCascada / item.kcal) * 100).toFixed(1));
      } else {
        gr = Number(sugerido.toFixed(1));
      }
      kcalRestanteCascada -= (item.kcal * gr) / 100;
    } else {
      gr = Number(((kcalRestanteCascada / item.kcal) * 100).toFixed(1));
    }
    pesosE4Map[item.id] = gr;
  });

  const pesosE4 = items.map(it => pesosE4Map[it.id]);
  const totE4 = calcularTotalesMezcla(pesosE4);

  estrategias.push({
    titulo: 'Estrategia 4: Cascada por Densidad',
    tipo: 'Ingrediente denso en porción mínima; remanente al más ligero',
    desglose: items.map((it, idx) => `• <strong>${it.nombre}</strong> (${it.kcal} kcal/100g): <span class="sug-gramos">${pesosE4[idx]} g</span> (${((it.kcal * pesosE4[idx])/100).toFixed(0)} kcal)`).join('<br>'),
    totales: totE4
  });

  estrategias.forEach(est => {
    const card = document.createElement('div');
    card.className = 'sugerencia-card';

    const excesoP = est.totales.p > rest.proteinas + 0.5 ? (est.totales.p - rest.proteinas) : 0;
    const excesoC = est.totales.c > rest.carbohidratos + 0.5 ? (est.totales.c - rest.carbohidratos) : 0;
    const excesoG = est.totales.g > rest.grasas + 0.5 ? (est.totales.g - rest.grasas) : 0;

    let alertas = [];
    if (excesoP > 0) alertas.push(`<span class="alerta-exceso">+${excesoP.toFixed(1)}g Prot</span>`);
    if (excesoC > 0) alertas.push(`<span class="alerta-exceso">+${excesoC.toFixed(1)}g Carbs</span>`);
    if (excesoG > 0) alertas.push(`<span class="alerta-exceso">+${excesoG.toFixed(1)}g Grasas</span>`);

    card.innerHTML = `
      <h4>${est.titulo}</h4>
      <small style="color: var(--primary); font-weight: 600;">${est.tipo}</small>
      <div style="margin: 0.5rem 0; line-height: 1.4;">${est.desglose}</div>
      <div style="font-size:0.85rem; margin-top:0.4rem; border-top: 1px solid var(--border); padding-top: 0.4rem;">
        Aporte: <strong>${totalKcal.toFixed(0)} kcal</strong> | 
        <span class="${excesoP > 0 ? 'alerta-exceso' : ''}">P: ${est.totales.p.toFixed(1)}g</span> | 
        <span class="${excesoC > 0 ? 'alerta-exceso' : ''}">C: ${est.totales.c.toFixed(1)}g</span> | 
        <span class="${excesoG > 0 ? 'alerta-exceso' : ''}">G: ${est.totales.g.toFixed(1)}g</span>
      </div>
      ${alertas.length > 0 ? `<div style="font-size:0.75rem; margin-top:0.4rem;">Exceso advertido: ${alertas.join(' | ')}</div>` : '<div style="font-size:0.75rem; color:var(--success); margin-top:0.4rem;">✓ Cuadra dentro de tus macros</div>'}
    `;
    cont.appendChild(card);
  });
});

/* ============================================================
   SECCIÓN: SUGERENCIAS AUTOMÁTICAS
   ============================================================ */
safeOn('btn-calcular-sugerencias', 'click', () => {
  const rest = window.restantesGlobales || { kcal: 0, proteinas: 0, carbohidratos: 0, grasas: 0 };
  const cont = document.getElementById('contenedor-sugerencias');
  if (!cont) return;
  cont.innerHTML = '';

  if (rest.kcal <= 0) {
    cont.innerHTML = '<p style="color:var(--text-muted)">Ya has alcanzado tu meta de Kcal del día.</p>';
    return;
  }

  const modo = document.getElementById('sug-modo')?.value || 'todos';
  const sugerencias = [];

  if (modo === 'individuales' || modo === 'todos') {
    const catalogo = [
      ...alimentosCache.map(a => ({ nombre: a.nombre, kcal100: a.kcal, p100: a.proteinas, c100: a.carbohidratos, g100: a.grasas, tipo: 'Alimento' })),
      ...recetasCache.map(r => ({ nombre: r.nombre, kcal100: r.kcalPor100g, p100: r.protPor100g, c100: r.carbsPor100g, g100: r.grasasPor100g, tipo: 'Receta' }))
    ];

    catalogo.forEach(item => {
      if (item.kcal100 <= 0) return;
      const gReq = (rest.kcal / item.kcal100) * 100;
      const f = gReq / 100;

      const pAporte = item.p100 * f;
      const cAporte = item.c100 * f;
      const gAporte = item.g100 * f;

      sugerencias.push({
        titulo: item.nombre,
        tipo: item.tipo,
        descripcion: `Consumir exactamente: <span class="sug-gramos">${gReq.toFixed(1)} g</span>`,
        kcal: rest.kcal,
        p: pAporte,
        c: cAporte,
        g: gAporte,
        excesoP: pAporte > rest.proteinas + 0.5 ? pAporte - rest.proteinas : 0,
        excesoC: cAporte > rest.carbohidratos + 0.5 ? cAporte - rest.carbohidratos : 0,
        excesoG: gAporte > rest.grasas + 0.5 ? gAporte - rest.grasas : 0
      });
    });
  }

  if (modo === 'combinaciones' || modo === 'todos') {
    recetasCache.forEach(rec => {
      if (rec.ingredientes && rec.ingredientes.length >= 2) {
        const ing1 = alimentosCache.find(a => a.id === rec.ingredientes[0].alimentoId);
        const ing2 = alimentosCache.find(a => a.id === rec.ingredientes[1].alimentoId);

        if (ing1 && ing2 && ing1.kcal > 0 && ing2.kcal > 0) {
          const prop1 = rec.ingredientes[0].gramos;
          const prop2 = rec.ingredientes[1].gramos;
          const kcalMezclaOriginal = (ing1.kcal * prop1 / 100) + (ing2.kcal * prop2 / 100);

          if (kcalMezclaOriginal > 0) {
            const factorEscala = rest.kcal / kcalMezclaOriginal;
            const g1Final = prop1 * factorEscala;
            const g2Final = prop2 * factorEscala;

            const pAporte = (ing1.proteinas * g1Final / 100) + (ing2.proteinas * g2Final / 100);
            const cAporte = (ing1.carbohidratos * g1Final / 100) + (ing2.carbohidratos * g2Final / 100);
            const gAporte = (ing1.grasas * g1Final / 100) + (ing2.grasas * g2Final / 100);

            sugerencias.push({
              titulo: `${ing1.nombre} + ${ing2.nombre}`,
              tipo: `Combinación habitual (${rec.nombre})`,
              descripcion: `
                • ${ing1.nombre}: <span class="sug-gramos">${g1Final.toFixed(1)} g</span><br>
                • ${ing2.nombre}: <span class="sug-gramos">${g2Final.toFixed(1)} g</span>
              `,
              kcal: rest.kcal,
              p: pAporte,
              c: cAporte,
              g: gAporte,
              excesoP: pAporte > rest.proteinas + 0.5 ? pAporte - rest.proteinas : 0,
              excesoC: cAporte > rest.carbohidratos + 0.5 ? cAporte - rest.carbohidratos : 0,
              excesoG: gAporte > rest.grasas + 0.5 ? gAporte - rest.grasas : 0
            });
          }
        }
      }
    });
  }

  if (sugerencias.length === 0) {
    cont.innerHTML = '<p style="color:var(--text-muted)">No hay sugerencias disponibles.</p>';
    return;
  }

  sugerencias.forEach(sug => {
    const card = document.createElement('div');
    card.className = 'sugerencia-card';

    let alertas = [];
    if (sug.excesoP > 0) alertas.push(`<span class="alerta-exceso">+${sug.excesoP.toFixed(1)}g Prot</span>`);
    if (sug.excesoC > 0) alertas.push(`<span class="alerta-exceso">+${sug.excesoC.toFixed(1)}g Carbs</span>`);
    if (sug.excesoG > 0) alertas.push(`<span class="alerta-exceso">+${sug.excesoG.toFixed(1)}g Grasas</span>`);

    card.innerHTML = `
      <h4>${sug.titulo} <small style="color:var(--text-muted)">(${sug.tipo})</small></h4>
      <div style="margin: 0.4rem 0;">${sug.descripcion}</div>
      <div style="font-size:0.85rem; margin-top:0.3rem;">
        Aporta: <strong>${sug.kcal.toFixed(0)} kcal</strong> | 
        <span class="${sug.excesoP > 0 ? 'alerta-exceso' : ''}">P: ${sug.p.toFixed(1)}g</span> | 
        <span class="${sug.excesoC > 0 ? 'alerta-exceso' : ''}">C: ${sug.c.toFixed(1)}g</span> | 
        <span class="${sug.excesoG > 0 ? 'alerta-exceso' : ''}">G: ${sug.g.toFixed(1)}g</span>
      </div>
      ${alertas.length > 0 ? `<div style="font-size:0.75rem; margin-top:0.4rem;">Exceso advertido: ${alertas.join(' | ')}</div>` : '<div style="font-size:0.75rem; color:var(--success); margin-top:0.4rem;">✓ Cuadra perfectamente dentro de tus macros</div>'}
    `;
    cont.appendChild(card);
  });
});

/* ============================================================
   SECCIÓN: RESPALDO LOCAL (EXPORTAR E IMPORTAR JSON)
   ============================================================ */
async function generarObjetoRespaldo() {
  const database = await conectarDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['alimentos', 'recetas', 'diario', 'config'], 'readonly');
    const respaldo = {
      versionApp: 'CoffeeBreak_v22',
      fechaExportacion: new Date().toISOString(),
      alimentos: [],
      recetas: [],
      diario: [],
      config: []
    };

    tx.objectStore('alimentos').getAll().onsuccess = (e) => respaldo.alimentos = e.target.result || [];
    tx.objectStore('recetas').getAll().onsuccess = (e) => respaldo.recetas = e.target.result || [];
    tx.objectStore('diario').getAll().onsuccess = (e) => respaldo.diario = e.target.result || [];
    tx.objectStore('config').getAll().onsuccess = (e) => respaldo.config = e.target.result || [];

    tx.oncomplete = () => resolve(respaldo);
    tx.onerror = (e) => reject(e);
  });
}

safeOn('btn-generar-texto-backup', 'click', async () => {
  try {
    const data = await generarObjetoRespaldo();
    const jsonStr = JSON.stringify(data, null, 2);
    const txtArea = document.getElementById('txt-backup-generado');
    const contenedor = document.getElementById('contenedor-texto-exportado');

    if (txtArea) txtArea.value = jsonStr;
    if (contenedor) {
      contenedor.classList.remove('hidden');
      contenedor.scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    console.error(err);
    alert('Error al leer los datos locales.');
  }
});

safeOn('btn-seleccionar-todo', 'click', () => {
  const txtArea = document.getElementById('txt-backup-generado');
  if (txtArea) {
    txtArea.focus();
    txtArea.select();
    txtArea.setSelectionRange(0, 999999);
    alert('Texto seleccionado.');
  }
});

safeOn('btn-descargar-archivo', 'click', async () => {
  try {
    const data = await generarObjetoRespaldo();
    const jsonStr = JSON.stringify(data, null, 2);
    const fileName = `coffeebreak_backup_${new Date().toISOString().split('T')[0]}.json`;

    const encodedData = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);
    const link = document.createElement('a');
    link.setAttribute('href', encodedData);
    link.setAttribute('download', fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

  } catch (err) {
    console.error(err);
    alert('Usa la opción de copiar texto.');
  }
});

async function procesarEInsertarDatos(data) {
  if (!data || (!data.alimentos && !data.recetas && !data.diario)) {
    alert('El contenido no corresponde a un respaldo válido.');
    return;
  }

  const database = await conectarDB();
  const tx = database.transaction(['alimentos', 'recetas', 'diario', 'config'], 'readwrite');

  if (Array.isArray(data.alimentos)) {
    const storeA = tx.objectStore('alimentos');
    data.alimentos.forEach(item => storeA.put(item));
  }
  if (Array.isArray(data.recetas)) {
    const storeR = tx.objectStore('recetas');
    data.recetas.forEach(item => storeR.put(item));
  }
  if (Array.isArray(data.diario)) {
    const storeD = tx.objectStore('diario');
    data.diario.forEach(item => storeD.put(item));
  }
  if (Array.isArray(data.config)) {
    const storeC = tx.objectStore('config');
    data.config.forEach(item => storeC.put(item));
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = async () => {
      await refrescarDatosLocales();
      resolve();
    };
    tx.onerror = (e) => {
      console.error(e);
      reject(e.target.error);
    };
  });
}

safeOn('btn-restaurar-texto', 'click', async () => {
  const txt = document.getElementById('txt-importar-manual')?.value.trim();
  if (!txt) return alert('Pega el texto del respaldo primero.');

  try {
    const data = JSON.parse(txt);
    await procesarEInsertarDatos(data);
    document.getElementById('txt-importar-manual').value = '';
    alert('✓ ¡Datos locales restaurados!');
    subirDiarioPrivado(false);
  } catch (err) {
    console.error(err);
    alert('El texto no es un JSON válido.');
  }
});

// ============================================================
// 6. ARRANQUE
// ============================================================
cargarTodo();
setTimeout(() => autoSyncCompletoSilencioso(), 1000);