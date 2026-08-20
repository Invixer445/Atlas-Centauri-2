#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS — train-model.js  ·  CAN the bot learn up from down?
//
//  Jupiter ships with a real online learning model (logistic regression over 10
//  features) that is supposed to learn which setups win. It has never had data:
//  it trains one sample at a time from closed trades, and there have barely been
//  any. So the "AI" has been running at its untrained prior — a coin flip — this
//  whole time.
//
//  This feeds it thousands of historical setups and asks the only question that
//  matters: having learned from the PAST, can it predict the FUTURE better than
//  chance? Trained strictly on the earlier portion, scored strictly on the later
//  portion it has never seen.
//
//  If out-of-sample accuracy is ~50%, the features carry no directional signal and
//  no amount of training fixes that — which is worth knowing definitively.
//
//  USAGE
//    node train-model.js                  train on cached daily bars
//    node train-model.js --split 0.7      fraction used for training
//    node train-model.js --write          save the trained weights into the bot
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const engine = require('./server.js');
const I = engine._internals;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes(n);
const SPLIT = Math.min(0.9, Math.max(0.5, parseFloat(arg('--split', '0.7'))));
const RICH  = flag('--rich');   // extended feature set (see richFeatures)
const CACHE = '.backtest-cache';

const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter(f => f.includes('-1Day-')) : [];
if (!files.length) { console.error('✖ No cached daily bars. Run: node backtest.js --bars 1Day --days 700'); process.exit(1); }
const data = {};
for (const f of files) {
  const sym = f.split('-')[0];
  const bars = JSON.parse(fs.readFileSync(`${CACHE}/${f}`, 'utf8'));
  if (bars.length > (data[sym] ? data[sym].length : 0)) data[sym] = bars;
}
const syms = Object.keys(data).filter(s => data[s].length >= 120);
console.log(`\n🧠  MODEL TRAINING — ${syms.length} symbols, daily bars, ${(SPLIT*100).toFixed(0)}% train / ${((1-SPLIT)*100).toFixed(0)}% test\n`);

// Cross-sectional momentum rank per date, precomputed once.
const xsRankByDate = {};
(function buildXsRanks() {
  const byDate = {};
  for (const sym of syms) {
    const b = data[sym];
    for (let i = 21; i < b.length; i++) {
      const mom = (b[i].c - b[i - 20].c) / b[i - 20].c;
      if (!Number.isFinite(mom)) continue;
      (byDate[b[i].t] = byDate[b[i].t] || []).push({ sym, mom });
    }
  }
  for (const t of Object.keys(byDate)) {
    const arr = byDate[t].sort((a2, b2) => a2.mom - b2.mom);
    xsRankByDate[t] = {};
    arr.forEach((o, idx) => { xsRankByDate[t][o.sym] = arr.length > 1 ? idx / (arr.length - 1) : 0.5; });
  }
})();


// ── build labelled samples ───────────────────────────────────────────────────
// One sample per candidate setup: Jupiter's own feature vector at the moment of
// entry, labelled with whether the ATR geometry would have produced a win.
const S = I.STRATEGY;
const samples = [];
for (const sym of syms) {
  const bars = data[sym];
  for (let i = 40; i < bars.length - 12; i++) {
    const window = bars.slice(i - 40, i);
    I.candleData[sym] = { m1: window, m5: [] };
    I.marketData[sym] = {
      price: window[window.length - 1].c,
      prevClose: window[window.length - 2].c,
      dayOpen: window[window.length - 1].o,
      high: Math.max(...window.map(b => b.h)), low: Math.min(...window.map(b => b.l)),
      dailyVolume: window.reduce((a, b) => a + (b.v || 0), 0),
      lastUpdate: Date.now(), lastTradeTime: Date.now(),
      history: window.map(b => b.c)
    };
    const gate = I.evaluateStrategyGate(sym, I.marketData[sym]);
    if (!gate.longGate && !gate.shortGate) continue;
    const dir = gate.longGate ? 'LONG' : 'SHORT';

    const a = I.atrPct(sym);
    if (!(a >= S.MIN_ATR_ENTRY)) continue;
    const entry = bars[i].o;
    const stopPx = dir === 'LONG' ? entry * (1 - S.ATR_STOP_MULT * a) : entry * (1 + S.ATR_STOP_MULT * a);
    const tgtPx  = dir === 'LONG' ? entry * (1 + S.ATR_TARGET_MULT * a) : entry * (1 - S.ATR_TARGET_MULT * a);

    // Resolve the trade forward: stop checked first each bar (pessimistic).
    let label = null;
    for (let j = i; j < Math.min(i + 12, bars.length); j++) {
      const b = bars[j];
      if (dir === 'LONG'  && b.l <= stopPx) { label = 0; break; }
      if (dir === 'SHORT' && b.h >= stopPx) { label = 0; break; }
      if (dir === 'LONG'  && b.h >= tgtPx)  { label = 1; break; }
      if (dir === 'SHORT' && b.l <= tgtPx)  { label = 1; break; }
    }
    if (label === null) continue;                       // unresolved — no clean label

    // Jupiter's OWN feature extractor, via a minimal harness.
    const feats = RICH ? richFeatures(sym, dir, bars, i, window) : featuresFor(sym, dir);
    if (!feats) continue;
    samples.push({ x: feats, y: label, t: bars[i].t, meta: { sym, i, atr: a, entry, dir } });
  }
}

