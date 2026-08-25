#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — hold-optimize.js  ·  what should the core actually hold?
//
//  The overnight decomposition established WHERE the return lives (holding, not
//  trading). This asks the next question honestly: given that you are going to hold
//  something, what and how?
//
//  THE TRAP THIS TOOL EXISTS TO AVOID. The 20-name watchlist returned 54.3%/yr in
//  the sample while SPY returned 20.9%. It would be trivial — and wrong — to
//  conclude "hold the watchlist". Those names were selected, they are high-beta,
//  and the sample is mostly a bull market: exactly the conditions that flatter a
//  concentrated risky basket. A fair comparison must run over the SAME period and
//  report RISK-ADJUSTED return, because more return for proportionally more risk is
//  not an improvement, it is just a bigger bet.
//
//  The one genuinely free improvement in holding is DIVERSIFICATION: spreading the
//  same money over more names cuts variance without cutting expected return. That
//  is the only free lunch in finance and it is worth measuring precisely.
//
//  USAGE  node hold-optimize.js
// ════════════════════════════════════════════════════════════════════════════
'use strict';

require('./server.js');
const https = require('https');
const KEY = process.env.APCA_API_KEY_ID, SEC = process.env.APCA_API_SECRET_KEY;
const FEED = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();

const BASKET = 'PLTR,SOFI,MARA,HOOD,SOUN,IONQ,RKLB,BBAI,HIMS,CIFR,F,BAC,JPM,WFC,GE,XOM,MRK,JNJ,PFE,KO'.split(',');
const BROAD  = ['SPY', 'QQQ'];
// Large, liquid, sector-spread names chosen for BREADTH, not for past returns.
const WIDE   = 'AAPL,MSFT,JNJ,JPM,XOM,PG,KO,WMT,CVX,MRK,PEP,ABBV,BAC,CSCO,VZ,T,PFE,INTC,GE,F'.split(',');
const ROUND_TRIP = 0.0010;

