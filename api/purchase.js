'use strict';
/*
 * Registro de compras.
 *  1) Webhook/postback do checkout (Wiapy):  POST /api/purchase?secret=SEU_SEGREDO
 *     (ou envie o segredo no cabeçalho x-webhook-secret). Aceita JSON ou formulário.
 *  2) Registro manual pelo painel: POST /api/purchase com o cabeçalho x-analytics-password
 *     e o corpo {"amount": 97, "product": "O Manual do TDAH"}.
 * Nomes, e-mails, CPF e telefones NÃO são guardados.
 */
const { redis, safeEqual, readBody, clientIp, isLockedOut, registerFail } = require('./_lib');

const PII_RE = /mail|name|nome|cpf|cnpj|phone|fone|tel|whats|document|address|endere|cep|zip|ip$|senha|password|token/i;

function flatten(obj, out, depth) {
  out = out || []; depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 5) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flatten(v, out, depth + 1);
    else out.push([String(k).toLowerCase(), v]);
  }
  return out;
}
function pick(flat, keys) {
  for (const key of keys) {
    const hit = flat.find(([k, v]) => k === key && v !== '' && v != null);
    if (hit) return hit[1];
  }
  return '';
}
function toNumber(v) {
  if (typeof v === 'number') return v;
  let s = String(v || '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
const OK_RE = /approved|aprovad|paid|pago|complet|confirm|success|captured|purchase_approved|order_paid|sale|venda|compra/i;
const BAD_RE = /refund|reembols|charge ?back|estorn|cancel|abandon|pending|pendente|waiting|aguard|expired|expirad|declin|recus|refus|fail|falh|boleto_generated|pix_generated|created|criad/i;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' || req.method === 'HEAD') { res.statusCode = 200; return res.end('ok'); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  try {
    const url = new URL(req.url, 'http://x');
    const secret = url.searchParams.get('secret') || req.headers['x-webhook-secret'] || '';
    const pass = req.headers['x-analytics-password'] || '';
    const wantSecret = process.env.PURCHASE_WEBHOOK_SECRET || '';
    const wantPass = process.env.ANALYTICS_PASSWORD || '';
    const viaWebhook = wantSecret && safeEqual(secret, wantSecret);
    const viaManual = wantPass && safeEqual(pass, wantPass);
    if (!wantSecret && !wantPass) { res.statusCode = 503; return res.end('configure PURCHASE_WEBHOOK_SECRET'); }
    const ip = clientIp(req);
    if (await isLockedOut(ip)) { res.statusCode = 429; return res.end(); }
    if (!viaWebhook && !viaManual) { await registerFail(ip); res.statusCode = 401; return res.end(); }

    const body = (await readBody(req)) || {};
    const flat = flatten(body);
    const now = Date.now();

    let rec;
    if (viaManual && !viaWebhook) {
      const amt = toNumber(body.amount);
      rec = { t: now, id: 'manual-' + now + '-' + Math.random().toString(36).slice(2, 7), st: 'manual', ok: true,
        amt, cur: 'BRL', prod: String(body.product || 'O Manual do TDAH').slice(0, 80), meth: 'manual', src: 'manual' };
    } else {
      const status = String(pick(flat, ['status', 'payment_status', 'transaction_status', 'event', 'situation', 'state', 'type']) || '');
      const id = String(pick(flat, ['transaction_id', 'transaction', 'order_id', 'sale_id', 'purchase_id', 'id', 'code', 'hash', 'checkout_id']) || 'wh-' + now);
      rec = {
        t: now, id: id.slice(0, 80), st: status.slice(0, 40).toLowerCase(),
        ok: OK_RE.test(status) && !BAD_RE.test(status),
        refund: /refund|reembols|charge ?back|estorn/i.test(status),
        amt: toNumber(pick(flat, ['amount', 'value', 'valor', 'total', 'price', 'preco', 'revenue', 'gross_amount', 'total_price'])),
        cur: String(pick(flat, ['currency', 'moeda']) || 'BRL').slice(0, 5).toUpperCase(),
        prod: String(pick(flat, ['product_name', 'product', 'offer_name', 'offer', 'item_name', 'title', 'produto']) || '').slice(0, 80),
        meth: String(pick(flat, ['payment_method', 'method', 'payment_type', 'forma_pagamento']) || '').slice(0, 30).toLowerCase(),
        src: 'webhook',
      };
      // guarda um exemplo do último webhook (sem dados pessoais) para você conferir os campos
      const sample = {};
      for (const [k, v] of flat.slice(0, 60)) if (!PII_RE.test(k)) sample[k] = String(v).slice(0, 60);
      await redis([['SET', 'pu:last', JSON.stringify({ t: now, campos: sample })]]);
    }

    await redis([['LPUSH', 'pu', JSON.stringify(rec)], ['LTRIM', 'pu', 0, 4999]]);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, id: rec.id, counted: rec.ok }));
  } catch (e) {
    res.statusCode = 500;
    return res.end();
  }
};