// Reproduce Jupiter's feature vector using the engine's exported indicators, in the
// same order and scaling the live model uses.
function featuresFor(sym, direction) {
  const dir = direction === 'SHORT' ? -1 : 1;
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const adxData = I.calculateADX(sym);
  const q = I.marketData[sym];
  const adx = adxData && Number.isFinite(adxData.adx) ? adxData.adx : 18;
  const atr = I.atrPct(sym);
  const rvol = I.calculateRVOL(sym);
  const rsi = I.rsi(q.history || [], S.RSI_PERIOD);
  const mom = (q.prevClose > 0) ? (q.price - q.prevClose) / q.prevClose : 0;
  const spread = I.estimateDynamicSpread(sym);
  const f = [
    0,                                        // jupiterConv (no Venus signal here)
    0,                                        // catalystEdge
    clip((adx - 20) / 30, -1, 1),
    clip((atr - 0.02) / 0.03, -1, 1),
    clip((rvol - 1) / 1.5, -1, 1),
    clip((dir * (rsi - 50)) / 50, -1, 1),
    clip(dir * mom * 20, -1, 1),
    0,                                        // session (not meaningful on daily bars)
    clip(dir * 0, -1, 1),                     // regimeAlign (no live regime in replay)
    clip((spread - 0.001) / 0.002, -1, 1)
  ];
  return f.every(Number.isFinite) ? f : null;
}

// ── RICH FEATURES ────────────────────────────────────────────────────────────
// The baseline model scored AUC 0.63 using only SIX live features — jupiterConv,
// catalystEdge, session and regimeAlign are all hardcoded to zero in historical
// replay, because Venus signals and intraday session context do not exist here.
// So the measured signal came from a crippled model. These are inputs that ARE
// computable from history and that it has never seen:
//   • where price sits inside its recent range (extension vs exhaustion)
//   • distance from the 20-day mean (stretch)
//   • whether volatility is expanding or contracting
//   • volume relative to its own recent norm
//   • CROSS-SECTIONAL rank — how this stock is doing versus its peers TODAY, which
//     is a different question from anything the old feature set asked
const RICH_NAMES = ['adx','atr','rvol','rsiAlign','momAlign','spread',
                    'rangePos','maStretch','volExpand','volRatio','xsRank','trendAge'];