function get(p) {
  return new Promise(r => { https.request({ host: 'data.alpaca.markets', path: p,
    headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } },
    x => { let b = ''; x.on('data', d => b += d); x.on('end', () => { try { r(JSON.parse(b)); } catch { r(null); } }); }).end(); });
}
async function daily(syms, startISO) {
  const out = {}; let token = null, pages = 0;
  do {
    const j = await get(`/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=1Day&start=${encodeURIComponent(startISO)}` +
      `&limit=10000&adjustment=all&feed=${FEED}&sort=asc` + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
    if (!j) break;
    Object.entries(j.bars || {}).forEach(([s, arr]) => {
      (out[s] = out[s] || []).push(...arr.map(b => ({ t: b.t.slice(0, 10), c: b.c })));
    });
    token = j.next_page_token || null; pages++;
  } while (token && pages < 12);
  return out;
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Equal-weight daily returns over a common calendar, rebalanced every `rebal` days.
// A daily-rebalanced equal-weight index is a fiction if you pay costs, so turnover is
// charged: rebalancing back to equal weight means trading the drift.
function equalWeight(series, dates, rebal) {
  const syms = Object.keys(series);
  let w = {}; syms.forEach(s => w[s] = 1 / syms.length);
  const rets = [];
  for (let i = 1; i < dates.length; i++) {
    let r = 0;
    const nw = {};
    for (const s of syms) {
      const p = series[s][dates[i - 1]], q = series[s][dates[i]];
      const sr = (p > 0 && q > 0) ? q / p - 1 : 0;
      r += w[s] * sr;
      nw[s] = w[s] * (1 + sr);
    }
    const tot = Object.values(nw).reduce((a, b) => a + b, 0) || 1;
    for (const s of syms) nw[s] = nw[s] / tot;              // drift to new weights
    if (rebal > 0 && i % rebal === 0) {
      // Turnover cost: half the sum of absolute weight changes, times round trip.
      let turn = 0; for (const s of syms) turn += Math.abs(nw[s] - 1 / syms.length);
      r -= (turn / 2) * ROUND_TRIP;
      for (const s of syms) nw[s] = 1 / syms.length;
    }
    w = nw;
    rets.push(r);
  }
  return rets;
}

function stats(rets, years) {
  const eq = rets.reduce((v, r) => v * (1 + r), 1);
  const cagr = Math.pow(eq, 1 / years) - 1;
  let v = 1, peak = 1, dd = 0;
  for (const r of rets) { v *= (1 + r); peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  const vol = sd(rets) * Math.sqrt(252);
  return { cagr, dd, vol, rr: vol > 0 ? cagr / vol : 0 };
}

(async function main() {
  console.log(`\n${'═'.repeat(78)}`);
  console.log('  WHAT SHOULD THE CORE HOLD?  — same period, risk-adjusted');
  console.log(`${'═'.repeat(78)}`);
  const all = [...new Set([...BASKET, ...BROAD, ...WIDE])];
  process.stdout.write('  fetching … ');
  const raw = await daily(all, '2018-11-01T00:00:00Z');
  console.log(`${Object.keys(raw).length} symbols`);

  // Common calendar: only dates every candidate has, so no group gets an easier period.
  const groups = { 'watchlist (20 picked)': BASKET, 'SPY only': ['SPY'], 'SPY+QQQ': BROAD,
                   'broad 20 (liquidity-picked)': WIDE };
  const present = {};
  Object.entries(groups).forEach(([k, v]) => { present[k] = v.filter(s => (raw[s] || []).length > 300); });
  const dateSets = Object.values(present).flat().map(s => new Set(raw[s].map(b => b.t)));
  let dates = raw[Object.values(present).flat()[0]].map(b => b.t);
  dateSets.forEach(ds => { dates = dates.filter(d => ds.has(d)); });
  const YEARS = dates.length / 252;
  console.log(`  common window: ${dates[0]} → ${dates[dates.length-1]}  (${YEARS.toFixed(1)} years, ${dates.length} days)`);
  console.log(`  NOTE: every figure below is inflated by a period that was mostly a bull market.`);
  console.log(`  Compare the COLUMNS against each other, never the absolute numbers against the future.\n`);

  const idx = {};
  all.forEach(s => { if (raw[s]) { idx[s] = {}; raw[s].forEach(b => idx[s][b.t] = b.c); } });

  console.log('  holding                        CAGR    maxDD     vol    return/risk');
  const rows = [];
  for (const [label, syms] of Object.entries(present)) {
    if (!syms.length) continue;
    const series = {}; syms.forEach(s => series[s] = idx[s]);
    const r = equalWeight(series, dates, 21);           // monthly rebalance
    const st = stats(r, YEARS);
    rows.push({ label, st, n: syms.length });
    console.log(`  ${label.padEnd(28)} ${(st.cagr*100).toFixed(1).padStart(6)}%  ${(st.dd*100).toFixed(1).padStart(6)}%  ${(st.vol*100).toFixed(1).padStart(6)}%   ${st.rr.toFixed(2).padStart(9)}`);
  }

  // ── Diversification: the one genuinely free improvement ───────────────────
  console.log(`\n  DIVERSIFICATION — same money, spread over more names (from the broad set)`);
  console.log('  names     CAGR    maxDD     vol    return/risk');
  for (const n of [1, 3, 5, 10, 20]) {
    const syms = present['broad 20 (liquidity-picked)'].slice(0, n);
    if (syms.length < n) continue;
    const series = {}; syms.forEach(s => series[s] = idx[s]);
    const st = stats(equalWeight(series, dates, 21), YEARS);
    console.log(`  ${String(n).padStart(5)}   ${(st.cagr*100).toFixed(1).padStart(6)}%  ${(st.dd*100).toFixed(1).padStart(6)}%  ${(st.vol*100).toFixed(1).padStart(6)}%   ${st.rr.toFixed(2).padStart(9)}`);
  }

  // ── Rebalance frequency ───────────────────────────────────────────────────
  console.log(`\n  REBALANCE FREQUENCY — broad 20. More often costs more; does it earn it back?`);
  console.log('  every      CAGR    maxDD   return/risk');
  for (const [d, l] of [[5,'week'],[21,'month'],[63,'quarter'],[252,'year'],[0,'never']]) {
    const syms = present['broad 20 (liquidity-picked)'];
    const series = {}; syms.forEach(s => series[s] = idx[s]);
    const st = stats(equalWeight(series, dates, d), YEARS);
    console.log(`  ${l.padEnd(9)} ${(st.cagr*100).toFixed(1).padStart(6)}%  ${(st.dd*100).toFixed(1).padStart(6)}%   ${st.rr.toFixed(2).padStart(9)}`);
  }

  const best = rows.reduce((a, x) => x.st.rr > a.st.rr ? x : a);
  console.log(`\n  READING IT`);
  console.log(`  · Best RISK-ADJUSTED holding here: ${best.label} (${best.st.rr.toFixed(2)} return per unit of risk).`);
  const wl = rows.find(r => r.label.startsWith('watchlist'));
  if (wl && best.label !== wl.label) {
    console.log(`  · The hand-picked watchlist earns more (${(wl.st.cagr*100).toFixed(1)}%) but takes proportionally`);
    console.log(`    more risk (${(wl.st.vol*100).toFixed(0)}% vol, ${(wl.st.dd*100).toFixed(0)}% drawdown) — that is a bigger bet, not a better one.`);
  }
  console.log(`  · Those 20 names were CHOSEN, in hindsight, from a period they did well in.`);
  console.log(`    Their past return is the least reliable number on this page.`);
  console.log('');
})();
