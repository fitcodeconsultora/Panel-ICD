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
  charts: {},
  comercial: {
    anio: null,
    mes: null,          // 1-12
    diaria: {},         // { 'YYYY-MM-DD': {averiguadores, ...} }
    mensual: null,      // { inversion, ticketProm }
    saveTimer: null
  }
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
    const snap = await db.collection('clientes').get();
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
  try {
    const snap = await db.collection('clientes').doc(gymId).collection('datosMensuales')
      .orderBy('mes', 'asc').get();
    const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.monthlyData = calcKpis(raw);
    renderDashboard();
    if (document.getElementById('view-comercial').classList.contains('active')) {
      refreshComercial();
    }
  } catch (err) {
    showToast('No se pudieron cargar los datos: ' + err.message, true);
    state.monthlyData = [];
    renderDashboard();
  }
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
    if (btn.dataset.view === 'comercial' && state.currentGymId) refreshComercial();
  });
});

document.querySelectorAll('#comercialTabs .pill-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#comercialTabs .pill-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ctab-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('ctab-' + btn.dataset.ctab).classList.add('active');
    if (btn.dataset.ctab === 'dash') renderComercialDashboard();
  });
});

document.querySelectorAll('#operacionesTabs .pill-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#operacionesTabs .pill-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.otab-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('otab-' + btn.dataset.otab).classList.add('active');
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
    document.getElementById('avgControls').style.display = 'none';
    document.getElementById('prevMonthCard').style.display = 'none';
    document.getElementById('dashMonthBar').style.display = 'none';
    document.getElementById('f_cargarExistente').innerHTML = '<option value="">— Nuevo mes —</option>';
    renderCharts([]);
    return;
  }
  emptyEl.style.display = 'none';
  tableEl.style.display = 'table';

  setupDashMonthSelect(data);

  renderDetailTableBody(data);

  renderCharts(data);
  setupAvgControls(data);
  renderPrevMonthSummary();
  renderExistingMonthsDropdown(data);
}

function setupAvgControls(data) {
  const controls = document.getElementById('avgControls');
  if (!data.length) { controls.style.display = 'none'; return; }
  controls.style.display = 'flex';

  const desdeSel = document.getElementById('avg_desde');
  const hastaSel = document.getElementById('avg_hasta');
  const meses = data.map(r => r.mes); // ya viene ordenado asc

  const optsHtml = meses.map(m => `<option value="${m}">${m}</option>`).join('');
  const alreadyBuilt = desdeSel.dataset.built === meses.join(',');
  if (!alreadyBuilt) {
    desdeSel.innerHTML = optsHtml;
    hastaSel.innerHTML = optsHtml;
    desdeSel.value = meses[0];
    hastaSel.value = meses[meses.length - 1];
    desdeSel.dataset.built = meses.join(',');
    hastaSel.dataset.built = meses.join(',');
    desdeSel.onchange = () => renderAverageRow(data);
    hastaSel.onchange = () => renderAverageRow(data);
  }

  renderAverageRow(data);
}