function richFeatures(sym, direction, bars, i, window) {
  const dir = direction === 'SHORT' ? -1 : 1;
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const q = I.marketData[sym];
  const adxData = I.calculateADX(sym);
  const adx = adxData && Number.isFinite(adxData.adx) ? adxData.adx : 18;
  const atr = I.atrPct(sym);
  const rvol = I.calculateRVOL(sym);
  const rsi = I.rsi(q.history || [], S.RSI_PERIOD);
  const mom = (q.prevClose > 0) ? (q.price - q.prevClose) / q.prevClose : 0;
  const spread = I.estimateDynamicSpread(sym);

  const last20 = window.slice(-20);
  const hi20 = Math.max(...last20.map(b => b.h)), lo20 = Math.min(...last20.map(b => b.l));
  const px = q.price;
  const rangePos = hi20 > lo20 ? (px - lo20) / (hi20 - lo20) : 0.5;          // 0=low, 1=high
  const ma20 = last20.reduce((a2, b) => a2 + b.c, 0) / last20.length;
  const maStretch = ma20 > 0 ? (px - ma20) / ma20 : 0;
  const recentVol = stdOf(last20.slice(-5).map(b => b.c));
  const olderVol  = stdOf(last20.map(b => b.c));
  const volExpand = olderVol > 0 ? recentVol / olderVol : 1;
  const avgVol = last20.reduce((a2, b) => a2 + (b.v || 0), 0) / last20.length;
  const volRatio = avgVol > 0 ? (bars[i - 1].v || 0) / avgVol : 1;
  const xs = (xsRankByDate[bars[i - 1].t] || {})[sym];
  const xsRank = Number.isFinite(xs) ? xs : 0.5;
  // How long the current direction has persisted, as an exhaustion proxy.
  let age = 0;
  for (let k = window.length - 1; k > 0 && age < 10; k--) {
    if ((window[k].c > window[k - 1].c) === (dir > 0)) age++; else break;
  }

  const f = [
    clip((adx - 20) / 30, -1, 1),
    clip((atr - 0.02) / 0.03, -1, 1),
    clip((rvol - 1) / 1.5, -1, 1),
    clip((dir * (rsi - 50)) / 50, -1, 1),
    clip(dir * mom * 20, -1, 1),
    clip((spread - 0.001) / 0.002, -1, 1),
    clip((rangePos - 0.5) * 2 * dir, -1, 1),
    clip(dir * maStretch * 10, -1, 1),
    clip((volExpand - 1) * 2, -1, 1),
    clip((volRatio - 1), -1, 1),
    clip((xsRank - 0.5) * 2 * dir, -1, 1),
    clip((age / 5) - 1, -1, 1)
  ];
  return f.every(Number.isFinite) ? f : null;
}
function stdOf(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}

if (samples.length < 200) { console.error(`✖ Only ${samples.length} labelled setups — not enough to train.`); process.exit(1); }
samples.sort((a, b) => a.t - b.t);                       // chronological, so the split is a real time split
const cut = Math.floor(samples.length * SPLIT);
const train = samples.slice(0, cut), test = samples.slice(cut);
const baseRate = test.reduce((a, s) => a + s.y, 0) / test.length;

console.log(`  labelled setups : ${samples.length}  (train ${train.length}, test ${test.length})`);
console.log(`  win rate overall: ${(samples.reduce((a, s) => a + s.y, 0) / samples.length * 100).toFixed(1)}%`);
console.log(`  win rate in test: ${(baseRate * 100).toFixed(1)}%   <-- always guessing "win" scores this\n`);

// ── train ────────────────────────────────────────────────────────────────────
const DIM = RICH ? RICH_NAMES.length : 10;
const res = engine.trainLogisticBatch(train.map(s => ({ x: s.x, y: s.y })), DIM,
  { epochs: 40, valSplit: 0.2, lr: 0.05, l2: 0.002,
    names: RICH ? RICH_NAMES : engine.jupiter.FEATURES });
const model = res.model;

// ── score on data it has never seen ──────────────────────────────────────────
let correct = 0, tp = 0, fp = 0, fn = 0;
const probs = [];
for (const s of test) {
  const p = model.predict(s.x);
  probs.push({ p, y: s.y });
  const pred = p >= 0.5 ? 1 : 0;
  if (pred === s.y) correct++;
  if (pred === 1 && s.y === 1) tp++;
  if (pred === 1 && s.y === 0) fp++;
  if (pred === 0 && s.y === 1) fn++;
}
const acc = correct / test.length;
// AUC via rank comparison — 0.5 means no discriminating power at all.
probs.sort((a, b) => a.p - b.p);
let rankSum = 0, pos = 0;
probs.forEach((o, idx) => { if (o.y === 1) { rankSum += idx + 1; pos++; } });
const neg = probs.length - pos;
const auc = (pos && neg) ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : 0.5;

console.log('  ── OUT-OF-SAMPLE (data the model never saw) ──');
console.log(`  accuracy        : ${(acc * 100).toFixed(1)}%`);
console.log(`  always-guess-win: ${(Math.max(baseRate, 1 - baseRate) * 100).toFixed(1)}%   <-- must beat this to be useful`);
console.log(`  AUC             : ${auc.toFixed(3)}   (0.50 = no signal, 0.60+ = genuinely useful)`);
console.log(`  train log-loss  : ${res.trainLoss.toFixed(4)}   val ${res.valLoss != null ? res.valLoss.toFixed(4) : '—'}`);
console.log('\n  most influential features:');
for (const f of model.importance(6)) console.log(`     ${f.weight >= 0 ? '+' : ''}${f.weight}  ${f.name}`);

