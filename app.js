// Base de Datos IndexedDB - Coffee Break Food Metrics
const DB_NAME = 'NutriAppDB';
const DB_VERSION = 2;

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

// 1. REGISTRO DE SERVICE WORKER PARA PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registrado:', reg.scope))
      .catch(err => console.log('Aviso Service Worker:', err));
  });
}

// 2. GESTIÓN DE PESTAÑAS
function activarPestanas() {
  const botones = document.querySelectorAll('.tab-btn');
  const contenidos = document.querySelectorAll('.tab-content');

  botones.forEach(btn => {
    btn.addEventListener('click', () => {
      botones.forEach(b => b.classList.remove('active'));
      contenidos.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetContenido = document.getElementById(targetId);
      if (targetContenido) targetContenido.classList.add('active');
    });
  });
}

// 3. INICIALIZACIÓN DE INDEXEDDB
function initDB() {
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
    cargarTodo();
  };

  req.onerror = (e) => console.error('Error DB:', e.target.error);
}

function cargarTodo() {
  const inputFecha = document.getElementById('diario-fecha');
  if (inputFecha) inputFecha.value = fechaSeleccionada;

  poblarFormMetas();
  if (!db) return;

  const tx = db.transaction(['config', 'alimentos', 'recetas'], 'readonly');

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
}

/* ============================================================
   SECCIÓN: FILTROS Y SELECTORES INTELIGENTES
   ============================================================ */
function actualizarSelectoresGlobales() {
  poblarSelectCalculadora();
  poblarSelectRecetaIngredientes();
  poblarSelectMezclador();
  poblarSelectIngredienteUrgente();
}

function poblarSelectIngredienteUrgente() {
  const sel = document.getElementById('ai-select-ingrediente-urgente');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Selecciona qué alimento debes gastar --</option>';
  alimentosCache.forEach(a => {
    sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, a.id));
  });
}

// Checkbox modo urgente
const checkUrgente = document.getElementById('ai-check-urgente');
const contUrgente = document.getElementById('ai-contenedor-urgente');
if (checkUrgente && contUrgente) {
  checkUrgente.addEventListener('change', () => {
    if (checkUrgente.checked) contUrgente.classList.remove('hidden');
    else contUrgente.classList.add('hidden');
  });
}

// Buscador en Calculadora
const calcFiltro = document.getElementById('calc-filtro-nombre');
if (calcFiltro) {
  calcFiltro.addEventListener('input', () => poblarSelectCalculadora(calcFiltro.value.trim().toLowerCase()));
}

function poblarSelectCalculadora(filtro = '') {
  const select = document.getElementById('select-alimento');
  if (!select) return;
  select.innerHTML = '<option value="">-- Elige un elemento --</option>';

  const alisFiltrados = alimentosCache.filter(a => a.nombre.toLowerCase().includes(filtro));
  if (alisFiltrados.length > 0) {
    const gAli = document.createElement('optgroup');
    gAli.label = 'Alimentos Individuales';
    alisFiltrados.forEach(a => gAli.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, `ali_${a.id}`)));
    select.appendChild(gAli);
  }

  const recsFiltradas = recetasCache.filter(r => r.nombre.toLowerCase().includes(filtro));
  if (recsFiltradas.length > 0) {
    const gRec = document.createElement('optgroup');
    gRec.label = 'Recetas Compuestas';
    recsFiltradas.forEach(r => gRec.appendChild(new Option(`${r.nombre} [Receta] (${r.kcalPor100g.toFixed(1)} kcal/100g)`, `rec_${r.id}`)));
    select.appendChild(gRec);
  }
}

// Buscador en Ingredientes de Recetas
const recetaFiltro = document.getElementById('receta-filtro-ingrediente');
if (recetaFiltro) {
  recetaFiltro.addEventListener('input', () => poblarSelectRecetaIngredientes(recetaFiltro.value.trim().toLowerCase()));
}

function poblarSelectRecetaIngredientes(filtro = '') {
  const select = document.getElementById('receta-select-alimento');
  if (!select) return;
  select.innerHTML = '<option value="">-- Elige un alimento base --</option>';

  const alisFiltrados = alimentosCache.filter(a => a.nombre.toLowerCase().includes(filtro));
  alisFiltrados.forEach(a => select.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, a.id)));
}

// Buscador en Alimentos Guardados
const buscadorAlisGuardados = document.getElementById('buscador-alimentos-guardados');
if (buscadorAlisGuardados) {
  buscadorAlisGuardados.addEventListener('input', () => renderizarListaAlimentosGuardados(buscadorAlisGuardados.value.trim().toLowerCase()));
}

