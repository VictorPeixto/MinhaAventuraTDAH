'use strict';
const crypto = require('crypto');

const REDIS_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

// Executa vários comandos Redis de uma vez (API REST da Upstash / Vercel KV).
async function redis(commands) {
  const url = REDIS_URL();
  if (!url) throw new Error('REDIS_NOT_CONFIGURED');
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN(), 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x && x.error) throw new Error('redis: ' + x.error);
    return x ? x.result : null;
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function clientIp(req) {
  const h = req.headers || {};
  const raw = h['x-vercel-forwarded-for'] || h['x-forwarded-for'] || h['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '';
  return String(raw).split(',')[0].trim().replace(/^::ffff:/, '') || 'desconhecido';
}

function geo(req) {
  const h = req.headers || {};
  const dec = (v) => { try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; } };
  return { co: h['x-vercel-ip-country'] || '', rg: dec(h['x-vercel-ip-country-region']), ci: dec(h['x-vercel-ip-city']) };
}

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|preview|monitor|uptime|pingdom|vercel-screenshot|python-requests|curl\/|wget|httpclient/i;

function parseUa(ua) {
  ua = String(ua || '');
  let os = 'Outro', b = 'Outro', d = 'desktop';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  if (/instagram/i.test(ua)) b = 'Instagram (app)';
  else if (/fban|fbav|facebook/i.test(ua)) b = 'Facebook (app)';
  else if (/tiktok|musical_ly|bytedance/i.test(ua)) b = 'TikTok (app)';
  else if (/edg\//i.test(ua)) b = 'Edge';
  else if (/opr\/|opera/i.test(ua)) b = 'Opera';
  else if (/samsungbrowser/i.test(ua)) b = 'Samsung Internet';
  else if (/firefox|fxios/i.test(ua)) b = 'Firefox';
  else if (/chrome|crios/i.test(ua)) b = 'Chrome';
  else if (/safari/i.test(ua)) b = 'Safari';
  if (/ipad|tablet/i.test(ua)) d = 'tablet';
  else if (/mobi|iphone|android/i.test(ua)) d = 'celular';
  return { os, b, d };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch (e) { return Object.fromEntries(new URLSearchParams(req.body)); }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return {}; }
    }
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100000) break;
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString('utf8');
  if (!txt) return {};
  try { return JSON.parse(txt); } catch (e) { return Object.fromEntries(new URLSearchParams(txt)); }
}

module.exports = { redis, safeEqual, clientIp, geo, BOT_RE, parseUa, hostOf, readBody };