// ACCURACY IS THE WRONG METRIC HERE. Wins are only ~12% of setups, so "always predict
// loss" scores 88% while being useless. AUC is the honest measure of whether the model
// can RANK winners above losers — and ranking is all we need, because we can simply
// decline the low-ranked setups.
const hasSignal = auc > 0.55;

// Does the ranking actually separate outcomes? Win rate by model-probability bucket,
// out-of-sample. If the top bucket wins materially more often than the bottom, the
// model is useful even though its raw accuracy looks unimpressive.
const sorted = [...probs].sort((a, b) => b.p - a.p);
const buckets = 5, per = Math.floor(sorted.length / buckets);
console.log('\n  ── DOES THE RANKING SEPARATE WINNERS? (out-of-sample) ──');
console.log('  model rank        setups   win rate');
const rates = [];
for (let k = 0; k < buckets; k++) {
  const grp = sorted.slice(k * per, (k + 1) * per);
  const wr = grp.reduce((a, o) => a + o.y, 0) / grp.length;
  rates.push(wr);
  const label = k === 0 ? 'top 20% (best)' : k === buckets - 1 ? 'bottom 20% (worst)' : `${k * 20}-${(k + 1) * 20}%`;
  console.log('  ' + label.padEnd(20) + String(grp.length).padStart(4) + (wr * 100).toFixed(1).padStart(10) + '%');
}
const lift = rates[0] / (rates[buckets - 1] || 1e-9);
console.log(`  -> top bucket wins ${isFinite(lift) ? lift.toFixed(1) + 'x' : '∞'} as often as the bottom`);

// Break-even win rate for this geometry, net of costs.
const beWin = 1 / (1 + (S.ATR_TARGET_MULT / S.ATR_STOP_MULT));
console.log(`  -> break-even needs ${(beWin * 100).toFixed(1)}% wins at ${(S.ATR_TARGET_MULT / S.ATR_STOP_MULT).toFixed(2)}:1 reward:risk`);
const topBeatsBE = rates[0] > beWin;

console.log('\n' + '═'.repeat(66));
console.log(hasSignal && topBeatsBE
  ? `  ✅ REAL, USABLE SIGNAL. AUC ${auc.toFixed(3)}, and the top-ranked bucket wins
     ${(rates[0] * 100).toFixed(1)}% vs the ${(beWin * 100).toFixed(1)}% needed to break even. Taking ONLY
     high-ranked setups should turn a losing population into a profitable subset.`
  : hasSignal
    ? `  ⚠️  The model ranks (AUC ${auc.toFixed(3)}) but even its BEST bucket wins only
     ${(rates[0] * 100).toFixed(1)}%, under the ${(beWin * 100).toFixed(1)}% break-even. It can tell better from
     worse, but nothing it likes is good enough to trade profitably.`
    : `  ❌ NO SIGNAL. AUC ${auc.toFixed(3)} is ~chance — these features cannot tell up
     from down, and more training will not change that.`);
console.log('═'.repeat(66) + '\n');
const beatsBaseline = hasSignal && topBeatsBE;

// ── GEOMETRY SWEEP ON THE MODEL'S PICKS ────────────────────────────────────
// The model ranks but its best bucket wins under the break-even for the CURRENT
// 2.09:1 geometry. Break-even at win rate w needs R:R = (1-w)/w, so a lower win rate
// is not fatal if the target is wider. This re-resolves ONLY the top-ranked setups at
// a range of target multiples and reports expectancy in R (units of risk), net of a
// round-trip fee. A wider target lowers the win rate too, so this is a real trade-off,
// not a free lunch — the sweep finds whether any point on it is positive.
{
  const COSTR = 0.30;   // round-trip fee, expressed in R (0.30% fee vs ~1R of 6.6% risk)
  const topFrac = 0.20;
  const scored = test.map((sm, idx) => ({ sm, p: model.predict(sm.x) }))
                     .sort((a, b) => b.p - a.p);
  const top = scored.slice(0, Math.max(20, Math.floor(scored.length * topFrac)));
  console.log(`\n  ── GEOMETRY SWEEP on the model's top ${(topFrac*100).toFixed(0)}% picks (${top.length} setups, out-of-sample) ──`);
  console.log('  target(xATR)   R:R    win%   expectancy(R)   verdict');
  let best = null;
  for (const tgtMult of [4.6, 6.0, 6.6, 8.0, 10.0, 13.0]) {
    let wins = 0, resolved = 0;
    for (const { sm } of top) {
      const r = resolveAt(sm, tgtMult);
      if (r === null) continue;
      resolved++; if (r === 1) wins++;
    }
    if (!resolved) continue;
    const w = wins / resolved;
    const rr = tgtMult / S.ATR_STOP_MULT;
    const exp = w * rr - (1 - w) * 1 - COSTR;      // in units of R
    if (!best || exp > best.exp) best = { tgtMult, rr, w, exp };
    console.log('  ' + String(tgtMult).padEnd(15) + rr.toFixed(2).padStart(5) +
      (w * 100).toFixed(1).padStart(8) + '%' + exp.toFixed(3).padStart(14) +
      (exp > 0 ? '   PROFITABLE' : ''));
  }
  if (best) console.log(`  -> best: target ${best.tgtMult}xATR (${best.rr.toFixed(2)}:1), ` +
    `${(best.w*100).toFixed(1)}% wins, expectancy ${best.exp.toFixed(3)}R` +
    (best.exp > 0 ? '  <-- POSITIVE' : '  <-- still negative'));
}