function renderizarListaAlimentosGuardados(filtro = '') {
  const lista = document.getElementById('lista-alimentos');
  if (!lista) return;
  lista.innerHTML = '';

  const filtrados = alimentosCache.filter(a => a.nombre.toLowerCase().includes(filtro) || (a.marca && a.marca.toLowerCase().includes(filtro)));
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

// Buscador en Recetas Guardadas
const buscadorRecsGuardadas = document.getElementById('buscador-recetas-guardadas');
if (buscadorRecsGuardadas) {
  buscadorRecsGuardadas.addEventListener('input', () => renderizarListaRecetasGuardadas(buscadorRecsGuardadas.value.trim().toLowerCase()));
}

function renderizarListaRecetasGuardadas(filtro = '') {
  const lista = document.getElementById('lista-recetas');
  if (!lista) return;
  lista.innerHTML = '';

  const filtradas = recetasCache.filter(r => r.nombre.toLowerCase().includes(filtro));
  if (filtradas.length === 0) {
    lista.innerHTML = '<li style="color: var(--text-muted);">No se encontraron recetas.</li>';
    return;
  }

  filtradas.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${r.nombre}</strong><br>
        <small style="color: var(--text-muted);">${r.kcalPor100g.toFixed(1)} kcal/100g (Total: ${r.pesoTotal}g - ${r.kcalTotal.toFixed(0)} kcal)</small>
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
   SECCIÓN: OCR Y NORMALIZACIÓN DE FOTOS
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
      ocrContainer.classList.remove('hidden');

      imgPreview.onload = async () => {
        if (typeof Tesseract === 'undefined') {
          alert('Se requiere internet la primera vez para cargar el motor OCR.');
          return;
        }

        try {
          ocrStatus.textContent = 'Normalizando imagen...';
          const imagenOptimizada = optimizarFotoCelular(imgPreview);

          ocrStatus.textContent = 'Analizando tabla...';
          const result = await Tesseract.recognize(
            imagenOptimizada,
            'spa',
            {
              logger: m => {
                if (m.status === 'recognizing text') {
                  ocrStatus.textContent = `Leyendo tabla: ${Math.round(m.progress * 100)}%`;
                }
              }
            }
          );

          const texto = result.data.text;
          if (ocrRawText) ocrRawText.textContent = texto;

          ocrStatus.textContent = '✓ Lectura lista. Comprueba los campos abajo:';
          parsearTablaNutricionalRobusto(texto);

        } catch (err) {
          console.error('Error OCR:', err);
          ocrStatus.textContent = 'Error al leer la imagen. Ingresa los datos manualmente.';
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
    const l整治 = l.toLowerCase();

    if ((l整治.includes('energ') || l整治.includes('kcal') || l整治.includes('calor')) && valores.kcal === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.kcal = nums.find(n => n >= 15) || nums[0];
    } else if ((l整治.includes('prot') || l整治.includes('prat')) && valores.proteinas === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.proteinas = nums[0];
    } else if ((l整治.includes('carb') || l整治.includes('h. de c') || l整治.includes('hidratos')) && valores.carbohidratos === null) {
      const nums = extraerNumerosConCoherencia(l, 'carbos');
      if (nums.length > 0) valores.carbohidratos = nums[0];
    } else if ((l整治.includes('grasa total') || l整治.includes('grasas totales') || l整治.includes('lipidos') || (l整治.includes('grasa') && !l整治.includes('sat') && !l整治.includes('mono') && !l整治.includes('trans'))) && valores.grasas === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.grasas = nums[0];
    } else if (l整治.includes('azuc') || l整治.includes('azúc')) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0 && valores.azucares === null) valores.azucares = nums[0];
    } else if (l整治.includes('fibra')) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0 && valores.fibra === null) valores.fibra = nums[0];
    } else if (l整治.includes('saturad') && valores.sat === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.sat = nums[0];
    } else if (l整治.includes('monoinsat') && valores.mono === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.mono = nums[0];
    } else if (l整治.includes('trans') && valores.trans === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.trans = nums[0];
    } else if (l整治.includes('sodio') && valores.sodio === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.sodio = nums[0];
    } else if (l整治.includes('colest') && valores.colesterol === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.colesterol = nums[0];
    }
  }

  const asignar = (id, val) => {
    if (val !== null) document.getElementById(id).value = Number(val.toFixed(2));
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

  document.getElementById('form-alimento').scrollIntoView({ behavior: 'smooth' });
}

/* ============================================================
   SECCIÓN: ALIMENTOS Y CALCULADORA DINÁMICA
   ============================================================ */
function actualizarVistasAlimentos() {
  renderizarListaAlimentosGuardados();
}

document.getElementById('form-alimento').addEventListener('submit', (e) => {
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

  const tx = db.transaction(['alimentos'], 'readwrite');
  tx.objectStore('alimentos').add(alimento);
  tx.oncomplete = () => {
    document.getElementById('form-alimento').reset();
    if (ocrContainer) ocrContainer.classList.add('hidden');
    alert(`¡"${alimento.nombre}" guardado con éxito!`);
    recargarAlimentos();
  };
});

