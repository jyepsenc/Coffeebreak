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

// 2. CAMBIO DE PESTAÑAS BLINDADO POR DELEGACIÓN GLOBAL
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  e.preventDefault();

  const targetId = btn.getAttribute('data-tab');
  if (!targetId) return;

  const botones = document.querySelectorAll('.tab-btn');
  const contenidos = document.querySelectorAll('.tab-content');

  botones.forEach(b => b.classList.remove('active'));
  contenidos.forEach(c => c.classList.remove('active'));

  btn.classList.add('active');
  const targetContenido = document.getElementById(targetId);
  if (targetContenido) targetContenido.classList.add('active');
});

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
  verificarSesionGuardada();

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

    setTimeout(() => autoSyncCompletoSilencioso(), 400);
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
   SECCIÓN: SINCRONIZACIÓN AUTOMÁTICA EN BACKGROUND
   ============================================================ */
async function autoSyncCompletoSilencioso() {
  if (!sesionUsuarioActual) return;

  const indicator = document.getElementById('sync-status-indicator');
  if (indicator) indicator.textContent = '🔄';

  try {
    await descargarCatalogoCompartido(false);
    await descargarDiarioPrivado(false);
    if (indicator) indicator.textContent = '☁️';
  } catch (err) {
    console.error('Error auto-sync:', err);
    if (indicator) indicator.textContent = '⚠️';
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

    cargarTodo();
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

    cargarTodo();
    if (statusMsg) statusMsg.textContent = `✓ Despensa compartida actualizada (Último cambio por: ${data.lastUpdatedBy || 'admin'})`;
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
          <strong>${u.username}</strong>${esAdmin ? '<span style="color:#10b981;">(Admin)</span>' : '<span style="color:var(--text-muted);">(Miembro)</span>'}
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
    contenedor.innerHTML = `<small style="color:var(--