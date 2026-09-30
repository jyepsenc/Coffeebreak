// Base de Datos IndexedDB - Coffee Break Food Metrics
const DB_NAME = 'NutriAppDB';
const DB_VERSION = 2;

let db = null;
let alimentosCache = [];
let recetasCache = [];
let categoriasCache = ['Desayuno', 'Almuerzo', 'Once/Cena', 'Snacks'];
let metasActuales = { kcal: 2000, proteinas: 140, carbohidratos: 200, grasas: 65 };
let fechaSeleccionada = new Date().toISOString().split('T')[0];
let recetaBorrador = [];

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
  };

  tx.objectStore('recetas').getAll().onsuccess = (e) => {
    recetasCache = e.target.result || [];
    actualizarVistasRecetas();
  };

  tx.oncomplete = () => cargarDiario();
}

/* ============================================================
   SECCIÓN: OCR ROBUSTO Y NORMALIZACIÓN DE MACROS
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
          alert('Se requiere conexión a internet la primera vez para descargar el diccionario OCR.');
          return;
        }

        try {
          ocrStatus.textContent = 'Optimizando resolución y contraste...';
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

          ocrStatus.textContent = '✓ Lectura lista. Comprueba los campos en el formulario antes de guardar:';
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
        if (n >= 100 && n <= 999) {
          n = n / 10;
        }
      } else if (tipo === 'macro_comun') {
        if (n >= 100 && n <= 999) {
          n = n / 100;
        } else if (n > 50 && n < 100) {
          n = n / 10;
        }
      }
      return n;
    }).filter(n => n !== null);
  };

  const valores = {
    kcal: null,
    proteinas: null,
    carbohidratos: null,
    grasas: null,
    azucares: null,
    fibra: null,
    sat: null,
    mono: null,
    poli: null,
    trans: null,
    sodio: null,
    colesterol: null
  };

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const lLow = l.toLowerCase();

    if ((lLow.includes('energ') || lLow.includes('kcal') || lLow.includes('calor')) && valores.kcal === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.kcal = nums.find(n => n >= 15) || nums[0];
    }
    else if ((lLow.includes('prot') || lLow.includes('prat')) && valores.proteinas === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.proteinas = nums[0];
    }
    else if ((lLow.includes('carb') || lLow.includes('h. de c') || lLow.includes('hidratos') || lLow.includes('disponibles')) && valores.carbohidratos === null) {
      const nums = extraerNumerosConCoherencia(l, 'carbos');
      if (nums.length > 0) valores.carbohidratos = nums[0];
    }
    else if ((lLow.includes('grasa total') || lLow.includes('grasas totales') || lLow.includes('lipidos') || lLow.includes('lípidos') || (lLow.includes('grasa') && !lLow.includes('sat') && !lLow.includes('mono') && !lLow.includes('trans'))) && valores.grasas === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.grasas = nums[0];
    }
    else if (lLow.includes('azuc') || lLow.includes('azúc')) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0 && valores.azucares === null) valores.azucares = nums[0];
    }
    else if (lLow.includes('fibra')) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0 && valores.fibra === null) valores.fibra = nums[0];
    }
    else if (lLow.includes('saturad') && valores.sat === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.sat = nums[0];
    }
    else if (lLow.includes('monoinsat') && valores.mono === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.mono = nums[0];
    }
    else if (lLow.includes('trans') && valores.trans === null) {
      const nums = extraerNumerosConCoherencia(l, 'macro_comun');
      if (nums.length > 0) valores.trans = nums[0];
    }
    else if (lLow.includes('sodio') && valores.sodio === null) {
      const nums = extraerNumerosConCoherencia(l, 'kcal');
      if (nums.length > 0) valores.sodio = nums[0];
    }
    else if ((lLow.includes('colest') || lLow.includes('cholest')) && valores.colesterol === null) {
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
  const select = document.getElementById('select-alimento');
  const selectReceta = document.getElementById('receta-select-alimento');
  const lista = document.getElementById('lista-alimentos');

  if (select) select.innerHTML = '<option value="">-- Elige un elemento --</option>';
  if (selectReceta) selectReceta.innerHTML = '<option value="">-- Elige un alimento base --</option>';
  if (lista) lista.innerHTML = '';

  if (select && alimentosCache.length > 0) {
    const grupoAlimentos = document.createElement('optgroup');
    grupoAlimentos.label = 'Alimentos Individuales';
    alimentosCache.forEach(a => {
      grupoAlimentos.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, `ali_${a.id}`));
    });
    select.appendChild(grupoAlimentos);
  }

  if (selectReceta) {
    alimentosCache.forEach(a => {
      selectReceta.appendChild(new Option(`${a.nombre} (${a.kcal} kcal/100g)`, a.id));
    });
  }

  if (lista) {
    alimentosCache.forEach(a => {
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

  if (select && recetasCache.length > 0) {
    const grupoRecetas = document.createElement('optgroup');
    grupoRecetas.label = 'Recetas Compuestas';
    recetasCache.forEach(r => {
      grupoRecetas.appendChild(new Option(`${r.nombre} [Receta] (${r.kcalPor100g.toFixed(1)} kcal/100g)`, `rec_${r.id}`));
    });
    select.appendChild(grupoRecetas);
  }
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
  };
}

window.eliminarAlimento = function(id) {
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
   SECCIÓN: RECETAS COMPUESTAS
   ============================================================ */
