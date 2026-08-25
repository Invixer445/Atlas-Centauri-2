#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — trend-test.js  ·  the last untested idea with real evidence
//
//  Everything this project has tried so far asked the bot to PICK: which stock,
//  which direction, which minute. Measured across ~22 variants, seven windows and
//  two symbol universes, that picking is worth +0.005R on stocks it was not built
//  around — zero. The edge that appeared came from a high-beta watchlist inside a
//  bull market, not from the strategy.
//
//  This tests the one approach with decades of published, replicated evidence that
//  does NOT require picking: time-series trend following on a broad index. Hold the
//  index while it is above its long moving average, sit in cash when it is below.
//  Faber (2007) and a long line of work before and after it. The claim is NOT that
//  it beats buy-and-hold on return — usually it does not — but that it earns a
//  similar return with materially smaller drawdowns, by sitting out the worst
//  stretches. Turnover is a handful of trades a year, so costs barely register.
//
//  It is measured here against the only benchmark that has ever mattered in this
//  project: simply holding the thing.
//
//  USAGE  node trend-test.js
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const FILE = process.argv[2] || '/private/tmp/claude-501/-Users-bredl-Downloads-ATLAS/964dcf66-a5d2-4f1d-a9b0-e19bc512c321/scratchpad/spy.json';
const bars = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  .map(b => ({ t: b.t.slice(0, 10), c: b.c }))
  .filter(b => b.c > 0);
if (bars.length < 300) { console.error('need more history'); process.exit(1); }

const ROUND_TRIP = 0.0010;          // 10bp in and out of SPY — generous for a liquid ETF
const YEARS = bars.length / 252;

function sma(arr, i, n) {
  if (i + 1 < n) return null;
  let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k].c;
  return s / n;
}
function stats(curve, trades) {
  const start = curve[0], end = curve[curve.length - 1];
  const cagr = Math.pow(end / start, 1 / YEARS) - 1;
  let peak = -Infinity, maxDD = 0;
  for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }
  // daily returns -> annualised volatility and return/risk
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
  const vol = sd * Math.sqrt(252);
  return { cagr, maxDD, vol, rr: vol > 0 ? cagr / vol : 0, end, trades };
}

// 1. Buy and hold — the benchmark.
const bh = [1]; for (let i = 1; i < bars.length; i++) bh.push(bh[i - 1] * (bars[i].c / bars[i - 1].c));

// 2. Trend filter at several lookbacks. Decide on YESTERDAY's close, act at today's —
//    no lookahead, the same discipline the main harness uses.
function trend(n) {
  const eq = [1]; let inMkt = false, trades = 0, daysIn = 0;
  for (let i = 1; i < bars.length; i++) {
    const sig = sma(bars, i - 1, n);
    const want = sig !== null && bars[i - 1].c > sig;
    let v = eq[i - 1];
    if (want !== inMkt) { v *= (1 - ROUND_TRIP / 2); trades++; inMkt = want; }
    if (inMkt) { v *= (bars[i].c / bars[i - 1].c); daysIn++; }
    eq.push(v);
  }
  return { eq, trades, exposure: daysIn / (bars.length - 1) };
}

console.log(`\n${'═'.repeat(78)}`);
console.log(`  TREND FOLLOWING ON THE INDEX — ${bars[0].t} to ${bars[bars.length-1].t} (${YEARS.toFixed(1)} years)`);
console.log(`${'═'.repeat(78)}`);
const b = stats(bh, 0);
console.log(`\n  strategy            CAGR    max drawdown    volatility   return/risk   trades   in market`);
console.log(`  ${'buy & hold'.padEnd(18)} ${(b.cagr*100).toFixed(1).padStart(5)}%   ${(b.maxDD*100).toFixed(1).padStart(9)}%    ${(b.vol*100).toFixed(1).padStart(7)}%   ${b.rr.toFixed(2).padStart(9)}       —        100%`);

const rows = [];
for (const n of [100, 150, 200, 250]) {
  const r = trend(n);
  const s = stats(r.eq, r.trades);
  rows.push({ n, s, exposure: r.exposure });
  console.log(`  ${(`trend ${n}-day`).padEnd(18)} ${(s.cagr*100).toFixed(1).padStart(5)}%   ${(s.maxDD*100).toFixed(1).padStart(9)}%    ${(s.vol*100).toFixed(1).padStart(7)}%   ${s.rr.toFixed(2).padStart(9)}   ${String(s.trades).padStart(6)}   ${(r.exposure*100).toFixed(0).padStart(9)}%`);
}

console.log(`\n  READING THIS HONESTLY`);
const best = rows.reduce((a, x) => x.s.rr > a.s.rr ? x : a);
console.log(`  · Trend following is NOT expected to out-earn buy-and-hold, and here it`);
console.log(`    ${best.s.cagr >= b.cagr ? 'happens to' : 'does not'} — ${(best.s.cagr*100).toFixed(1)}% vs ${(b.cagr*100).toFixed(1)}% at ${best.n} days.`);
console.log(`  · What it is supposed to do is cut the worst losses: ${(best.s.maxDD*100).toFixed(1)}% vs ${(b.maxDD*100).toFixed(1)}%.`);
console.log(`  · Return per unit of risk: ${best.s.rr.toFixed(2)} vs ${b.rr.toFixed(2)}.`);
console.log(`  · ${best.s.trades} trades in ${YEARS.toFixed(1)} years — costs are irrelevant at this turnover,`);
console.log(`    which is the whole reason this survives where minute-bar trading does not.`);
console.log(`  · ONE index over ${YEARS.toFixed(1)} years is a SMALL sample containing one crash and one`);
console.log(`    bear market. The published evidence is far longer, but this run alone is`);
console.log(`    not proof, and a filter that helps in these regimes can lag badly in others`);
console.log(`    (repeated whipsaws in a choppy, trendless market).`);
console.log('');