function recargarAlimentos() {
  db.transaction(['alimentos'], 'readonly').objectStore('alimentos').getAll().onsuccess = (e) => {
    alimentosCache = e.target.result || [];
    actualizarVistasAlimentos();
    actualizarSelectoresGlobales();
  };
}

window.eliminarAlimento = function(id) {
  if (!confirm('¿Eliminar este alimento?')) return;
  const tx = db.transaction(['alimentos'], 'readwrite');
  tx.objectStore('alimentos').delete(id);
  tx.oncomplete = () => recargarAlimentos();
};

function calcularGramos() {
  const val = document.getElementById('select-alimento').value;
  const gramos = parseFloat(document.getElementById('input-gramos').value) || 0;
  const box = document.getElementById('resultado-calculo');

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

document.getElementById('select-alimento').addEventListener('change', calcularGramos);
document.getElementById('input-gramos').addEventListener('input', calcularGramos);

/* ============================================================
   SECCIÓN: RECETAS COMPUESTAS (CREAR Y EDITAR)
   ============================================================ */
document.getElementById('btn-agregar-ingrediente').addEventListener('click', () => {
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
    lista.innerHTML = '<li style="color: var(--text-muted);">Sin ingredientes aún.</li>';
    preview.classList.add('hidden');
    return;
  }

  lista.innerHTML = '';
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

      const li = document.createElement('li');
      li.innerHTML = `
        <span>${ing.nombre} - ${ing.gramos}g (${(ali.kcal * f).toFixed(1)} kcal)</span>
        <button class="btn-del" onclick="eliminarIngredienteReceta(${idx})">x</button>
      `;
      lista.appendChild(li);
    }
  });

  document.getElementById('receta-total-kcal').textContent = totKcal.toFixed(1);
  document.getElementById('receta-total-peso').textContent = totPeso.toFixed(1);
  document.getElementById('receta-total-prot').textContent = totProt.toFixed(1);
  document.getElementById('receta-total-carbs').textContent = totCarbs.toFixed(1);
  document.getElementById('receta-total-grasas').textContent = totGrasas.toFixed(1);
  preview.classList.remove('hidden');
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
  document.getElementById('btn-guardar-receta').textContent = 'Guardar Cambios de la Receta';
  document.getElementById('btn-cancelar-edicion-receta').classList.remove('hidden');

  recetaBorrador = JSON.parse(JSON.stringify(rec.ingredientes || []));
  actualizarVistaBorradorReceta();

  document.getElementById('tab-recetas').scrollIntoView({ behavior: 'smooth' });
};

document.getElementById('btn-cancelar-edicion-receta').addEventListener('click', () => {
  resetearFormularioReceta();
});

function resetearFormularioReceta() {
  recetaEditandoId = null;
  recetaBorrador = [];
  document.getElementById('titulo-panel-receta').textContent = 'Crear Receta Compuesta';
  document.getElementById('receta-nombre').value = '';
  document.getElementById('btn-guardar-receta').textContent = 'Guardar Receta';
  document.getElementById('btn-cancelar-edicion-receta').classList.add('hidden');
  actualizarVistaBorradorReceta();
}

document.getElementById('btn-guardar-receta').addEventListener('click', () => {
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

  const objReceta = {
    nombre: nombre,
    ingredientes: [...recetaBorrador],
    pesoTotal: totPeso,
    kcalTotal: totKcal,
    kcalPor100g: totPeso > 0 ? (totKcal / totPeso) * 100 : 0,
    protPor100g: totPeso > 0 ? (totProt / totPeso) * 100 : 0,
    carbsPor100g: totPeso > 0 ? (totCarbs / totPeso) * 100 : 0,
    grasasPor100g: totPeso > 0 ? (totGrasas / totPeso) * 100 : 0
  };

  const tx = db.transaction(['recetas'], 'readwrite');
  const store = tx.objectStore('recetas');

  if (recetaEditandoId !== null) {
    objReceta.id = recetaEditandoId;
    store.put(objReceta);
  } else {
    store.add(objReceta);
  }

  tx.oncomplete = () => {
    alert(`¡Receta "${objReceta.nombre}" guardada con éxito!`);
    resetearFormularioReceta();
    recargarRecetas();
  };
});

function recargarRecetas() {
  db.transaction(['recetas'], 'readonly').objectStore('recetas').getAll().onsuccess = (e) => {
    recetasCache = e.target.result || [];
    actualizarVistasRecetas();
    actualizarSelectoresGlobales();
  };
}

function actualizarVistasRecetas() {
  renderizarListaRecetasGuardadas();
}

