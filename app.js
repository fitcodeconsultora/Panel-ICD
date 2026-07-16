/* =========================================================
   FITCODE · Tablero de Indicadores — app.js
   ========================================================= */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const COLUMNS = ['mes','facturacion','metaFacturacion','activos','ventas','visitas','leads',
  'bajas','aRenovar','renovados','sueldos','gastos','impuestos','alquiler','inflacion','observaciones'];

let state = {
  user: null,        // { uid, nombre, rol, gymId }
  gyms: [],          // for admin: list of {id, nombre}
  currentGymId: null,
  monthlyData: [],   // raw docs for currentGymId, sorted by mes asc
  charts: {}
};

// ---------------------------------------------------------
// KPI CALCULATIONS — mismas fórmulas que Proyeccion_STARTUP.xlsx
// ---------------------------------------------------------

function safeDiv(a, b) {
  if (!b) return null;
  return a / b;
}

function calcKpis(rows) {
  // rows: array ordered by mes asc, each with raw fields.
  // returns same array with computed fields added.
  let prevActivos = null;
  let prevFacturacion = null;

  return rows.map(r => {
    const gastosTotal = (r.sueldos || 0) + (r.gastos || 0) + (r.impuestos || 0) + (r.alquiler || 0);
    const ticketPromedio = safeDiv(r.facturacion, r.activos);
    const pctMeta = safeDiv(r.facturacion, r.metaFacturacion);
    const icv = safeDiv(r.ventas, r.visitas);
    const pctRenovacion = safeDiv(r.renovados, r.aRenovar);
    const rotacion = safeDiv(r.bajas, prevActivos);
    const vidaMedia = rotacion ? safeDiv(1, rotacion) : null;
    const ltv = (ticketPromedio != null && vidaMedia != null) ? ticketPromedio * vidaMedia : null;
    const rentabilidad = r.facturacion ? 1 - safeDiv(gastosTotal, r.facturacion) : null;
    const utilidad = r.facturacion != null ? r.facturacion - gastosTotal : null;
    const variacionFacturacion = (prevFacturacion != null && prevFacturacion !== 0)
      ? safeDiv(r.facturacion - prevFacturacion, prevFacturacion) : null;
    const sueldosPct = safeDiv(r.sueldos, gastosTotal);
    const gastosPct = safeDiv(r.gastos, gastosTotal);
    const impuestosPct = safeDiv(r.impuestos, gastosTotal);
    const alquilerPct = safeDiv(r.alquiler, gastosTotal);

    const computed = {
      ...r,
      gastosTotal, ticketPromedio, pctMeta, icv, pctRenovacion, rotacion, vidaMedia, ltv,
      rentabilidad, utilidad, variacionFacturacion, sueldosPct, gastosPct, impuestosPct, alquilerPct
    };

    prevActivos = r.activos;
    prevFacturacion = r.facturacion;
    return computed;
  });
}

function statusFor(kpiKey, value) {
  // semáforo: reglas simples y razonables por default.
  // Julián puede después ajustar los umbrales por gimnasio si lo pedís.
  if (value == null || isNaN(value)) return '';
  switch (kpiKey) {
    case 'pctMeta':
      return value >= 1 ? 'good' : value >= 0.85 ? 'warn' : 'bad';
    case 'icv':
      return value >= 0.3 ? 'good' : value >= 0.15 ? 'warn' : 'bad';
    case 'pctRenovacion':
      return value >= 0.75 ? 'good' : value >= 0.6 ? 'warn' : 'bad';
    case 'rotacion':
      return value <= 0.05 ? 'good' : value <= 0.08 ? 'warn' : 'bad';
    case 'rentabilidad':
      return value >= 0.25 ? 'good' : value >= 0.1 ? 'warn' : 'bad';
    default:
      return '';
  }
}

function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + Math.round(v).toLocaleString('es-AR');
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(1) + '%';
}
function fmtNum(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(decimals);
}

// ---------------------------------------------------------
// AUTH
// ---------------------------------------------------------

