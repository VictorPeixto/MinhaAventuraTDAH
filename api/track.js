'use strict';
const { redis, clientIp, geo, BOT_RE, parseUa, hostOf, readBody } = require('./_lib');

const MAX_EVENTS = 30000;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  try {
    const ua = req.headers['user-agent'] || '';
    if (!ua || BOT_RE.test(ua)) { res.statusCode = 204; return res.end(); }

    const b = (await readBody(req)) || {};
    const kind = b.k === 'ck' || b.k === 'lv' ? b.k : b.k === 'pv' ? 'pv' : '';
    if (!kind || !b.v || !b.s) { res.statusCode = 400; return res.end(); }

    const ip = clientIp(req);
    const g = geo(req);
    const p = parseUa(ua);
    const now = Date.now();

    // limite simples por IP: 240 eventos por minuto
    const bucket = 'rl:' + ip + ':' + Math.floor(now / 60000);
    const [count] = await redis([['INCR', bucket], ['EXPIRE', bucket, 120]]);
    if (count > 240) { res.statusCode = 429; return res.end(); }

    const ev = {
      t: now, k: kind, v: clip(b.v, 64), s: clip(b.s, 64), ip,
      co: clip(g.co, 3), rg: clip(g.rg, 40), ci: clip(g.ci, 60),
      b: p.b, o: p.os, d: p.d,
      pa: clip(b.p, 100), w: num(b.w, 20000), lg: clip(b.lg, 16), tz: clip(b.tz, 60),
      r: hostOf(b.r), us: clip(b.us, 60), um: clip(b.um, 60), uc: clip(b.uc, 80),
    };
    if (kind === 'ck') {
      ev.l = clip(b.l, 80); ev.hr = clip(b.hr, 300); ev.x = num(b.x, 20000); ev.y = num(b.y, 20000);
    } else if (kind === 'lv') {
      ev.du = num(b.d, 6 * 3600 * 1000); ev.sd = num(b.sd, 100);
    }

    const cmds = [['LPUSH', 'ev', JSON.stringify(ev)], ['LTRIM', 'ev', 0, MAX_EVENTS - 1]];
    if (kind === 'pv') { cmds.push(['INCR', 'c:pv'], ['PFADD', 'hll:v', ev.v]); }
    if (kind === 'ck') { cmds.push(['INCR', 'c:ck']); }
    await redis(cmds);

    res.statusCode = 204;
    return res.end();
  } catch (e) {
    res.statusCode = e && e.message === 'REDIS_NOT_CONFIGURED' ? 503 : 500;
    return res.end();
  }
};