// ── INVERSION TEST ─────────────────────────────────────────────────────────
// The model's BOTTOM bucket wins 1.9% — those setups fail ~98% of the time. That is a
// far stronger, cleaner signal than anything on the winning side (19-25%). We have
// only ever used the model to pick winners. This asks the opposite question: if it is
// near-certain a LONG here fails, does the SHORT win?
//
// It is NOT automatic. "Fails" means price hit -2.2xATR before +4.6xATR. The mirrored
// trade needs price to reach -4.6xATR before +2.2xATR, which is a strictly harder bar.
// So this is a real experiment, not an arithmetic identity.
{
  console.log('\n  ── INVERSION: take the OPPOSITE side of the model\'s worst-rated setups ──');
  const ranked = test.map(sm => ({ sm, p: model.predict(sm.x) })).sort((a, b) => a.p - b.p);
  console.log('  slice            n    normal win%   INVERTED win%   break-even   verdict');
  const beWin = 1 / (1 + (S.ATR_TARGET_MULT / S.ATR_STOP_MULT));
  // DIRECTION SPLIT — the decisive control. If the setups are overwhelmingly SHORT and
  // the sample period ROSE, then "invert" simply means "go long" and the whole result is
  // market beta wearing a disguise. This is the exact trap that killed four earlier
  // "edges", so it gets checked before anything is believed.
  {
    const longs = ranked.filter(r => r.sm.meta.dir === 'LONG').length;
    const shorts = ranked.length - longs;
    console.log(`  [control] setup directions: ${longs} LONG / ${shorts} SHORT`);
    // Win rate of inverting, split by original direction.
    for (const d of ['LONG', 'SHORT']) {
      const grp = ranked.filter(r => r.sm.meta.dir === d);
      if (!grp.length) continue;
      let inv = 0, ires = 0, norm = 0, nres = 0;
      for (const { sm } of grp) {
        const a2 = resolveDir(sm, d); if (a2 !== null) { nres++; if (a2 === 1) norm++; }
        const flip = d === 'LONG' ? 'SHORT' : 'LONG';
        const b2 = resolveDir(sm, flip); if (b2 !== null) { ires++; if (b2 === 1) inv++; }
      }
      console.log(`  [control] gate said ${d.padEnd(5)} (${grp.length}): as-is ${(nres?norm/nres*100:0).toFixed(1)}%  inverted ${(ires?inv/ires*100:0).toFixed(1)}%`);
    }
  }

  // CONTROL: invert EVERY setup, not just the low-ranked ones. If this also wins ~65%,
  // the model is contributing nothing — the strategy gate is simply backwards, which is
  // a completely different (and much simpler) finding.
  {
    let inv = 0, ires = 0, norm = 0, nres = 0;
    for (const { sm } of ranked) {
      const a2 = resolveDir(sm, sm.meta.dir);
      if (a2 !== null) { nres++; if (a2 === 1) norm++; }
      const flip = sm.meta.dir === 'LONG' ? 'SHORT' : 'LONG';
      const b2 = resolveDir(sm, flip);
      if (b2 !== null) { ires++; if (b2 === 1) inv++; }
    }
    console.log('  ALL setups     ' + String(ranked.length).padStart(5) +
      (nres ? (norm / nres * 100).toFixed(1) : '—').padStart(13) + '%' +
      (ires ? (inv / ires * 100).toFixed(1) : '—').padStart(15) + '%' +
      (beWin * 100).toFixed(1).padStart(12) + '%   <-- CONTROL');
  }
  // And the model's BEST-rated setups, inverted. If the model truly ranks direction,
  // inverting its favourites should do WORSE than inverting its rejects.
  {
    const best = ranked.slice(-Math.max(20, Math.floor(ranked.length * 0.20)));
    let inv = 0, ires = 0;
    for (const { sm } of best) {
      const flip = sm.meta.dir === 'LONG' ? 'SHORT' : 'LONG';
      const b2 = resolveDir(sm, flip);
      if (b2 !== null) { ires++; if (b2 === 1) inv++; }
    }
    console.log('  BEST 20% inv   ' + String(best.length).padStart(5) + '            —' +
      (ires ? (inv / ires * 100).toFixed(1) : '—').padStart(15) + '%' +
      (beWin * 100).toFixed(1).padStart(12) + '%   <-- should be LOW if model ranks');
  }
  for (const frac of [0.20, 0.30, 0.40]) {
    const grp = ranked.slice(0, Math.max(20, Math.floor(ranked.length * frac)));
    let norm = 0, inv = 0, nres = 0, ires = 0;
    for (const { sm } of grp) {
      const a2 = resolveDir(sm, sm.meta.dir);
      if (a2 !== null) { nres++; if (a2 === 1) norm++; }
      const flip = sm.meta.dir === 'LONG' ? 'SHORT' : 'LONG';
      const b2 = resolveDir(sm, flip);
      if (b2 !== null) { ires++; if (b2 === 1) inv++; }
    }
    const nw = nres ? norm / nres : 0, iw = ires ? inv / ires : 0;
    console.log('  worst ' + (frac * 100).toFixed(0) + '%'.padEnd(10) + String(grp.length).padStart(5) +
      (nw * 100).toFixed(1).padStart(13) + '%' + (iw * 100).toFixed(1).padStart(15) + '%' +
      (beWin * 100).toFixed(1).padStart(12) + '%' + (iw > beWin ? '   PROFITABLE INVERTED' : ''));
  }
}

