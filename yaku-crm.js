// yaku-crm.js — JS del CRM de empresas. Cargado con <script defer> desde
// yaku-crm.html: orden y ejecución post-parseo garantizados por el navegador.

var API_URL = 'https://fukari-backend-production.up.railway.app';
var ADMIN_EMAIL = 'renebiagioni@yakuagua.com.ar';
var ADMIN_EMAILS = [ADMIN_EMAIL, 'info@wearebilab.com'];
var INTEGRATOR_EMAIL = 'bautx23@gmail.com';
var BOT_ALLOWED_EMAILS = [...ADMIN_EMAILS, INTEGRATOR_EMAIL];
var _currentUserEmail = '';
var SUPABASE_URL = 'https://bqjbblgbwgwqkziqzdyy.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxamJibGdid2d3cWt6aXF6ZHl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2Mjg4MTAsImV4cCI6MjA4ODIwNDgxMH0.DLXFYR4EgaejMbk3wBlU9SSVCi17YJ2aPiJc2h4y5mE';
var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

var allLeads = [];
var _debounceTimer = null;
var _openPopoverId = null;

// WhatsApp state
var waConversaciones = [];
var waConvActual = null;
var waMensajes = [];
var _waPollingInterval = null;
var _waSearchTimer = null;

// ── Auth ──
sb.auth.getSession().then(function(result) {
  var session = result.data.session;
  if (!session) { window.location.href = '/index.html'; return; }
  var email = session.user.email;
  _currentUserEmail = email;
  if (!ADMIN_EMAILS.includes(email) && email !== INTEGRATOR_EMAIL) { window.location.href = '/hub.html'; return; }
  document.body.classList.add('ready');
  var d = new Date();
  document.getElementById('topbar-fecha').textContent = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  // Mostrar sección Configuración a usuarios autorizados
  if (BOT_ALLOWED_EMAILS.indexOf(email) !== -1) {
    document.getElementById('sidebar-config').style.display = '';
  }
  // Botones de admin (exportar/integrar) solo para INTEGRATOR_EMAIL
  if (email === INTEGRATOR_EMAIL) {
    document.getElementById('bot-actions-admin').style.display = '';
  }
  cargarLeads();
  cargarConversacionesWA();
  _waPollingInterval = setInterval(pollWhatsApp, 10000);
});

async function logout() { await sb.auth.signOut(); window.location.href = '/index.html'; }

// ── Sidebar ──
function switchView(view) {
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  document.querySelectorAll('.sidebar-link').forEach(function(l) { l.classList.remove('active'); });
  document.getElementById('view-' + view).classList.add('active');
  document.getElementById('nav-' + view).classList.add('active');
  if (window.innerWidth <= 900) toggleSidebar();
  if (view === 'whatsapp') cargarConversacionesWA();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

// ════════════════════════════════════════════════════════════════════
// EMPRESAS (existing code preserved exactly)
// ════════════════════════════════════════════════════════════════════

async function cargarLeads() {
  try {
    var res = await fetch(API_URL + '/api/leads');
    if (!res.ok) throw new Error('Error ' + res.status);
    allLeads = await res.json();
    actualizarMetricas();
    renderTabla();
  } catch (err) {
    document.getElementById('tabla-contenido').innerHTML = '<div class="empty-state"><div class="icon">&#9888;</div><h3>Error al cargar leads</h3><p>' + err.message + '</p></div>';
  }
}

function actualizarMetricas() {
  document.getElementById('s-total').textContent = allLeads.length;
  document.getElementById('s-nuevo').textContent = allLeads.filter(function(l) { return l.estado === 'nuevo'; }).length;
  document.getElementById('s-contactado').textContent = allLeads.filter(function(l) { return l.estado === 'contactado'; }).length;
  document.getElementById('s-negociacion').textContent = allLeads.filter(function(l) { return l.estado === 'en negociacion'; }).length;
  document.getElementById('s-ganado').textContent = allLeads.filter(function(l) { return l.estado === 'ganado'; }).length;
}

document.getElementById('filtro-estado').addEventListener('change', renderTabla);
document.getElementById('filtro-buscar').addEventListener('input', function() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(renderTabla, 300);
});

function limpiarFiltros() {
  document.getElementById('filtro-estado').value = '';
  document.getElementById('filtro-buscar').value = '';
  renderTabla();
}

function getFiltered() {
  var estado = document.getElementById('filtro-estado').value;
  var buscar = document.getElementById('filtro-buscar').value.toLowerCase().trim();
  return allLeads.filter(function(l) {
    if (estado && l.estado !== estado) return false;
    if (buscar) {
      var hay = (l.empresa || '').toLowerCase().indexOf(buscar) !== -1 ||
                (l.contacto_nombre || '').toLowerCase().indexOf(buscar) !== -1 ||
                (l.contacto_email || '').toLowerCase().indexOf(buscar) !== -1;
      if (!hay) return false;
    }
    return true;
  });
}

var ESTADOS = [
  { value: 'nuevo', label: 'Nuevo', cls: 'badge-nuevo', dot: 'dot-nuevo' },
  { value: 'contactado', label: 'Contactado', cls: 'badge-contactado', dot: 'dot-contactado' },
  { value: 'en negociacion', label: 'En negociación', cls: 'badge-negociacion', dot: 'dot-negociacion' },
  { value: 'ganado', label: 'Ganado', cls: 'badge-ganado', dot: 'dot-ganado' },
  { value: 'perdido', label: 'Perdido', cls: 'badge-perdido', dot: 'dot-perdido' }
];

function estadoInfo(val) { return ESTADOS.find(function(e) { return e.value === val; }) || { value: val, label: val, cls: 'badge-nuevo', dot: 'dot-nuevo' }; }
function formatFecha(iso) { if (!iso) return '—'; var d = new Date(iso); return d.getDate() + ' ' + d.toLocaleDateString('es-AR', { month: 'short' }).replace('.', ''); }
var DESAFIOS = { '1': 'Agua purificada certificada', '2': 'Optimizar tiempos muertos', '3': 'Agua térmica (frío/calor)', '4': 'Reemplazo bidones', '5': 'Otro' };

