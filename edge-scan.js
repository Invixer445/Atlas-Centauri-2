#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS — edge-scan.js  ·  does a candidate effect exist AT ALL?
//
//  A full portfolio backtest is the wrong first tool for a new idea: it mixes the
//  question "is there an effect?" with sizing, slots, exits and risk gates, so a
//  real effect can be buried by mechanics and a fake one flattered by them.
//
//  This measures the RETURN DISTRIBUTION of an effect directly. If the mean edge
//  does not clear the round-trip fee here, no amount of engineering downstream can
//  rescue it — and we have saved ourselves building the engineering.
//
//  Every number is a simple forward return on real daily bars, per symbol, pooled.
//  Costs are stated separately so the reader can see gross vs net.
//
//  USAGE
//    node edge-scan.js                 scan every effect on cached daily bars
//    node edge-scan.js --cost 0.003    assume a different round-trip fee
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COST = parseFloat(arg('--cost', '0.003'));      // round-trip, fraction of price
const CACHE = '.backtest-cache';

if (!fs.existsSync(CACHE)) { console.error('✖ No cached bars. Run: node backtest.js --bars 1Day --days 500'); process.exit(1); }
const files = fs.readdirSync(CACHE).filter(f => f.includes('-1Day-'));
if (!files.length) { console.error('✖ No cached DAILY bars. Run: node backtest.js --bars 1Day --days 500'); process.exit(1); }

const data = {};
for (const f of files) {
  const sym = f.split('-')[0];
  const bars = JSON.parse(fs.readFileSync(`${CACHE}/${f}`, 'utf8'));
  if (bars.length > (data[sym] ? data[sym].length : 0)) data[sym] = bars;
}
const syms = Object.keys(data).filter(s => data[s].length >= 100);
console.log(`\n🔎  EDGE SCAN — ${syms.length} symbols, daily bars, assumed round-trip cost ${(COST*100).toFixed(2)}%\n`);

// ── statistics ───────────────────────────────────────────────────────────────
// Unconditional forward return over the same horizon — the return you get for doing
// NOTHING but being long. Any "edge" must beat THIS, not merely beat zero. Over a
// rising sample every long-biased rule looks profitable; that is beta, not alpha.
const baselineCache = {};
function baseline(holdDays) {
  if (baselineCache[holdDays] != null) return baselineCache[holdDays];
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = 0; i < b.length - holdDays; i++) if (b[i].c > 0) r.push((b[i + holdDays].c - b[i].c) / b[i].c); }
  const m = r.length ? r.reduce((a, x) => a + x, 0) / r.length : 0;
  baselineCache[holdDays] = m;
  return m;
}

function stats(name, rets, holdDays) {
  const n = rets.length;
  if (n < 30) return { name, n, skip: true };
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const wins = rets.filter(r => r > 0).length;
  const net = mean - COST;
  // t-statistic: how many standard errors from zero. |t| > 2 is the usual bar for
  // "probably not chance". This is what separates a real effect from a lucky sample.
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const bl = holdDays ? baseline(holdDays) : 0;
  // Excess over simply being long for the same number of days.
  const excess = mean - bl;
  const tExcess = sd > 0 ? excess / (sd / Math.sqrt(n)) : 0;
  return { name, n, meanPct: mean * 100, netPct: net * 100, winPct: wins / n * 100, t,
           blPct: bl * 100, excessPct: excess * 100, tExcess };
}

function show(rows) {
  console.log('  effect                        n     gross%   just-being-long   EXCESS   t(exc)');
  console.log('  ' + '─'.repeat(78));
  for (const r of rows) {
    if (r.skip) { console.log('  ' + r.name.padEnd(28) + String(r.n).padStart(6) + '   (too few samples)'); continue; }
    // The only thing that matters: does it beat buy-and-hold by more than the fee?
    const netExcess = r.excessPct - COST * 100;
    const flag = netExcess > 0 && Math.abs(r.tExcess) > 2 ? '  <-- REAL ALPHA'
               : netExcess > 0 ? '  weak'
               : '';
    console.log('  ' + r.name.padEnd(28) + String(r.n).padStart(6) +
      r.meanPct.toFixed(3).padStart(10) + r.blPct.toFixed(3).padStart(16) +
      r.excessPct.toFixed(3).padStart(10) + r.tExcess.toFixed(2).padStart(8) + flag);
  }
  console.log('  ' + '─'.repeat(78));
}