window.eliminarReceta = function(id) {
  if (!confirm('¿Eliminar esta preparación?')) return;
  const tx = db.transaction(['recetas'], 'readwrite');
  tx.objectStore('recetas').delete(id);
  tx.oncomplete = () => recargarRecetas();
};

/* ============================================================
   SECCIÓN: METAS DIARIAS
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

document.getElementById('form-metas').addEventListener('submit', (e) => {
  e.preventDefault();
  metasActuales = {
    kcal: parseFloat(document.getElementById('meta-kcal').value) || 0,
    proteinas: parseFloat(document.getElementById('meta-prot').value) || 0,
    carbohidratos: parseFloat(document.getElementById('meta-carbs').value) || 0,
    grasas: parseFloat(document.getElementById('meta-grasas').value) || 0
  };

  const tx = db.transaction(['config'], 'readwrite');
  tx.objectStore('config').put({ clave: 'metas_diarias', valor: metasActuales });
  tx.oncomplete = () => {
    alert('Metas actualizadas.');
    cargarDiario();
  };
});

/* ============================================================
   SECCIÓN: DIARIO NUTRICIONAL
   ============================================================ */
document.getElementById('diario-fecha').addEventListener('change', (e) => {
  fechaSeleccionada = e.target.value;
  cargarDiario();
});

document.getElementById('btn-nueva-categoria').addEventListener('click', () => {
  const nom = prompt('Nombre de la nueva categoría (Ej: Merienda, Pre-entreno):');
  if (nom && !categoriasCache.includes(nom.trim())) {
    categoriasCache.push(nom.trim());
    const tx = db.transaction(['config'], 'readwrite');
    tx.objectStore('config').put({ clave: 'categorias', valor: categoriasCache });
    tx.oncomplete = () => cargarDiario();
  }
});

function cargarDiario() {
  if (!db) return;
  const tx = db.transaction(['diario'], 'readonly');
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
            <small>${item.kcal.toFixed(1)} kcal | P:${item.proteinas.toFixed(1)}g C:${item.carbohidratos.toFixed(1)}g G:${item.grasas.toFixed(1)}g</small>
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
            <strong style="color: var(--primary);">${catKcal.toFixed(0)} kcal</strong> • 
            <span>P: ${catProt.toFixed(1)}g</span> | 
            <span>C: ${catCarbs.toFixed(1)}g</span> | 
            <span>G: ${catGrasas.toFixed(1)}g</span>
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
  document.getElementById('modal-agregar-diario').classList.add('hidden');
  categoriaModalDiario = null;
};

const diarioBuscador = document.getElementById('diario-buscador');
if (diarioBuscador) {
  diarioBuscador.addEventListener('input', () => poblarSelectModalDiario(diarioBuscador.value.trim().toLowerCase()));
}

function poblarSelectModalDiario(filtro = '') {
  const sel = document.getElementById('diario-select-item');
  sel.innerHTML = '';

  const alis = alimentosCache.filter(a => a.nombre.toLowerCase().includes(filtro));
  alis.forEach(a => sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, `ali_${a.id}`)));

  const recs = recetasCache.filter(r => r.nombre.toLowerCase().includes(filtro));
  recs.forEach(r => sel.appendChild(new Option(`${r.nombre} [Receta] (${r.kcalPor100g.toFixed(1)} kcal/100g)`, `rec_${r.id}`)));
}

document.getElementById('btn-confirmar-agregar-diario').addEventListener('click', () => {
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

  const tx = db.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').add(entrada);
  tx.oncomplete = () => {
    cerrarModalDiario();
    cargarDiario();
  };
});

window.eliminarEntradaDiario = function(id) {
  const tx = db.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').delete(id);
  tx.oncomplete = () => cargarDiario();
};

/* ============================================================
   SECCIÓN: CHEF IA CON GEMINI + ESCALADO + GASTAR INGREDIENTE
   ============================================================ */
const selectAiObjetivo = document.getElementById('ai-objetivo-calorico');
const contAiKcalManual = document.getElementById('contenedor-ai-kcal-manual');

if (selectAiObjetivo) {
  selectAiObjetivo.addEventListener('change', () => {
    if (selectAiObjetivo.value === 'manual') {
      contAiKcalManual.classList.remove('hidden');
    } else {
      contAiKcalManual.classList.add('hidden');
    }
  });
}

