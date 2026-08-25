#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — anomaly-test.js  ·  the two documented effects never tested here
//
//  Everything tested so far asked the bot to pick a direction from recent price
//  action. That measured +0.005R on symbols it was not built around — zero. These
//  two are different in kind: both are published, replicated effects that do NOT
//  depend on predicting anything, and both are testable with daily bars.
//
//  1. THE OVERNIGHT EFFECT. Equity returns are heavily concentrated in the
//     close-to-open window rather than the open-to-close session. Documented across
//     decades and markets. If real here, "hold overnight, sit out the day" earns
//     most of the return with less exposure.
//     THE CATCH, stated before the numbers: it needs a round trip EVERY day. 252
//     round trips a year at even 5bp each is ~12.6%/yr of friction. This is the
//     standard reason the effect is not harvestable at retail — so the test must
//     charge costs honestly, and the gross-vs-net gap is the whole story.
//
//  2. CROSS-SECTIONAL MOMENTUM. Rank the universe by trailing return, hold the top
//     slice, rebalance monthly. Jegadeesh & Titman (1993), replicated widely, and
//     decayed since publication. Unlike everything else here it has LOW turnover —
//     12 rebalances a year, not 252 — so the toll that killed minute-bar trading is
//     roughly 20x smaller.
//
//  Both are measured against buy-and-hold, the only benchmark that has ever mattered
//  in this project, and both report gross AND net so friction is never hidden.
//
//  USAGE  node anomaly-test.js
// ════════════════════════════════════════════════════════════════════════════
'use strict';

require('./server.js');
const https = require('https');
const KEY = process.env.APCA_API_KEY_ID, SEC = process.env.APCA_API_SECRET_KEY;
const FEED = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();
const SYMBOLS = 'PLTR,SOFI,MARA,HOOD,SOUN,IONQ,RKLB,BBAI,HIMS,CIFR,F,BAC,JPM,WFC,GE,XOM,MRK,JNJ,PFE,KO'.split(',');
const ROUND_TRIP = 0.0010;                       // 10bp all-in per round trip

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
      (out[s] = out[s] || []).push(...arr.map(b => ({ t: b.t.slice(0, 10), o: b.o, c: b.c })));
    });
    token = j.next_page_token || null; pages++;
  } while (token && pages < 12);
  return out;
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); }
const tstat = a => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
function ann(dailyRets, years) {
  const eq = dailyRets.reduce((v, r) => v * (1 + r), 1);
  return Math.pow(eq, 1 / years) - 1;
}
function maxDD(dailyRets) {
  let v = 1, peak = 1, dd = 0;
  for (const r of dailyRets) { v *= (1 + r); peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak); }
  return dd;
}

