// ════════════════════════════════════════════════════════════════════════════
//  ATLAS SOLAR — Broker Adapter Layer  (broker.js)
//  Zero-dependency execution bridge. Routes ATLAS orders to a real brokerage.
//
//  Supported brokers (set via BROKER env var):
//    • "paper"  — internal acknowledger. No external account. Echoes simulated
//                 fills so you can test the TradingView → ATLAS → broker bridge
//                 end-to-end WITHOUT a brokerage account. (default)
//    • "alpaca" — Alpaca Markets REST. Works for BOTH Alpaca paper and live
//                 accounts (identical API, different base URL + keys).
//
//  Credentials come ONLY from environment variables — never hard-code keys.
//    APCA_API_KEY_ID       your Alpaca key id
//    APCA_API_SECRET_KEY   your Alpaca secret
//    ALPACA_PAPER          "true" (default) → paper-api.alpaca.markets
//                          "false"          → api.alpaca.markets (REAL MONEY)
//
//  Interface returned by createBroker():
//    name           string
//    isLive         boolean (true only for alpaca + ALPACA_PAPER=false)
//    submitOrder({ symbol, side, qty, type?, limitPrice?, tif? }) → {id, status, ...}
//    getAccount()                         → { cash, equity, buying_power, ... }
//    getPositions()                       → [ { symbol, qty, side, avg_entry_price } ]
//    closePosition(symbol)                → close a single position
//    cancelAll()                          → cancel all open orders
//
//  Every method returns a Promise and never throws raw — errors resolve to
//  { ok:false, error } so the caller can decide what to do.
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const https = require('https');