document.getElementById('btn-generar-receta-ia').addEventListener('click', async () => {
  if (alimentosCache.length < 2) {
    alert('Debes tener al menos 2 o 3 alimentos guardados en tu catálogo para que la IA arme una preparación.');
    return;
  }

  const rest = window.restantesGlobales || { kcal: 0, proteinas: 0, carbohidratos: 0, grasas: 0 };
  let metaKcal = 0;

  if (selectAiObjetivo.value === 'manual') {
    metaKcal = parseFloat(document.getElementById('ai-kcal-manual').value) || 0;
    if (metaKcal <= 0) return alert('Ingresa un valor válido de Kcal manuales.');
  } else {
    metaKcal = rest.kcal;
    if (metaKcal <= 20) {
      return alert('Ya has alcanzado tus Kcal restantes del día. Cambia la opción a "Fijar Kcal manuales" para pedir una receta independiente.');
    }
  }

  const tipoComida = document.getElementById('ai-tipo-comida').value;
  const antojoExtra = document.getElementById('ai-antojo-extra').value.trim();

  // Modo Urgente
  let instruccionUrgente = '';
  if (document.getElementById('ai-check-urgente').checked) {
    const idUrg = parseInt(document.getElementById('ai-select-ingrediente-urgente').value, 10);
    const grUrg = parseFloat(document.getElementById('ai-gramos-urgente').value) || 0;
    const aliUrg = alimentosCache.find(a => a.id === idUrg);

    if (!aliUrg || grUrg <= 0) {
      return alert('Si activas el Modo Gastar Ingrediente, debes seleccionar el alimento y los gramos exactos a gastar.');
    }
    instruccionUrgente = `REQUISITO OBLIGATORIO Y PRIORITARIO: La receta DEBE incluir exactamente ${grUrg}g de "${aliUrg.nombre}" (id: ${aliUrg.id}). Cuadra el resto de las calorías con otros ingredientes de la despensa.`;
  }

  // Formatear catálogo disponible
  const despensaTexto = alimentosCache.map(a => 
    `{id: ${a.id}, nombre: "${a.nombre}", kcal100: ${a.kcal}, p100: ${a.proteinas}, c100: ${a.carbohidratos}, g100: ${a.grasas}}`
  ).join(',\n');

  const aiStatus = document.getElementById('ai-status');
  const aiBox = document.getElementById('ai-resultado-receta');
  aiStatus.textContent = 'El Chef Gemini está diseñando tu receta culinaria...';
  aiStatus.classList.remove('hidden');
  aiBox.classList.add('hidden');

  const promptSistema = `
Actúa como un Chef y Nutricionista deportivo de alta precisión.
Tu misión es diseñar una receta deliciosa, coherente y con verdadero sentido gastronómico usando EXCLUSIVAMENTE alimentos de esta despensa:
[
${despensaTexto}
]

REQUISITOS ESTRICTOS:
1. Objetivo calórico total de la receta: exactamente ${metaKcal.toFixed(0)} kcal (margen de tolerancia +- 15 kcal).
2. Perfil culinario solicitado: "${tipoComida}".
${instruccionUrgente ? `3. ${instruccionUrgente}` : ''}
${antojoExtra ? `4. Preferencias del usuario: "${antojoExtra}".` : ''}
5. NO uses ingredientes inventados que no estén en la despensa (puedes asumir agua, sal o especias secas comunes).
6. Calcula los gramos EXACTOS de cada ingrediente para sumar las Kcal objetivo.
7. Responde ÚNICAMENTE en formato JSON válido con la siguiente estructura, sin texto antes ni después:
{
  "nombre": "Nombre atractivo del plato",
  "descripcion": "Breve frase explicando la textura y sabor",
  "ingredientes": [
    { "alimentoId": id_del_alimento, "nombre": "nombre_exacto", "gramos": numero_gramos }
  ],
  "pasos": [
    "Paso 1...",
    "Paso 2...",
    "Paso 3..."
  ]
}
`;

  try {
    const resp = await fetch(WORKER_CHEF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptSistema }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      if (resp.status === 429) {
        throw new Error('Límite de solicitudes por minuto alcanzado. Espera 10-15 segundos y vuelve a presionar el botón.');
      }
      if (resp.status === 503) {
        throw new Error('Los servidores de Google están con alta demanda en este instante. Intenta nuevamente en unos segundos.');
      }
      const detalleError = data?.error?.message || `Código ${resp.status}`;
      throw new Error(`Aviso del Chef IA: ${detalleError}`);
    }

    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawJson) throw new Error('No se recibió contenido válido del Chef IA.');

    const recetaGenerada = JSON.parse(rawJson);

    // Guardar receta original base para el escalador
    recetaIABaseOriginal = recetaGenerada;
    factorEscalaActual = 1;

    renderizarRecetaIAEscalada(1);

    aiStatus.classList.add('hidden');
    aiBox.classList.remove('hidden');
    aiBox.scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    console.error(err);
    aiStatus.textContent = `❌ ${err.message}`;
  }
});