document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!email || !pass) { errEl.textContent = 'Completá email y contraseña.'; return; }

  auth.signInWithEmailAndPassword(email, pass)
    .catch(err => {
      errEl.textContent = err.code === 'auth/invalid-credential'
        ? 'Email o contraseña incorrectos.'
        : 'No se pudo iniciar sesión (' + err.code + ').';
    });
}

document.getElementById('logoutBtn').addEventListener('click', () => auth.signOut());

auth.onAuthStateChanged(async (fbUser) => {
  if (!fbUser) {
    state.user = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('app').classList.remove('visible');
    return;
  }

  const userDoc = await db.collection('usuarios').doc(fbUser.uid).get();
  if (!userDoc.exists) {
    document.getElementById('loginError').textContent = 'Tu usuario no tiene un perfil asignado. Pedile a Julián que lo cree.';
    auth.signOut();
    return;
  }

  const data = userDoc.data();
  state.user = { uid: fbUser.uid, nombre: data.nombre || fbUser.email, rol: data.rol, gymId: data.gymId };

  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('userLabel').textContent = state.user.nombre + (state.user.rol === 'admin' ? ' · Admin' : '');

  await initForRole();
});

async function initForRole() {
  const gymSelectEl = document.getElementById('gymSelect');

  if (state.user.rol === 'admin') {
    const snap = await db.collection('gimnasios').get();
    state.gyms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    gymSelectEl.style.display = 'block';
    gymSelectEl.innerHTML = state.gyms
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      .map(g => `<option value="${g.id}">${g.nombre || g.id}</option>`).join('');
    gymSelectEl.onchange = () => loadGymData(gymSelectEl.value);
    state.currentGymId = state.gyms[0]?.id || null;
  } else {
    gymSelectEl.style.display = 'none';
    state.currentGymId = state.user.gymId;
  }

  if (state.currentGymId) {
    await loadGymData(state.currentGymId);
  } else {
    renderDashboard();
  }
}

// ---------------------------------------------------------
// DATA LOADING
// ---------------------------------------------------------

async function loadGymData(gymId) {
  state.currentGymId = gymId;
  const snap = await db.collection('gimnasios').doc(gymId).collection('datosMensuales')
    .orderBy('mes', 'asc').get();
  const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  state.monthlyData = calcKpis(raw);
  renderDashboard();
}

// ---------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// ---------------------------------------------------------
// DASHBOARD RENDER
// ---------------------------------------------------------