function renderTabla() {
  var leads = getFiltered();
  if (leads.length === 0) { document.getElementById('tabla-contenido').innerHTML = '<div class="empty-state"><div class="icon">&#128203;</div><h3>No hay leads</h3><p>Cuando lleguen solicitudes desde la landing, aparecerán acá.</p></div>'; return; }
  var html = '<table><thead><tr><th>Empresa</th><th>Contacto</th><th>Tel / Email</th><th>Empleados</th><th>Desafío</th><th>Ingreso</th><th>Estado</th><th></th></tr></thead><tbody>';
  leads.forEach(function(l) {
    var ei = estadoInfo(l.estado);
    var desafioText = DESAFIOS[l.desafio] || l.desafio || '—';
    var popoverHtml = '<div class="status-popover" id="pop-' + l.id + '">';
    ESTADOS.forEach(function(e) { var isCurrent = e.value === l.estado ? ' current' : ''; popoverHtml += '<div class="status-option' + isCurrent + '" onclick="cambiarEstado(event,\'' + l.id + '\',\'' + e.value + '\')"><span class="opt-badge ' + e.dot + '"></span><span class="opt-label">' + e.label + '</span><span class="opt-check">&#10003;</span></div>'; });
    popoverHtml += '</div>';
    var nLlamadas = Array.isArray(l.llamadas) ? l.llamadas.length : 0;
    var llamadasHint = nLlamadas > 0 ? ' <span title="Informes de llamada" style="color:#2563eb;font-size:10px;font-weight:700;margin-left:4px;">📞 ' + nLlamadas + '</span>' : '';
    html += '<tr><td class="empresa-name">' + esc(l.empresa) + llamadasHint + '</td><td>' + esc(l.contacto_nombre) + (l.cargo ? '<div class="contacto-cargo">' + esc(l.cargo) + '</div>' : '') + '</td><td class="contacto-detail">' + esc(l.contacto_telefono) + '<br>' + esc(l.contacto_email) + '</td><td>' + esc(l.cantidad_empleados || '—') + '</td><td class="desafio-cell" title="' + esc(desafioText) + '">' + esc(desafioText) + '</td><td class="fecha-cell">' + formatFecha(l.created_at) + '</td><td class="status-cell"><span class="badge ' + ei.cls + '" id="badge-' + l.id + '" onclick="togglePopover(event,\'' + l.id + '\')">' + esc(ei.label) + '</span>' + popoverHtml + '</td><td style="white-space:nowrap;"><button class="btn-ver" onclick=\'abrirPanel(' + JSON.stringify(l).replace(/'/g, '&#39;') + ')\'>Ver</button><button class="btn-trash" title="Eliminar lead" onclick="eliminarLead(\'' + l.id + '\')">🗑</button></td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('tabla-contenido').innerHTML = html;
}

function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function togglePopover(e, id) {
  e.stopPropagation(); closeAllPopovers();
  var badge = document.getElementById('badge-' + id); var pop = document.getElementById('pop-' + id);
  if (pop && badge) { var rect = badge.getBoundingClientRect(); pop.style.top = (rect.bottom + 6) + 'px'; pop.style.left = rect.left + 'px'; pop.classList.add('open'); _openPopoverId = id;
    requestAnimationFrame(function() { var popRect = pop.getBoundingClientRect(); if (popRect.right > window.innerWidth - 10) pop.style.left = (window.innerWidth - popRect.width - 10) + 'px'; if (popRect.bottom > window.innerHeight - 10) pop.style.top = (rect.top - popRect.height - 6) + 'px'; });
  }
}
function closeAllPopovers() { document.querySelectorAll('.status-popover.open').forEach(function(p) { p.classList.remove('open'); }); _openPopoverId = null; }
document.addEventListener('click', function(e) { if (!e.target.closest('.status-cell')) closeAllPopovers(); });

async function cambiarEstado(e, id, nuevoEstado) {
  e.stopPropagation(); closeAllPopovers();
  var badgeEl = document.getElementById('badge-' + id);
  if (badgeEl) { var newInfo = estadoInfo(nuevoEstado); badgeEl.className = 'badge ' + newInfo.cls; badgeEl.textContent = newInfo.label; }
  try { var res = await fetch(API_URL + '/api/leads/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: nuevoEstado }) }); if (!res.ok) throw new Error('Error'); var updated = await res.json(); for (var i = 0; i < allLeads.length; i++) { if (allLeads[i].id === id) { allLeads[i] = updated; break; } } actualizarMetricas(); renderTabla(); } catch (err) { alert('Error al cambiar estado'); renderTabla(); }
}

// Los estados del pipeline (excluye "perdido", que es terminal fuera del flujo)
var PIPELINE = ['nuevo', 'contactado', 'en negociacion', 'ganado'];
var PIPELINE_LABELS = { 'nuevo': 'Nuevo', 'contactado': 'Contactado', 'en negociacion': 'En negociación', 'ganado': 'Ganado' };

var _panelLeadId = null; // id del lead abierto en el panel

function abrirPanel(lead) {
  _panelLeadId = lead.id;
  renderPanel(lead);
  document.getElementById('overlay').classList.add('open');
  document.getElementById('side-panel').classList.add('open');
}

function renderPanel(lead) {
  var ei = estadoInfo(lead.estado);
  var desafioText = DESAFIOS[lead.desafio] || lead.desafio || '—';

  // ── Pipeline visual ──
  var isLost = lead.estado === 'perdido';
  var currentIdx = PIPELINE.indexOf(lead.estado);
  var pipeHtml = '<div class="pipeline">';
  PIPELINE.forEach(function(s, i) {
    var klass = 'pipe-step';
    if (!isLost) {
      if (i < currentIdx) klass += ' done';
      else if (i === currentIdx) klass += ' current';
    }
    pipeHtml += '<div class="' + klass + '" onclick="cambiarEstadoPanel(\'' + lead.id + '\',\'' + s + '\')">';
    pipeHtml += '<div class="pipe-dot">' + (i+1) + '</div>';
    pipeHtml += '<div class="pipe-label">' + PIPELINE_LABELS[s] + '</div>';
    pipeHtml += '</div>';
  });
  pipeHtml += '</div>';

  var prevEstado = currentIdx > 0 ? PIPELINE[currentIdx - 1] : null;
  var nextEstado = (currentIdx >= 0 && currentIdx < PIPELINE.length - 1) ? PIPELINE[currentIdx + 1] : null;
  var canAvanzar = !isLost && !!nextEstado;
  var canRetroceder = !isLost && !!prevEstado;

  var pipelineActions =
    '<div class="pipeline-actions">' +
      '<button class="btn-pipe" ' + (canRetroceder ? '' : 'disabled') + ' onclick="cambiarEstadoPanel(\'' + lead.id + '\',\'' + (prevEstado || '') + '\')">← Atrás' + (prevEstado ? ' · ' + PIPELINE_LABELS[prevEstado] : '') + '</button>' +
      '<button class="btn-pipe" ' + (canAvanzar ? '' : 'disabled') + ' onclick="cambiarEstadoPanel(\'' + lead.id + '\',\'' + (nextEstado || '') + '\')"' + (canAvanzar ? ' style="border-color:#2563eb;color:#2563eb;font-weight:700;"' : '') + '>Avanzar' + (nextEstado ? ' · ' + PIPELINE_LABELS[nextEstado] : '') + ' →</button>' +
    '</div>' +
    '<div style="margin-top:8px;">' +
      (isLost
        ? '<button class="btn-pipe" style="width:100%;" onclick="cambiarEstadoPanel(\'' + lead.id + '\',\'nuevo\')">↺ Reabrir lead (Nuevo)</button>'
        : '<button class="btn-pipe btn-pipe-lost" style="width:100%;" onclick="cambiarEstadoPanel(\'' + lead.id + '\',\'perdido\')">✕ Marcar como perdido</button>'
      ) +
    '</div>';

  // ── Llamadas ──
  var llamadas = Array.isArray(lead.llamadas) ? lead.llamadas : [];
  var callsHtml = '';
  if (llamadas.length === 0) {
    callsHtml = '<div class="call-empty">Sin informes aún. Cuando René llame, dejá acá qué pasó.</div>';
  } else {
    callsHtml = '<div class="calls-list">';
    llamadas.forEach(function(c) {
      var fecha = c.fecha ? new Date(c.fecha).toLocaleString('es-AR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
      callsHtml += '<div class="call-item">' +
        '<div class="call-meta"><span class="call-autor">' + esc(c.autor || 'Sin autor') + '</span><span>' + esc(fecha) + ' <button class="btn-trash-sm" title="Eliminar informe" onclick="eliminarLlamada(\'' + lead.id + '\',\'' + esc(c.id || '') + '\')">🗑</button></span></div>' +
        '<div class="call-text">' + esc(c.comentario || '') + '</div>' +
      '</div>';
    });
    callsHtml += '</div>';
  }

  var html = '' +
    '<div class="panel-section-title">Estado del lead</div>' +
    '<div class="panel-field"><div class="pf-value"><span class="badge ' + ei.cls + '">' + esc(ei.label) + '</span></div></div>' +
    pipeHtml + pipelineActions +

    '<div class="panel-section-title">Datos</div>' +
    '<div class="panel-field"><div class="pf-label">Empresa</div><div class="pf-value">' + esc(lead.empresa) + '</div></div>' +
    '<div class="panel-field"><div class="pf-label">Contacto</div><div class="pf-value">' + esc(lead.contacto_nombre) + '</div></div>' +
    '<div class="panel-field"><div class="pf-label">Email</div><div class="pf-value">' + esc(lead.contacto_email) + '</div></div>' +
    '<div class="panel-field"><div class="pf-label">Teléfono</div><div class="pf-value">' + esc(lead.contacto_telefono) + '</div></div>' +
    (lead.cargo ? '<div class="panel-field"><div class="pf-label">Cargo</div><div class="pf-value">' + esc(lead.cargo) + '</div></div>' : '') +
    (lead.cantidad_empleados ? '<div class="panel-field"><div class="pf-label">Empleados</div><div class="pf-value">' + esc(lead.cantidad_empleados) + '</div></div>' : '') +
    '<div class="panel-field"><div class="pf-label">Desafío</div><div class="pf-value">' + esc(desafioText) + '</div></div>' +
    '<div class="panel-field"><div class="pf-label">Ingreso</div><div class="pf-value">' + (lead.created_at ? new Date(lead.created_at).toLocaleString('es-AR') : '—') + '</div></div>' +

    '<div class="panel-section-title">Informe de llamadas</div>' +
    callsHtml +
    '<div class="call-add-row"><textarea id="panel-nueva-llamada" placeholder="Ej: Llamé a Juan. Confirmó interés, quedamos en enviar cotización mañana."></textarea></div>' +
    '<button class="btn-call-add" id="btn-agregar-llamada" onclick="agregarLlamada(\'' + lead.id + '\')">+ Registrar llamada</button>' +

    '<div class="panel-section-title">Notas generales</div>' +
    '<div class="panel-field"><textarea id="panel-notas">' + esc(lead.notas || '') + '</textarea></div>' +
    '<button class="btn-save" onclick="guardarNotas(\'' + lead.id + '\')">Guardar notas</button>';

  document.getElementById('panel-body').innerHTML = html;
}

function cerrarPanel() {
  _panelLeadId = null;
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('side-panel').classList.remove('open');
}

function refrescarLeadEnPanel(updated) {
  for (var i = 0; i < allLeads.length; i++) {
    if (allLeads[i].id === updated.id) { allLeads[i] = updated; break; }
  }
  actualizarMetricas();
  renderTabla();
  if (_panelLeadId === updated.id) renderPanel(updated);
}

async function cambiarEstadoPanel(id, nuevoEstado) {
  if (!nuevoEstado) return;
  try {
    var res = await fetch(API_URL + '/api/leads/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: nuevoEstado }) });
    if (!res.ok) throw new Error('Error');
    var updated = await res.json();
    refrescarLeadEnPanel(updated);
  } catch (err) {
    alert('Error al cambiar estado');
  }
}

async function agregarLlamada(id) {
  var txt = document.getElementById('panel-nueva-llamada');
  var comentario = (txt.value || '').trim();
  if (!comentario) { alert('Escribí qué pasó en la llamada antes de guardar'); return; }
  var btn = document.getElementById('btn-agregar-llamada');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    var res = await fetch(API_URL + '/api/leads/' + id + '/llamadas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comentario: comentario, autor: _currentUserEmail || null })
    });
    if (!res.ok) { var j = await res.json().catch(function(){return{};}); throw new Error(j.error || 'Error'); }
    var updated = await res.json();
    refrescarLeadEnPanel(updated);
  } catch (err) {
    alert('No se pudo registrar: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '+ Registrar llamada';
  }
}

async function eliminarLlamada(leadId, llamadaId) {
  if (!llamadaId) return;
  if (!confirm('¿Eliminar este informe de llamada?')) return;
  try {
    var res = await fetch(API_URL + '/api/leads/' + leadId + '/llamadas/' + encodeURIComponent(llamadaId), { method: 'DELETE' });
    if (!res.ok) throw new Error('Error');
    var updated = await res.json();
    refrescarLeadEnPanel(updated);
  } catch (err) {
    alert('No se pudo eliminar');
  }
}

async function eliminarLead(id) {
  var lead = allLeads.find(function(l) { return l.id === id; });
  var nombre = lead ? lead.empresa : 'este lead';
  if (!confirm('¿Eliminar el lead de "' + nombre + '"?\n\nEsta acción es irreversible y borra también sus informes de llamada.')) return;
  try {
    var res = await fetch(API_URL + '/api/leads/' + id, { method: 'DELETE' });
    if (!res.ok) { var j = await res.json().catch(function(){return{};}); throw new Error(j.error || 'Error'); }
    allLeads = allLeads.filter(function(l) { return l.id !== id; });
    if (_panelLeadId === id) cerrarPanel();
    actualizarMetricas();
    renderTabla();
  } catch (err) {
    alert('No se pudo eliminar: ' + err.message);
  }
}

async function guardarNotas(id) {
  var notas = document.getElementById('panel-notas').value;
  try {
    var res = await fetch(API_URL + '/api/leads/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notas: notas }) });
    if (!res.ok) throw new Error('Error');
    var updated = await res.json();
    for (var i = 0; i < allLeads.length; i++) { if (allLeads[i].id === id) { allLeads[i] = updated; break; } }
    cerrarPanel();
    renderTabla();
  } catch (err) { alert('Error al guardar notas'); }
}

// ════════════════════════════════════════════════════════════════════
// WHATSAPP
// ════════════════════════════════════════════════════════════════════

async function cargarConversacionesWA() {
  try {
    var res = await fetch(API_URL + '/api/whatsapp/conversaciones?canal=empresas');
    if (!res.ok) throw new Error('Error ' + res.status);
    waConversaciones = await res.json();
    renderConversacionesWA();
    actualizarBadgeNoLeidos();
  } catch (err) {
    document.getElementById('wa-convos').innerHTML = '<div class="empty-state" style="padding:40px 20px;"><p>' + esc(err.message) + '</p></div>';
  }
}

function actualizarBadgeNoLeidos() {
  var total = 0;
  waConversaciones.forEach(function(c) { total += c.mensajes_no_leidos || 0; });
  var badge = document.getElementById('wa-unread-badge');
  badge.textContent = total > 0 ? total : '';
}

function formatTiempoRelativo(iso) {
  if (!iso) return '';
  var now = new Date();
  var d = new Date(iso);
  var diff = (now - d) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return Math.floor(diff / 60) + ' min';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  var ayer = new Date(now); ayer.setDate(ayer.getDate() - 1);
  if (d.toDateString() === ayer.toDateString()) return 'ayer';
  return d.getDate() + ' ' + d.toLocaleDateString('es-AR', { month: 'short' }).replace('.', '');
}

function getInitials(name) {
  if (!name) return '?';
  var parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function renderConversacionesWA() {
  var search = (document.getElementById('wa-search').value || '').toLowerCase().trim();
  var filtered = waConversaciones;
  if (search) {
    filtered = waConversaciones.filter(function(c) {
      return (c.nombre_contacto || '').toLowerCase().indexOf(search) !== -1 ||
             (c.telefono || '').indexOf(search) !== -1 ||
             (c.leads_empresas?.empresa || '').toLowerCase().indexOf(search) !== -1;
    });
  }

  if (filtered.length === 0) {
    document.getElementById('wa-convos').innerHTML = '<div class="empty-state" style="padding:50px 20px;"><div class="icon" style="font-size:36px;">&#128172;</div><h3>No hay conversaciones</h3><p>Los mensajes entrantes aparecerán acá.</p></div>';
    return;
  }

  var html = '';
  filtered.forEach(function(c) {
    var isActive = waConvActual && waConvActual.id === c.id ? ' active' : '';
    var nombre = c.nombre_contacto || c.telefono;
    var empresa = c.leads_empresas?.empresa || '';
    html += '<div class="wa-conv-item' + isActive + '" onclick="seleccionarConversacion(\'' + c.id + '\')">' +
      '<div class="wa-avatar">' + getInitials(c.nombre_contacto || c.telefono) + '</div>' +
      '<div class="wa-conv-body">' +
        '<div class="wa-conv-name"><span>' + esc(nombre) + '</span><span class="time">' + formatTiempoRelativo(c.ultimo_mensaje_at) + '</span></div>' +
        (empresa ? '<div class="wa-conv-empresa">' + esc(empresa) + '</div>' : '') +
        '<div class="wa-conv-preview">' + esc(c.ultimo_mensaje || '') + '</div>' +
      '</div>' +
      (c.mensajes_no_leidos > 0 ? '<div class="wa-unread">' + c.mensajes_no_leidos + '</div>' : '') +
    '</div>';
  });

  document.getElementById('wa-convos').innerHTML = html;
}

document.getElementById('wa-search').addEventListener('input', function() {
  clearTimeout(_waSearchTimer);
  _waSearchTimer = setTimeout(renderConversacionesWA, 200);
});

async function seleccionarConversacion(id) {
  var conv = waConversaciones.find(function(c) { return c.id === id; });
  if (!conv) return;
  waConvActual = conv;

  // Mobile: show chat
  document.getElementById('wa-container').classList.add('chat-open');

  // Show chat UI
  document.getElementById('wa-placeholder').style.display = 'none';
  document.getElementById('wa-chat-header').style.display = 'flex';
  document.getElementById('wa-messages').style.display = 'flex';
  document.getElementById('wa-input-area').style.display = 'flex';

  // Header
  var nombre = conv.nombre_contacto || conv.telefono;
  var empresa = conv.leads_empresas?.empresa || '';
  var headerHtml = '<div><h4>' + esc(nombre) + '</h4><span>' + esc(conv.telefono) + (empresa ? ' · ' + esc(empresa) : '') + '</span></div>';
  if (conv.lead_id) {
    headerHtml += '<button class="btn-ver-lead" onclick="verLeadDesdeWA(\'' + conv.lead_id + '\')">Ver lead</button>';
  }
  document.getElementById('wa-chat-header-info').innerHTML = headerHtml;

  // Highlight in list
  renderConversacionesWA();

  // Load messages
  await cargarMensajesWA(id);
}

async function cargarMensajesWA(convId) {
  try {
    var res = await fetch(API_URL + '/api/whatsapp/conversaciones/' + convId + '/mensajes');
    if (!res.ok) throw new Error('Error');
    waMensajes = await res.json();
    renderMensajesWA();
    // Update unread count locally
    var conv = waConversaciones.find(function(c) { return c.id === convId; });
    if (conv) { conv.mensajes_no_leidos = 0; actualizarBadgeNoLeidos(); renderConversacionesWA(); }
  } catch (err) {
    document.getElementById('wa-messages').innerHTML = '<div class="empty-state" style="padding:40px;"><p>Error al cargar mensajes</p></div>';
  }
}

function renderMensajesWA() {
  var container = document.getElementById('wa-messages');
  if (waMensajes.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#8696a0;padding:40px;font-size:13px;">No hay mensajes en esta conversación</div>';
    return;
  }
  var html = '';
  waMensajes.forEach(function(m) {
    var cls = m.direccion === 'saliente' ? 'saliente' : 'entrante';
    var time = m.created_at ? new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    html += '<div class="wa-msg ' + cls + '">' + esc(m.contenido || '') + '<div class="msg-time">' + time + '</div></div>';
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

// ── Send message ──
async function enviarMensaje() {
  if (!waConvActual) return;
  var input = document.getElementById('wa-input');
  var msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  autoResizeInput(input);

  // Optimistic UI
  waMensajes.push({ direccion: 'saliente', contenido: msg, created_at: new Date().toISOString() });
  renderMensajesWA();

  try {
    var res = await fetch(API_URL + '/api/whatsapp/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversacion_id: waConvActual.id, mensaje: msg })
    });
    if (!res.ok) { var err = await res.json(); throw new Error(err.error || 'Error al enviar'); }
    // Update conversation preview
    waConvActual.ultimo_mensaje = msg;
    waConvActual.ultimo_mensaje_at = new Date().toISOString();
    renderConversacionesWA();
  } catch (err) {
    alert('Error al enviar: ' + err.message);
  }
}

// Textarea auto-resize and Enter to send
var waInput = document.getElementById('wa-input');
waInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensaje(); }
});
waInput.addEventListener('input', function() { autoResizeInput(this); });
function autoResizeInput(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// ── New chat modal ──
function abrirNuevoChat() { document.getElementById('modal-new-chat').classList.add('open'); document.getElementById('new-chat-tel').focus(); }
function cerrarNuevoChat() { document.getElementById('modal-new-chat').classList.remove('open'); document.getElementById('new-chat-tel').value = ''; document.getElementById('new-chat-msg').value = ''; }

async function enviarNuevoChat() {
  var tel = document.getElementById('new-chat-tel').value.trim();
  var msg = document.getElementById('new-chat-msg').value.trim();
  if (!tel || !msg) { alert('Completá teléfono y mensaje'); return; }

  try {
    var res = await fetch(API_URL + '/api/whatsapp/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono: tel, mensaje: msg })
    });
    if (!res.ok) { var err = await res.json(); throw new Error(err.error || 'Error'); }
    cerrarNuevoChat();
    await cargarConversacionesWA();
    // Select the new/existing conversation
    if (waConversaciones.length > 0) seleccionarConversacion(waConversaciones[0].id);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Ver lead from WhatsApp ──
function verLeadDesdeWA(leadId) {
  switchView('empresas');
  var lead = allLeads.find(function(l) { return l.id === leadId; });
  if (lead) abrirPanel(lead);
}

// ── Polling ──
async function pollWhatsApp() {
  try {
    var res = await fetch(API_URL + '/api/whatsapp/conversaciones?canal=empresas');
    if (!res.ok) return;
    waConversaciones = await res.json();
    renderConversacionesWA();
    actualizarBadgeNoLeidos();
    // If we have an open conversation, refresh its messages
    if (waConvActual) {
      var stillExists = waConversaciones.find(function(c) { return c.id === waConvActual.id; });
      if (stillExists) {
        var prevCount = waMensajes.length;
        var msgRes = await fetch(API_URL + '/api/whatsapp/conversaciones/' + waConvActual.id + '/mensajes');
        if (msgRes.ok) {
          waMensajes = await msgRes.json();
          if (waMensajes.length !== prevCount) renderMensajesWA();
        }
      }
    }
  } catch (err) { /* silent */ }
}

// ════════════════════════════════════════════════════════════════════
// CONTACTOS
// ════════════════════════════════════════════════════════════════════

var allContactos = [];
var camposCustom = [];
var _ctSearchTimer = null;

async function cargarCamposCustom() {
  try {
    var res = await fetch(API_URL + '/api/contactos/campos/custom');
    if (!res.ok) throw new Error('Error');
    camposCustom = await res.json();
  } catch (err) { camposCustom = []; }
}

async function cargarContactos() {
  try {
    await cargarCamposCustom();
    var res = await fetch(API_URL + '/api/contactos');
    if (!res.ok) throw new Error('Error ' + res.status);
    allContactos = await res.json();
    renderContactos();
  } catch (err) {
    document.getElementById('ct-tabla').innerHTML = '<div class="empty-state"><div class="icon">&#9888;</div><h3>Error</h3><p>' + esc(err.message) + '</p></div>';
  }
}

document.getElementById('ct-buscar').addEventListener('input', function() {
  clearTimeout(_ctSearchTimer);
  _ctSearchTimer = setTimeout(renderContactos, 250);
});

function getFilteredContactos() {
  var q = (document.getElementById('ct-buscar').value || '').toLowerCase().trim();
  if (!q) return allContactos;
  return allContactos.filter(function(c) {
    return (c.nombre||'').toLowerCase().indexOf(q)!==-1 || (c.empresa||'').toLowerCase().indexOf(q)!==-1 || (c.telefono||'').indexOf(q)!==-1 || (c.email||'').toLowerCase().indexOf(q)!==-1;
  });
}

function renderContactos() {
  var list = getFilteredContactos();
  if (list.length === 0) {
    document.getElementById('ct-tabla').innerHTML = '<div class="empty-state"><div class="icon">&#128100;</div><h3>No hay contactos</h3><p>Creá tu primer contacto para empezar a enviar mensajes y plantillas.</p></div>';
    return;
  }
  var html = '<table class="ct-table"><thead><tr><th>Nombre</th><th>Teléfono</th><th>Email</th><th>Empresa</th>';
  camposCustom.forEach(function(f) { html += '<th>' + esc(f.nombre) + '</th>'; });
  html += '<th></th></tr></thead><tbody>';
  list.forEach(function(c) {
    var custom = c.campos_custom || {};
    html += '<tr><td class="ct-name">' + esc(c.nombre) + '</td><td class="ct-sub">' + esc(c.telefono||'—') + '</td><td class="ct-sub">' + esc(c.email||'—') + '</td><td class="ct-sub">' + esc(c.empresa||'—') + '</td>';
    camposCustom.forEach(function(f) { html += '<td class="ct-sub">' + esc(custom[f.slug]||'—') + '</td>'; });
    html += '<td><div class="ct-actions-cell">' +
      '<button class="btn-ct btn-ct-wa" onclick="enviarWAContacto(\'' + c.id + '\')">WA</button>' +
      '<button class="btn-ct" onclick=\'abrirContactoModal(' + JSON.stringify(c).replace(/'/g,"&#39;") + ')\'>Editar</button>' +
      '<button class="btn-ct btn-ct-del" onclick="eliminarContacto(\'' + c.id + '\')">&#10005;</button>' +
    '</div></td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('ct-tabla').innerHTML = html;
}

// ── Contact Modal ──
function abrirContactoModal(contacto) {
  document.getElementById('modal-contacto').classList.add('open');
  document.getElementById('ct-add-field-area').style.display = 'none';
  var isEdit = contacto && contacto.id;
  document.getElementById('ct-modal-title').textContent = isEdit ? 'Editar contacto' : 'Nuevo contacto';
  document.getElementById('ct-edit-id').value = isEdit ? contacto.id : '';
  document.getElementById('ct-nombre').value = isEdit ? contacto.nombre || '' : '';
  document.getElementById('ct-telefono').value = isEdit ? contacto.telefono || '' : '';
  document.getElementById('ct-email').value = isEdit ? contacto.email || '' : '';
  document.getElementById('ct-empresa').value = isEdit ? contacto.empresa || '' : '';
  document.getElementById('ct-notas').value = isEdit ? contacto.notas || '' : '';
  // Custom fields
  var custom = isEdit ? (contacto.campos_custom || {}) : {};
  var cfHtml = '';
  camposCustom.forEach(function(f) {
    cfHtml += '<label>' + esc(f.nombre) + '</label>';
    if (f.tipo === 'select' && f.opciones) {
      var opts = typeof f.opciones === 'string' ? JSON.parse(f.opciones) : f.opciones;
      cfHtml += '<select id="ct-cf-' + f.slug + '"><option value="">—</option>';
      (opts||[]).forEach(function(o) { cfHtml += '<option value="' + esc(o) + '"' + (custom[f.slug] === o ? ' selected' : '') + '>' + esc(o) + '</option>'; });
      cfHtml += '</select>';
    } else {
      cfHtml += '<input type="' + (f.tipo || 'text') + '" id="ct-cf-' + f.slug + '" value="' + esc(custom[f.slug] || '') + '">';
    }
  });
  document.getElementById('ct-custom-fields').innerHTML = cfHtml;
}
function cerrarContactoModal() { document.getElementById('modal-contacto').classList.remove('open'); }

async function guardarContacto() {
  var id = document.getElementById('ct-edit-id').value;
  var nombre = document.getElementById('ct-nombre').value.trim();
  if (!nombre) { alert('El nombre es obligatorio'); return; }
  var payload = {
    nombre: nombre,
    telefono: document.getElementById('ct-telefono').value.trim() || null,
    email: document.getElementById('ct-email').value.trim() || null,
    empresa: document.getElementById('ct-empresa').value.trim() || null,
    notas: document.getElementById('ct-notas').value.trim() || null,
    campos_custom: {}
  };
  camposCustom.forEach(function(f) {
    var el = document.getElementById('ct-cf-' + f.slug);
    if (el && el.value) payload.campos_custom[f.slug] = el.value;
  });
  try {
    var url = API_URL + '/api/contactos' + (id ? '/' + id : '');
    var res = await fetch(url, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Error'); }
    cerrarContactoModal();
    cargarContactos();
  } catch (err) { alert('Error: ' + err.message); }
}

async function eliminarContacto(id) {
  if (!confirm('¿Eliminar este contacto?')) return;
  try {
    var res = await fetch(API_URL + '/api/contactos/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('Error');
    cargarContactos();
  } catch (err) { alert('Error: ' + err.message); }
}

// ── Add custom field inline ──
function abrirAgregarCampo() {
  var area = document.getElementById('ct-add-field-area');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
  document.getElementById('ct-new-field-name').value = '';
}

async function crearCampoCustom() {
  var nombre = document.getElementById('ct-new-field-name').value.trim();
  var tipo = document.getElementById('ct-new-field-type').value;
  if (!nombre) { alert('Ingresá el nombre del campo'); return; }
  try {
    var res = await fetch(API_URL + '/api/contactos/campos/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: nombre, tipo: tipo })
    });
    if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Error'); }
    document.getElementById('ct-add-field-area').style.display = 'none';
    await cargarCamposCustom();
    // Re-render custom fields in the modal
    var currentId = document.getElementById('ct-edit-id').value;
    var current = currentId ? allContactos.find(function(c){return c.id===currentId;}) : null;
    abrirContactoModal(current);
  } catch (err) { alert('Error: ' + err.message); }
}

// ── Manage fields modal ──
function abrirGestionCampos() {
  document.getElementById('modal-campos').classList.add('open');
  renderCamposList();
}
function cerrarGestionCampos() { document.getElementById('modal-campos').classList.remove('open'); }

function renderCamposList() {
  if (camposCustom.length === 0) {
    document.getElementById('campos-list').innerHTML = '<p style="color:#9ca3af;font-size:13px;">No hay campos personalizados. Podés crearlos desde el formulario de contacto.</p>';
    return;
  }
  var html = '';
  camposCustom.forEach(function(f) {
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;">' +
      '<div><span style="font-weight:600;font-size:13px;color:#1a1a2e;">' + esc(f.nombre) + '</span><span style="font-size:11px;color:#9ca3af;margin-left:8px;">{{' + esc(f.slug) + '}}</span><span style="font-size:10px;color:#6b7280;margin-left:8px;background:#f1f5f9;padding:2px 6px;border-radius:3px;">' + esc(f.tipo) + '</span></div>' +
      '<button class="btn-ct btn-ct-del" onclick="eliminarCampoCustom(\'' + f.id + '\')">&#10005;</button>' +
    '</div>';
  });
  document.getElementById('campos-list').innerHTML = html;
}

async function eliminarCampoCustom(id) {
  if (!confirm('¿Eliminar este campo? Los datos existentes en contactos no se borran.')) return;
  try {
    var res = await fetch(API_URL + '/api/contactos/campos/custom/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('Error');
    await cargarCamposCustom();
    renderCamposList();
    renderContactos();
  } catch (err) { alert('Error: ' + err.message); }
}

// ── Send WA to contact ──
function enviarWAContacto(contactoId) {
  var c = allContactos.find(function(x) { return x.id === contactoId; });
  if (!c || !c.telefono) { alert('Este contacto no tiene teléfono'); return; }
  // Switch to WhatsApp view and open new chat with pre-filled phone
  switchView('whatsapp');
  setTimeout(function() {
    abrirNuevoChat();
    document.getElementById('new-chat-tel').value = c.telefono;
  }, 100);
}

// ── Select contact for template sending ──
function abrirSelectContacto(callback) {
  document.getElementById('modal-select-contacto').classList.add('open');
  document.getElementById('select-ct-buscar').value = '';
  window._selectContactoCallback = callback;
  renderSelectContacto();
}

function renderSelectContacto() {
  var q = (document.getElementById('select-ct-buscar').value || '').toLowerCase().trim();
  var list = allContactos.filter(function(c) {
    if (!c.telefono) return false;
    if (!q) return true;
    return (c.nombre||'').toLowerCase().indexOf(q)!==-1 || (c.empresa||'').toLowerCase().indexOf(q)!==-1 || (c.telefono||'').indexOf(q)!==-1;
  });
  if (list.length === 0) {
    document.getElementById('select-ct-list').innerHTML = '<p style="color:#9ca3af;font-size:13px;text-align:center;padding:20px;">No hay contactos con teléfono</p>';
    return;
  }
  var html = '';
  list.forEach(function(c) {
    html += '<div style="padding:10px 12px;border-bottom:1px solid #f1f5f9;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background .1s;" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'" onclick="seleccionarContactoParaEnvio(\'' + c.id + '\')">' +
      '<div><div style="font-weight:600;font-size:13px;color:#1a1a2e;">' + esc(c.nombre) + '</div><div style="font-size:11px;color:#9ca3af;">' + esc(c.telefono) + (c.empresa ? ' · ' + esc(c.empresa) : '') + '</div></div>' +
      '<span style="color:#25d366;font-size:12px;">Seleccionar</span>' +
    '</div>';
  });
  document.getElementById('select-ct-list').innerHTML = html;
}

function seleccionarContactoParaEnvio(id) {
  document.getElementById('modal-select-contacto').classList.remove('open');
  var c = allContactos.find(function(x) { return x.id === id; });
  if (c && window._selectContactoCallback) window._selectContactoCallback(c);
}

// ════════════════════════════════════════════════════════════════════
// TEMPLATES
// ════════════════════════════════════════════════════════════════════

var allTemplates = [];
var _sendTemplateData = null;
var _tplButtonCount = 0;

async function cargarTemplates(force) {
  var url = API_URL + '/api/whatsapp/templates' + (force ? '?refresh=true' : '');
  try {
    document.getElementById('tpl-grid-contenido').innerHTML = '<div class="empty-state" style="padding:40px;"><p>Cargando plantillas...</p></div>';
    var res = await fetch(url);
    if (!res.ok) throw new Error('Error ' + res.status);
    allTemplates = await res.json();
    renderTemplates();
  } catch (err) {
    document.getElementById('tpl-grid-contenido').innerHTML = '<div class="empty-state"><div class="icon">&#9888;</div><h3>Error al cargar plantillas</h3><p>' + esc(err.message) + '</p></div>';
  }
}

function renderTemplates() {
  if (allTemplates.length === 0) {
    document.getElementById('tpl-grid-contenido').innerHTML = '<div class="empty-state"><div class="icon">&#128196;</div><h3>No hay plantillas</h3><p>Creá tu primera plantilla para enviar mensajes a tus contactos.</p></div>';
    return;
  }
  var html = '<div class="tpl-grid">';
  allTemplates.forEach(function(t) {
    var catCls = 'tpl-badge-utility';
    if (t.category === 'MARKETING') catCls = 'tpl-badge-marketing';
    if (t.category === 'AUTHENTICATION') catCls = 'tpl-badge-authentication';
    var statusCls = 'tpl-status-pending';
    var statusLabel = t.status;
    if (t.status === 'APPROVED') { statusCls = 'tpl-status-approved'; statusLabel = 'Aprobada'; }
    if (t.status === 'PENDING') { statusLabel = 'Pendiente'; }
    if (t.status === 'REJECTED') { statusCls = 'tpl-status-rejected'; statusLabel = 'Rechazada'; }

    var bodyText = '';
    if (t.components) {
      var bodyComp = t.components.find(function(c) { return c.type === 'BODY'; });
      if (bodyComp) bodyText = bodyComp.text || '';
    }

    html += '<div class="tpl-card">' +
      '<div class="tpl-card-header"><span class="tpl-card-name">' + esc(t.name) + '</span></div>' +
      '<div class="tpl-card-badges">' +
        '<span class="tpl-badge-cat ' + catCls + '">' + esc(t.category) + '</span>' +
        '<span class="tpl-badge-status ' + statusCls + '">' + statusLabel + '</span>' +
      '</div>' +
      '<div class="tpl-card-lang">' + esc(t.language || '—') + '</div>' +
      '<div class="tpl-card-body">' + esc(bodyText) + '</div>' +
      '<div class="tpl-card-actions">' +
        (t.status === 'APPROVED' ? '<button class="btn-tpl btn-tpl-send" onclick=\'abrirEnviarTemplate(' + JSON.stringify({name:t.name,language:t.language,components:t.components}).replace(/'/g,"&#39;") + ')\'>Enviar</button>' : '') +
        '<button class="btn-tpl btn-tpl-danger" onclick="eliminarTemplate(\'' + esc(t.name) + '\')">Eliminar</button>' +
      '</div>' +
    '</div>';
  });
  html += '</div>';
  document.getElementById('tpl-grid-contenido').innerHTML = html;
}

// ── Create Template ──
function abrirCrearTemplate() {
  document.getElementById('modal-create-tpl').classList.add('open');
  _tplButtonCount = 0;
  document.getElementById('tpl-buttons-container').innerHTML = '';
  document.getElementById('tpl-name').value = '';
  document.getElementById('tpl-header').value = '';
  document.getElementById('tpl-body').value = '';
  document.getElementById('tpl-footer').value = '';
  actualizarPreviewTemplate();
  renderVarsPalette();
}
function cerrarCrearTemplate() { document.getElementById('modal-create-tpl').classList.remove('open'); }

function renderVarsPalette() {
  // Load custom fields if not loaded
  var buildPalette = function() {
    var fields = [
      { num: 1, label: 'Nombre' },
      { num: 2, label: 'Empresa' },
      { num: 3, label: 'Teléfono' },
      { num: 4, label: 'Email' }
    ];
    var nextNum = 5;
    camposCustom.forEach(function(f) {
      fields.push({ num: nextNum, label: f.nombre });
      nextNum++;
    });
    var html = '';
    fields.forEach(function(f) {
      html += '<button type="button" class="var-chip" onclick="insertarVariable(' + f.num + ')" title="Insertar {{' + f.num + '}} = ' + esc(f.label) + '"><span class="var-num">{{' + f.num + '}}</span> ' + esc(f.label) + '</button>';
    });
    document.getElementById('tpl-vars-palette').innerHTML = html;
  };
  if (camposCustom.length === 0) {
    fetch(API_URL + '/api/contactos/campos/custom').then(function(r){return r.json();}).then(function(d){ camposCustom = d; buildPalette(); }).catch(function(){ buildPalette(); });
  } else {
    buildPalette();
  }
}

function insertarVariable(num) {
  var ta = document.getElementById('tpl-body');
  var varText = '{{' + num + '}}';
  var start = ta.selectionStart;
  var end = ta.selectionEnd;
  var val = ta.value;
  ta.value = val.substring(0, start) + varText + val.substring(end);
  ta.selectionStart = ta.selectionEnd = start + varText.length;
  ta.focus();
  actualizarPreviewTemplate();
}

function agregarBotonTemplate() {
  if (_tplButtonCount >= 2) { alert('Máximo 2 botones'); return; }
  _tplButtonCount++;
  var container = document.getElementById('tpl-buttons-container');
  var div = document.createElement('div');
  div.className = 'tpl-buttons-row';
  div.innerHTML = '<input type="text" class="tpl-btn-text" placeholder="Texto del botón ' + _tplButtonCount + '" oninput="actualizarPreviewTemplate()"><button class="btn-remove-btn" onclick="this.parentElement.remove();_tplButtonCount--;actualizarPreviewTemplate();">&times;</button>';
  container.appendChild(div);
  actualizarPreviewTemplate();
}

// Live preview
document.getElementById('tpl-header').addEventListener('input', actualizarPreviewTemplate);
document.getElementById('tpl-body').addEventListener('input', actualizarPreviewTemplate);
document.getElementById('tpl-footer').addEventListener('input', actualizarPreviewTemplate);

function actualizarPreviewTemplate() {
  var header = document.getElementById('tpl-header').value;
  var body = document.getElementById('tpl-body').value;
  var footer = document.getElementById('tpl-footer').value;

  var hEl = document.getElementById('tpl-prev-header');
  var bEl = document.getElementById('tpl-prev-body');
  var fEl = document.getElementById('tpl-prev-footer');
  var btnsEl = document.getElementById('tpl-prev-buttons');

  hEl.style.display = header ? 'block' : 'none';
  hEl.textContent = header;
  bEl.textContent = body || 'Escribí el body para ver la vista previa...';
  bEl.style.color = body ? '#111827' : '#6b7280';
  fEl.style.display = footer ? 'block' : 'none';
  fEl.textContent = footer;

  var btns = document.querySelectorAll('.tpl-btn-text');
  var btnsHtml = '';
  btns.forEach(function(b) { if (b.value.trim()) btnsHtml += '<div class="prev-btn">' + esc(b.value.trim()) + '</div>'; });
  btnsEl.innerHTML = btnsHtml;
}

// Validar nombre al tipear
document.getElementById('tpl-name').addEventListener('input', function() {
  this.value = this.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
});

async function crearTemplate() {
  var name = document.getElementById('tpl-name').value.trim();
  var category = document.getElementById('tpl-category').value;
  var language = document.getElementById('tpl-language').value;
  var header = document.getElementById('tpl-header').value.trim();
  var body = document.getElementById('tpl-body').value.trim();
  var footer = document.getElementById('tpl-footer').value.trim();

  if (!name) { alert('El nombre es obligatorio'); return; }
  if (!body) { alert('El body es obligatorio'); return; }
  if (!/^[a-z0-9_]+$/.test(name)) { alert('El nombre solo puede contener minúsculas, números y _'); return; }

  var components = [];
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header });
  components.push({ type: 'BODY', text: body });
  if (footer) components.push({ type: 'FOOTER', text: footer });

  var btns = document.querySelectorAll('.tpl-btn-text');
  var buttons = [];
  btns.forEach(function(b) { if (b.value.trim()) buttons.push({ type: 'QUICK_REPLY', text: b.value.trim() }); });
  if (buttons.length > 0) components.push({ type: 'BUTTONS', buttons: buttons });

  try {
    var res = await fetch(API_URL + '/api/whatsapp/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, category: category, language: language, components: components })
    });
    var data = await res.json();
    if (!res.ok) {
      var msg = data.detalle?.message || data.error || 'Error al crear';
      alert('Error: ' + msg);
      return;
    }
    cerrarCrearTemplate();
    alert('Plantilla enviada a Meta para aprobación. El proceso puede tardar hasta 24 horas.');
    cargarTemplates(true);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function eliminarTemplate(name) {
  if (!confirm('¿Eliminar la plantilla "' + name + '"? Esta acción no se puede deshacer.')) return;
  try {
    var res = await fetch(API_URL + '/api/whatsapp/templates/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!res.ok) { var data = await res.json(); throw new Error(data.detalle?.message || data.error || 'Error'); }
    cargarTemplates(true);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Send Template ──
function abrirEnviarTemplate(tplData) {
  _sendTemplateData = tplData;
  document.getElementById('modal-send-tpl').classList.add('open');
  document.getElementById('tpl-send-tel').value = '';

  // Find variables in body
  var bodyComp = (tplData.components || []).find(function(c) { return c.type === 'BODY'; });
  var bodyText = bodyComp ? bodyComp.text || '' : '';
  var vars = bodyText.match(/\{\{\d+\}\}/g) || [];
  var uniqueVars = [];
  vars.forEach(function(v) { if (uniqueVars.indexOf(v) === -1) uniqueVars.push(v); });

  var varsHtml = '';
  uniqueVars.forEach(function(v, i) {
    varsHtml += '<label>Variable ' + v + '</label><input type="text" class="tpl-send-var" data-var="' + v + '" placeholder="Valor para ' + v + '" oninput="actualizarSendPreview()">';
  });
  document.getElementById('tpl-send-vars').innerHTML = varsHtml;
  _sendTemplateBodyText = bodyText;
  actualizarSendPreview();
}
var _sendTemplateBodyText = '';

function actualizarSendPreview() {
  var text = _sendTemplateBodyText;
  document.querySelectorAll('.tpl-send-var').forEach(function(input) {
    var v = input.dataset.var;
    var val = input.value || v;
    text = text.split(v).join(val);
  });
  document.getElementById('tpl-send-preview-text').textContent = text;
}

function cerrarEnviarTemplate() { document.getElementById('modal-send-tpl').classList.remove('open'); _sendTemplateData = null; }

async function enviarTemplate() {
  if (!_sendTemplateData) return;
  var tel = document.getElementById('tpl-send-tel').value.trim();
  if (!tel) { alert('Ingresá el teléfono'); return; }

  // Build components with variable values
  var bodyVars = [];
  document.querySelectorAll('.tpl-send-var').forEach(function(input) {
    bodyVars.push({ type: 'text', text: input.value || input.dataset.var });
  });

  var components = [];
  if (bodyVars.length > 0) {
    components.push({ type: 'body', parameters: bodyVars });
  }

  try {
    var res = await fetch(API_URL + '/api/whatsapp/templates/enviar-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telefono: tel,
        template_name: _sendTemplateData.name,
        template_language: _sendTemplateData.language,
        components: components.length > 0 ? components : undefined
      })
    });
    var data = await res.json();
    if (!res.ok) {
      var msg = data.detalle?.error?.message || data.error || 'Error al enviar';
      alert('Error: ' + msg);
      return;
    }
    cerrarEnviarTemplate();
    alert('Template enviado exitosamente');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Load templates when switching to view
var _origSwitchView = switchView;
switchView = function(view) {
  _origSwitchView(view);
  if (view === 'plantillas' && allTemplates.length === 0) cargarTemplates(false);
  if (view === 'contactos' && allContactos.length === 0) cargarContactos();
};

// ── Select contact to auto-fill template send ──
function seleccionarContactoParaTpl() {
  // Load contacts if not loaded yet
  if (allContactos.length === 0) {
    fetch(API_URL + '/api/contactos').then(function(r){return r.json();}).then(function(d){ allContactos = d; _showContactPicker(); });
    fetch(API_URL + '/api/contactos/campos/custom').then(function(r){return r.json();}).then(function(d){ camposCustom = d; });
  } else {
    _showContactPicker();
  }
}

function _showContactPicker() {
  abrirSelectContacto(function(contacto) {
    // Fill phone
    document.getElementById('tpl-send-tel').value = contacto.telefono || '';
    // Build field values array from contact for auto-filling variables
    var fieldValues = [contacto.nombre, contacto.empresa, contacto.telefono, contacto.email];
    var custom = contacto.campos_custom || {};
    camposCustom.forEach(function(f) { if (custom[f.slug]) fieldValues.push(custom[f.slug]); });
    // Auto-fill variable inputs in order
    var varInputs = document.querySelectorAll('.tpl-send-var');
    varInputs.forEach(function(input, i) {
      if (i < fieldValues.length && fieldValues[i]) {
        input.value = fieldValues[i];
      }
    });
    actualizarSendPreview();
  });
}

// ════════════════════════════════════════════════════════════════════
// BOT KNOWLEDGE (v2)
// ════════════════════════════════════════════════════════════════════

var botSecciones = [];
var botSeccionActual = null;
var botMensajes = [];
var botEstadoActual = 'sin_iniciar';
var _botSending = false;

async function botCargarSecciones() {
  try {
    var res = await fetch(API_URL + '/api/bot/secciones');
    if (!res.ok) throw new Error('Error ' + res.status);
    botSecciones = await res.json();
    botRenderSecciones();
    botRenderProgress();
  } catch (err) { console.error('Error cargando secciones bot:', err); }
}

function botRenderSecciones() {
  var html = '';
  botSecciones.forEach(function(s) {
    var activeCls = botSeccionActual === s.id ? ' active' : '';
    var estadoLabel = 'Sin iniciar';
    var estadoCls = s.estado;
    if (s.estado === 'en_progreso') estadoLabel = 'En progreso';
    if (s.estado === 'completa') estadoLabel = '\u2705 Completa';
    html += '<div class="bot-section-item' + activeCls + '" onclick="botSeleccionarSeccion(\'' + s.id + '\')">' +
      '<span class="bot-section-icon">' + s.icon + '</span>' +
      '<div class="bot-section-info"><div class="bot-section-name">' + esc(s.title) + '</div>' +
      '<div class="bot-section-status ' + estadoCls + '">' + estadoLabel + '</div></div></div>';
  });
  document.getElementById('bot-section-list').innerHTML = html;
}

function botRenderProgress() {
  var completas = botSecciones.filter(function(s) { return s.estado === 'completa'; }).length;
  var pct = Math.round((completas / Math.max(botSecciones.length, 1)) * 100);
  document.getElementById('bot-progress-fill').style.width = pct + '%';
  document.getElementById('bot-progress-text').textContent = completas + '/' + botSecciones.length + ' secciones completas';
}

async function botSeleccionarSeccion(id) {
  botSeccionActual = id;
  var seccion = botSecciones.find(function(s) { return s.id === id; });
  if (!seccion) return;

  document.getElementById('bot-chat-title').innerHTML = seccion.icon + ' ' + esc(seccion.title);
  document.getElementById('bot-chat-subtitle').textContent = seccion.description;
  var badge = document.getElementById('bot-estado-badge');
  badge.className = 'bot-estado-badge bot-estado-' + seccion.estado;
  badge.textContent = seccion.estado === 'completa' ? '\u2705 Completa' : seccion.estado === 'en_progreso' ? 'En progreso' : 'Sin iniciar';

  botRenderSecciones();

  // Load messages
  try {
    var res = await fetch(API_URL + '/api/bot/entrevista/' + id);
    if (!res.ok) throw new Error('Error');
    var data = await res.json();
    botMensajes = data.mensajes || [];
    botEstadoActual = data.estado || 'sin_iniciar';
  } catch (err) {
    botMensajes = [];
    botEstadoActual = 'sin_iniciar';
  }

  if (botMensajes.length === 0 && botEstadoActual === 'sin_iniciar') {
    // Show "Iniciar" button
    document.getElementById('bot-chat-msgs').innerHTML = '<div class="bot-empty"><div style="font-size:48px;opacity:0.5;">' + seccion.icon + '</div><div style="margin-bottom:12px;">' + esc(seccion.title) + '</div><button class="btn-bot-iniciar" onclick="botIniciarSeccion()">Iniciar entrevista</button></div>';
    document.getElementById('bot-input-area').style.display = 'none';
  } else {
    botRenderMensajes();
    document.getElementById('bot-input-area').style.display = botEstadoActual === 'completa' ? 'none' : 'flex';
  }
}

async function botIniciarSeccion() {
  if (!botSeccionActual) return;
  document.getElementById('bot-chat-msgs').innerHTML = '<div class="bot-empty"><div class="bot-typing"><span></span><span></span><span></span></div><div style="margin-top:8px;">Iniciando entrevista...</div></div>';

  try {
    var res = await fetch(API_URL + '/api/bot/entrevista/' + botSeccionActual + '/iniciar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail: _currentUserEmail })
    });
    if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Error'); }
    var data = await res.json();
    botMensajes = data.mensajes || [];
    botEstadoActual = data.estado;
    botRenderMensajes();
    document.getElementById('bot-input-area').style.display = 'flex';
    document.getElementById('bot-input').focus();
    // Update section state in sidebar
    var sec = botSecciones.find(function(s) { return s.id === botSeccionActual; });
    if (sec) sec.estado = botEstadoActual;
    botRenderSecciones();
    botRenderProgress();
    var badge = document.getElementById('bot-estado-badge');
    badge.className = 'bot-estado-badge bot-estado-' + botEstadoActual;
    badge.textContent = 'En progreso';
  } catch (err) {
    document.getElementById('bot-chat-msgs').innerHTML = '<div class="bot-empty">Error: ' + esc(err.message) + '</div>';
  }
}

function botRenderMensajes() {
  var container = document.getElementById('bot-chat-msgs');
  if (botMensajes.length === 0) {
    container.innerHTML = '<div class="bot-empty">Sin mensajes</div>';
    return;
  }
  var html = '';
  botMensajes.forEach(function(m) {
    var cls = m.role === 'user' ? 'user' : 'assistant';
    var label = m.role === 'user' ? 'René' : 'Entrevistador';
    var textHtml = esc(m.text || m.content || '').replace(/\n/g, '<br>');
    html += '<div class="bot-msg ' + cls + '"><div class="msg-label">' + label + '</div><div class="msg-text">' + textHtml + '</div></div>';
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

async function botEnviarMensaje() {
  if (_botSending || !botSeccionActual) return;
  var input = document.getElementById('bot-input');
  var texto = input.value.trim();
  if (!texto) return;

  _botSending = true;
  document.getElementById('btn-bot-send').disabled = true;
  input.value = '';
  botAutoResize(input);

  // Optimistic: show user message + typing
  botMensajes.push({ role: 'user', text: texto, ts: new Date().toISOString() });
  botRenderMensajes();
  var container = document.getElementById('bot-chat-msgs');
  container.innerHTML += '<div class="bot-typing" id="bot-typing-indicator"><span></span><span></span><span></span></div>';
  container.scrollTop = container.scrollHeight;

  try {
    var res = await fetch(API_URL + '/api/bot/entrevista/' + botSeccionActual + '/mensaje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: texto, userEmail: _currentUserEmail })
    });
    if (!res.ok) { var e = await res.json(); throw new Error(e.error || 'Error'); }
    var data = await res.json();

    botMensajes.push({ role: 'assistant', text: data.respuesta, ts: new Date().toISOString() });
    botEstadoActual = data.estado;

    // Remove typing indicator
    var typing = document.getElementById('bot-typing-indicator');
    if (typing) typing.remove();

    botRenderMensajes();

    // Update estado if changed
    if (data.estado === 'completa') {
      document.getElementById('bot-input-area').style.display = 'none';
      var badge = document.getElementById('bot-estado-badge');
      badge.className = 'bot-estado-badge bot-estado-completa';
      badge.textContent = '\u2705 Completa';
    }
    var sec = botSecciones.find(function(s) { return s.id === botSeccionActual; });
    if (sec) sec.estado = data.estado;
    botRenderSecciones();
    botRenderProgress();
  } catch (err) {
    var typing = document.getElementById('bot-typing-indicator');
    if (typing) typing.remove();
    alert('Error: ' + err.message);
    // Remove the optimistic user message
    botMensajes.pop();
    botRenderMensajes();
  } finally {
    _botSending = false;
    document.getElementById('btn-bot-send').disabled = false;
    input.focus();
  }
}

// Enter to send, Shift+Enter new line
document.getElementById('bot-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); botEnviarMensaje(); }
});
document.getElementById('bot-input').addEventListener('input', function() { botAutoResize(this); });
function botAutoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// Hook switchView for bot
var _prevSwitchViewBot = switchView;
switchView = function(view) {
  _prevSwitchViewBot(view);
  if (view === 'bot' && botSecciones.length === 0) botCargarSecciones();
};

// ── Guardarraíl anti-fragilidad (mismo criterio que ventas) ──
(function(){
  var criticas = ['switchView','cargarConversacionesWA','pollWhatsApp','cargarLeads'];
  var faltan = criticas.filter(function(n){ return typeof window[n] !== 'function'; });
  if (faltan.length) console.error('[CRM empresas] Funciones de init sin definir:', faltan.join(', '));
})();
