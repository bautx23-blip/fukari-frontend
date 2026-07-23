// yaku-crm-ventas.js — JS del CRM de ventas.
// Cargado con <script defer> desde yaku-crm-ventas.html: el navegador garantiza
// que corre en orden y después de parsear el DOM, así ninguna función se llama
// antes de existir (el bug del "Cargando…" infinito es imposible por diseño).

// ══════════════════════════════════════════════════════════════════════════
// BLOQUE 1 — principal (auth, switchView, whatsapp, agentes, etc.)
// ══════════════════════════════════════════════════════════════════════════
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
  // CRM de ventas: bi.lab + el cliente (René) + ventas (María Pía). El resto va al hub.
  var CRM_EMAILS = ['info@wearebilab.com', 'renebiagioni@yakuagua.com.ar', 'ventas@yakuagua.com.ar', 'agustincalabres@yakuagua.com.ar'];
  if (CRM_EMAILS.indexOf(email) === -1) { window.location.href = '/hub.html'; return; }
  document.body.classList.add('ready');
  // Métrica "Cerrados por Bot": por ahora visible solo para info@wearebilab.com.
  if (email === 'info@wearebilab.com') {
    var _navCer = document.getElementById('nav-cerrados');
    if (_navCer) _navCer.style.display = '';
  }
  var d = new Date();
  document.getElementById('topbar-fecha').textContent = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  // Mostrar sección Configuración a usuarios autorizados
  if (BOT_ALLOWED_EMAILS.indexOf(email) !== -1) {
    document.getElementById('sidebar-config').style.display = '';
  }
  // Agentes (prender/apagar el bot + horario): SOLO info@wearebilab.com.
  if (email !== 'info@wearebilab.com') {
    var _navAg = document.getElementById('nav-agentes');
    if (_navAg) _navAg.style.display = 'none';
  }
  // Botones de admin (exportar/integrar) solo para INTEGRATOR_EMAIL
  if (email === INTEGRATOR_EMAIL) {
    document.getElementById('bot-actions-admin').style.display = '';
  }
  // OJO: plLoad/pollWhatsApp se definen en bloques <script> POSTERIORES. Si la
  // sesión resuelve rápido (cache), este callback corre antes de que existan y
  // tiraba "plLoad is not defined" → pipeline colgado en "Cargando…". Diferimos
  // hasta que todo el HTML/scripts estén parseados.
  function _crmInitData(){
    plLoad();
    cargarConversacionesWA();
    calCargarNotis(); // badge de agenda + popup de instalaciones por vencer
    _waPollingInterval = setInterval(pollWhatsApp, 10000);
    // Vuelta del embedded signup de Kapso: verificar conexión del número de ventas.
    if (location.search.indexOf('wa=ok') !== -1) {
      switchView('whatsapp');
      setTimeout(function(){ waVerificarConexion(false); }, 500);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _crmInitData);
  } else {
    _crmInitData();
  }
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
  if (view === 'pipeline') plLoad();
  if (view === 'probarbot') pbInit();
  if (view === 'agentes') agLoad();
  if (view === 'agenda') calCargar();
  if (view === 'cerrados') cerLoad();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

// ════════════════════════════════════════════════════════════════════
// AGENTES — control del bot de ventas (on/off + horario de atención)
// ════════════════════════════════════════════════════════════════════
var agCfg = null;
var _agChipTimer = null;
var AG_DIAS = [{n:1,l:'Lun'},{n:2,l:'Mar'},{n:3,l:'Mié'},{n:4,l:'Jue'},{n:5,l:'Vie'},{n:6,l:'Sáb'},{n:7,l:'Dom'}];
var AG_TZ = 'America/Argentina/Buenos_Aires';

function agEsc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function agHM(t){ return (t||'').slice(0,5); }

async function agLoad(){
  var slot = document.getElementById('ag-slot');
  slot.innerHTML = '<div class="ag-loading">Cargando…</div>';
  try {
    var r = await fetch(API_URL + '/api/sales-bot/config', { headers: { 'x-user-email': _currentUserEmail } });
    if (r.status === 403){ slot.innerHTML = '<div class="ag-err">No tenés permiso para esta sección.</div>'; return; }
    if (!r.ok) throw new Error('status ' + r.status);
    agCfg = await r.json();
    agRender();
    agCargarErrores();
  } catch(e){ slot.innerHTML = '<div class="ag-err">Error al cargar: ' + agEsc(e.message) + '</div>'; }
}

// Salud del bot: últimos errores registrados (solo info@wearebilab.com).
async function agCargarErrores(){
  var cont = document.getElementById('ag-errores');
  if (!cont) return;
  try {
    var r = await fetch(API_URL + '/api/sales-bot/errores', { headers: { 'x-user-email': _currentUserEmail } });
    if (!r.ok) { cont.innerHTML = ''; return; }
    var errs = await r.json();
    var head = '<div class="ag-card"><div class="ag-name" style="margin-bottom:4px;">🩺 Salud del bot</div>';
    if (!errs.length){
      cont.innerHTML = head + '<div style="font-size:12.5px;color:#16a34a;font-weight:600;">🟢 Sin errores registrados.</div></div>';
      return;
    }
    var filas = errs.slice(0,20).map(function(e){
      var f = new Date(e.created_at).toLocaleString('es-AR');
      return '<div style="font-size:11.5px;color:#475569;padding:7px 0;border-top:1px solid #f1f5f9;">'
        + '<span style="color:#b91c1c;font-weight:700;">'+agEsc(e.tipo||'error')+'</span> · '+agEsc(f)
        + (e.telefono?' · '+agEsc(e.telefono):'')
        + '<div style="color:#6b7280;margin-top:2px;word-break:break-word;">'+agEsc((e.detalle||'').slice(0,180))+'</div></div>';
    }).join('');
    cont.innerHTML = head + '<div style="font-size:12px;color:#b45309;font-weight:700;margin-bottom:4px;">⚠️ '+errs.length+' error'+(errs.length===1?'':'es')+' (últimos 50)</div>' + filas + '</div>';
  } catch(e){ cont.innerHTML = ''; }
}