// Renderizado y escalado dinámico de porciones
function renderizarRecetaIAEscalada(factor) {
  if (!recetaIABaseOriginal) return;
  factorEscalaActual = factor;

  // Actualizar botones de escala activos
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
      infoPorcion.textContent = `⚖️ Peso total de la preparación: ${totPeso.toFixed(0)}g`;
    }
  }

  const ulIng = document.getElementById('ai-receta-ingredientes');
  ulIng.innerHTML = '';
  ingredientesEscalados.forEach(ing => {
    const li = document.createElement('li');
    li.innerHTML = `<span><strong>${ing.nombre}</strong></span> <span class="sug-gramos">${ing.gramos.toFixed(1)} g</span> <small>(${ing.kcalAporte.toFixed(0)} kcal)</small>`;
    ulIng.appendChild(li);
  });

  const olPasos = document.getElementById('ai-receta-pasos');
  olPasos.innerHTML = '';
  (recetaIABaseOriginal.pasos || []).forEach(paso => {
    const li = document.createElement('li');
    li.textContent = paso;
    olPasos.appendChild(li);
  });

  document.getElementById('ai-macros-totales').textContent = `Total: P: ${totProt.toFixed(1)}g | C: ${totCarbs.toFixed(1)}g | G: ${totGrasas.toFixed(1)}g`;
}

// Botones de escalador
document.querySelectorAll('.btn-scale').forEach(btn => {
  btn.addEventListener('click', () => {
    const s = parseFloat(btn.getAttribute('data-scale')) || 1;
    renderizarRecetaIAEscalada(s);
  });
});

document.getElementById('btn-guardar-receta-ia').addEventListener('click', () => {
  if (!recetaIAPendiente) return;

  const tx = db.transaction(['recetas'], 'readwrite');
  tx.objectStore('recetas').add(recetaIAPendiente);
  tx.oncomplete = () => {
    alert(`✓ ¡"${recetaIAPendiente.nombre}" se guardó en tus Recetas compuestas!`);
    recargarRecetas();
  };
});

/* ============================================================
   SECCIÓN: MODO COCINA (MANOS LIBRES CON VOZ)
   ============================================================ */
const modalCocina = document.getElementById('modal-modo-cocina');
const btnIniciarCocina = document.getElementById('btn-iniciar-modo-cocina');
const btnCerrarCocina = document.getElementById('btn-cerrar-cocina');
const btnCocinaAnt = document.getElementById('btn-cocina-anterior');
const btnCocinaSig = document.getElementById('btn-cocina-siguiente');
const btnVozPaso = document.getElementById('btn-voz-paso');

if (btnIniciarCocina) {
  btnIniciarCocina.addEventListener('click', () => {
    if (!recetaIABaseOriginal || !recetaIABaseOriginal.pasos || recetaIABaseOriginal.pasos.length === 0) {
      return alert('Genera una receta primero.');
    }
    pasoCocinaActual = 0;
    actualizarVistaModoCocina();
    modalCocina.classList.remove('hidden');
  });
}

if (btnCerrarCocina) {
  btnCerrarCocina.addEventListener('click', () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    modalCocina.classList.add('hidden');
  });
}

function actualizarVistaModoCocina() {
  const pasos = recetaIABaseOriginal.pasos || [];
  const tot = pasos.length;

  document.getElementById('cocina-receta-titulo').textContent = recetaIAPendiente.nombre;
  document.getElementById('cocina-paso-contador').textContent = `Paso ${pasoCocinaActual + 1} de ${tot}`;
  document.getElementById('cocina-paso-texto').textContent = pasos[pasoCocinaActual];

  // Resumen breve de ingredientes escalados
  const resIng = (recetaIAPendiente.ingredientes || []).map(i => `${i.nombre} (${i.gramos.toFixed(0)}g)`).join(' • ');
  document.getElementById('cocina-resumen-ingredientes').textContent = `Ingredientes listos: ${resIng}`;

  btnCocinaAnt.disabled = (pasoCocinaActual === 0);
  btnCocinaSig.textContent = (pasoCocinaActual === tot - 1) ? '✓ ¡Listo!' : 'Siguiente ➡';
}

if (btnCocinaAnt) {
  btnCocinaAnt.addEventListener('click', () => {
    if (pasoCocinaActual > 0) {
      pasoCocinaActual--;
      actualizarVistaModoCocina();
    }
  });
}

if (btnCocinaSig) {
  btnCocinaSig.addEventListener('click', () => {
    const pasos = recetaIABaseOriginal.pasos || [];
    if (pasoCocinaActual < pasos.length - 1) {
      pasoCocinaActual++;
      actualizarVistaModoCocina();
    } else {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      modalCocina.classList.add('hidden');
      alert('¡Buen provecho! Receta completada.');
    }
  });
}