function renderDashboard() {
  const data = state.monthlyData;
  const emptyEl = document.getElementById('dashboardEmpty');
  const tableEl = document.getElementById('detailTable');

  if (!data.length) {
    emptyEl.style.display = 'block';
    tableEl.style.display = 'none';
    document.getElementById('kpiGrid').innerHTML = '';
    renderCharts([]);
    return;
  }
  emptyEl.style.display = 'none';
  tableEl.style.display = 'table';

  const last = data[data.length - 1];
  const cards = [
    { key: 'facturacion', label: 'Facturación', value: fmtMoney(last.facturacion), headline: true },
    { key: 'pctMeta', label: '% Meta', value: fmtPct(last.pctMeta), status: statusFor('pctMeta', last.pctMeta) },
    { key: 'icv', label: 'ICV', value: fmtPct(last.icv), status: statusFor('icv', last.icv) },
    { key: 'pctRenovacion', label: '% Renovación', value: fmtPct(last.pctRenovacion), status: statusFor('pctRenovacion', last.pctRenovacion) },
    { key: 'rotacion', label: 'Rotación', value: fmtPct(last.rotacion), status: statusFor('rotacion', last.rotacion) },
    { key: 'vidaMedia', label: 'Vida Media', value: fmtNum(last.vidaMedia), sub: 'meses' },
    { key: 'ltv', label: 'LTV', value: fmtMoney(last.ltv) },
    { key: 'rentabilidad', label: 'Rentabilidad', value: fmtPct(last.rentabilidad), status: statusFor('rentabilidad', last.rentabilidad) },
    { key: 'utilidad', label: 'Utilidad', value: fmtMoney(last.utilidad) },
    { key: 'ticketPromedio', label: 'Ticket Promedio', value: fmtMoney(last.ticketPromedio) },
  ];

  const statusText = { good: 'Bien', warn: 'Alerta', bad: 'Riesgo' };

  document.getElementById('kpiGrid').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.status ? 'status-' + c.status : ''} ${c.headline ? 'headline' : ''}">
      <div class="label">
        <span>${c.label}</span>
        ${c.status ? `<span class="badge ${c.status}">${statusText[c.status]}</span>` : ''}
      </div>
      <div class="kpi-value">${c.value}</div>
      ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
    </div>
  `).join('');

  const tbody = document.getElementById('detailTableBody');
  tbody.innerHTML = data.slice().reverse().map(r => `
    <tr>
      <td>${r.mes}</td>
      <td class="num">${fmtMoney(r.facturacion)}</td>
      <td class="num">${r.activos ?? '—'}</td>
      <td class="num">${fmtMoney(r.ticketPromedio)}</td>
      <td class="num">${fmtPct(r.pctMeta)}</td>
      <td class="num">${fmtPct(r.icv)}</td>
      <td class="num">${fmtPct(r.pctRenovacion)}</td>
      <td class="num">${fmtPct(r.rotacion)}</td>
      <td class="num">${fmtNum(r.vidaMedia)}</td>
      <td class="num">${fmtMoney(r.ltv)}</td>
      <td class="num">${fmtPct(r.rentabilidad)}</td>
      <td class="num">${fmtMoney(r.utilidad)}</td>
    </tr>
  `).join('');

  renderCharts(data);
}

function renderCharts(data) {
  const labels = data.map(r => r.mes);

  if (state.charts.fact) state.charts.fact.destroy();
  if (state.charts.ratios) state.charts.ratios.destroy();

  const ctxFact = document.getElementById('chartFacturacion').getContext('2d');
  state.charts.fact = new Chart(ctxFact, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Facturación', data: data.map(r => r.facturacion), backgroundColor: '#E4602E', order: 2 },
        { label: 'Meta', data: data.map(r => r.metaFacturacion), type: 'line', borderColor: '#16161A', borderDash: [5,4], pointRadius: 0, order: 1 }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
  });

  const ctxRatios = document.getElementById('chartRatios').getContext('2d');
  state.charts.ratios = new Chart(ctxRatios, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Rentabilidad', data: data.map(r => r.rentabilidad != null ? r.rentabilidad * 100 : null), borderColor: '#35A667', tension: .3 },
        { label: 'ICV', data: data.map(r => r.icv != null ? r.icv * 100 : null), borderColor: '#E4602E', tension: .3 },
        { label: '% Renovación', data: data.map(r => r.pctRenovacion != null ? r.pctRenovacion * 100 : null), borderColor: '#16161A', tension: .3 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { ticks: { callback: v => v + '%' } } }
    }
  });
}

// ---------------------------------------------------------
// MANUAL ENTRY
// ---------------------------------------------------------

document.getElementById('saveMonthBtn').addEventListener('click', saveMonth);
document.getElementById('clearFormBtn').addEventListener('click', clearForm);

function readForm() {
  const mes = document.getElementById('f_mes').value; // YYYY-MM
  if (!mes) { showToast('Elegí el mes.', true); return null; }
  const num = id => {
    const v = document.getElementById(id).value;
    return v === '' ? 0 : parseFloat(v);
  };
  return {
    mes,
    facturacion: num('f_facturacion'),
    metaFacturacion: num('f_metaFacturacion'),
    activos: num('f_activos'),
    ventas: num('f_ventas'),
    visitas: num('f_visitas'),
    leads: num('f_leads'),
    bajas: num('f_bajas'),
    aRenovar: num('f_aRenovar'),
    renovados: num('f_renovados'),
    sueldos: num('f_sueldos'),
    gastos: num('f_gastos'),
    impuestos: num('f_impuestos'),
    alquiler: num('f_alquiler'),
    inflacion: num('f_inflacion'),
    observaciones: document.getElementById('f_observaciones').value || ''
  };
}

async function saveMonth() {
  const record = readForm();
  if (!record) return;
  if (!state.currentGymId) { showToast('No hay gimnasio seleccionado.', true); return; }

  try {
    await db.collection('gimnasios').doc(state.currentGymId)
      .collection('datosMensuales').doc(record.mes).set(record, { merge: true });
    showToast('Mes guardado correctamente.');
    clearForm();
    await loadGymData(state.currentGymId);
  } catch (err) {
    showToast('Error al guardar: ' + err.message, true);
  }
}

function clearForm() {
  document.querySelectorAll('#view-carga input').forEach(i => i.value = '');
}

// ---------------------------------------------------------
// IMPORT CSV / XLSX
// ---------------------------------------------------------

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

function handleFile(file) {
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  if (isCsv) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: res => previewImport(res.data)
    });
  } else {
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
      previewImport(json);
    };
    reader.readAsArrayBuffer(file);
  }
}

let pendingImportRows = [];

function previewImport(rows) {
  const missingCols = COLUMNS.filter(c => c !== 'observaciones' && rows.length && !(c in rows[0]));
  const previewEl = document.getElementById('importPreview');

  if (missingCols.length) {
    previewEl.innerHTML = `<p class="error-msg">Faltan columnas: ${missingCols.join(', ')}. Revisá los encabezados del archivo.</p>`;
    pendingImportRows = [];
    return;
  }

  pendingImportRows = rows.map(r => ({
    mes: String(r.mes).trim(),
    facturacion: parseFloat(r.facturacion) || 0,
    metaFacturacion: parseFloat(r.metaFacturacion) || 0,
    activos: parseFloat(r.activos) || 0,
    ventas: parseFloat(r.ventas) || 0,
    visitas: parseFloat(r.visitas) || 0,
    leads: parseFloat(r.leads) || 0,
    bajas: parseFloat(r.bajas) || 0,
    aRenovar: parseFloat(r.aRenovar) || 0,
    renovados: parseFloat(r.renovados) || 0,
    sueldos: parseFloat(r.sueldos) || 0,
    gastos: parseFloat(r.gastos) || 0,
    impuestos: parseFloat(r.impuestos) || 0,
    alquiler: parseFloat(r.alquiler) || 0,
    inflacion: parseFloat(r.inflacion) || 0,
    observaciones: r.observaciones || ''
  })).filter(r => r.mes && r.mes !== 'undefined');

  previewEl.innerHTML = `
    <p class="hint">${pendingImportRows.length} mes(es) detectados. Revisá antes de confirmar:</p>
    <div class="table-scroll">
      <table>
        <thead><tr>${COLUMNS.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>
          ${pendingImportRows.map(r => `<tr>${COLUMNS.map(c => `<td>${r[c]}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn" id="confirmImportBtn" style="margin-top:16px;">Confirmar e importar</button>
  `;

  document.getElementById('confirmImportBtn').addEventListener('click', confirmImport);
}

async function confirmImport() {
  if (!pendingImportRows.length) return;
  if (!state.currentGymId) { showToast('No hay gimnasio seleccionado.', true); return; }

  try {
    const batch = db.batch();
    pendingImportRows.forEach(r => {
      const ref = db.collection('gimnasios').doc(state.currentGymId)
        .collection('datosMensuales').doc(r.mes);
      batch.set(ref, r, { merge: true });
    });
    await batch.commit();
    showToast(`${pendingImportRows.length} mes(es) importados.`);
    document.getElementById('importPreview').innerHTML = '';
    pendingImportRows = [];
    fileInput.value = '';
    await loadGymData(state.currentGymId);
  } catch (err) {
    showToast('Error al importar: ' + err.message, true);
  }
}

document.getElementById('downloadTemplateBtn').addEventListener('click', () => {
  const header = COLUMNS.join(',');
  const example = '2026-01,1500000,1400000,380,25,90,300,15,280,230,400000,150000,80000,200000,3,"Mes de ejemplo"';
  const csv = header + '\n' + example + '\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'plantilla_fitcode_kpi.csv';
  a.click();
});

// ---------------------------------------------------------
// TOAST
// ---------------------------------------------------------

let toastTimer = null;
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}