function agAhoraTZ(){
  var parts = new Intl.DateTimeFormat('en-US',{timeZone:AG_TZ,hour12:false,weekday:'short',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date());
  var g = function(t){ var p = parts.find(function(x){return x.type===t;}); return p?p.value:''; };
  var hh = parseInt(g('hour'),10); if(hh===24) hh=0; var mm = parseInt(g('minute'),10)||0;
  var map = {Sun:7,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return { min: hh*60+mm, dow: map[g('weekday')]||0 };
}
function agToMin(t){ var p=(t||'0:0').split(':'); return (parseInt(p[0],10)||0)*60+(parseInt(p[1],10)||0); }
function agDentro(){
  if (!agCfg.horario_activo) return true;
  var a = agAhoraTZ();
  var dias = (agCfg.dias_semana&&agCfg.dias_semana.length)?agCfg.dias_semana:[1,2,3,4,5,6,7];
  if (dias.indexOf(a.dow)===-1) return false;
  var d=agToMin(agCfg.hora_desde), h=agToMin(agCfg.hora_hasta);
  if (d===h) return true;
  if (d<h) return a.min>=d && a.min<h;
  return a.min>=d || a.min<h;
}
function agChip(){
  if (!agCfg.activo) return '<span class="ag-estado off"><span class="pt"></span>Apagado</span>';
  if (agDentro()) return '<span class="ag-estado on"><span class="pt"></span>Atendiendo ahora</span>';
  return '<span class="ag-estado sched"><span class="pt"></span>Encendido — fuera de horario</span>';
}

function agRender(){
  var diasSel = agCfg.dias_semana || [];
  var html = ''
   + '<div class="ag-card">'
   + '  <div class="ag-head">'
   + '    <div class="ag-icon">💧</div>'
   + '    <div class="ag-meta">'
   + '      <div class="ag-name">Bot de Ventas Yakú</div>'
   + '      <div class="ag-sub">Atiende WhatsApp, responde consultas y toma leads.</div>'
   + '      <div id="ag-chip">' + agChip() + '</div>'
   + '    </div>'
   + '    <label class="ag-switch"><input type="checkbox" id="ag-activo" '+(agCfg.activo?'checked':'')+' onchange="agOnActivo()"><span class="ag-slider"></span></label>'
   + '  </div>'
   + '  <div class="ag-row">'
   + '    <div class="ag-rowtxt"><div class="t">Restringir horario de atención</div><div class="d">Si está apagado, el bot atiende las 24 hs.</div></div>'
   + '    <label class="ag-switch"><input type="checkbox" id="ag-horario" '+(agCfg.horario_activo?'checked':'')+' onchange="agOnHorario()"><span class="ag-slider"></span></label>'
   + '  </div>'
   + '  <div class="ag-sched '+(agCfg.horario_activo?'':'ag-hidden')+'" id="ag-sched">'
   + '    <div class="ag-times">'
   + '      <label>Desde</label><input type="time" id="ag-desde" value="'+agHM(agCfg.hora_desde)+'" onchange="agDirty()">'
   + '      <span class="ag-sep">→</span>'
   + '      <label>Hasta</label><input type="time" id="ag-hasta" value="'+agHM(agCfg.hora_hasta)+'" onchange="agDirty()">'
   + '    </div>'
   + '    <div class="ag-days">'
   +        AG_DIAS.map(function(d){ return '<button type="button" class="ag-day '+(diasSel.indexOf(d.n)!==-1?'sel':'')+'" data-d="'+d.n+'" onclick="agToggleDay('+d.n+')">'+d.l+'</button>'; }).join('')
   + '    </div>'
   + '  </div>'
   + '  <div class="ag-foot">'
   + '    <span class="ag-saved" id="ag-saved">'+(agCfg.updated_at?('Último cambio: '+new Date(agCfg.updated_at).toLocaleString('es-AR')):'')+'</span>'
   + '    <button class="ag-save" id="ag-save" onclick="agSave()" disabled>Guardar cambios</button>'
   + '  </div>'
   + '  <div class="ag-err2" id="ag-err" style="display:none"></div>'
   + '</div>'
   + '<div class="ag-note">⚠️ Cuando prendés el bot, empieza a responder <b>solo</b> los mensajes nuevos. Si hay chats que estás atendiendo a mano, pausá el bot en esa conversación desde <b>WhatsApp</b>. El bot además se pausa solo cuando cierra una venta o deriva a un asesor.</div>';
  document.getElementById('ag-slot').innerHTML = html;
  if (_agChipTimer) clearInterval(_agChipTimer);
  _agChipTimer = setInterval(function(){ var c=document.getElementById('ag-chip'); if(c && agCfg) c.innerHTML=agChip(); }, 30000);
}

function agDirty(){ var b=document.getElementById('ag-save'); if(b) b.disabled=false; }
function agOnActivo(){ agCfg.activo=document.getElementById('ag-activo').checked; document.getElementById('ag-chip').innerHTML=agChip(); agDirty(); }
function agOnHorario(){ agCfg.horario_activo=document.getElementById('ag-horario').checked; document.getElementById('ag-sched').classList.toggle('ag-hidden', !agCfg.horario_activo); document.getElementById('ag-chip').innerHTML=agChip(); agDirty(); }
function agToggleDay(n){ agCfg.dias_semana=agCfg.dias_semana||[]; var i=agCfg.dias_semana.indexOf(n); if(i===-1)agCfg.dias_semana.push(n); else agCfg.dias_semana.splice(i,1); document.querySelector('.ag-day[data-d="'+n+'"]').classList.toggle('sel'); document.getElementById('ag-chip').innerHTML=agChip(); agDirty(); }

async function agSave(){
  var btn=document.getElementById('ag-save'), err=document.getElementById('ag-err');
  err.style.display='none';
  var body={ activo:document.getElementById('ag-activo').checked, horario_activo:document.getElementById('ag-horario').checked, hora_desde:document.getElementById('ag-desde').value||'09:00', hora_hasta:document.getElementById('ag-hasta').value||'18:00', dias_semana:(agCfg.dias_semana||[]).slice().sort(function(a,b){return a-b;}) };
  if (body.horario_activo && body.dias_semana.length===0){ err.textContent='Elegí al menos un día de atención.'; err.style.display='block'; return; }
  btn.disabled=true; btn.textContent='Guardando…';
  try {
    var r=await fetch(API_URL + '/api/sales-bot/config', { method:'PUT', headers:{'Content-Type':'application/json','x-user-email':_currentUserEmail}, body:JSON.stringify(body) });
    var j=await r.json();
    if (!r.ok) throw new Error(j.error||('status '+r.status));
    agCfg={ activo:j.activo, horario_activo:j.horario_activo, hora_desde:j.hora_desde, hora_hasta:j.hora_hasta, dias_semana:j.dias_semana, timezone:j.timezone, updated_at:j.updated_at };
    document.getElementById('ag-saved').textContent='Guardado ✓ '+new Date().toLocaleTimeString('es-AR');
    document.getElementById('ag-chip').innerHTML=agChip();
    btn.textContent='Guardar cambios';
  } catch(e){ err.textContent='No se pudo guardar: '+e.message; err.style.display='block'; btn.disabled=false; btn.textContent='Guardar cambios'; }
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

// Guardas: estos elementos son del CRM de empresas y no existen en este CRM.
// Sin el chequeo, getElementById(...).addEventListener rompía TODO el init.
var _plFiltroEstado = document.getElementById('filtro-estado');
if (_plFiltroEstado) _plFiltroEstado.addEventListener('change', renderTabla);
var _plFiltroBuscar = document.getElementById('filtro-buscar');
if (_plFiltroBuscar) _plFiltroBuscar.addEventListener('input', function() {
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
  waCargarEstadoCanal(); // estado de conexión del número de ventas (banner)
  try {
    // Solo el canal de ventas: las conversaciones de empresas quedan en el CRM de empresas.
    var res = await fetch(API_URL + '/api/whatsapp/conversaciones?canal=ventas');
    if (!res.ok) throw new Error('Error ' + res.status);
    waConversaciones = await res.json();
    renderConversacionesWA();
    actualizarBadgeNoLeidos();
  } catch (err) {
    document.getElementById('wa-convos').innerHTML = '<div class="empty-state" style="padding:40px 20px;"><p>' + esc(err.message) + '</p></div>';
  }
}

// ── Conexión del número de ventas (embedded signup de Kapso) ──
var waCanalVentas = null;
var _waPollConexion = null;
var waSetupUrl = null; // URL de embedded signup de Kapso (para el link de respaldo)

async function waCargarEstadoCanal() {
  try {
    var r = await fetch(API_URL + '/api/whatsapp/canales');
    if (!r.ok) return;
    var canales = await r.json();
    waCanalVentas = (canales || []).find(function(c) { return c.canal === 'ventas'; }) || null;
    waRenderBanner();
  } catch (e) {}
}

function waRenderBanner() {
  var el = document.getElementById('wa-connect-banner');
  if (!el) return;
  var estado = waCanalVentas && waCanalVentas.estado;
  if (estado === 'conectado') {
    var num = (waCanalVentas.display_phone_number || '').trim();
    el.innerHTML = '<div style="padding:8px 14px;font-size:11.5px;color:#16a34a;background:#f0fdf4;border-bottom:1px solid #dcfce7;">&#9989; WhatsApp de ventas conectado' + (num ? ' &middot; <b>' + esc(num) + '</b>' : '') + '</div>';
  } else if (estado === 'pendiente') {
    // Link REAL a Kapso (un <a> nunca lo bloquea el navegador). Si no tenemos la
    // URL (ej: recarga de página), ofrecemos "Reabrir" que regenera el link.
    var abrir = waSetupUrl
      ? '<a href="' + esc(waSetupUrl) + '" target="_blank" rel="noopener" style="background:#25d366;color:#fff;padding:6px 12px;border-radius:7px;font-size:12px;font-weight:700;font-family:inherit;text-decoration:none;display:inline-block;">Abrir Kapso</a>'
      : '<button onclick="waConectar()" style="background:#25d366;border:none;color:#fff;padding:6px 12px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Reabrir</button>';
    el.innerHTML = '<div style="padding:12px 14px;background:#fffbeb;border-bottom:1px solid #fde68a;font-size:12px;color:#92400e;line-height:1.5;">Conexión en proceso. Abrí el alta en Kapso, completala y después tocá <b>Verificar</b>. Si no se abrió la ventana sola, usá el botón <b>Abrir Kapso</b>.'
      + '<div style="margin-top:8px;display:flex;gap:8px;">' + abrir
      + '<button onclick="waVerificarConexion(true)" style="background:#fff;border:1px solid #d1d5db;color:#374151;padding:6px 12px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Verificar</button></div></div>';
  } else {
    el.innerHTML = '<div style="padding:14px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;color:#475569;line-height:1.5;">El WhatsApp del bot de ventas todav&iacute;a no est&aacute; conectado (es un n&uacute;mero aparte del de empresas).'
      + '<div style="margin-top:9px;"><button onclick="waConectar()" style="background:#25d366;border:none;color:#fff;padding:8px 14px;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;">Conectar WhatsApp</button></div></div>';
  }
}

async function waConectar() {
  // La pestaña se abre YA, sincrónico con el click. Si se abriera después del
  // await (como antes), el navegador la bloquea y "no hace nada". Luego la
  // redirigimos a la URL de Kapso; si el navegador igual la bloqueó, queda el
  // link "Abrir Kapso" en el banner como respaldo.
  var win = null;
  try { win = window.open('about:blank', '_blank'); } catch (_) {}
  try {
    var r = await fetch(API_URL + '/api/whatsapp/canales/ventas/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-email': _currentUserEmail },
      body: JSON.stringify({ base_url: location.origin })
    });
    var j = await r.json();
    if (!r.ok) throw new Error((j && (j.error || (j.detalle && j.detalle.error))) || ('status ' + r.status));
    waSetupUrl = j.url || null;
    if (waSetupUrl && win) { try { win.opener = null; } catch (_) {} win.location.href = waSetupUrl; }
    else if (win) { try { win.close(); } catch (_) {} }
    waCanalVentas = { canal: 'ventas', estado: 'pendiente' };
    waRenderBanner();
    if (_waPollConexion) clearInterval(_waPollConexion);
    _waPollConexion = setInterval(function(){ waVerificarConexion(false); }, 8000);
  } catch (e) {
    if (win) { try { win.close(); } catch (_) {} }
    alert('No se pudo iniciar la conexión: ' + e.message);
  }
}

async function waVerificarConexion(avisar) {
  try {
    var r = await fetch(API_URL + '/api/whatsapp/canales/ventas/status');
    var j = await r.json();
    if (j && j.estado === 'conectado') {
      if (_waPollConexion) { clearInterval(_waPollConexion); _waPollConexion = null; }
      waCanalVentas = { canal: 'ventas', estado: 'conectado', phone_number_id: j.phone_number_id, display_phone_number: j.display_phone_number };
      waRenderBanner();
      cargarConversacionesWA();
    } else if (avisar) {
      alert('Todavía no aparece conectado. Terminá el alta en la ventana de Kapso y probá de nuevo en unos segundos.');
    }
  } catch (e) { if (avisar) alert('No se pudo verificar: ' + e.message); }
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

// Muestra el contenido de un mensaje: texto normal, o media limpia (los audios/imágenes
// vienen de Kapso como "Audio attached (...) URL: ... Transcript: ..." — mostramos solo lo útil).
function contenidoMensajeWA(m) {
  var c = m.contenido || '';
  var mt = /^(image|audio|video|document|sticker)\s+attached/i.exec(c);
  if (mt) {
    var t = /Transcript(?:ion)?:\s*([\s\S]+)/i.exec(c);
    if (t) return esc(t[1].trim()); // audio transcripto → mostramos el texto
    var label = { image: 'Imagen', audio: 'Audio', video: 'Video', document: 'Documento', sticker: 'Sticker' }[mt[1].toLowerCase()] || 'Archivo';
    return '<span style="opacity:.7;font-style:italic;">[' + label + ']</span>';
  }
  return esc(c);
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
    html += '<div class="wa-msg ' + cls + '">' + contenidoMensajeWA(m) + '<div class="msg-time">' + time + '</div></div>';
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
    var res = await fetch(API_URL + '/api/whatsapp/conversaciones?canal=ventas');
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
  var list = !q ? allContactos.slice() : allContactos.filter(function(c) {
    return (c.nombre||'').toLowerCase().indexOf(q)!==-1 || (c.empresa||'').toLowerCase().indexOf(q)!==-1 || (c.telefono||'').indexOf(q)!==-1 || (c.email||'').toLowerCase().indexOf(q)!==-1;
  });
  var ordenEl = document.getElementById('ct-orden');
  var orden = ordenEl ? ordenEl.value : 'recientes';
  if (orden === 'recientes') {
    list.sort(function(a,b){ return new Date(b.created_at||0) - new Date(a.created_at||0); });
  } else {
    list.sort(function(a,b){ return (a.nombre||'').localeCompare(b.nombre||'', 'es', {sensitivity:'base'}); });
  }
  return list;
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

// ══════════════════════════════════════════════════════════════════════════
// BLOQUE 2 — pipeline (window.pl*)
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var PL_STAGES = [
    { key:'en conversación', label:'En conversación', color:'#3B82F6' },
    { key:'venta de equipo', label:'Pidió comprar equipo', color:'#8B5CF6' },
    { key:'contactar manualmente', label:'Contactar manualmente', color:'#F59E0B' },
    { key:'aguardando instalacion', label:'Aguardando instalación', color:'#16A34A' },
    { key:'no calificado', label:'No calificado', color:'#9CA3AF' },
    { key:'sin cobertura', label:'Sin cobertura', color:'#9CA3AF' }
  ];
  var plLeads = [];
  var plModalReady = false;
  var _plDragId = null;

  function plEsc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function plHeaders(){ return { 'Content-Type':'application/json', 'x-user-email': _currentUserEmail }; }
  function plOptsFor(etapa){ return PL_STAGES.map(function(s){ return '<option value="'+s.key+'"'+(s.key===etapa?' selected':'')+'>'+s.label+'</option>'; }).join(''); }

  var PL_TEL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>';

  function plCardHtml(l){
    var mm = /Modelo:\s*([^·]+)/.exec(l.notas||''); var modelo = mm ? mm[1].trim() : '';
    return '<div class="pl-card" draggable="true" data-id="'+l.id+'" onclick="plVer(\''+l.id+'\')" ondragstart="plDragStart(event)" ondragend="plDragEnd(event)">'
      + '<div class="pl-card-top"><div class="pl-card-name">'+plEsc(l.nombre||'(sin nombre)')+'</div>'
      + '<button class="pl-card-x" title="Sacar del pipeline" onclick="event.stopPropagation();plDel(\''+l.id+'\')">&times;</button></div>'
      + (l.telefono?'<div class="pl-card-tel">'+PL_TEL_SVG+plEsc(l.telefono)+'</div>':'')
      + ((l.localidad||l.email||modelo)?('<div class="pl-card-tags">'
          + (l.localidad?'<span class="pl-chip loc">'+plEsc(l.localidad)+'</span>':'')
          + (modelo?'<span class="pl-chip eq">'+plEsc(modelo)+'</span>':'')
          + (l.email?'<span class="pl-chip">'+plEsc(l.email)+'</span>':'')
        + '</div>'):'')
      + '</div>';
  }

  function plRender(){
    document.getElementById('pl-total').textContent = plLeads.length + ' contacto' + (plLeads.length===1?'':'s') + ' en total';
    var html = '<div class="pl-board">';
    PL_STAGES.forEach(function(st){
      var rows = plLeads.filter(function(l){ return l.etapa === st.key; });
      html += '<div class="pl-col">'
        + '<div class="pl-col-head" style="background:'+st.color+'14;border-left-color:'+st.color+'">'
        +   '<span class="pl-col-name" style="color:'+st.color+'">'+plEsc(st.label)+'</span>'
        +   '<span class="pl-col-count" style="background:'+st.color+'22;color:'+st.color+'">'+rows.length+'</span>'
        + '</div>'
        + '<div class="pl-col-body" data-stage="'+plEsc(st.key)+'" ondragover="plDragOver(event)" ondragleave="plDragLeave(event)" ondrop="plDrop(event,\''+st.key+'\')">'
        +   (rows.length? rows.map(plCardHtml).join('') : '<div class="pl-vacio">Vacío</div>')
        + '</div></div>';
    });
    html += '</div>';
    document.getElementById('pl-stages-slot').innerHTML = html;
    plNotificarHandoffs();
  }

  // ── Derivaciones a humano: badge en Pipeline + popup (una vez por día) ──
  var _plNotiMostrada = false;
  function plNotificarHandoffs(){
    var handoffs = plLeads.filter(function(l){ return l.etapa === 'contactar manualmente'; });
    var badge = document.getElementById('pipeline-badge');
    if (badge) badge.textContent = handoffs.length ? handoffs.length : '';
    if (!_plNotiMostrada && handoffs.length){
      _plNotiMostrada = true;
      var hoy = new Date().toISOString().slice(0,10);
      if (localStorage.getItem('pl_handoff_'+hoy) !== '1'){
        var body = document.getElementById('pl-noti-body');
        if (body){
          body.innerHTML = handoffs.map(function(l){
            return '<div class="cal-noti-item"><span><b>'+plEsc(l.nombre||'(sin nombre)')+'</b>'
              + (l.telefono?' &middot; '+plEsc(l.telefono):'')+(l.localidad?' &middot; '+plEsc(l.localidad):'')+'</span></div>';
          }).join('');
          document.getElementById('pl-noti').classList.add('open');
        }
      }
    }
  }
  window.plCerrarNotiHandoff = function(){
    document.getElementById('pl-noti').classList.remove('open');
    localStorage.setItem('pl_handoff_'+new Date().toISOString().slice(0,10), '1');
  };

  window.plLoad = async function(){
    if (!plModalReady){ var em = document.getElementById('plm-etapa'); if (em){ em.innerHTML = plOptsFor(''); plModalReady = true; } }
    var slot = document.getElementById('pl-stages-slot');
    if (slot) slot.innerHTML = '<div class="pl-loading">Cargando…</div>';
    var intentos = 0;
    async function intento(){
      intentos++;
      var ctrl = new AbortController();
      var to = setTimeout(function(){ ctrl.abort(); }, 12000); // corta si el backend se cuelga
      try {
        var r = await fetch(API_URL + '/api/sales-bot/pipeline', { headers: { 'x-user-email': _currentUserEmail }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error('status ' + r.status);
        plLeads = await r.json();
        plRender();
      } catch(e){
        clearTimeout(to);
        if (intentos < 2) return intento(); // 1 reintento automático (cold-start del backend)
        var msg = (e && e.name === 'AbortError') ? 'La carga tardó demasiado (el servidor no respondió).' : ('Error al cargar: ' + plEsc(e && e.message || 'desconocido'));
        if (slot) slot.innerHTML = '<div class="pl-loading" style="color:#991B1B">' + msg + ' <button class="pl-btn pl-btn-primary" style="margin-left:10px;padding:6px 14px" onclick="plLoad()">Reintentar</button></div>';
      }
    }
    await intento();
  };
  window.plMove = async function(id, etapa){
    var l = plLeads.find(function(x){ return x.id===id; });
    var prev = l ? l.etapa : null;
    if (l) l.etapa = etapa;
    plRender(); // optimista
    try { var r = await fetch(API_URL + '/api/sales-bot/pipeline/' + id, { method:'PATCH', headers: plHeaders(), body: JSON.stringify({ etapa: etapa }) }); if (!r.ok) throw new Error('status '+r.status); }
    catch(e){ if (l) l.etapa = prev; plRender(); alert('No se pudo mover: ' + e.message); }
  };
  window.plDel = async function(id){
    if (!confirm('¿Sacar este lead del CRM?')) return;
    try { var r = await fetch(API_URL + '/api/sales-bot/pipeline/' + id, { method:'DELETE', headers: { 'x-user-email': _currentUserEmail } }); if (!r.ok) throw new Error('status '+r.status); plLeads = plLeads.filter(function(x){ return x.id!==id; }); plRender(); }
    catch(e){ alert('No se pudo eliminar: ' + e.message); }
  };

  // ── Drag & drop entre columnas ──
  window.plDragStart = function(e){ _plDragId = e.currentTarget.getAttribute('data-id'); e.currentTarget.classList.add('dragging'); if (e.dataTransfer){ e.dataTransfer.effectAllowed='move'; try{ e.dataTransfer.setData('text/plain', _plDragId); }catch(_){} } };
  window.plDragEnd = function(e){ e.currentTarget.classList.remove('dragging'); };
  window.plDragOver = function(e){ e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect='move'; e.currentTarget.classList.add('drag-over'); };
  window.plDragLeave = function(e){ if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drag-over'); };
  window.plDrop = function(e, etapa){ e.preventDefault(); e.currentTarget.classList.remove('drag-over'); var id = _plDragId || (e.dataTransfer && e.dataTransfer.getData('text/plain')); _plDragId = null; if (!id) return; var l = plLeads.find(function(x){ return x.id===id; }); if (!l || l.etapa===etapa) return; plMove(id, etapa); };

  window.plOpenModal = function(){ if (!plModalReady){ document.getElementById('plm-etapa').innerHTML = plOptsFor(''); plModalReady = true; } document.getElementById('pl-modal').classList.add('open'); };
  window.plCloseModal = function(){ document.getElementById('pl-modal').classList.remove('open'); ['plm-nombre','plm-telefono','plm-email','plm-localidad'].forEach(function(id){ document.getElementById(id).value=''; }); };
  window.plSaveLead = async function(){
    var btn = document.getElementById('plm-save');
    var body = { nombre:document.getElementById('plm-nombre').value.trim(), telefono:document.getElementById('plm-telefono').value.trim(), email:document.getElementById('plm-email').value.trim(), localidad:document.getElementById('plm-localidad').value.trim(), etapa:document.getElementById('plm-etapa').value };
    if (!body.nombre && !body.telefono){ alert('Poné al menos nombre o teléfono'); return; }
    btn.disabled = true;
    try { var r = await fetch(API_URL + '/api/sales-bot/pipeline', { method:'POST', headers: plHeaders(), body: JSON.stringify(body) }); var j = await r.json(); if (!r.ok) throw new Error(j.error||('status '+r.status)); plLeads.unshift(j); plCloseModal(); plRender(); }
    catch(e){ alert('No se pudo agregar: ' + e.message); }
    finally { btn.disabled = false; }
  };

  // ── Detalle del lead (abrir tarjeta) ──
  window.plVer = function(id){
    var l = plLeads.find(function(x){ return x.id===id; });
    if (!l) return;
    var stage = PL_STAGES.find(function(s){ return s.key===l.etapa; }) || {label:l.etapa,color:'#64748b'};
    // notas del bot: "Modelo: X · Tipo: Y · Personas: Z · CUIT/CUIL: W · Dir: V"
    var ex = {};
    (l.notas||'').split(' · ').forEach(function(p){ var i=p.indexOf(':'); if(i>0){ ex[p.slice(0,i).trim()] = p.slice(i+1).trim(); } });
    function row(k,v){ return v ? '<div class="pld-row"><span class="pld-k">'+plEsc(k)+'</span><span class="pld-v">'+plEsc(v)+'</span></div>' : ''; }
    var fecha=''; try{ if(l.created_at) fecha=new Date(l.created_at).toLocaleString('es-AR'); }catch(_){}
    var html = '<div class="pld-etapa" style="background:'+stage.color+'1e;color:'+stage.color+'">'+plEsc(stage.label)+'</div>'
      + row('Teléfono', l.telefono)
      + row('Email', l.email)
      + row('Localidad', l.localidad)
      + row('Equipo', ex['Modelo'])
      + row('Tipo', ex['Tipo'])
      + row('Personas', ex['Personas'])
      + row('CUIT/CUIL', ex['CUIT/CUIL'] || ex['CUIT'] || ex['CUIL'])
      + row('Dirección', ex['Dir'] || ex['Dirección'])
      + row('Ingreso', fecha)
      + '<label class="pld-lbl">Notas</label>'
      + '<textarea id="pld-notas" class="pld-ta">'+plEsc(l.notas||'')+'</textarea>'
      + '<div class="pl-modal-actions"><button class="pl-btn pl-btn-primary" onclick="plGuardarNotas(\''+l.id+'\')">Guardar notas</button></div>';
    document.getElementById('pld-nombre-txt').textContent = l.nombre || '(sin nombre)';
    document.getElementById('pld-body').innerHTML = html;
    document.getElementById('pl-detalle').classList.add('open');
  };
  window.plVerClose = function(){ document.getElementById('pl-detalle').classList.remove('open'); };
  window.plGuardarNotas = async function(id){
    var notas = document.getElementById('pld-notas').value;
    try {
      var r = await fetch(API_URL + '/api/sales-bot/pipeline/' + id, { method:'PATCH', headers: plHeaders(), body: JSON.stringify({ notas: notas }) });
      if (!r.ok) throw new Error('status '+r.status);
      var l = plLeads.find(function(x){ return x.id===id; }); if (l) l.notas = notas;
      plVerClose(); plRender();
    } catch(e){ alert('No se pudo guardar: '+e.message); }
  };
})();

// ══════════════════════════════════════════════════════════════════════════
// BLOQUE 3 — probar-bot (window.pb*)
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var PB_LABELS = [['nombre','Nombre'],['telefono','Teléfono'],['email','Email'],['localidad','Localidad'],['tipo_interes','Tipo (empresa/casa)'],['tipo_empresa','Tipo de empresa'],['cantidad_personas','Personas'],['direccion','Dirección instalación'],['modelo_interes','Modelo de interés']];
  var PB_TERMINAL = {
    'aguardando instalacion':{bg:'#ECFDF5',brd:'#A7F3D0',fg:'#065F46',text:'✅ Cierre completo. En producción este lead se movería a "Aguardando instalación".'},
    'sin cobertura':{bg:'#F9FAFB',brd:'#E5E7EB',fg:'#6B7280',text:'Fuera de cobertura — lead descartado (tag: sin cobertura).'},
    'no calificado':{bg:'#F9FAFB',brd:'#E5E7EB',fg:'#6B7280',text:'Off-topic / sin intención (tag: no calificado).'},
    'contactar manualmente':{bg:'#FFFBEB',brd:'#FDE68A',fg:'#92400E',text:'Derivado a un asesor humano (tag: contactar manualmente).'}
  };
  var pbMsgs = [];
  var pbSending = false;
  function pbEsc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function pbRenderChat(){
    var c = document.getElementById('pb-chat');
    if (pbMsgs.length===0){ c.innerHTML = '<div class="pb-empty">Escribí un mensaje como cliente (ej: "Hola, quería info de los dispensers para mi casa en Santa Fe").</div>'; return; }
    c.innerHTML = pbMsgs.map(function(m){ return '<div class="pb-bubble '+(m.role==='user'?'pb-in':'pb-out')+'">'+pbEsc(m.content)+'</div>'; }).join('');
    c.scrollTop = c.scrollHeight;
  }
  function pbRenderDatos(d){ d=d||{}; document.getElementById('pb-datos').innerHTML = PB_LABELS.map(function(p){ var v=d[p[0]]; return '<div class="pb-field"><div class="l">'+p[1]+'</div><div class="v'+(v?'':' empty')+'">'+(v?pbEsc(v):'—')+'</div></div>'; }).join(''); }
  function pbRenderTag(tag){ document.getElementById('pb-tag').textContent = tag; var t=PB_TERMINAL[tag]; document.getElementById('pb-banner').innerHTML = t ? '<div class="pb-banner" style="background:'+t.bg+';border:1px solid '+t.brd+';color:'+t.fg+'">'+t.text+'</div>' : ''; }
  window.pbInit = function(){ pbRenderDatos({}); };
  window.pbSend = async function(){
    var inp = document.getElementById('pb-input'); var text = inp.value.trim();
    if (!text || pbSending) return;
    document.getElementById('pb-err').innerHTML='';
    pbMsgs.push({role:'user',content:text}); inp.value=''; pbRenderChat();
    pbSending=true; var btn=document.getElementById('pb-send'); btn.disabled=true; btn.textContent='…';
    try {
      var r = await fetch(API_URL + '/api/sales-bot/test', { method:'POST', headers:{'Content-Type':'application/json','x-user-email':_currentUserEmail}, body: JSON.stringify({ company_name:'Yakú Agua Saludable', business_context: document.getElementById('pb-ctx').value, messages: pbMsgs }) });
      var j = await r.json(); if (!r.ok) throw new Error(j.error||('status '+r.status));
      pbMsgs.push({role:'assistant',content:j.reply}); pbRenderChat(); pbRenderDatos(j.datos); pbRenderTag(j.tag||'en conversación');
    } catch(e){ pbMsgs.pop(); pbRenderChat(); document.getElementById('pb-err').innerHTML='<div class="pb-err">'+pbEsc(e.message)+'</div>'; }
    finally { pbSending=false; btn.disabled=false; btn.textContent='Enviar'; }
  };
  window.pbReset = function(){ pbMsgs=[]; pbRenderChat(); pbRenderDatos({}); pbRenderTag('en conversación'); document.getElementById('pb-err').innerHTML=''; };
  var pbInputEl = document.getElementById('pb-input');
  if (pbInputEl) pbInputEl.addEventListener('keydown', function(e){ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); pbSend(); } });
  pbRenderDatos({});
})();

// ══════════════════════════════════════════════════════════════════════════
// AGENDA — calendario de instalaciones (SLA 72hs hábiles) + notificaciones
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var calEventos = [];
  var calAnio = null, calMesN = null;   // mes visible (0-11)
  var calNotis = null;
  var MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  var DOW = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

  function calHeaders(){ return { 'x-user-email': _currentUserEmail }; }
  function hoyAR(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires'}).format(new Date()); }
  function ymd(y,m,d){ return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }

  window.calHoy = function(){ var h=hoyAR().split('-'); calAnio=+h[0]; calMesN=+h[1]-1; calCargar(); };
  window.calMes = function(delta){
    if (calAnio==null){ calHoy(); return; }
    calMesN += delta;
    if (calMesN<0){ calMesN=11; calAnio--; }
    if (calMesN>11){ calMesN=0; calAnio++; }
    calCargar();
  };

  window.calCargar = async function(){
    if (calAnio==null){ var h=hoyAR().split('-'); calAnio=+h[0]; calMesN=+h[1]-1; }
    var slot=document.getElementById('cal-slot');
    var t=document.getElementById('cal-title'); if(t) t.textContent = MESES[calMesN]+' '+calAnio;
    if (slot) slot.innerHTML='<div class="cal-loading">Cargando…</div>';
    var desde=ymd(calAnio,calMesN,1);
    var ultimo=new Date(calAnio,calMesN+1,0).getDate();
    var hasta=ymd(calAnio,calMesN,ultimo);
    try {
      var r=await fetch(API_URL+'/api/agenda?desde='+desde+'&hasta='+hasta,{headers:calHeaders()});
      calEventos = r.ok ? await r.json() : [];
      calRender();
    } catch(e){ if(slot) slot.innerHTML='<div class="cal-loading" style="color:#991B1B">Error: '+esc(e.message)+'</div>'; }
  };

  function evClase(e){
    if (e.estado==='hecho') return 'hecho';
    var h=hoyAR(); var fl=String(e.fecha_limite).slice(0,10);
    if (fl<h) return 'vencida';
    if (fl===h) return 'hoy';
    return 'pendiente';
  }

  function calRender(){
    var slot=document.getElementById('cal-slot'); if(!slot) return;
    var porDia={};
    calEventos.forEach(function(e){ var d=String(e.fecha_limite).slice(0,10); (porDia[d]=porDia[d]||[]).push(e); });
    var primero=new Date(Date.UTC(calAnio,calMesN,1,12)).getUTCDay(); // 0=dom..6=sab
    var offset=(primero+6)%7; // lun=0
    var ultimo=new Date(calAnio,calMesN+1,0).getDate();
    var h=hoyAR();
    var html='<div class="cal-grid">';
    DOW.forEach(function(d){ html+='<div class="cal-dow">'+d+'</div>'; });
    for(var i=0;i<offset;i++) html+='<div class="cal-cell otro"></div>';
    for(var day=1;day<=ultimo;day++){
      var f=ymd(calAnio,calMesN,day);
      var evs=porDia[f]||[];
      html+='<div class="cal-cell'+(f===h?' hoy':'')+'">'
        + '<div class="cal-num">'+day+'</div>'
        + evs.slice(0,3).map(function(e){ return '<div class="cal-ev '+evClase(e)+'" onclick="calAbrirDia(\''+f+'\')" title="'+esc(e.nombre||e.telefono||'')+'">'+esc(e.nombre||e.telefono||'(sin nombre)')+'</div>'; }).join('')
        + (evs.length>3 ? '<div class="cal-ev pendiente" onclick="calAbrirDia(\''+f+'\')">+'+(evs.length-3)+' más</div>' : '')
        + '</div>';
    }
    html+='</div>';
    slot.innerHTML=html;
  }

  window.calAbrirDia = function(f){
    var evs=calEventos.filter(function(e){ return String(e.fecha_limite).slice(0,10)===f; });
    var p=f.split('-');
    document.getElementById('cal-modal-title').textContent='Instalaciones — '+p[2]+'/'+p[1]+'/'+p[0];
    document.getElementById('cal-modal-body').innerHTML = evs.length ? evs.map(function(e){
      var cls=evClase(e);
      var chip = cls==='vencida'?'<span class="cal-chip vencida">vencida</span>':(cls==='hoy'?'<span class="cal-chip hoy">vence hoy</span>':(cls==='hecho'?'<span class="cal-chip hecho">hecho</span>':''));
      // Planilla pre-cargada: todos los datos que capturó el bot al cerrar.
      return '<div class="cal-item'+(e.estado==='hecho'?' hecho':'')+'">'
        + '<div class="n">'+esc(e.nombre||'(sin nombre)')+chip+'</div>'
        + '<div class="m" style="line-height:1.7;">'
        +   (e.telefono?'&#128222; '+esc(e.telefono)+'<br>':'')
        +   (e.email?'&#9993; '+esc(e.email)+'<br>':'')
        +   (e.localidad?'&#128205; '+esc(e.localidad)+'<br>':'')
        +   (e.notas?'&#128203; '+esc(e.notas):'')
        + '</div>'
        + '<div class="acc" style="display:flex;gap:8px;flex-wrap:wrap;">'
        +   '<button class="cal-btn" style="background:#0ea5e9;color:#fff;" onclick="calCopiarPlanilla(\''+e.id+'\')">Copiar planilla</button>'
        +   (e.estado==='hecho' ? '' : '<button class="cal-btn cal-btn-done" onclick="calMarcarHecho(\''+e.id+'\')">Marcar como contactado</button>')
        + '</div>'
        + '</div>';
    }).join('') : '<div style="color:#9ca3af;font-size:13px">Sin instalaciones este día.</div>';
    document.getElementById('cal-modal').classList.add('open');
  };
  window.calCopiarPlanilla = function(id){
    var e = calEventos.find(function(x){ return x.id===id; }); if(!e) return;
    var txt = ['PLANILLA — INSTALACIÓN (cierre del bot)',
      'Nombre: '+(e.nombre||''),
      'Teléfono: '+(e.telefono||''),
      'Email: '+(e.email||''),
      'Localidad: '+(e.localidad||''),
      (e.notas||''),
      'Contactar antes de (72hs háb.): '+e.fecha_limite].filter(Boolean).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(function(){ alert('Planilla copiada al portapapeles.'); }, function(){ window.prompt('Copiá los datos:', txt); });
    } else { window.prompt('Copiá los datos:', txt); }
  };
  window.calCerrarDia = function(){ document.getElementById('cal-modal').classList.remove('open'); };

  window.calMarcarHecho = async function(id){
    try {
      var r=await fetch(API_URL+'/api/agenda/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','x-user-email':_currentUserEmail},body:JSON.stringify({estado:'hecho'})});
      if(!r.ok) throw new Error('status '+r.status);
      var e=calEventos.find(function(x){return x.id===id;}); if(e) e.estado='hecho';
      calRender(); calCerrarDia(); calCargarNotis();
    } catch(err){ alert('No se pudo marcar: '+err.message); }
  };

  // ── Notificaciones: badge en el sidebar + popup una vez por día ──
  window.calCargarNotis = async function(){
    try {
      var r=await fetch(API_URL+'/api/agenda/notificaciones',{headers:calHeaders()});
      if(!r.ok) return;
      calNotis=await r.json();
      var badge=document.getElementById('agenda-badge');
      if(badge) badge.textContent = calNotis.urgentes>0 ? calNotis.urgentes : '';
      if (calNotis.urgentes>0 && localStorage.getItem('agenda_noti_'+calNotis.hoy)!=='1') calPopupNotis();
    } catch(e){}
  };
  function calPopupNotis(){
    if(!calNotis) return;
    var urg=calNotis.items.filter(function(i){ return i.urgencia==='vencida'||i.urgencia==='hoy'; });
    if(!urg.length) return;
    document.getElementById('cal-noti-body').innerHTML = urg.map(function(i){
      var chip = i.urgencia==='vencida'?'<span class="cal-chip vencida">vencida</span>':'<span class="cal-chip hoy">vence hoy</span>';
      return '<div class="cal-noti-item"><span><b>'+esc(i.nombre||'(sin nombre)')+'</b>'+(i.localidad?' &middot; '+esc(i.localidad):'')+'</span>'+chip+'</div>';
    }).join('');
    document.getElementById('cal-noti').classList.add('open');
  }
  window.calCerrarNotis = function(){
    document.getElementById('cal-noti').classList.remove('open');
    if(calNotis) localStorage.setItem('agenda_noti_'+calNotis.hoy,'1');
  };
})();