// Asistente de voz del navegador
if (btnVozPaso) {
  btnVozPaso.addEventListener('click', () => {
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
}

/* ============================================================
   SECCIÓN: MEZCLADOR PERSONALIZADO
   ============================================================ */
const mezcladorFiltro = document.getElementById('mezclador-filtro');
if (mezcladorFiltro) {
  mezcladorFiltro.addEventListener('input', () => poblarSelectMezclador(mezcladorFiltro.value.trim().toLowerCase()));
}

function poblarSelectMezclador(filtro = '') {
  const sel = document.getElementById('mezclador-select-alimento');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Selecciona alimento para la mezcla --</option>';

  const alis = alimentosCache.filter(a => a.nombre.toLowerCase().includes(filtro));
  alis.forEach(a => sel.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g | P:${a.proteinas}g)`, a.id)));
}

const selectTipoObjetivo = document.getElementById('mezclador-tipo-objetivo');
const contKcalManual = document.getElementById('contenedor-kcal-manual');
if (selectTipoObjetivo) {
  selectTipoObjetivo.addEventListener('change', () => {
    if (selectTipoObjetivo.value === 'manual') {
      contKcalManual.classList.remove('hidden');
    } else {
      contKcalManual.classList.add('hidden');
    }
  });
}

document.getElementById('btn-agregar-alimento-mezcla').addEventListener('click', () => {
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
    lista.innerHTML = '<li style="color: var(--text-muted);">Ningún alimento seleccionado (elige al menos 2).</li>';
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

document.getElementById('btn-calcular-mezcla-personalizada').addEventListener('click', () => {
  const rest = window.restantesGlobales || { kcal: 0, proteinas: 0, carbohidratos: 0, grasas: 0 };
  const cont = document.getElementById('contenedor-sugerencias-personalizadas');
  cont.innerHTML = '';

  if (alimentosMezclador.length < 2) {
    cont.innerHTML = '<p style="color: var(--danger); font-weight: bold;">Debes seleccionar al menos 2 alimentos para crear la mezcla.</p>';
    return;
  }

  const tipoObj = document.getElementById('mezclador-tipo-objetivo').value;
  let totalKcal = 0;

  if (tipoObj === 'manual') {
    totalKcal = parseFloat(document.getElementById('mezclador-kcal-manual').value) || 0;
    if (totalKcal <= 0) {
      cont.innerHTML = '<p style="color: var(--danger); font-weight: bold;">Ingresa una cantidad válida de Kcal personalizadas mayor a 0.</p>';
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

  // ESTRATEGIA 1: Mayor Kcal Dominante
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
    titulo: 'Estrategia 1: Alimento con más Kcal Dominante',
    tipo: 'Mayor aporte del alimento más denso',
    desglose: items.map((it, idx) => `• <strong>${it.nombre}</strong>: <span class="sug-gramos">${pesosE1[idx]} g</span> (${((it.kcal * pesosE1[idx])/100).toFixed(0)} kcal)`).join('<br>'),
    totales: totE1
  });

  // ESTRATEGIA 2: Balance Parejo
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

  // ESTRATEGIA 3: Menor Kcal Dominante
  let pesosE3 = [];
  items.forEach(item => {
    const rank = ordenDesc.findIndex(x => x.id === item.id);
    const porcionKcal = totalKcal * ((rank + 1) / sumaPonderadores);
    const gr = Number(((porcionKcal / item.kcal) * 100).toFixed(1));
    pesosE3.push(gr);
  });
  const totE3 = calcularTotalesMezcla(pesosE3);

  estrategias.push({
    titulo: 'Estrategia 3: Alimento con menor Kcal Dominante (Mayor Volumen)',
    tipo: 'Mayor porción del alimento más ligero para saciedad',
    desglose: items.map((it, idx) => `• <strong>${it.nombre}</strong>: <span class="sug-gramos">${pesosE3[idx]} g</span> (${((it.kcal * pesosE3[idx])/100).toFixed(0)} kcal)`).join('<br>'),
    totales: totE3
  });

  // ESTRATEGIA 4: Cascada por Densidad
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
    titulo: 'Estrategia 4: Cascada por Densidad Decreciente',
    tipo: 'Ingrediente más denso en porción mínima; remanente al más ligero',
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
        Aporte total: <strong>${totalKcal.toFixed(0)} kcal</strong> | 
        <span class="${excesoP > 0 ? 'alerta-exceso' : ''}">P: ${est.totales.p.toFixed(1)}g</span> | 
        <span class="${excesoC > 0 ? 'alerta-exceso' : ''}">C: ${est.totales.c.toFixed(1)}g</span> | 
        <span class="${excesoG > 0 ? 'alerta-exceso' : ''}">G: ${est.totales.g.toFixed(1)}g</span>
      </div>
      ${alertas.length > 0 ? `<div style="font-size:0.75rem; margin-top:0.4rem;">Exceso frente al remanente del día: ${alertas.join(' | ')}</div>` : '<div style="font-size:0.75rem; color:var(--success); margin-top:0.4rem;">✓ Respeta tus límites diarios</div>'}
    `;
    cont.appendChild(card);
  });
});