// ── the candidate effects ────────────────────────────────────────────────────
const results = [];

// 1. OVERNIGHT DRIFT — hold close -> next open. One of the most durable documented
//    equity anomalies: historically a large share of total return accrues overnight.
{
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = 0; i < b.length - 1; i++) if (b[i].c > 0) r.push((b[i + 1].o - b[i].c) / b[i].c); }
  results.push(stats('overnight (close->open)', r, 0));
}

// 2. INTRADAY — hold open -> same close. The mirror image; shown for contrast.
{
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = 0; i < b.length; i++) if (b[i].o > 0) r.push((b[i].c - b[i].o) / b[i].o); }
  results.push(stats('intraday (open->close)', r, 0));
}

// 3. SHORT-TERM REVERSAL — after a sharp multi-day drop, do the next days bounce?
for (const [look, drop, hold] of [[3, 0.05, 3], [5, 0.08, 5], [1, 0.04, 2]]) {
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = look; i < b.length - hold; i++) {
      const past = (b[i].c - b[i - look].c) / b[i - look].c;
      if (past <= -drop) r.push((b[i + hold].c - b[i].c) / b[i].c);
    }
  }
  results.push(stats(`reversal ${look}d drop>${(drop*100)}% hold ${hold}d`, r, hold));
}

// 4. MOMENTUM CONTINUATION — after a sharp multi-day rise, does it keep going?
for (const [look, rise, hold] of [[3, 0.05, 3], [5, 0.08, 5]]) {
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = look; i < b.length - hold; i++) {
      const past = (b[i].c - b[i - look].c) / b[i - look].c;
      if (past >= rise) r.push((b[i + hold].c - b[i].c) / b[i].c);
    }
  }
  results.push(stats(`momentum ${look}d rise>${(rise*100)}% hold ${hold}d`, r, hold));
}

// 5. GAP FADE — after a large opening gap, does it close back toward the prior close?
for (const g of [0.03, 0.05]) {
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = 1; i < b.length; i++) {
      const gap = (b[i].o - b[i - 1].c) / b[i - 1].c;
      if (gap >= g) r.push(-((b[i].c - b[i].o) / b[i].o));   // SHORT the gap up
    }
  }
  results.push(stats(`fade gap-up >${(g*100)}% (short)`, r, 0));
  const r2 = [];
  for (const s of syms) { const b = data[s];
    for (let i = 1; i < b.length; i++) {
      const gap = (b[i].o - b[i - 1].c) / b[i - 1].c;
      if (gap <= -g) r2.push((b[i].c - b[i].o) / b[i].o);    // BUY the gap down
    }
  }
  results.push(stats(`buy gap-down >${(g*100)}%`, r2, 0));
}

// 6. BUY-AND-HOLD baseline — the return you get for doing nothing. Any strategy
//    must beat THIS, not merely beat zero.
{
  const r = [];
  for (const s of syms) { const b = data[s];
    for (let i = 0; i < b.length - 5; i++) if (b[i].c > 0) r.push((b[i + 5].c - b[i].c) / b[i].c); }
  results.push(stats('buy & hold 5 days', r, 5));
}

show(results);

