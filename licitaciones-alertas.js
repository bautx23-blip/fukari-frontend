// fukari-frontend/licitaciones-alertas.js
// Pop-up global de alertas de licitaciones.
// Muestra una vez por día las licitaciones "por vencerse" o cercanas
// al cierre. El estado "ya vista hoy" se guarda en localStorage por key.

(function () {
  'use strict';

  const API_URL = location.hostname.indexOf('staging') !== -1
    ? 'https://fukari-backend-production-92f1.up.railway.app'
    : 'https://fukari-backend-production.up.railway.app';

  const STORAGE_PREFIX = 'lic_alert_seen_';
  const STORAGE_DATE_FMT = () => new Date().toISOString().slice(0, 10);

  function ensureStyles() {
    if (document.getElementById('lic-alert-styles')) return;
    const css = `
      .lic-alert-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;z-index:9999;}
      .lic-alert-card{background:#fff;border-radius:14px;width:100%;max-width:520px;padding:22px 24px;box-shadow:0 24px 60px rgba(15,23,42,.25);font-family:'Inter',Arial,sans-serif;color:#111827;}
      .lic-alert-card h3{font-size:16px;font-weight:700;color:#b45309;display:flex;align-items:center;gap:8px;margin-bottom:10px;}
      .lic-alert-card h3 .icon{font-size:20px;}
      .lic-alert-card p.intro{font-size:13px;color:#6b7280;margin-bottom:14px;}
      .lic-alert-list{display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;border-top:1px solid #f3f4f6;padding-top:12px;}
      .lic-alert-item{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;font-size:13px;}
      .lic-alert-item.danger{background:#fee2e2;border-color:#fecaca;}
      .lic-alert-item .org{font-weight:600;color:#1a1a2e;}
      .lic-alert-item .meta{font-size:11.5px;color:#92400e;text-transform:uppercase;letter-spacing:.04em;}
      .lic-alert-item.danger .meta{color:#b91c1c;}
      .lic-alert-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px;}
      .lic-alert-actions a{color:#2563eb;font-size:13px;text-decoration:none;font-weight:600;}
      .lic-alert-actions a:hover{text-decoration:underline;}
      .lic-alert-actions button{background:#1a1a2e;color:#fff;border:none;border-radius:7px;padding:8px 16px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;}
      .lic-alert-actions button:hover{background:#2d2d4e;}
    `;
    const style = document.createElement('style');
    style.id = 'lic-alert-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function alreadySeenToday(key) {
    try {
      return localStorage.getItem(STORAGE_PREFIX + key) === STORAGE_DATE_FMT();
    } catch { return false; }
  }

  function markSeenToday(keys) {
    try {
      const today = STORAGE_DATE_FMT();
      keys.forEach(k => localStorage.setItem(STORAGE_PREFIX + k, today));
    } catch {}
  }

  function fmtFecha(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function diasRestantes(iso) {
    if (!iso) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(iso); d.setHours(0,0,0,0);
    return Math.ceil((d - today) / (1000 * 60 * 60 * 24));
  }

  function showPopup(items) {
    ensureStyles();
    const overlay = document.createElement('div');
    overlay.className = 'lic-alert-overlay';
    overlay.innerHTML = `
      <div class="lic-alert-card" role="dialog" aria-modal="true">
        <h3><span class="icon">⚠️</span> Licitaciones que requieren atención</h3>
        <p class="intro">Tenés ${items.length} licitación${items.length === 1 ? '' : 'es'} próxima${items.length === 1 ? '' : 's'} a vencerse o cerrarse.</p>
        <div class="lic-alert-list">
          ${items.map(it => {
            const dias = it.dias_restantes != null ? it.dias_restantes : diasRestantes(it.vence);
            const danger = dias != null && dias <= 7;
            const lbl = it.tipo === 'activa_por_vencerse'
              ? `Vence ${fmtFecha(it.vence)} · ${dias} día${dias === 1 ? '' : 's'}`
              : `Cierra ${fmtFecha(it.fecha_cierre)} · ${dias} día${dias === 1 ? '' : 's'}`;
            return `
              <div class="lic-alert-item ${danger ? 'danger' : ''}">
                <div>
                  <div class="org">${escHtml(it.organismo)}</div>
                  <div class="meta">${it.tipo === 'activa_por_vencerse' ? 'Activa por vencerse' : 'A presentarse'}${it.orden_compra ? ' · OC ' + escHtml(it.orden_compra) : ''}</div>
                </div>
                <div style="white-space:nowrap;font-weight:600;color:${danger ? '#b91c1c' : '#92400e'};">${lbl}</div>
              </div>
            `;
          }).join('')}
        </div>
        <div class="lic-alert-actions">
          <a href="/licitaciones.html">Ir a Licitaciones →</a>
          <button type="button" id="lic-alert-close">Entendido</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('lic-alert-close').addEventListener('click', () => {
      markSeenToday(items.map(i => i.key));
      overlay.remove();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        markSeenToday(items.map(i => i.key));
        overlay.remove();
      }
    });
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function chequearAlertas() {
    try {
      const r = await fetch(API_URL + '/api/licitaciones/alertas');
      if (!r.ok) return;
      const d = await r.json();
      const items = [
        ...(d.activas_por_vencerse || []),
        ...(d.presentarse_alertas || []),
      ];
      const pendientes = items.filter(it => !alreadySeenToday(it.key));
      if (!pendientes.length) return;
      showPopup(pendientes);
    } catch (err) {
      // silencioso: alertas son secundarias
    }
  }

  // No mostrar en login ni dentro de la página de licitaciones (ya está ahí)
  if (document.body && !location.pathname.match(/(index|login|licitaciones)\.html$/i)) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', chequearAlertas);
    } else {
      chequearAlertas();
    }
  }
})();