/* ============================================================
   SECCIÓN: SUGERENCIAS AUTOMÁTICAS GLOBALES
   ============================================================ */
document.getElementById('btn-calcular-sugerencias').addEventListener('click', () => {
  const rest = window.restantesGlobales || { kcal: 0, proteinas: 0, carbohidratos: 0, grasas: 0 };
  const cont = document.getElementById('contenedor-sugerencias');
  cont.innerHTML = '';

  if (rest.kcal <= 0) {
    cont.innerHTML = '<p style="color:var(--text-muted)">Ya has alcanzado o superado tu meta de Kcal del día.</p>';
    return;
  }

  const modo = document.getElementById('sug-modo').value;
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
        descripcion: `Consumir exactamente: <span class="sug-gramos">${gReq.toFixed(1)} gramos</span>`,
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
      ${alertas.length > 0 ? `<div style="font-size:0.75rem; margin-top:0.4rem;">Exceso advertido: ${alertas.join(' | ')}</div>` : '<div style="font-size:0.75rem; color:var(--success); margin-top:0.4rem;">✓ Encaja perfectamente dentro de tus macros</div>'}
    `;
    cont.appendChild(card);
  });
});

/* ============================================================
   SECCIÓN: RESPALDO (EXPORTAR E IMPORTAR JSON)
   ============================================================ */
function generarObjetoRespaldo() {
  return new Promise((resolve, reject) => {
    if (!db) return reject('Base de datos no inicializada');
    const tx = db.transaction(['alimentos', 'recetas', 'diario', 'config'], 'readonly');
    const respaldo = {
      versionApp: 'CoffeeBreak_v8',
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

document.getElementById('btn-generar-texto-backup').addEventListener('click', async () => {
  try {
    const data = await generarObjetoRespaldo();
    const jsonStr = JSON.stringify(data, null, 2);
    const txtArea = document.getElementById('txt-backup-generado');
    const contenedor = document.getElementById('contenedor-texto-exportado');

    txtArea.value = jsonStr;
    contenedor.classList.remove('hidden');
    contenedor.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    alert('Error al leer los datos locales.');
  }
});

document.getElementById('btn-seleccionar-todo').addEventListener('click', () => {
  const txtArea = document.getElementById('txt-backup-generado');
  txtArea.focus();
  txtArea.select();
  txtArea.setSelectionRange(0, 999999);
  alert('Texto seleccionado. Mantén presionado y toca "Copiar" para guardarlo en Notas.');
});

document.getElementById('btn-descargar-archivo').addEventListener('click', async () => {
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
    alert('Usa la opción de "Ver y Copiar Texto de Respaldo".');
  }
});

function procesarEInsertarDatos(data) {
  if (!data || (!data.alimentos && !data.recetas && !data.diario)) {
    alert('El contenido no corresponde a un respaldo válido de Coffee Break.');
    return;
  }

  const tx = db.transaction(['alimentos', 'recetas', 'diario', 'config'], 'readwrite');

  if (Array.isArray(data.alimentos)) {
    const store = tx.objectStore('alimentos');
    data.alimentos.forEach(item => store.put(item));
  }
  if (Array.isArray(data.recetas)) {
    const store = tx.objectStore('recetas');
    data.recetas.forEach(item => store.put(item));
  }
  if (Array.isArray(data.diario)) {
    const store = tx.objectStore('diario');
    data.diario.forEach(item => store.put(item));
  }
  if (Array.isArray(data.config)) {
    const store = tx.objectStore('config');
    data.config.forEach(item => store.put(item));
  }

  tx.oncomplete = () => {
    alert('✓ ¡Datos restaurados con éxito!');
    cargarTodo();
  };

  tx.onerror = (e) => {
    console.error(e);
    alert('Hubo un error al escribir en la base de datos.');
  };
}

document.getElementById('btn-restaurar-texto').addEventListener('click', () => {
  const txt = document.getElementById('txt-importar-manual').value.trim();
  if (!txt) return alert('Pega el texto del respaldo primero.');

  try {
    const data = JSON.parse(txt);
    procesarEInsertarDatos(data);
    document.getElementById('txt-importar-manual').value = '';
  } catch (err) {
    console.error(err);
    alert('El texto pegado está dañado o no es un formato JSON válido.');
  }
});

document.getElementById('input-importar-backup').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      procesarEInsertarDatos(data);
      e.target.value = '';
    } catch (err) {
      console.error(err);
      alert('El archivo no contiene un JSON válido.');
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

// 5. ARRANQUE
window.addEventListener('DOMContentLoaded', () => {
  activarPestanas();
  initDB();
});