function renderAverageRow(data) {
  const desde = document.getElementById('avg_desde').value;
  const hasta = document.getElementById('avg_hasta').value;
  const foot = document.getElementById('detailTableFoot');

  let lo = desde, hi = hasta;
  if (lo > hi) { [lo, hi] = [hi, lo]; }

  const enRango = data.filter(r => r.mes >= lo && r.mes <= hi);
  renderDetailTableBody(enRango);
  if (!enRango.length) { foot.innerHTML = ''; return; }

  const avg = (key) => {
    const vals = enRango.map(r => r[key]).filter(v => v != null && !isNaN(v));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  foot.innerHTML = `
    <tr class="avg-row">
      <td>Promedio</td>
      <td class="num">${fmtMoney(avg('facturacion'))}</td>
      <td class="num">${avg('activos') != null ? Math.round(avg('activos')) : '—'}</td>
      <td class="num">${fmtMoney(avg('ticketPromedio'))}</td>
      <td class="num">${fmtPct(avg('pctMeta'))}</td>
      <td class="num">${fmtPct(avg('icv'))}</td>
      <td class="num">${fmtPct(avg('pctRenovacion'))}</td>
      <td class="num">${fmtPct(avg('rotacion'))}</td>
      <td class="num">${fmtNum(avg('vidaMedia'))}</td>
      <td class="num">${fmtMoney(avg('ltv'))}</td>
      <td class="num">${fmtPct(avg('rentabilidad'))}</td>
      <td class="num">${fmtMoney(avg('utilidad'))}</td>
    </tr>
  `;
}

function renderDetailTableBody(rows) {
  const tbody = document.getElementById('detailTableBody');
  tbody.innerHTML = rows.slice().reverse().map(r => `
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
}

function setupDashMonthSelect(data) {
  const bar = document.getElementById('dashMonthBar');
  const sel = document.getElementById('dash_mesSelect');
  bar.style.display = 'flex';

  const sorted = data.slice().reverse(); // más reciente primero
  const prevValue = sel.value;
  sel.innerHTML = sorted.map((r, i) => `<option value="${r.mes}">${r.mes}${i === 0 ? ' (último)' : ''}</option>`).join('');

  const stillExists = sorted.some(r => r.mes === prevValue);
  sel.value = stillExists ? prevValue : sorted[0].mes;

  sel.onchange = () => {
    const record = data.find(r => r.mes === sel.value);
    if (record) renderKpiCards(record);
  };

  renderKpiCards(data.find(r => r.mes === sel.value) || sorted[0]);
}

function renderKpiCards(record) {
  const cards = [
    { key: 'facturacion', label: 'Facturación', value: fmtMoney(record.facturacion), headline: true },
    { key: 'pctMeta', label: '% Meta', value: fmtPct(record.pctMeta), status: statusFor('pctMeta', record.pctMeta) },
    { key: 'icv', label: 'ICV', value: fmtPct(record.icv), status: statusFor('icv', record.icv) },
    { key: 'pctRenovacion', label: '% Renovación', value: fmtPct(record.pctRenovacion), status: statusFor('pctRenovacion', record.pctRenovacion) },
    { key: 'rotacion', label: 'Rotación', value: fmtPct(record.rotacion), status: statusFor('rotacion', record.rotacion) },
    { key: 'vidaMedia', label: 'Vida Media', value: fmtNum(record.vidaMedia), sub: 'meses' },
    { key: 'ltv', label: 'LTV', value: fmtMoney(record.ltv) },
    { key: 'rentabilidad', label: 'Rentabilidad', value: fmtPct(record.rentabilidad), status: statusFor('rentabilidad', record.rentabilidad) },
    { key: 'utilidad', label: 'Utilidad', value: fmtMoney(record.utilidad) },
    { key: 'ticketPromedio', label: 'Ticket Promedio', value: fmtMoney(record.ticketPromedio) },
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
}

function renderCharts(data) {
  const labels = data.map(r => r.mes);

  if (state.charts.fact) state.charts.fact.destroy();
  if (state.charts.icv) state.charts.icv.destroy();
  if (state.charts.rentabilidad) state.charts.rentabilidad.destroy();

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

  const ctxICV = document.getElementById('chartICV').getContext('2d');
  state.charts.icv = new Chart(ctxICV, {
    type: 'line',
    data: {
      labels,
      datasets: [
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

  const ctxRent = document.getElementById('chartRentabilidad').getContext('2d');
  state.charts.rentabilidad = new Chart(ctxRent, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Rentabilidad', data: data.map(r => r.rentabilidad != null ? r.rentabilidad * 100 : null), borderColor: '#35A667', tension: .3, fill: true, backgroundColor: 'rgba(53,166,103,.12)' }
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

function initFormMesAnio() {
  const mesSel = document.getElementById('f_mesNombre');
  mesSel.innerHTML = MESES_NOMBRES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');

  const anioSel = document.getElementById('f_anio');
  const now = new Date();
  const years = [];
  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) years.push(y);
  anioSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');

  resetFormMesAnioToNow();

  mesSel.addEventListener('change', renderPrevMonthSummary);
  anioSel.addEventListener('change', renderPrevMonthSummary);
}

function resetFormMesAnioToNow() {
  const now = new Date();
  document.getElementById('f_mesNombre').value = now.getMonth() + 1;
  document.getElementById('f_anio').value = now.getFullYear();
}

function renderExistingMonthsDropdown(data) {
  const sel = document.getElementById('f_cargarExistente');
  const prevValue = sel.value;

  const sorted = data.slice().reverse(); // más reciente primero
  sel.innerHTML = '<option value="">— Nuevo mes —</option>' +
    sorted.map(r => `<option value="${r.mes}">${r.mes}</option>`).join('');

  // Mantener la selección si el mes sigue existiendo
  if (sorted.some(r => r.mes === prevValue)) sel.value = prevValue;
}

document.getElementById('f_cargarExistente').addEventListener('change', (e) => {
  const mes = e.target.value;
  if (!mes) { clearForm(); resetFormMesAnioToNow(); renderPrevMonthSummary(); return; }

  const record = state.monthlyData.find(r => r.mes === mes);
  if (!record) return;

  const [anio, mesNum] = mes.split('-');
  document.getElementById('f_mesNombre').value = parseInt(mesNum);
  document.getElementById('f_anio').value = parseInt(anio);

  const setVal = (id, v) => { document.getElementById(id).value = (v ?? '') === 0 ? 0 : (v || ''); };
  setVal('f_facturacion', record.facturacion);
  setVal('f_metaFacturacion', record.metaFacturacion);
  setVal('f_activos', record.activos);
  setVal('f_ventas', record.ventas);
  setVal('f_visitas', record.visitas);
  setVal('f_leads', record.leads);
  setVal('f_bajas', record.bajas);
  setVal('f_aRenovar', record.aRenovar);
  setVal('f_renovados', record.renovados);
  setVal('f_sueldos', record.sueldos);
  setVal('f_gastos', record.gastos);
  setVal('f_impuestos', record.impuestos);
  setVal('f_alquiler', record.alquiler);
  setVal('f_inflacion', record.inflacion);
  document.getElementById('f_observaciones').value = record.observaciones || '';

  renderPrevMonthSummary();
  showToast(`Editando ${mes} — los cambios reemplazan ese mes al guardar.`);
});

function renderPrevMonthSummary() {
  const card = document.getElementById('prevMonthCard');
  const mesNum = parseInt(document.getElementById('f_mesNombre').value);
  const anio = parseInt(document.getElementById('f_anio').value);
  if (!mesNum || !anio) { card.style.display = 'none'; return; }

  // Calcular el mes anterior al seleccionado en el formulario
  let prevMes = mesNum - 1;
  let prevAnio = anio;
  if (prevMes < 1) { prevMes = 12; prevAnio = anio - 1; }
  const prevMesId = `${prevAnio}-${String(prevMes).padStart(2, '0')}`;

  const prevData = state.monthlyData.find(r => r.mes === prevMesId);
  if (!prevData) { card.style.display = 'none'; return; }

  document.getElementById('prevMonthLabel').textContent = `${MESES_NOMBRES[prevMes - 1]} ${prevAnio}`;

  const rows = [
    { label: 'Facturación', value: fmtMoney(prevData.facturacion) },
    { label: 'Activos', value: prevData.activos ?? '—' },
    { label: 'Ventas', value: prevData.ventas ?? '—' },
    { label: 'Visitas', value: prevData.visitas ?? '—' },
    { label: 'Leads', value: prevData.leads ?? '—' },
    { label: 'Bajas', value: prevData.bajas ?? '—' },
    { label: 'Renovados / A renovar', value: `${prevData.renovados ?? '—'} / ${prevData.aRenovar ?? '—'}` },
    { label: 'ICV', value: fmtPct(prevData.icv) },
    { label: 'Rentabilidad', value: fmtPct(prevData.rentabilidad) },
    { label: 'Utilidad', value: fmtMoney(prevData.utilidad) },
  ];

  document.getElementById('prevMonthGrid').innerHTML = rows.map(r => `
    <div class="metric-row"><span>${r.label}</span><strong>${r.value}</strong></div>
  `).join('');

  card.style.display = 'block';
}

function readForm() {
  const mesNum = document.getElementById('f_mesNombre').value;
  const anio = document.getElementById('f_anio').value;
  if (!mesNum || !anio) { showToast('Elegí el mes y el año.', true); return null; }
  const mes = `${anio}-${String(mesNum).padStart(2, '0')}`; // YYYY-MM
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
    await db.collection('clientes').doc(state.currentGymId)
      .collection('datosMensuales').doc(record.mes).set(record, { merge: true });
    showToast('Mes guardado correctamente.');
    clearForm();
    await loadGymData(state.currentGymId);
  } catch (err) {
    showToast('Error al guardar: ' + err.message, true);
  }
}

function clearForm() {
  document.querySelectorAll('#otab-carga input[type="number"], #otab-carga input[type="text"]').forEach(i => i.value = '');
  document.getElementById('f_cargarExistente').value = '';
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
      const ref = db.collection('clientes').doc(state.currentGymId)
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

// ---------------------------------------------------------
// COMERCIAL — embudo diario, resumen mensual, dashboard
// ---------------------------------------------------------

const MESES_NOMBRES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const COMERCIAL_DAILY_FIELDS = ['averiguadores','averigAgendados','agendadosClase','asistenciaInvitacion','visitas','ventasVisita','ventasAveriguador'];

function initComercialPeriod() {
  const now = new Date();
  state.comercial.anio = now.getFullYear();
  state.comercial.mes = now.getMonth() + 1;

  const mesSel = document.getElementById('com_mes');
  mesSel.innerHTML = MESES_NOMBRES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
  mesSel.value = state.comercial.mes;

  const anioSel = document.getElementById('com_anio');
  const years = [];
  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) years.push(y);
  anioSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  anioSel.value = state.comercial.anio;

  mesSel.addEventListener('change', () => { state.comercial.mes = parseInt(mesSel.value); refreshComercial(); });
  anioSel.addEventListener('change', () => { state.comercial.anio = parseInt(anioSel.value); refreshComercial(); });
}

function comercialMesId() {
  return `${state.comercial.anio}-${String(state.comercial.mes).padStart(2, '0')}`;
}

function daysInSelectedMonth() {
  return new Date(state.comercial.anio, state.comercial.mes, 0).getDate();
}

async function refreshComercial() {
  if (!state.currentGymId) return;
  const mesId = comercialMesId();
  const daysCount = daysInSelectedMonth();

  try {
    // Cargar días del mes
    const diarioSnap = await db.collection('clientes').doc(state.currentGymId)
      .collection('comercialDiario')
      .where(firebase.firestore.FieldPath.documentId(), '>=', `${mesId}-01`)
      .where(firebase.firestore.FieldPath.documentId(), '<=', `${mesId}-31`)
      .get();

    state.comercial.diaria = {};
    diarioSnap.docs.forEach(d => { state.comercial.diaria[d.id] = d.data(); });

    // Cargar resumen mensual (inversión / ticket)
    const mensualDoc = await db.collection('clientes').doc(state.currentGymId)
      .collection('comercialMensual').doc(mesId).get();
    state.comercial.mensual = mensualDoc.exists ? mensualDoc.data() : { inversion: 0, ticketProm: 0 };

    document.getElementById('com_inversion').value = state.comercial.mensual.inversion || '';
    document.getElementById('com_ticketProm').value = state.comercial.mensual.ticketProm || '';

    renderDiariaTable(daysCount, mesId);
    renderResumenMensual();

    if (document.getElementById('ctab-dash').classList.contains('active')) {
      renderComercialDashboard();
    }
  } catch (err) {
    showToast('No se pudo cargar Comercial: ' + err.message, true);
    // Igual renderizamos la tabla vacía para que se vea la grilla del mes
    renderDiariaTable(daysCount, mesId);
  }
}

function ventasTotalesDia(d) {
  return (d?.ventasVisita || 0) + (d?.ventasAveriguador || 0);
}
function efectividadDia(d) {
  const total = ventasTotalesDia(d);
  return d?.averiguadores ? total / d.averiguadores : null;
}
function efectividadVisitaDia(d) {
  return d?.visitas ? (d.ventasVisita || 0) / d.visitas : null;
}

function renderDiariaTable(daysCount, mesId) {
  document.getElementById('diariaTitle').textContent = `${MESES_NOMBRES[state.comercial.mes - 1]} ${state.comercial.anio}`;

  const todayStr = new Date().toISOString().slice(0, 10);
  let rows = '';
  for (let day = 1; day <= daysCount; day++) {
    const dateId = `${mesId}-${String(day).padStart(2, '0')}`;
    const d = state.comercial.diaria[dateId] || {};
    const isToday = dateId === todayStr;
    const ventasTot = ventasTotalesDia(d);
    const efect = efectividadDia(d);
    const efectVisita = efectividadVisitaDia(d);

    rows += `<tr class="${isToday ? 'today-row' : ''}" data-date="${dateId}">
      <td>${day}</td>
      ${COMERCIAL_DAILY_FIELDS.map(f => `<td class="num"><input class="diaria-input" type="number" min="0" data-field="${f}" data-date="${dateId}" value="${d[f] != null ? d[f] : ''}"></td>`).join('')}
      <td class="computed">${ventasTot || 0}</td>
      <td class="computed">${efect != null ? (efect * 100).toFixed(0) + '%' : '—'}</td>
      <td class="computed">${efectVisita != null ? (efectVisita * 100).toFixed(0) + '%' : '—'}</td>
    </tr>`;
  }
  document.getElementById('diariaTableBody').innerHTML = rows;

  document.querySelectorAll('#diariaTableBody .diaria-input').forEach(inp => {
    inp.addEventListener('input', onDiariaInputChange);
  });

  renderDiariaTotalsRow();
}

function renderDiariaTotalsRow() {
  const t = comercialTotalesMes();
  const efectVisitaMes = t.visitas ? t.ventasVisita / t.visitas : null;
  const foot = document.getElementById('diariaTableFoot');
  foot.innerHTML = `
    <tr class="avg-row">
      <td>Total</td>
      <td class="num">${t.averiguadores}</td>
      <td class="num">${t.averigAgendados}</td>
      <td class="num">${t.agendadosClase}</td>
      <td class="num">${t.asistenciaInvitacion}</td>
      <td class="num">${t.visitas}</td>
      <td class="num">${t.ventasVisita}</td>
      <td class="num">${t.ventasAveriguador}</td>
      <td class="num">${t.ventasTotales}</td>
      <td class="num">${t.efectividad != null ? (t.efectividad * 100).toFixed(0) + '%' : '—'}</td>
      <td class="num">${efectVisitaMes != null ? (efectVisitaMes * 100).toFixed(0) + '%' : '—'}</td>
    </tr>
  `;
}

function onDiariaInputChange(e) {
  const dateId = e.target.dataset.date;
  const field = e.target.dataset.field;
  const value = e.target.value === '' ? 0 : parseFloat(e.target.value);

  if (!state.comercial.diaria[dateId]) state.comercial.diaria[dateId] = {};
  state.comercial.diaria[dateId][field] = value;

  // recompute the row's computed cells live
  const row = e.target.closest('tr');
  const d = state.comercial.diaria[dateId];
  const ventasTot = ventasTotalesDia(d);
  const efect = efectividadDia(d);
  const efectVisita = efectividadVisitaDia(d);
  const cells = row.querySelectorAll('td.computed');
  cells[0].textContent = ventasTot || 0;
  cells[1].textContent = efect != null ? (efect * 100).toFixed(0) + '%' : '—';
  cells[2].textContent = efectVisita != null ? (efectVisita * 100).toFixed(0) + '%' : '—';

  renderDiariaTotalsRow();

  document.getElementById('diariaSaveStatus').textContent = 'Guardando…';
  clearTimeout(state.comercial.saveTimer);
  state.comercial.saveTimer = setTimeout(() => saveDiariaRow(dateId), 700);
}

async function saveDiariaRow(dateId) {
  if (!state.currentGymId) return;
  try {
    await db.collection('clientes').doc(state.currentGymId)
      .collection('comercialDiario').doc(dateId)
      .set(state.comercial.diaria[dateId], { merge: true });
    document.getElementById('diariaSaveStatus').textContent = 'Guardado ✓';
  } catch (err) {
    document.getElementById('diariaSaveStatus').textContent = 'Error al guardar';
    showToast('Error al guardar día: ' + err.message, true);
  }
}

function comercialTotalesMes() {
  const totals = { averiguadores: 0, averigAgendados: 0, agendadosClase: 0, asistenciaInvitacion: 0, visitas: 0, ventasVisita: 0, ventasAveriguador: 0 };
  Object.values(state.comercial.diaria).forEach(d => {
    COMERCIAL_DAILY_FIELDS.forEach(f => { totals[f] += d[f] || 0; });
  });
  totals.ventasTotales = totals.ventasVisita + totals.ventasAveriguador;
  totals.agendados = totals.averigAgendados + totals.agendadosClase;
  totals.asistieron = totals.asistenciaInvitacion;
  totals.efectividad = totals.averiguadores ? totals.ventasTotales / totals.averiguadores : null;
  return totals;
}

document.getElementById('saveComercialMensualBtn').addEventListener('click', saveComercialMensual);

async function saveComercialMensual() {
  if (!state.currentGymId) { showToast('No hay gimnasio seleccionado.', true); return; }
  const inversion = parseFloat(document.getElementById('com_inversion').value) || 0;
  const ticketProm = parseFloat(document.getElementById('com_ticketProm').value) || 0;
  state.comercial.mensual = { inversion, ticketProm };

  try {
    await db.collection('clientes').doc(state.currentGymId)
      .collection('comercialMensual').doc(comercialMesId())
      .set({ inversion, ticketProm }, { merge: true });
    showToast('Resumen mensual guardado.');
    renderResumenMensual();
  } catch (err) {
    showToast('Error al guardar: ' + err.message, true);
  }
}

function renderResumenMensual() {
  const totals = comercialTotalesMes();
  const { inversion = 0, ticketProm = 0 } = state.comercial.mensual || {};

  const costoLead = totals.averiguadores ? inversion / totals.averiguadores : null;
  const cac = totals.ventasTotales ? inversion / totals.ventasTotales : null;
  const facturacionEstimada = totals.ventasTotales * ticketProm;
  const roi = inversion ? (facturacionEstimada - inversion) / inversion : null;

  document.getElementById('m_costoLead').textContent = fmtMoney(costoLead);
  document.getElementById('m_cac').textContent = fmtMoney(cac);
  document.getElementById('m_facturacionEstimada').textContent = fmtMoney(facturacionEstimada);
  document.getElementById('m_roi').textContent = roi != null ? fmtPct(roi) : '—';

  renderFunnelChart(totals);
}

function renderFunnelChart(totals) {
  if (state.charts.funnel) state.charts.funnel.destroy();
  const ctx = document.getElementById('chartFunnelMes').getContext('2d');
  const labels = ['Averiguadores', 'Agendados', 'Asistieron', 'Visitas', 'Ventas'];
  const data = [totals.averiguadores, totals.agendados, totals.asistieron, totals.visitas, totals.ventasTotales];

  state.charts.funnel = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: '#E4602E', borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } }
    }
  });
}

function renderComercialDashboard() {
  const totals = comercialTotalesMes();
  const { inversion = 0, ticketProm = 0 } = state.comercial.mensual || {};
  const cac = totals.ventasTotales ? inversion / totals.ventasTotales : null;
  const facturacionEstimada = totals.ventasTotales * ticketProm;
  const roi = inversion ? (facturacionEstimada - inversion) / inversion : null;

  const cards = [
    { label: 'Averiguadores (mes)', value: totals.averiguadores || 0, headline: true },
    { label: 'Ventas Totales', value: totals.ventasTotales || 0 },
    { label: 'Efectividad', value: totals.efectividad != null ? fmtPct(totals.efectividad) : '—' },
    { label: 'CAC', value: fmtMoney(cac) },
    { label: 'ROI del mes', value: roi != null ? fmtPct(roi) : '—' },
  ];

  document.getElementById('comercialKpiGrid').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.headline ? 'headline' : ''}">
      <div class="label"><span>${c.label}</span></div>
      <div class="kpi-value">${c.value}</div>
    </div>
  `).join('');

  const daysCount = daysInSelectedMonth();
  const mesId = comercialMesId();
  const labels = [];
  const ventasSerie = [];
  const efectSerie = [];
  for (let day = 1; day <= daysCount; day++) {
    const dateId = `${mesId}-${String(day).padStart(2, '0')}`;
    const d = state.comercial.diaria[dateId] || {};
    labels.push(day);
    ventasSerie.push(ventasTotalesDia(d));
    const e = efectividadDia(d);
    efectSerie.push(e != null ? e * 100 : null);
  }

  if (state.charts.comercialEvo) state.charts.comercialEvo.destroy();
  const ctx = document.getElementById('chartComercialEvolucion').getContext('2d');
  state.charts.comercialEvo = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Ventas totales', data: ventasSerie, backgroundColor: '#E4602E', yAxisID: 'y' },
        { type: 'line', label: 'Efectividad %', data: efectSerie, borderColor: '#16161A', tension: .3, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        y: { beginAtZero: true, position: 'left' },
        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } }
      }
    }
  });
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

initComercialPeriod();
initFormMesAnio();