// Resolve a sample in an arbitrary direction, same geometry.
function resolveDir(sm, dir) {
  const m = sm.meta; if (!m) return null;
  const bars = data[m.sym]; if (!bars) return null;
  const a = m.atr, entry = m.entry;
  const stopPx = dir === 'LONG' ? entry * (1 - S.ATR_STOP_MULT * a) : entry * (1 + S.ATR_STOP_MULT * a);
  const tgtPx  = dir === 'LONG' ? entry * (1 + S.ATR_TARGET_MULT * a) : entry * (1 - S.ATR_TARGET_MULT * a);
  for (let j = m.i; j < Math.min(m.i + 12, bars.length); j++) {
    const b = bars[j];
    if (dir === 'LONG'  && b.l <= stopPx) return 0;
    if (dir === 'SHORT' && b.h >= stopPx) return 0;
    if (dir === 'LONG'  && b.h >= tgtPx)  return 1;
    if (dir === 'SHORT' && b.l <= tgtPx)  return 1;
  }
  return null;
}

// Re-resolve one sample's outcome at a different target multiple.
function resolveAt(sm, tgtMult) {
  const m = sm.meta; if (!m) return null;
  const bars = data[m.sym]; if (!bars) return null;
  const a = m.atr, entry = m.entry, dir = m.dir;
  const stopPx = dir === 'LONG' ? entry * (1 - S.ATR_STOP_MULT * a) : entry * (1 + S.ATR_STOP_MULT * a);
  const tgtPx  = dir === 'LONG' ? entry * (1 + tgtMult * a)         : entry * (1 - tgtMult * a);
  for (let j = m.i; j < Math.min(m.i + 30, bars.length); j++) {
    const b = bars[j];
    if (dir === 'LONG'  && b.l <= stopPx) return 0;
    if (dir === 'SHORT' && b.h >= stopPx) return 0;
    if (dir === 'LONG'  && b.h >= tgtPx)  return 1;
    if (dir === 'SHORT' && b.l <= tgtPx)  return 1;
  }
  return null;
}

if (flag('--write') && beatsBaseline && hasSignal) {
  const added = engine.jupiter.ingestTrainingData(samples.map(s => ({ features: s.x, win: s.y })));
  console.log(`  Wrote ${added} samples into Jupiter's training buffer.\n`);
} else if (flag('--write')) {
  console.log('  --write ignored: refusing to install a model with no measured signal.\n');
}