(async function main() {
  const start = '2018-11-01T00:00:00Z';
  console.log(`\n${'═'.repeat(78)}`);
  console.log('  TWO DOCUMENTED EFFECTS, MEASURED HONESTLY');
  console.log(`${'═'.repeat(78)}`);
  process.stdout.write('  fetching daily bars … ');
  const bars = await daily(SYMBOLS, start);
  const usable = SYMBOLS.filter(s => (bars[s] || []).length > 400);
  console.log(`${usable.length}/${SYMBOLS.length} symbols, ${bars[usable[0]].length} days`);
  if (usable.length < 5) { console.error('  not enough history'); process.exit(1); }
  const N = Math.min(...usable.map(s => bars[s].length));
  const YEARS = N / 252;

  // ── 1. OVERNIGHT vs INTRADAY ──────────────────────────────────────────────
  // overnight = open[i] / close[i-1] - 1     (held through the night)
  // intraday  = close[i] / open[i]  - 1      (held through the session)
  console.log(`\n  1. OVERNIGHT vs INTRADAY  —  equal-weight across ${usable.length} names, ${YEARS.toFixed(1)} years`);
  const onR = [], inR = [], allR = [];
  for (let i = 1; i < N; i++) {
    const on = [], intr = [], all = [];
    for (const s of usable) {
      const b = bars[s], p = b[i - 1], q = b[i];
      if (!p || !q || !(p.c > 0) || !(q.o > 0)) continue;
      on.push(q.o / p.c - 1);
      intr.push(q.c / q.o - 1);
      all.push(q.c / p.c - 1);
    }
    if (on.length) { onR.push(mean(on)); inR.push(mean(intr)); allR.push(mean(all)); }
  }
  const fmt = (label, r, tradesPerYear) => {
    const gross = ann(r, YEARS);
    const netR  = tradesPerYear ? r.map(x => x - ROUND_TRIP) : r;
    const net   = ann(netR, YEARS);
    console.log(`     ${label.padEnd(26)} gross ${(gross*100).toFixed(1).padStart(6)}%/yr   ` +
                `net ${(net*100).toFixed(1).padStart(7)}%/yr   ` +
                `t=${tstat(r).toFixed(2).padStart(5)}   maxDD ${(maxDD(netR)*100).toFixed(0)}%`);
    return { gross, net };
  };
  const bh  = fmt('buy & hold (no trading)', allR, 0);
  const ovn = fmt('overnight only', onR, 252);
  const idy = fmt('intraday only', inR, 252);
  console.log(`     → the effect is ${ovn.gross > idy.gross ? 'PRESENT' : 'absent'}: overnight ${(ovn.gross*100).toFixed(1)}%/yr vs intraday ${(idy.gross*100).toFixed(1)}%/yr gross.`);
  console.log(`     → after 252 round trips a year it nets ${(ovn.net*100).toFixed(1)}%/yr against buy-and-hold's ${(bh.gross*100).toFixed(1)}%/yr.`);
  console.log(`     → friction cost: ${((ovn.gross - ovn.net)*100).toFixed(1)} points a year. THIS is why it is not harvestable at retail.`);

  // ── 2. CROSS-SECTIONAL MOMENTUM ───────────────────────────────────────────
  // Rank by trailing LOOKBACK-day return, skipping the most recent SKIP days (the
  // standard construction — the last month reverses). Hold the top third. Rebalance
  // every REBAL days. Decide on data strictly before the rebalance date.
  console.log(`\n  2. CROSS-SECTIONAL MOMENTUM  —  top third, monthly rebalance`);
  for (const [LOOK, SKIP, REBAL] of [[252, 21, 21], [126, 21, 21], [63, 5, 21]]) {
    const rets = []; let held = [], turnovers = 0;
    for (let i = LOOK + SKIP + 1; i < N; i++) {
      if ((i - LOOK - SKIP - 1) % REBAL === 0) {
        const scored = usable.map(s => {
          const b = bars[s];
          const a = b[i - 1 - SKIP - LOOK], z = b[i - 1 - SKIP];
          return { s, m: (a && z && a.c > 0) ? z.c / a.c - 1 : -Infinity };
        }).filter(x => Number.isFinite(x.m)).sort((a, b2) => b2.m - a.m);
        const keep = scored.slice(0, Math.max(1, Math.floor(scored.length / 3))).map(x => x.s);
        turnovers += keep.filter(s => !held.includes(s)).length;
        held = keep;
      }
      const day = held.map(s => { const b = bars[s]; return (b[i] && b[i-1] && b[i-1].c > 0) ? b[i].c / b[i-1].c - 1 : 0; });
      rets.push(mean(day));
    }
    const tradesPerYear = turnovers / YEARS;
    const costPerDay = (tradesPerYear * ROUND_TRIP) / 252;
    const net = rets.map(r => r - costPerDay);
    console.log(`     ${LOOK}d lookback / skip ${SKIP}d   gross ${(ann(rets,YEARS)*100).toFixed(1).padStart(6)}%/yr   ` +
                `net ${(ann(net,YEARS)*100).toFixed(1).padStart(6)}%/yr   t=${tstat(rets).toFixed(2)}   ` +
                `~${tradesPerYear.toFixed(0)} trades/yr   maxDD ${(maxDD(net)*100).toFixed(0)}%`);
  }
  console.log(`     benchmark: equal-weight buy & hold ${(bh.gross*100).toFixed(1)}%/yr, maxDD ${(maxDD(allR)*100).toFixed(0)}%`);

  console.log(`\n  CAVEAT THAT APPLIES TO BOTH: this is ONE 20-name basket over ${YEARS.toFixed(1)} years,`);
  console.log(`  inside a period that was mostly a bull market. A positive number here is a`);
  console.log(`  reason to test further, never a reason to deploy.\n`);
})();
