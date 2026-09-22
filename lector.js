// lector.js — rol de SOLO LECTURA por email para el panel de gestión.
//
// Un lector ve Órdenes, Bajas, Clientes, Reportes y Stock, y no puede escribir
// nada. Se incluye en TODAS las páginas ANTES del cliente de Supabase, porque:
//   1) El guard de fetch se instala en el momento de cargar este script.
//      supabase-js captura window.fetch al crear el cliente, así que si este
//      script corriera después, las escrituras directas a PostgREST/Storage
//      pasarían por el fetch original.
//   2) En una página que no está permitida, redirige al hub apenas se conoce
//      la sesión, antes de que la página cargue datos.
// Para dar de alta un lector: agregar el email a LECTORES y crear el usuario en
// Supabase Auth (ver memoria del proyecto). Nada más.
(function () {
  var LECTORES = ['matimusso@gmail.com'];
  var PAGINAS_PERMITIDAS = ['/hub.html', '/yaku-panel.html', '/yaku-panel-bajas.html', '/yaku-clientes.html', '/yaku-reportes-v2.html', '/yaku-stock.html'];
  var SUPABASE_URL = 'https://bqjbblgbwgwqkziqzdyy.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxamJibGdid2d3cWt6aXF6ZHl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2Mjg4MTAsImV4cCI6MjA4ODIwNDgxMH0.DLXFYR4EgaejMbk3wBlU9SSVCi17YJ2aPiJc2h4y5mE';

  window._esLector = false;

  // ── 1. Guard de fetch (se instala YA, decide en cada llamada) ──────────────
  var fetchOriginal = window.fetch;
  window.fetch = function (input, init) {
    if (window._esLector) {
      var metodo = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var esAuth = url.indexOf('/auth/v1/') !== -1; // refresh de sesión y logout tienen que pasar
      if (!esAuth && metodo !== 'GET' && metodo !== 'HEAD' && metodo !== 'OPTIONS') {
        avisar();
        return Promise.reject(new Error('Usuario de solo lectura: no se puede modificar.'));
      }
    }
    return fetchOriginal.apply(this, arguments);
  };

  var _avisoTs = 0;
  function avisar() {
    var ahora = Date.now();
    if (ahora - _avisoTs < 3000) return; // no apilar avisos
    _avisoTs = ahora;
    var el = document.createElement('div');
    el.textContent = 'Tu usuario es de solo lectura: no se puede modificar nada.';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2937;color:#fff;padding:10px 16px;border-radius:8px;font:13px system-ui,sans-serif;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.3)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  // ── 2. Resolver el rol y aplicar restricciones ─────────────────────────────
  function aplicar(email) {
    if (LECTORES.indexOf(email) === -1) return;
    window._esLector = true;
    document.documentElement.classList.add('lector');

    var pagina = location.pathname === '/' ? '/hub.html' : location.pathname;
    if (PAGINAS_PERMITIDAS.indexOf(pagina) === -1) { location.replace('/hub.html'); return; }

    // Controles de escritura: links a formularios de carga y botones que guardan,
    // crean, borran o cambian estado. Va por CSS para que alcance también a lo que
    // se renderiza después (tablas, modales).
    var ocultar = [
      'a[href*="/yaku-orden-instalacion"]', 'a[href*="/yaku-orden-baja"]',
      '[onclick*="guardar"]', '[onclick*="crear"]', '[onclick*="eliminar"]', '[onclick*="borrar"]', '[onclick*="Borrar"]',
      '[onclick*="anular"]', '[onclick*="Anular"]', '[onclick*="marcarNoFactible"]', '[onclick*="toggleCompletada"]',
      '[onclick*="abrirFuente"]', '[onclick*="abrirEdicion"]', '[onclick*="editarRechazo"]', '[onclick*="agregarOpcion"]',
      '[onclick*="borrarOpcion"]', '[onclick*="togglePromo"]', '[onclick*="toggleStock"]', '[onclick*="togglePanelOpciones"]',
      '[onclick*="quitarEquipo"]', '[onclick*="agregarEquipo"]', '[onclick*="agregarProducto"]',
      '.btn-edit-orden', '.btn-del-orden',
    ];
    var css = 'html.lector ' + ocultar.join(', html.lector ') + ' { display: none !important; }'
      + 'html.lector input:not([type="date"]):not([type="search"]):not([type="text"]):not([type="hidden"]), html.lector select[id^="edit-"], html.lector textarea { pointer-events: none; opacity: .6; }';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Hub: dejar sólo los módulos de consulta. Corre después del script propio del
    // hub (que muestra/oculta por email) porque este handler es de DOMContentLoaded.
    if (pagina === '/hub.html') {
      document.querySelectorAll('.task-card').forEach(function (card) {
        var href = card.getAttribute('href') || '';
        card.style.display = PAGINAS_PERMITIDAS.indexOf(href) !== -1 ? '' : 'none';
      });
      var lbl = document.getElementById('user-email');
      if (lbl) lbl.textContent = email + ' · solo lectura';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.supabase || !window.supabase.createClient) return;
    var client = window.sb || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    client.auth.getSession().then(function (r) {
      var email = r && r.data && r.data.session && r.data.session.user && r.data.session.user.email;
      if (email) aplicar(email);
    });
  });
})();
