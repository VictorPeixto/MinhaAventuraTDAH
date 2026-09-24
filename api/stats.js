'use strict';
const { redis, safeEqual } = require('./_lib');

const TZ = 'America/Sao_Paulo';
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
});
const WEEK = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function local(t) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(t))) o[p.type] = p.value;
  const hour = Number(o.hour) % 24;
  return {
    day: `${o.year}-${o.month}-${o.day}`, hour, wd: WEEK[o.weekday] || 0,
    text: `${o.day}/${o.month}/${o.year} ${String(hour).padStart(2, '0')}:${o.minute}:${o.second}`,
  };
}
const inc = (m, k, by) => { m.set(k, (m.get(k) || 0) + (by || 1)); };
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const place = (e) => [e.ci, e.rg, e.co].filter(Boolean).join(', ') || 'Local desconhecido';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const want = process.env.ANALYTICS_PASSWORD || '';
  if (!want) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'ANALYTICS_PASSWORD não configurada' })); }
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(auth, want)) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'senha incorreta' })); }

  try {
    const url = new URL(req.url, 'http://x');
    const range = url.searchParams.get('range') || '7';
    const days = range === 'all' ? 0 : Math.max(1, Math.min(365, parseInt(range, 10) || 7));
    const now = Date.now();
    const startDay = days ? local(now - (days - 1) * 86400000).day : '';
    const since = days ? new Date(startDay + 'T00:00:00-03:00').getTime() : 0;

    const [rawEv, rawPu, cpv, cck, uniqAll, last] = await redis([
      ['LRANGE', 'ev', 0, 29999], ['LRANGE', 'pu', 0, 4999], ['GET', 'c:pv'], ['GET', 'c:ck'], ['PFCOUNT', 'hll:v'], ['GET', 'pu:last'],
    ]);
    const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    const events = (rawEv || []).map(parse).filter(Boolean).filter((e) => e.t >= since); // mais recentes primeiro
    const oldest = events.length ? events[events.length - 1].t : now;

    const visitors = new Set(), sessions = new Set(), clickers = new Set(), buyClickers = new Set();
    let pageviews = 0, clicks = 0, buyClicks = 0, durSum = 0, durN = 0, scrollSum = 0, scrollN = 0;
    const byLabel = new Map(), labelUniq = new Map();
    const hourPv = Array(24).fill(0), hourCk = Array(24).fill(0);
    const wdPv = Array(7).fill(0), wdCk = Array(7).fill(0);
    const dayPv = new Map(), dayCk = new Map(), dayUv = new Map();
    const ips = new Map(), cities = new Map(), cityVisits = new Map(), countries = new Map();
    const devices = new Map(), browsers = new Map(), oses = new Map(), refs = new Map(), utms = new Map();
    const visitorFirst = new Map();

    for (const e of events) {
      const L = local(e.t);
      visitors.add(e.v); sessions.add(e.s);
      if (!visitorFirst.has(e.v)) visitorFirst.set(e.v, true);
      if (e.k === 'pv') {
        pageviews++;
        hourPv[L.hour]++; wdPv[L.wd]++; inc(dayPv, L.day);
        if (!dayUv.has(L.day)) dayUv.set(L.day, new Set());
        dayUv.get(L.day).add(e.v);
        inc(devices, e.d); inc(browsers, e.b); inc(oses, e.o);
        inc(refs, e.r || 'direto / sem origem');
        if (e.us) inc(utms, e.us + (e.um ? ' / ' + e.um : ''));
        inc(cityVisits, place(e));
        const rec = ips.get(e.ip) || { ip: e.ip, place: place(e), visits: 0, clicks: 0, first: e.t, last: e.t, labels: new Map(), visitors: new Set() };
        rec.visits++; rec.visitors.add(e.v); rec.first = Math.min(rec.first, e.t); rec.last = Math.max(rec.last, e.t);
        ips.set(e.ip, rec);
      } else if (e.k === 'ck') {
        clicks++; clickers.add(e.v);
        hourCk[L.hour]++; wdCk[L.wd]++; inc(dayCk, L.day);
        const lab = e.l || 'outro';
        inc(byLabel, lab);
        if (!labelUniq.has(lab)) labelUniq.set(lab, new Set());
        labelUniq.get(lab).add(e.v);
        if (lab.startsWith('comprar:')) { buyClicks++; buyClickers.add(e.v); }
        inc(cities, place(e)); inc(countries, e.co || '??');
        const rec = ips.get(e.ip) || { ip: e.ip, place: place(e), visits: 0, clicks: 0, first: e.t, last: e.t, labels: new Map(), visitors: new Set() };
        rec.clicks++; rec.visitors.add(e.v); rec.first = Math.min(rec.first, e.t); rec.last = Math.max(rec.last, e.t); inc(rec.labels, lab);
        ips.set(e.ip, rec);
      } else if (e.k === 'lv') {
        if (e.du > 500) { durSum += Math.min(e.du, 30 * 60000); durN++; }
        if (typeof e.sd === 'number') { scrollSum += e.sd; scrollN++; }
      }
    }

    // compras: a última linha de cada id define o estado (reembolso anula)
    const seen = new Map();
    for (const raw of rawPu || []) {
      const p = parse(raw);
      if (!p || p.t < since) continue;
      if (!seen.has(p.id)) seen.set(p.id, p);
    }
    const purchases = [...seen.values()].sort((a, b) => b.t - a.t);
    const paid = purchases.filter((p) => p.ok && !p.refund);
    const revenue = paid.reduce((s, p) => s + (p.amt || 0), 0);
    const byProd = new Map();
    for (const p of paid) inc(byProd, p.prod || 'Sem nome', 1);
    const dayBuy = new Map();
    for (const p of paid) inc(dayBuy, local(p.t).day);

    // série diária
    const daysList = [];
    const spanDays = days || Math.min(90, Math.max(1, Math.ceil((now - oldest) / 86400000) + 1));
    for (let i = spanDays - 1; i >= 0; i--) daysList.push(local(now - i * 86400000).day);
    const daily = daysList.map((d) => ({ day: d, pv: dayPv.get(d) || 0, ck: dayCk.get(d) || 0, uv: dayUv.has(d) ? dayUv.get(d).size : 0, buy: dayBuy.get(d) || 0 }));

    const ipList = [...ips.values()].sort((a, b) => b.clicks - a.clicks || b.visits - a.visits).slice(0, 25).map((r) => ({
      ip: r.ip, place: r.place, visits: r.visits, clicks: r.clicks, people: r.visitors.size,
      first: local(r.first).text, last: local(r.last).text,
      topClick: top(r.labels, 1)[0] ? top(r.labels, 1)[0][0] : '',
    }));

    const nVis = visitors.size;
    const out = {
      generatedAt: local(now).text, tz: TZ, range: days ? String(days) : 'all',
      dataFrom: local(oldest).text, eventsInWindow: events.length, capped: (rawEv || []).length >= 30000,
      totals: {
        visitors: nVis, sessions: sessions.size, pageviews, clicks, clickers: clickers.size,
        ctr: nVis ? +(clickers.size / nVis * 100).toFixed(1) : 0,
        buyClicks, buyClickers: buyClickers.size,
        buyCtr: nVis ? +(buyClickers.size / nVis * 100).toFixed(1) : 0,
        purchases: paid.length, revenue: +revenue.toFixed(2),
        conversion: nVis ? +(paid.length / nVis * 100).toFixed(2) : 0,
        checkoutConversion: buyClickers.size ? +(paid.length / buyClickers.size * 100).toFixed(1) : 0,
        avgSeconds: durN ? Math.round(durSum / durN / 1000) : 0, avgScroll: scrollN ? Math.round(scrollSum / scrollN) : 0,
        allTime: { pageviews: Number(cpv || 0), clicks: Number(cck || 0), visitors: Number(uniqAll || 0) },
      },
      clicksByLabel: top(byLabel, 30).map(([label, n]) => ({ label, clicks: n, people: labelUniq.get(label).size })),
      hourly: hourPv.map((pv, h) => ({ hour: h, pv, ck: hourCk[h] })),
      weekday: wdPv.map((pv, d) => ({ wd: d, pv, ck: wdCk[d] })),
      daily,
      topIps: ipList,
      cities: { clicks: top(cities, 12), visits: top(cityVisits, 12) },
      countries: top(countries, 10),
      devices: top(devices, 6), browsers: top(browsers, 8), os: top(oses, 8),
      referrers: top(refs, 10), utm: top(utms, 10),
      purchasesList: purchases.slice(0, 50).map((p) => ({ when: local(p.t).text, id: p.id, status: p.st, counted: !!(p.ok && !p.refund), refund: !!p.refund, amount: p.amt, product: p.prod, method: p.meth, src: p.src })),
      purchasesByProduct: top(byProd, 10),
      recent: events.filter((e) => e.k !== 'lv').slice(0, 80).map((e) => ({
        when: local(e.t).text, kind: e.k === 'pv' ? 'visita' : 'clique', label: e.l || '', ip: e.ip, place: place(e),
        device: e.d, browser: e.b, os: e.o, ref: e.r || '',
      })),
      lastWebhook: last ? parse(last) : null,
    };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = e && e.message === 'REDIS_NOT_CONFIGURED' ? 503 : 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: e && e.message === 'REDIS_NOT_CONFIGURED' ? 'Banco Redis não conectado' : 'erro interno' }));
  }
};