// ══════════════════════════════════════════════════════════════════════════
// CERRADOS POR BOT — métrica (solo info@wearebilab.com)
// ══════════════════════════════════════════════════════════════════════════
window.cerLoad = async function(){
  var slot = document.getElementById('cer-slot'); if(!slot) return;
  slot.innerHTML = '<div class="cer-loading">Cargando…</div>';
  try {
    var hdr = { 'x-user-email': _currentUserEmail };
    var res = await Promise.all([
      fetch(API_URL + '/api/sales-bot/cerrados-stats', { headers: hdr }).then(function(r){ return r.ok?r.json():{total:0,por_mes:[]}; }),
      fetch(API_URL + '/api/sales-bot/uso-stats', { headers: hdr }).then(function(r){ return r.ok?r.json():{total_usd:0,mes_usd:0}; })
    ]);
    var d = res[0], u = res[1];
    var meses = d.por_mes || [];
    var max = meses.reduce(function(a,m){ return Math.max(a, m.cantidad||0); }, 1);
    var MESN = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    function fmtMes(k){ var p=String(k).split('-'); return MESN[(+p[1]-1)]+' '+p[0]; }
    function usd(n){ return 'US$ '+(Number(n)||0).toFixed(2); }
    var html = '<div class="cer-cards">'
      + '<div class="cer-total-card"><span class="cer-total-num">'+(d.total||0)+'</span><span class="cer-total-lbl">ventas cerradas por el bot</span></div>'
      + '<div class="cer-total-card cer-gasto"><span class="cer-total-num">'+usd(u.total_usd)+'</span><span class="cer-total-lbl">gasto estimado en IA</span><span class="cer-gasto-mes">Este mes: '+usd(u.mes_usd)+'</span></div>'
      + '</div>';
    if (meses.length){
      html += '<div class="cer-meses-t">Por mes</div><div class="cer-meses">' + meses.map(function(m){
        var w = Math.round((m.cantidad||0)/max*100);
        return '<div class="cer-mes-row"><span class="cer-mes-lbl">'+esc(fmtMes(m.mes))+'</span>'
          + '<div class="cer-bar-wrap"><div class="cer-bar" style="width:'+w+'%"></div></div>'
          + '<span class="cer-mes-val">'+(m.cantidad||0)+'</span></div>';
      }).join('') + '</div>';
    } else {
      html += '<div class="cer-empty">Todavía no hay ventas cerradas por el bot.</div>';
    }
    slot.innerHTML = html;
  } catch(e){ slot.innerHTML = '<div class="cer-loading" style="color:#991B1B">Error: '+esc(e.message)+'</div>'; }
};

// ══════════════════════════════════════════════════════════════════════════
// Guardarraíl anti-fragilidad: con defer, todo esto ya está definido acá.
// Si a futuro alguien rompe el orden, lo gritamos en consola en vez de fallar
// en silencio con un "Cargando…" eterno.
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var criticas = ['switchView','plLoad','pbInit','agLoad','cargarConversacionesWA','pollWhatsApp','waVerificarConexion','waConectar','calCargar','calCargarNotis','calMes','cerLoad','waConectar'];
  var faltan = criticas.filter(function(n){ return typeof window[n] !== 'function'; });
  if (faltan.length) console.error('[CRM] Funciones de init sin definir (revisar carga):', faltan.join(', '));
})();