// ── tiny promise-based HTTPS JSON client (GET/POST/DELETE) ─────────────────
function httpsJson(method, urlString, headers, body) {
  return new Promise(resolve => {
    let url;
    try { url = new URL(urlString); }
    catch (e) { return resolve({ ok: false, status: 0, error: 'bad-url:' + e.message }); }

    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: 10000,
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

    let done = false;   // resolve exactly once (destroy() after timeout also fires 'error')
    const finish = (v) => { if (!done) { done = true; clearTimeout(hardTh); resolve(v); } };
    // Hard wall-clock timeout — the opts.timeout below only fires on socket INACTIVITY,
    // which a stalled-but-trickling response never trips. This always does.
    const hardTh = setTimeout(() => { try { req.destroy(); } catch {} finish({ ok: false, status: 0, error: 'timeout' }); }, 15000);
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        finish({ ok, status: res.statusCode, data: parsed,
                 error: ok ? null : (parsed && (parsed.message || parsed.raw)) || ('http-' + res.statusCode) });
      });
    });
    req.on('error',   e => finish({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} finish({ ok: false, status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── PAPER adapter — no external account, echoes acknowledgements ───────────
function makePaperBroker() {
  let counter = 0;
  const _orders = {};   // v11.18: order store for the instant-fill lifecycle
  return {
    name: 'paper',
    isLive: false,
    async submitOrder({ symbol, side, qty, type = 'market', limitPrice = null, refPrice = null }) {
      counter += 1;
      const id = `paper-${Date.now()}-${counter}`;
      // v11.18: instant-fill test double for the pending-order lifecycle — fills
      // immediately at refPrice (the caller's reference quote). No real order exists.
      _orders[id] = { status: 'filled',
                      filled_avg_price: Number(refPrice) > 0 ? Number(refPrice) : (Number(limitPrice) > 0 ? Number(limitPrice) : 0),
                      filled_qty: qty };
      return { ok: true, id, symbol, side, qty, type, limitPrice, status: 'accepted',
               note: 'paper acknowledger — no real order placed' };
    },
    async getOrder(id) {
      const o = _orders[id];
      if (!o) return { ok: false, status: 404, error: 'unknown-order' };
      return { ok: true, id, status: o.status, filled_avg_price: o.filled_avg_price, filled_qty: o.filled_qty };
    },
    async cancelOrder(id) { delete _orders[id]; return { ok: true, id, status: 'canceled' }; },
    async getAccount() {
      return { ok: true, cash: null, equity: null, buying_power: null,
               note: 'paper broker has no real account; ATLAS tracks sim cash internally' };
    },
    async getPositions() { return { ok: true, positions: [] }; },
    // No real account, so no calendar — callers fall back to weekday hours.
    async getCalendar() { return { ok: false, error: 'paper-broker-has-no-calendar' }; },
    async closePosition(symbol) { return { ok: true, symbol, status: 'close-acknowledged' }; },
    async cancelAll() { return { ok: true, status: 'cancel-all-acknowledged' }; },
  };
}

// ── ALPACA adapter — real REST (paper or live by base URL) ─────────────────
function makeAlpacaBroker() {
  const keyId  = process.env.APCA_API_KEY_ID || '';
  const secret = process.env.APCA_API_SECRET_KEY || '';
  const isPaper = (process.env.ALPACA_PAPER || 'true').toLowerCase() !== 'false';
  const base = isPaper ? 'https://paper-api.alpaca.markets'
                       : 'https://api.alpaca.markets';
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret };
  const configured = !!(keyId && secret);

  function guard() {
    if (!configured) return { ok: false, error: 'alpaca-keys-missing (set APCA_API_KEY_ID / APCA_API_SECRET_KEY)' };
    return null;
  }

  return {
    name: isPaper ? 'alpaca-paper' : 'alpaca-LIVE',
    isLive: !isPaper,
    configured,
    async submitOrder({ symbol, side, qty, type = 'market', limitPrice = null, tif = 'day' }) {
      const g = guard(); if (g) return g;
      if (!symbol || !side || !qty || qty < 1) return { ok: false, error: 'bad-order-params' };
      const body = { symbol, qty: String(qty), side, type, time_in_force: tif };
      if (type === 'limit' && limitPrice) body.limit_price = String(limitPrice);
      const r = await httpsJson('POST', `${base}/v2/orders`, headers, body);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      return { ok: true, id: r.data.id, symbol, side, qty, type,
               status: r.data.status, submittedAt: r.data.submitted_at };
    },
    async getOrder(id) {
      const g = guard(); if (g) return g;
      if (!id) return { ok: false, error: 'no-order-id' };
      const r = await httpsJson('GET', `${base}/v2/orders/${id}`, headers, null);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const o = r.data;
      return { ok: true, id: o.id, status: o.status,
               filled_avg_price: parseFloat(o.filled_avg_price || 0),
               filled_qty: parseFloat(o.filled_qty || 0) };
    },
    async cancelOrder(id) {
      const g = guard(); if (g) return g;
      if (!id) return { ok: false, error: 'no-order-id' };
      const r = await httpsJson('DELETE', `${base}/v2/orders/${id}`, headers, null);
      // 404/422 mean already terminal (filled or gone) — treat as handled; the poller
      // reads the true terminal state on its next pass.
      return { ok: r.ok || r.status === 404 || r.status === 422, status: r.status, error: r.ok ? null : r.error };
    },
    async getAccount() {
      const g = guard(); if (g) return g;
      const r = await httpsJson('GET', `${base}/v2/account`, headers, null);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const a = r.data;
      return { ok: true, cash: parseFloat(a.cash), equity: parseFloat(a.equity),
               buying_power: parseFloat(a.buying_power), status: a.status,
               pattern_day_trader: a.pattern_day_trader };
    },
    // Official NYSE/NASDAQ trading calendar — real holidays and early closes.
    // Weekday-only logic silently treats Thanksgiving, Christmas, Juneteenth etc. as
    // normal sessions, and misses 1pm early closes.
    async getCalendar(startISO, endISO) {
      const g = guard(); if (g) return g;
      const r = await httpsJson('GET', `${base}/v2/calendar?start=${startISO}&end=${endISO}`, headers, null);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const days = (Array.isArray(r.data) ? r.data : []).map(d => ({
        date: d.date, open: d.open, close: d.close
      }));
      return { ok: true, days };
    },
    async getPositions() {
      const g = guard(); if (g) return g;
      const r = await httpsJson('GET', `${base}/v2/positions`, headers, null);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const positions = (Array.isArray(r.data) ? r.data : []).map(p => ({
        symbol: p.symbol, qty: parseFloat(p.qty), side: p.side,
        avg_entry_price: parseFloat(p.avg_entry_price),
        market_value: parseFloat(p.market_value),
        unrealized_pl: parseFloat(p.unrealized_pl),
      }));
      return { ok: true, positions };
    },
    async closePosition(symbol) {
      const g = guard(); if (g) return g;
      const r = await httpsJson('DELETE', `${base}/v2/positions/${encodeURIComponent(symbol)}`, headers, null);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      return { ok: true, symbol, status: 'close-submitted' };
    },
    async cancelAll() {
      const g = guard(); if (g) return g;
      const r = await httpsJson('DELETE', `${base}/v2/orders`, headers, null);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      return { ok: true, status: 'all-orders-cancelled' };
    },
  };
}

// ── factory ────────────────────────────────────────────────────────────────
function createBroker() {
  const choice = (process.env.BROKER || 'paper').toLowerCase();
  if (choice === 'alpaca') return makeAlpacaBroker();
  return makePaperBroker();
}

module.exports = { createBroker };