// ── PERSISTENCE ACROSS TIME ─────────────────────────────────────────────────
// Three of twelve tests cleared |t|>2. Testing twelve hypotheses, roughly one
// would clear that bar by chance alone, so a single pass is not evidence. The
// stronger question: does the effect show up in EVERY period, or only in one?
// A real effect is boring and repeats. A fitted one lives in a single stretch.
console.log('\n  PERSISTENCE — the surviving "buy sharp drops" family, by time period');
console.log('  ' + '─'.repeat(78));
function splitTest(label, collect, holdDays, parts = 3) {
  const perPart = [];
  for (let k = 0; k < parts; k++) {
    const r = [];
    for (const s of syms) {
      const b = data[s];
      const lo = Math.floor(b.length * k / parts), hi = Math.floor(b.length * (k + 1) / parts);
      collect(b, lo, hi, r);
    }
    if (r.length < 20) { perPart.push(null); continue; }
    const mean = r.reduce((a, x) => a + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1));
    // baseline over the same period
    const bl = [];
    for (const s of syms) {
      const b = data[s];
      const lo = Math.floor(b.length * k / parts), hi = Math.floor(b.length * (k + 1) / parts);
      for (let i = lo; i < hi - holdDays; i++) if (b[i].c > 0) bl.push((b[i + holdDays].c - b[i].c) / b[i].c);
    }
    const blm = bl.length ? bl.reduce((a, x) => a + x, 0) / bl.length : 0;
    perPart.push({ n: r.length, excess: (mean - (holdDays ? blm : 0)) * 100,
                   t: sd > 0 ? (mean - (holdDays ? blm : 0)) / (sd / Math.sqrt(r.length)) : 0 });
  }
  const cells = perPart.map(p => p ? (p.excess.toFixed(2) + '%').padStart(9) + ('(t' + p.t.toFixed(1) + ',n' + p.n + ')').padStart(13) : '        —            ');
  console.log('  ' + label.padEnd(26) + cells.join(''));
  const good = perPart.filter(p => p && p.excess > COST * 100 && p.t > 1).length;
  const seen = perPart.filter(p => p).length;
  console.log('  ' + ' '.repeat(26) + `-> beat the fee in ${good} of ${seen} periods` +
    (good === seen && seen >= 3 ? '   <-- PERSISTENT' : good <= 1 ? '   <-- NOT persistent' : '   <-- mixed'));
}
console.log('  effect                        oldest third      middle third       newest third');
console.log('  ' + '─'.repeat(78));
splitTest('reversal 1d drop>4% h2d', (b, lo, hi, r) => {
  for (let i = Math.max(lo, 1); i < hi - 2; i++) {
    const past = (b[i].c - b[i - 1].c) / b[i - 1].c;
    if (past <= -0.04) r.push((b[i + 2].c - b[i].c) / b[i].c);
  }
}, 2);
splitTest('buy gap-down >3%', (b, lo, hi, r) => {
  for (let i = Math.max(lo, 1); i < hi; i++) {
    const gap = (b[i].o - b[i - 1].c) / b[i - 1].c;
    if (gap <= -0.03) r.push((b[i].c - b[i].o) / b[i].o);
  }
}, 0);
splitTest('buy gap-down >5%', (b, lo, hi, r) => {
  for (let i = Math.max(lo, 1); i < hi; i++) {
    const gap = (b[i].o - b[i - 1].c) / b[i - 1].c;
    if (gap <= -0.05) r.push((b[i].c - b[i].o) / b[i].o);
  }
}, 0);
console.log('  ' + '─'.repeat(78));


console.log('\n  READING THIS TABLE');
console.log('  gross%          = average return per occurrence, before fees');
console.log('  just-being-long = unconditional return over the SAME holding period');
console.log('  EXCESS          = gross minus that. This is alpha; the rest is beta.');
console.log('  t(exc)          = t-stat on the excess. |t|>2 = probably not chance.');
console.log('');
console.log('  To be tradeable an effect needs EXCESS > ' + (COST*100).toFixed(2) + '% (the fee) AND |t(exc)| > 2.');
console.log('  Intraday/gap rows have a 0-day baseline, so their excess equals gross.\n');