document.getElementById('btn-agregar-ingrediente').addEventListener('click', () => {
  const aliId = parseInt(document.getElementById('receta-select-alimento').value, 10);
  const gramos = parseFloat(document.getElementById('receta-gramos-ingrediente').value) || 0;

  if (!aliId || gramos <= 0) return;

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

document.getElementById('btn-guardar-receta').addEventListener('click', () => {
  const nombre = document.getElementById('receta-nombre').value.trim();
  if (!nombre || recetaBorrador.length === 0) {
    alert('Ingresa un nombre y al menos un ingrediente.');
    return;
  }

  let totKcal = 0, totProt = 0, totCarbs = 0, totGrasas = 0, totPeso = 0;
  recetaBorrador.forEach(ing => {
    const ali = alimentosCache.find(a => a.id === ing.alimentoId);
    const f = ing.gramos / 100;
    totKcal += ali.kcal * f;
    totProt += ali.proteinas * f;
    totCarbs += ali.carbohidratos * f;
    totGrasas += ali.grasas * f;
    totPeso += ing.gramos;
  });

  const nuevaReceta = {
    nombre: nombre,
    ingredientes: [...recetaBorrador],
    pesoTotal: totPeso,
    kcalTotal: totKcal,
    kcalPor100g: (totKcal / totPeso) * 100,
    protPor100g: (totProt / totPeso) * 100,
    carbsPor100g: (totCarbs / totPeso) * 100,
    grasasPor100g: (totGrasas / totPeso) * 100
  };

  const tx = db.transaction(['recetas'], 'readwrite');
  tx.objectStore('recetas').add(nuevaReceta);
  tx.oncomplete = () => {
    recetaBorrador = [];
    document.getElementById('receta-nombre').value = '';
    actualizarVistaBorradorReceta();
    recargarRecetas();
  };
});

function recargarRecetas() {
  db.transaction(['recetas'], 'readonly').objectStore('recetas').getAll().onsuccess = (e) => {
    recetasCache = e.target.result || [];
    actualizarVistasRecetas();
    actualizarVistasAlimentos();
  };
}

function actualizarVistasRecetas() {
  const lista = document.getElementById('lista-recetas');
  if (!lista) return;
  lista.innerHTML = '';
  recetasCache.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${r.nombre}</strong><br>
        <small style="color: var(--text-muted);">${r.kcalPor100g.toFixed(1)} kcal/100g (Total: ${r.pesoTotal}g - ${r.kcalTotal.toFixed(0)} kcal)</small>
      </div>
      <button class="btn-del" onclick="eliminarReceta(${r.id})">Borrar</button>
    `;
    lista.appendChild(li);
  });
}

window.eliminarReceta = function(id) {
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
   SECCIÓN: DIARIO CON TOTALES DE KCAL Y MACROS POR CATEGORÍA
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
    let catKcal = 0;
    let catProt = 0;
    let catCarbs = 0;
    let catGrasas = 0;

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
        <button class="btn-secondary" onclick="abrirAgregarComida('${cat}')">+ Agregar</button>
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
  if (kRest < 0) {
    elemKcalRest.classList.add('alerta-exceso');
  } else {
    elemKcalRest.classList.remove('alerta-exceso');
  }

  const setMacro = (idCol, idRest, idSub, rest, cons, meta) => {
    const rElem = document.getElementById(idRest);
    const sElem = document.getElementById(idSub);

    rElem.textContent = `${rest.toFixed(1)}g`;
    sElem.textContent = `${cons.toFixed(1)} / ${meta}g`;

    if (rest < 0) {
      rElem.classList.add('alerta-exceso');
    } else {
      rElem.classList.remove('alerta-exceso');
    }
  };

  setMacro('col-prot', 'dash-prot-restante', 'dash-prot-sub', pRest, pCons, metasActuales.proteinas);
  setMacro('col-carbs', 'dash-carbs-restante', 'dash-carbs-sub', cRest, cCons, metasActuales.carbohidratos);
  setMacro('col-grasas', 'dash-grasas-restante', 'dash-grasas-sub', gRest, gCons, metasActuales.grasas);

  window.restantesGlobales = { kcal: kRest, proteinas: pRest, carbohidratos: cRest, grasas: gRest };
}

window.abrirAgregarComida = function(cat) {
  const origen = prompt(`¿Agregar a ${cat}?\nEscribe el número:\n1. Alimento guardado\n2. Receta`);
  if (!origen) return;

  if (origen === '1') {
    if (alimentosCache.length === 0) return alert('No hay alimentos guardados. Ve a la pestaña Alimentos.');
    let listado = alimentosCache.map((a, i) => `${i + 1}. ${a.nombre}`).join('\n');
    let sel = prompt(`Selecciona el número del alimento:\n${listado}`);
    let idx = parseInt(sel, 10) - 1;
    if (alimentosCache[idx]) {
      let g = parseFloat(prompt(`Gramos consumidos de ${alimentosCache[idx].nombre}:`));
      if (g > 0) guardarEnDiario(cat, alimentosCache[idx], g, false);
    }
  } else if (origen === '2') {
    if (recetasCache.length === 0) return alert('No hay recetas guardadas. Ve a la pestaña Recetas.');
    let listado = recetasCache.map((r, i) => `${i + 1}. ${r.nombre}`).join('\n');
    let sel = prompt(`Selecciona el número de la receta:\n${listado}`);
    let idx = parseInt(sel, 10) - 1;
    if (recetasCache[idx]) {
      let g = parseFloat(prompt(`Gramos consumidos de ${recetasCache[idx].nombre}:`));
      if (g > 0) guardarEnDiario(cat, recetasCache[idx], g, true);
    }
  }
};

function guardarEnDiario(categoria, item, gramos, esReceta) {
  const f = gramos / 100;
  const entrada = {
    fecha: fechaSeleccionada,
    categoria: categoria,
    nombre: item.nombre,
    gramos: gramos,
    kcal: (esReceta ? item.kcalPor100g : item.kcal) * f,
    proteinas: (esReceta ? item.protPor100g : item.proteinas) * f,
    carbohidratos: (esReceta ? item.carbsPor100g : item.carbohidratos) * f,
    grasas: (esReceta ? item.grasasPor100g : item.grasas) * f
  };

  const tx = db.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').add(entrada);
  tx.oncomplete = () => cargarDiario();
}

window.eliminarEntradaDiario = function(id) {
  const tx = db.transaction(['diario'], 'readwrite');
  tx.objectStore('diario').delete(id);
  tx.oncomplete = () => cargarDiario();
};

/* ============================================================
   SECCIÓN: SUGERENCIAS INTELIGENTES
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
              tipo: `Combinación habitual (De receta: ${rec.nombre})`,
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
   SECCIÓN: EXPORTAR E IMPORTAR RESPALDO (100% LIBRE DE BLOQUEOS)
   ============================================================ */
function generarObjetoRespaldo() {
  return new Promise((resolve, reject) => {
    if (!db) return reject('Base de datos no inicializada');
    const tx = db.transaction(['alimentos', 'recetas', 'diario', 'config'], 'readonly');
    const respaldo = {
      versionApp: 'CoffeeBreak_v2',
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

// 1. Mostrar texto de respaldo en pantalla para copiar fácilmente
document.getElementById('btn-generar-texto-backup').addEventListener('click', async () => {
  try {
    const data = await generarObjetoRespaldo();
    const jsonStr = JSON.stringify(data, null, 2);
    const txtArea = document.getElementById('txt-backup-generado');
    const contenedor = document.getElementById('contenedor-texto-exportado');

    txtArea.value = jsonStr;
    contenedor.classList.remove('hidden');

    // Desplazar suavemente hasta el texto generado
    contenedor.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    alert('Error al leer los datos locales.');
  }
});

// Botón para seleccionar todo el texto de una vez
document.getElementById('btn-seleccionar-todo').addEventListener('click', () => {
  const txtArea = document.getElementById('txt-backup-generado');
  txtArea.focus();
  txtArea.select();
  txtArea.setSelectionRange(0, 999999);
  alert('Texto seleccionado. Mantén presionado y toca "Copiar" para guardarlo en la app Notas.');
});

// 2. Descargar como archivo sin trabar Safari
document.getElementById('btn-descargar-archivo').addEventListener('click', async () => {
  try {
    const data = await generarObjetoRespaldo();
    const jsonStr = JSON.stringify(data, null, 2);
    const fileName = `coffeebreak_backup_${new Date().toISOString().split('T')[0]}.json`;

    // data: URI en lugar de blob: para evitar que Safari abra pantalla negra
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

// Lógica de inserción sin confirmaciones bloqueantes
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

// 3. Restaurar pegando texto (El método más fiable en iOS)
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

// 4. Restaurar desde archivo .json
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

// 4. ARRANQUE
window.addEventListener('DOMContentLoaded', () => {
  activarPestanas();
  initDB();
});