/* Rastreador da MinhaAventuraTDAH: visitas, cliques, tempo na página e rolagem. */
(function () {
  'use strict';
  var ENDPOINT = '/api/track';
  var ls = null, ss = null;
  try { ls = window.localStorage; ss = window.sessionStorage; } catch (e) {}

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function stored(store, key) {
    var v = null;
    try { v = store && store.getItem(key); } catch (e) {}
    if (!v) { v = uid(); try { store && store.setItem(key, v); } catch (e) {} }
    return v;
  }
  var VID = stored(ls, 'mat_vid');   // visitante (persistente)
  var SID = stored(ss, 'mat_sid');   // sessão (por aba)

  var qs = new URLSearchParams(location.search);
  var startedAt = Date.now();
  var maxScroll = 0;

  function send(kind, extra) {
    var body = {
      k: kind, v: VID, s: SID, p: location.pathname,
      w: window.innerWidth, h: window.innerHeight,
      lg: navigator.language || '', tz: '',
      r: document.referrer || '',
      us: qs.get('utm_source') || '', um: qs.get('utm_medium') || '', uc: qs.get('utm_campaign') || ''
    };
    try { body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key];
    var json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([json], { type: 'application/json' }))) return;
    } catch (e) {}
    try { fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }); } catch (e) {}
  }

  // 1) visita
  send('pv', {});

  // 2) cliques (qualquer clique; o rótulo vem do atributo data-track)
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-track]');
    var label = el ? el.getAttribute('data-track') : 'outro:' + (t.tagName || '').toLowerCase();
    var a = t.closest('a');
    send('ck', { l: label, hr: a ? a.href : '', x: Math.round(ev.clientX), y: Math.round(ev.clientY) });
  }, true);

  // 3) rolagem
  function onScroll() {
    var doc = document.documentElement;
    var total = Math.max(1, (doc.scrollHeight || 1) - window.innerHeight);
    var pct = Math.min(100, Math.round(((window.scrollY || doc.scrollTop || 0) / total) * 100));
    if (pct > maxScroll) maxScroll = pct;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 4) saída (tempo na página)
  var left = false;
  function leave() {
    if (left) return;
    left = true;
    send('lv', { d: Date.now() - startedAt, sd: maxScroll });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') leave(); });
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { left = false; startedAt = Date.now(); } });
})();
