#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — regression test suite   (run: npm test)
//
//  Zero dependencies. Locks in the invariants that were previously only ever
//  verified by hand — including the two real bugs found in v11.19:
//    • the sentiment EMA silently coupling to the main-loop tick rate
//    • orphaned `_exiting` marks surviving a restart and killing stop-losses
//
//  Importing server.js does NOT boot the engine (it guards on require.main), so
//  these run offline with no market data, no broker, and no network.
//
//  NOTE: exits via process.exit() on purpose — applyEntryFill/closeLong call
//  queueSaveState(), which arms a 5s debounced write to the REAL state file.
//  Exiting before it fires keeps the suite from clobbering live bot state.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const engine = require('./server.js');
const I = engine._internals;

const MARGIN_RATE = 0.5;   // mirrors server.js (not exported; asserted via relationships)

let passed = 0, failed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('returned false');
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failures.push(name);
    failed++;
  }
}
function group(title) { console.log(`\n${title}`); }
function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label} expected ${expected}, got ${actual}`);
}
function near(actual, expected, tol, label = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label} expected ~${expected} (±${tol}), got ${actual}`);
  }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'assertion failed'); }

// Reset shared module state between tests that mutate it.
function resetBook() {
  Object.keys(I.portfolio.longPositions).forEach(k => delete I.portfolio.longPositions[k]);
  Object.keys(I.portfolio.shortPositions).forEach(k => delete I.portfolio.shortPositions[k]);
  I.portfolio.trades.length = 0;
  I.portfolio.closedTrades.length = 0;
  I.portfolio.cash = 1000;
  I.riskSystem.dailyTradeCount = 0;
  I.riskSystem.consecutiveLosses = 0;
  I.setPendingOrders({});
}

function seedSymbol(sym, price = 20) {
  I.marketData[sym] = {
    price, prevClose: price * 0.98, high: price * 1.02, low: price * 0.97,
    dayOpen: price * 0.99, dailyVolume: 5e6,
    lastUpdate: Date.now(), lastTradeTime: Date.now(),
    history: Array.from({ length: 30 }, (_, i) => price * (0.97 + i * 0.002))
  };
  I.candleData[sym] = {
    m1: Array.from({ length: 40 }, (_, i) => {
      const b = price * (0.97 + i * 0.0015);
      return { t: i, o: b, h: b * 1.004, l: b * 0.996, c: b, v: 12000 };
    })
  };
}

console.log('🧪  ATLAS CENTAURI — regression suite');

// ════════════════════════════════════════════════════════════════════════════
group('RISK RAILS — must never be silently loosened');
// These are the survival limits. A tuning pass must not move them without an
// explicit decision; this test is the tripwire for that.
check('maxDrawdown = 20%',            () => eq(I.riskSystem.maxDrawdown, 0.20));
check('dailyLossLimit = 5%',          () => eq(I.riskSystem.dailyLossLimit, 0.05));
check('maxPortfolioHeat = 50%',       () => eq(I.riskSystem.maxPortfolioHeat, 0.50));
check('maxConsecutiveLosses = 4',     () => eq(I.riskSystem.maxConsecutiveLosses, 4));
check('safeModeDrawdown = 10%',       () => eq(I.capitalSystem.safeModeDrawdown, 0.10));
check('emergencyDrawdown = 20%',      () => eq(I.capitalSystem.emergencyDrawdown, 0.20));
check('risk/trade cap ≥ base',        () => ok(I.STRATEGY.RISK_PER_TRADE_MAX >= I.STRATEGY.RISK_PER_TRADE_BASE));
check('risk/trade cap ≤ 3% ceiling',  () => ok(I.STRATEGY.RISK_PER_TRADE_MAX <= 0.03,
                                          `cap ${I.STRATEGY.RISK_PER_TRADE_MAX} exceeds the 3% ceiling`));
check('MIN_RR ≥ 1.5',                 () => ok(I.STRATEGY.MIN_RR >= 1.5));
check('target mult > stop mult (positive R:R by construction)',
                                      () => ok(I.STRATEGY.ATR_TARGET_MULT > I.STRATEGY.ATR_STOP_MULT));

// ════════════════════════════════════════════════════════════════════════════
group('SENTIMENT EMA — must be independent of main-loop tick rate (v11.19 bug)');
// Regression guard: a flat per-call alpha makes the filter's real-world
// responsiveness a function of how often the loop happens to run. Changing the
// loop cadence must NOT change how fast sentiment converges.
// These drive the REAL exported sentimentAlpha() from server.js — not a copy of the
// formula — so reverting the fix makes them fail. (Verified by mutation testing.)
check('sentimentAlpha(10s) reproduces the original 0.2 step exactly', () => {
  near(I.sentimentAlpha(I.SENTIMENT_EMA_REF_MS), 0.2, 1e-9, 'alpha at reference cadence');
});
check('equal wall-clock elapsed converges identically at ANY tick rate', () => {
  const converge = (cadenceMs, seconds) => {
    let v = 0.5;
    const target = 0.8;
    const a = I.sentimentAlpha(cadenceMs);          // production function
    for (let i = 0; i < Math.floor(seconds * 1000 / cadenceMs); i++) v = v * (1 - a) + target * a;
    return v;
  };
  for (const secs of [10, 30, 60, 120]) {
    // 2s loop vs 10s loop must land in the same place after the same real time.
    near(converge(2000, secs), converge(10000, secs), 1e-6, `${secs}s convergence`);
    near(converge(500, secs),  converge(10000, secs), 1e-6, `${secs}s @500ms`);
  }
});
check('a flat-alpha (pre-fix) filter demonstrably FAILS that property', () => {
  // Control: proves the test above has teeth rather than passing vacuously.
  const naive = (cadenceMs, seconds) => {
    let v = 0.5;
    for (let i = 0; i < Math.floor(seconds * 1000 / cadenceMs); i++) v = v * 0.8 + 0.8 * 0.2;
    return v;
  };
  ok(Math.abs(naive(2000, 10) - naive(10000, 10)) > 0.1,
     'the buggy formula should diverge across cadences');
});
check('sentimentAlpha is bounded (0,1] and safe on junk input', () => {
  for (const dt of [0, 1, 10000, 60000, 1e9, -5, NaN, undefined]) {
    const a = I.sentimentAlpha(dt);
    ok(Number.isFinite(a) && a >= 0 && a <= 1, `alpha(${dt}) = ${a} out of range`);
  }
  ok(I.sentimentAlpha(1e9) < 1, 'a huge gap must not pin alpha at exactly 1');
  ok(I.sentimentAlpha(60000) > I.sentimentAlpha(10000), 'longer gap → larger step');
});

check('computeMarketBreadth keeps sentiment finite and inside the [0.2,0.8] clamp', () => {
  // Note: returns early when the market is closed (symbolsForMarket is empty), so this
  // asserts the invariant holds either way rather than asserting a specific movement.
  ['PLTR', 'SOFI'].forEach(s => seedSymbol(s));
  const before = I.sentimentData.general;
  for (let i = 0; i < 50; i++) I.computeMarketBreadth();
  const g = I.sentimentData.general;
  ok(Number.isFinite(g), 'sentiment went non-finite');
  ok(g >= 0.2 && g <= 0.8, `sentiment ${g} outside clamp band`);
  ok(Number.isFinite(before), 'baseline sane');
});

// ════════════════════════════════════════════════════════════════════════════
group('ORPHANED IN-FLIGHT MARKS — a restart must not kill stop-losses (v11.19 bug)');
check('orphaned _exiting is cleared (exit re-armed)', () => {
  resetBook();
  I.portfolio.longPositions['PLTR'] = [{ lotId: 'a', qty: 10, entryPrice: 20, _exiting: true }];
  const cleared = I.clearOrphanedInFlightMarks();
  eq(cleared, 1, 'cleared count');
  eq(I.portfolio.longPositions['PLTR'][0]._exiting, undefined, '_exiting');
});

check('_exiting WITH a live pending order is preserved (poller still owns it)', () => {
  resetBook();
  I.portfolio.longPositions['PLTR'] = [{ lotId: 'a', qty: 10, entryPrice: 20, _exiting: true }];
  I.setPendingOrders({ 'o1': { kind: 'exitLong', ticker: 'PLTR', direction: 'LONG', submittedAt: Date.now() } });
  const cleared = I.clearOrphanedInFlightMarks();
  eq(cleared, 0, 'cleared count');
  eq(I.portfolio.longPositions['PLTR'][0]._exiting, true, '_exiting preserved');
});

check('orphaned _pendingRung is cleared; matching rung preserved', () => {
  resetBook();
  I.portfolio.longPositions['AAA'] = [{ lotId: 'a', qty: 10, entryPrice: 20, _pendingRung: 'tp1' }];
  I.portfolio.longPositions['BBB'] = [{ lotId: 'b', qty: 10, entryPrice: 20, _pendingRung: 'tp2' }];
  I.setPendingOrders({ 'o1': { kind: 'partial', ticker: 'BBB', direction: 'LONG', rung: 'tp2', submittedAt: Date.now() } });
  const cleared = I.clearOrphanedInFlightMarks();
  eq(cleared, 1, 'cleared count');
  eq(I.portfolio.longPositions['AAA'][0]._pendingRung, undefined, 'orphan cleared');
  eq(I.portfolio.longPositions['BBB'][0]._pendingRung, 'tp2', 'live rung preserved');
});

check('shorts are covered too, and a wrong-direction order does not count as live', () => {
  resetBook();
  I.portfolio.shortPositions['MARA'] = [{ lotId: 'c', qty: 5, entryPrice: 30, _exiting: true }];
  // an exitLong order for the same ticker must NOT protect a SHORT lot
  I.setPendingOrders({ 'o1': { kind: 'exitLong', ticker: 'MARA', direction: 'LONG', submittedAt: Date.now() } });
  eq(I.clearOrphanedInFlightMarks(), 1, 'cleared count');
  eq(I.portfolio.shortPositions['MARA'][0]._exiting, undefined, '_exiting');
});

// ════════════════════════════════════════════════════════════════════════════
group('TRADE PLAN GEOMETRY — every plan must carry a sane stop');
check('LONG stop sits below entry, target above', () => {
  seedSymbol('PLTR', 20);
  const p = I.buildTradePlan('PLTR', 'LONG', 20, 0.7, 'test');
  ok(p.stop.price < p.entryPrice, `stop ${p.stop.price} not below entry ${p.entryPrice}`);
  ok(p.target.price > p.entryPrice, 'target not above entry');
});
check('SHORT stop sits above entry, target below', () => {
  seedSymbol('PLTR', 20);
  const p = I.buildTradePlan('PLTR', 'SHORT', 20, 0.7, 'test');
  ok(p.stop.price > p.entryPrice, 'stop not above entry');
  ok(p.target.price < p.entryPrice, 'target not below entry');
});
check('reward:risk always clears MIN_RR by construction', () => {
  seedSymbol('PLTR', 20);
  for (const dir of ['LONG', 'SHORT']) {
    const p = I.buildTradePlan('PLTR', dir, 20, 0.7, 'test');
    ok(p.rewardRisk >= I.STRATEGY.MIN_RR, `${dir} R:R ${p.rewardRisk} < ${I.STRATEGY.MIN_RR}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
group('TERRA GATE — rejects malformed plans (rules 1–3, order-independent)');
const basePlan = () => {
  seedSymbol('PLTR', 20);
  return I.buildTradePlan('PLTR', 'LONG', 20, 0.7, 'test');
};
check('rejects a plan with no stop loss', () => {
  const p = { ...basePlan(), shares: 10, stop: null };
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/stop/i.test(v.reason), `reason was: ${v.reason}`);
});
check('rejects LONG whose stop is not below entry', () => {
  const p = { ...basePlan(), shares: 10 };
  p.stop = { price: p.entryPrice + 1, frac: 0.03 };
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/stop not below/i.test(v.reason), `reason was: ${v.reason}`);
});
check('rejects thin reward:risk', () => {
  const p = { ...basePlan(), shares: 10, rewardRisk: 0.5 };
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/R:R/i.test(v.reason), `reason was: ${v.reason}`);
});
check('rejects size below 1 share', () => {
  const p = { ...basePlan(), shares: 0 };
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/1 share/i.test(v.reason), `reason was: ${v.reason}`);
});
check('rejects a price above the max', () => {
  // Uses a HIGH price rather than a penny stock: on a $0.50 name the one-cent tick is
  // a 2% spread, so the v11.20 economic gate legitimately rejects it first and the
  // price rule never gets exercised. A $5,000 name has negligible tick spread, so this
  // isolates the bound under test.
  seedSymbol('PRICEY', 5000);
  const p = I.buildTradePlan('PRICEY', 'LONG', 5000, 0.7, 'test');
  p.shares = 1;
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/above/i.test(v.reason), `reason was: ${v.reason}`);
});
check('a sub-$2 stock is rejected (economics or the price rule — either is correct)', () => {
  seedSymbol('PENNY', 0.5);
  const p = I.buildTradePlan('PENNY', 'LONG', 0.5, 0.7, 'test');
  p.shares = 10;
  const v = I.terraValidateTrade(p);
  eq(v.approved, false, 'a 2%-tick-spread penny stock must never be tradeable');
});

// ════════════════════════════════════════════════════════════════════════════
group('TRADE ECONOMICS — costs must be in the gate, not just the geometry');
check('spread model is microstructure-realistic, not session-range-driven', () => {
  // Was `0.25% + sessionRange*0.5`, which modelled a 3%-range day as a 1.5% bid-ask.
  // Backtesting measured a 1.73% median round trip — ~5x reality — which once costs
  // entered the gate rejected essentially every trade.
  seedSymbol('LIQ', 20);
  const sp = I.estimateDynamicSpread('LIQ');
  ok(sp > 0 && sp < 0.006, `spread ${(sp * 100).toFixed(3)}% is not realistic for a $20 liquid name`);
  ok(sp >= 0.01 / 20 * 0.9, 'spread must never fall below one tick');
});
check('a cheaper stock has a wider tick-relative spread', () => {
  seedSymbol('CHEAP', 3); seedSymbol('DEAR', 300);
  ok(I.estimateDynamicSpread('CHEAP') > I.estimateDynamicSpread('DEAR'),
     'a $3 stock must quote wider in percentage terms than a $300 one');
});
check('round-trip cost is bounded and finite', () => {
  seedSymbol('LIQ', 20);
  const c = I.estimateRoundTripCost('LIQ');
  ok(Number.isFinite(c) && c > 0 && c < 0.05, `round trip ${c} out of range`);
});
check('net R:R is always below gross R:R when costs are real', () => {
  const gross = 0.046 / 0.022;
  const net = I.netRewardRisk(0.046, 0.022, 0.003);
  ok(net < gross, 'costs must reduce reward:risk');
  ok(net > 0, 'should still be positive here');
});
check('net R:R goes BELOW 1 exactly where the live bot was losing', () => {
  // 0.3% ATR: target 1.38%, stop 0.66%, ~0.55% round trip -> the average loss is
  // bigger than the average win. Gross R:R still reads a healthy 2.09.
  const a = 0.003, cost = 0.0055;
  const net = I.netRewardRisk(4.6 * a, 2.2 * a, cost);
  ok(net < 1, `net R:R ${net.toFixed(2)} should be under 1 — this is the losing case`);
  ok((4.6 * a) / (2.2 * a) > 2, 'gross R:R still looks fine, which is why it went unnoticed');
});
// Each economic gate is tested where it is the ONLY one that can fire — otherwise they
// mask each other and removing either one still "passes" (mutation testing caught this).
const planWith = (o) => ({ ticker: 'X', direction: 'LONG', entryPrice: 20, shares: 10,
  stop: { price: 19.87, frac: 0.0066 }, target: { price: 20.24, frac: 0.012 },
  rewardRisk: 0.012 / 0.0066, cost: 0.004,
  netRewardRisk: I.netRewardRisk(0.012, 0.0066, 0.004),
  targetCostRatio: 0.012 / 0.004, ...o });

check('net-R:R gate fires on its own (target/cost ratio is fine)', () => {
  const p = planWith({});
  ok(p.targetCostRatio >= I.STRATEGY.MIN_TARGET_COST_RATIO, 'setup: cost-ratio gate must NOT be the one firing');
  ok(p.rewardRisk >= I.STRATEGY.MIN_RR, 'setup: gross R:R must pass');
  ok(p.netRewardRisk < I.STRATEGY.MIN_RR_NET, 'setup: net R:R must be the failing condition');
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/net R:R/i.test(v.reason), `reason was: ${v.reason}`);
});
check('target-vs-cost gate fires on its own', () => {
  // Mathematically the net-R:R gate subsumes most of this one (net >= 1.35 already
  // implies target >= ~2.35x cost), so it is exercised with the net gate relaxed.
  // It is kept as a backstop and for a clearer rejection message.
  const saved = I.STRATEGY.MIN_RR_NET;
  try {
    I.STRATEGY.MIN_RR_NET = 0.1;
    const p = planWith({ cost: 0.006, targetCostRatio: 0.012 / 0.006,
                         netRewardRisk: I.netRewardRisk(0.012, 0.0066, 0.006) });
    ok(p.netRewardRisk >= 0.1, 'setup: net gate must NOT be the one firing');
    ok(p.targetCostRatio < I.STRATEGY.MIN_TARGET_COST_RATIO, 'setup: cost ratio must be the failing condition');
    const v = I.terraValidateTrade(p);
    eq(v.approved, false);
    ok(/round-trip cost/i.test(v.reason), `reason was: ${v.reason}`);
  } finally { I.STRATEGY.MIN_RR_NET = saved; }
});

// ════════════════════════════════════════════════════════════════════════════
group('P&L ACCOUNTING — deterministic (exact broker-fill prices, no slippage RNG)');
check('LONG round-trip: cash and realized P&L are exact', () => {
  resetBook();
  seedSymbol('PLTR', 20);
  const startCash = I.portfolio.cash;
  const plan = I.buildTradePlan('PLTR', 'LONG', 20, 0.7, 'test');
  I.applyEntryFill(plan, 20, 10, false);                 // buy 10 @ 20 = -200
  near(I.portfolio.cash, startCash - 200, 1e-6, 'cash after entry');
  I.closeLong('PLTR', false, { brokerFill: true, fillPrice: 22 });   // sell 10 @ 22 = +220
  near(I.portfolio.cash, startCash + 20, 1e-6, 'cash after exit');
  const c = I.portfolio.closedTrades.at(-1);
  near(c.realizedPnL, 20, 1e-6, 'realized P&L');
});

check('SHORT round-trip: margin returned + P&L, borrow fee ~0 intraday', () => {
  resetBook();
  seedSymbol('MARA', 30);
  const startCash = I.portfolio.cash;
  const plan = I.buildTradePlan('MARA', 'SHORT', 30, 0.7, 'test');
  I.applyEntryFill(plan, 30, 10, false);                  // margin = 30*10*0.5 = -150
  near(I.portfolio.cash, startCash - 150, 1e-6, 'cash after short entry');
  I.closeShort('MARA', false, { brokerFill: true, fillPrice: 28 });  // +150 margin, +20 gross
  const c = I.portfolio.closedTrades.at(-1);
  near(c.realizedPnL, 20, 0.05, 'realized P&L (borrow ≈ 0 intraday)');
  ok(I.portfolio.cash > startCash, 'profitable short should raise cash');
});

check('losing trade increments consecutiveLosses; winner resets it', () => {
  resetBook();
  seedSymbol('PLTR', 20);
  const p1 = I.buildTradePlan('PLTR', 'LONG', 20, 0.7, 'test');
  I.applyEntryFill(p1, 20, 5, false);
  I.closeLong('PLTR', true, { brokerFill: true, fillPrice: 19 });    // loss
  eq(I.riskSystem.consecutiveLosses, 1, 'after loss');
  const p2 = I.buildTradePlan('PLTR', 'LONG', 20, 0.7, 'test');
  I.applyEntryFill(p2, 20, 5, false);
  I.closeLong('PLTR', false, { brokerFill: true, fillPrice: 21 });   // win
  eq(I.riskSystem.consecutiveLosses, 0, 'after win');
});

check('open SHORT equity counts locked margin (not a phantom drawdown)', () => {
  resetBook();
  seedSymbol('MARA', 30);
  const before = I.getTotalValue();
  const plan = I.buildTradePlan('MARA', 'SHORT', 30, 0.7, 'test');
  I.applyEntryFill(plan, 30, 10, false);
  const after = I.getTotalValue();
  // Cash fell by the margin, but equity must be ~flat: the collateral is still ours.
  near(after, before, 0.01, 'equity should not dip just from opening a short');
});

// ════════════════════════════════════════════════════════════════════════════
group('VOLATILITY DATA QUALITY — the live money-loser (5 straight losses)');
// A session ran with candles for only 3 of 21 symbols. Tick-fallback ATR collapsed to
// the floor, producing stops INSIDE the round-trip spread. These lock that shut.
check('a symbol with no candles is flagged as fallback quality', () => {
  delete I.candleData['NOCANDLE'];
  eq(I.atrQuality('NOCANDLE'), 'fallback');
  eq(I.hasReliableVolatility('NOCANDLE'), false);
});
check('too few candles still counts as fallback', () => {
  I.candleData['FEW'] = { m1: Array.from({ length: I.MIN_CANDLES_FOR_ATR - 1 },
    (_, i) => ({ t: i, o: 10, h: 10.1, l: 9.9, c: 10, v: 100 })) };
  eq(I.atrQuality('FEW'), 'fallback');
});
check('enough candles is candle-grade', () => {
  seedSymbol('GOOD', 20);   // seeds 40 m1 bars
  eq(I.atrQuality('GOOD'), 'candle');
  eq(I.hasReliableVolatility('GOOD'), true);
});
check('fallback ATR floor keeps the stop clear of round-trip costs', () => {
  // The whole bug: 0.3% ATR -> 0.66% stop vs ~0.5-1.5% round-trip cost.
  delete I.candleData['NOCANDLE'];
  I.marketData['NOCANDLE'] = { price: 20, prevClose: 20, high: 20, low: 20,
                               lastUpdate: Date.now(), history: [20, 20, 20] };
  const a = I.atrPct('NOCANDLE');
  ok(a >= 0.008, `fallback atrPct ${a} below the 0.8% floor`);
  const stopFrac = Math.max(0.004, I.STRATEGY.ATR_STOP_MULT * a);
  ok(stopFrac >= 0.017, `stop ${(stopFrac * 100).toFixed(2)}% is too tight to survive costs`);
});
check('candle-grade symbols keep the tighter floor (calm names not over-widened)', () => {
  seedSymbol('CALM', 100);
  ok(I.atrQuality('CALM') === 'candle');
  const a = I.atrPct('CALM');
  ok(a >= 0.003 && a <= 0.15, `atrPct ${a} out of band`);
});

// ════════════════════════════════════════════════════════════════════════════
group('13F INSTITUTIONAL SCORE — must discriminate, not saturate');
check('does not saturate across the realistic filing range', () => {
  const s = [52, 242, 1675, 3127, 10000].map(I.institutionalScore);
  for (let i = 1; i < s.length; i++) {
    ok(s[i] > s[i - 1], `score did not increase from ${s[i - 1]} to ${s[i]}`);
  }
  ok(s[0] < 0.6 && s[4] >= 0.99, `range too narrow: ${s[0]} .. ${s[4]}`);
});
check('the old /2 formula demonstrably DID saturate (control)', () => {
  const old = f => Math.max(0, Math.min(1, Math.log10(1 + f) / 2));
  eq(old(242), 1, 'control: 242 filings should have saturated');
  eq(old(10000), 1, 'control: 10000 filings should have saturated');
  ok(I.institutionalScore(242) < I.institutionalScore(10000), 'new formula must separate them');
});
check('handles junk input', () => {
  for (const f of [0, -5, NaN, undefined, null]) {
    const s = I.institutionalScore(f);
    ok(Number.isFinite(s) && s >= 0 && s <= 1, `score ${s} invalid for ${f}`);
  }
});

group('RESEARCH DIRECTION — 13F must never pick a side');
check('institutional interest alone yields NO direction, even at max score', () => {
  // The structural long-only bias: `newsDir || (instScore >= 0.3 ? 'long' : null)` with
  // a saturated score meant every idea was forced LONG. Every rec in the live log was LONG.
  eq(I.ideaDirection(null, 1.0), null, 'max institutional score must not imply long');
  eq(I.ideaDirection(null, 0.5), null);
  eq(I.ideaDirection(undefined, 1.0), null);
});
check('news direction is honoured in BOTH directions', () => {
  eq(I.ideaDirection('long', 0), 'long');
  eq(I.ideaDirection('short', 0), 'short', 'shorts must be expressible');
  eq(I.ideaDirection('short', 1.0), 'short', 'institutional score must not override a short');
});
check('garbage direction values are rejected', () => {
  for (const d of ['sideways', '', 0, {}, true]) eq(I.ideaDirection(d, 1.0), null, `for ${String(d)}`);
});

// ════════════════════════════════════════════════════════════════════════════
group('LIQUIDITY THRESHOLD — must match the data feed in use');
check('iex feed scales the consolidated threshold down', () => {
  ok(I.EFFECTIVE_MIN_DAY_VOL < I.DYNAMIC_MIN_DAY_VOL,
     'IEX reports ~3% of consolidated volume; threshold must scale or it rejects everything');
});
check('the symbols rejected live would now pass', () => {
  // From the live log: MP 220090, NBIS 314679, BYND 91975 — all real, liquid mid-caps
  // wrongly rejected as "too thin" because IEX volume was compared to a consolidated bar.
  for (const [sym, vol] of [['MP', 220090], ['NBIS', 314679], ['BYND', 91975]]) {
    ok(vol >= I.EFFECTIVE_MIN_DAY_VOL, `${sym} (${vol}) still rejected by ${I.EFFECTIVE_MIN_DAY_VOL}`);
  }
});
check('genuinely illiquid volume is still rejected', () => {
  ok(500 < I.EFFECTIVE_MIN_DAY_VOL, 'a 500-share day must still fail the screen');
});

// ════════════════════════════════════════════════════════════════════════════
group('CONSECUTIVE-LOSS HALT — must be a cooldown, not a deadlock');
// The counter resets only on a WIN or a new ET day, but the halt blocks entries, so no
// win can occur -> it bricked itself until midnight while logging "cooling off".
check('the halt expires and re-arms entries', () => {
  I.riskSystem.consecutiveLosses = 5;
  I.riskSystem.lossHaltUntil = Date.now() - 1000;      // already elapsed
  const released = I.releaseExpiredLossHalt();
  eq(released, true, 'should have released');
  eq(I.riskSystem.consecutiveLosses, 0, 'streak must clear so it cannot re-block instantly');
  eq(I.riskSystem.lossHaltUntil, 0, 'halt timestamp cleared');
});
check('an UNEXPIRED halt is left alone', () => {
  I.riskSystem.consecutiveLosses = 5;
  I.riskSystem.lossHaltUntil = Date.now() + 10 * 60000;
  eq(I.releaseExpiredLossHalt(), false, 'must not release early');
  eq(I.riskSystem.consecutiveLosses, 5, 'streak preserved during cool-off');
  I.riskSystem.consecutiveLosses = 0; I.riskSystem.lossHaltUntil = 0;   // cleanup
});
check('a high loss count alone no longer blocks forever (the deadlock)', () => {
  // Tests lossHaltReason() directly, NOT getKillSwitchReason(): that outer function
  // returns early on `!wsConnected`, which is always true offline — an earlier version
  // of this test passed for that reason alone and mutation testing caught it.
  I.riskSystem.consecutiveLosses = 99;                 // far past maxConsecutiveLosses
  I.riskSystem.lossHaltUntil = 0;                      // but no active cool-off
  eq(I.lossHaltReason(), null,
     'a raw counter with no live cool-off must NOT block — that was the deadlock');
  I.riskSystem.consecutiveLosses = 0;
});
check('an active cool-off DOES block, and says how long is left', () => {
  I.riskSystem.consecutiveLosses = 4;
  I.riskSystem.lossHaltUntil = Date.now() + 10 * 60000;
  const reason = I.lossHaltReason();
  ok(reason && /consecutive losses/.test(reason), `expected a halt reason, got: ${reason}`);
  ok(/\d+min/.test(reason), `reason should state remaining time, got: ${reason}`);
  I.riskSystem.consecutiveLosses = 0; I.riskSystem.lossHaltUntil = 0;
});
check('LOSS_HALT_MS is a sane, finite cooldown', () => {
  ok(Number.isFinite(I.LOSS_HALT_MS) && I.LOSS_HALT_MS > 0 && I.LOSS_HALT_MS <= 4 * 3600 * 1000,
     `LOSS_HALT_MS ${I.LOSS_HALT_MS} out of range`);
});

// ════════════════════════════════════════════════════════════════════════════
group('SIGNAL AGEING — a re-reported idea must actually decay');
const freshJupiter = () => {
  const j = engine.createJupiter({ strategy: I.STRATEGY });
  j.init({
    strategy: I.STRATEGY, venus: engine.venus,
    capitalSystem: { safeMode: false, tradingCapital: 1000 },
    riskSystem: { consecutiveLosses: 0, currentDrawdown: 0 },
    aiSystem: { aggressionLevel: 0.5 },
    helpers: {
      atrPct: () => 0.02, calculateATR: () => 0.5, calculateRVOL: () => 1.2,
      calculateMarketStress: () => 0.1, getGapSizeAdjust: () => 1,
      calculateTradeExpectancy: () => ({ winRate: 0.5, profitFactor: 1, avgWin: 10, avgLoss: 8 }),
      isHighVolatility: () => false, closedTradeCount: () => 0,
      adx: () => ({ adx: 25 }), rsi: () => 55, regimeNumeric: () => 1,
      sessionFraction: () => 0.5, spread: () => 0.001,
      quote: () => ({ price: 10, prevClose: 9.9 })
    }
  });
  return j;
};
const REC = () => ({ symbol: 'AAA', direction: 'long', conviction: 0.7,
                     catalyst: 'earnings', reasoning: 'x', horizonMinutes: 240 });

check('re-reporting the SAME idea preserves its original birth time', () => {
  // Venus re-emits its whole watchlist every cycle. Stamping createdAt=now each time
  // pinned the decay term in scoreAdjustment at full strength forever, so a 240-minute
  // "horizon" refreshed every few minutes never aged at all.
  //
  // The signal is BACKDATED between the two calls rather than sleeping: both calls would
  // otherwise land in the same millisecond, making `createdAt = now` and
  // `createdAt = prev.createdAt` indistinguishable — a weak test that mutation testing
  // caught passing against the reintroduced bug.
  const j = freshJupiter();
  j.consumeRecommendations([REC()]);
  const sig = j.getSignal('AAA');
  const born = sig.createdAt - 60 * 60000;    // pretend it was first seen an hour ago
  // Shorten the remaining life too (still in the future, so it stays the "same idea").
  // Both fields must differ from what a freshly-stamped `now + horizon` would produce,
  // or the assertion cannot distinguish preserved from re-stamped.
  const dies = Date.now() + 60 * 60000;
  sig.createdAt = born;
  sig.expiresAt = dies;
  j.consumeRecommendations([REC()]);          // identical idea, next cycle
  const again = j.getSignal('AAA');
  eq(again.createdAt, born, 'createdAt was reset — decay would never progress');
  eq(again.expiresAt, dies, 'expiresAt was extended — the signal would never expire');
});
check('an aged signal really does decay toward zero influence', () => {
  // End-to-end proof that preserving createdAt has the intended effect on the score.
  const j = freshJupiter();
  j.consumeRecommendations([REC()]);
  const sig = j.getSignal('AAA');
  const fresh = Math.abs(j.scoreAdjustment('AAA').long);
  // Age it to ~95% through its life without changing anything else.
  const life = sig.expiresAt - sig.createdAt;
  sig.createdAt = Date.now() - life * 0.95;
  sig.expiresAt = sig.createdAt + life;
  const aged = Math.abs(j.scoreAdjustment('AAA').long);
  ok(aged < fresh, `aged influence ${aged} should be below fresh ${fresh}`);
});
check('a CHANGED idea (new direction) starts a fresh clock', () => {
  const j = freshJupiter();
  j.consumeRecommendations([REC()]);
  const born = j.getSignal('AAA').createdAt;
  const flipped = { ...REC(), direction: 'short' };
  j.consumeRecommendations([flipped]);
  const s = j.getSignal('AAA');
  eq(s.direction, 'short', 'direction should update');
  ok(s.expiresAt > born, 'a genuinely new idea must get a fresh horizon');
});
check('the traded flag survives a re-report', () => {
  const j = freshJupiter();
  j.consumeRecommendations([REC()]);
  j.markTraded('AAA', 'LONG');
  eq(j.getSignal('AAA').traded, true, 'setup');
  j.consumeRecommendations([REC()]);
  eq(j.getSignal('AAA').traded, true, 'traded flag lost on refresh — would allow re-entry');
});

// ════════════════════════════════════════════════════════════════════════════
group('TRADE LOG TRIMMING — must stay chronological');
check('open trades survive a trim and stay visible in the recent-trades tail', () => {
  resetBook();
  // 250 closed trades (over the 200 cap) followed by a live open position.
  for (let i = 0; i < 250; i++) {
    I.portfolio.trades.push({ ticker: 'OLD', direction: 'LONG', status: 'closed',
                              timestamp: new Date(Date.now() - (300 - i) * 60000).toISOString(),
                              qty: 1, entryPrice: 10, realizedPnL: 1 });
  }
  I.portfolio.trades.push({ ticker: 'LIVE', direction: 'LONG', status: 'open',
                            timestamp: new Date().toISOString(), qty: 5, entryPrice: 20, realizedPnL: 0 });
  I.trimTrades();
  const tail = I.portfolio.trades.slice(-12);          // exactly what /api/portfolio renders
  ok(tail.some(t => t.ticker === 'LIVE'),
     'the open position fell out of the recent-trades tail — trim reordered the array');
  eq(I.portfolio.trades.filter(t => t.status === 'closed').length, 200, 'closed cap');
  eq(I.portfolio.trades.filter(t => t.status === 'open').length, 1, 'open preserved');
});
check('trim is a no-op below the cap', () => {
  resetBook();
  for (let i = 0; i < 50; i++) {
    I.portfolio.trades.push({ ticker: 'X', status: 'closed', timestamp: new Date().toISOString(), qty: 1 });
  }
  I.trimTrades();
  eq(I.portfolio.trades.length, 50);
});
check('trim keeps the NEWEST closed trades, not the oldest', () => {
  resetBook();
  for (let i = 0; i < 260; i++) {
    I.portfolio.trades.push({ ticker: 'T' + i, status: 'closed',
                              timestamp: new Date(Date.now() - (300 - i) * 60000).toISOString(), qty: 1 });
  }
  I.trimTrades();
  ok(I.portfolio.trades.some(t => t.ticker === 'T259'), 'newest closed trade was dropped');
  ok(!I.portfolio.trades.some(t => t.ticker === 'T0'),  'oldest closed trade should be gone');
});

// ════════════════════════════════════════════════════════════════════════════
group('INDICATORS — bounds and non-finite safety');
check('RSI stays within [0, 100]', () => {
  const flat = new Array(40).fill(10);
  const rising = Array.from({ length: 40 }, (_, i) => 10 + i);
  const falling = Array.from({ length: 40 }, (_, i) => 50 - i);
  for (const h of [flat, rising, falling]) {
    const r = I.rsi(h, 14);
    ok(Number.isFinite(r) && r >= 0 && r <= 100, `RSI out of range: ${r}`);
  }
});
check('RSI handles too-short history without NaN', () => {
  const r = I.rsi([10, 11], 14);
  ok(Number.isFinite(r), `got ${r}`);
});
check('EMA returns finite values / null on empty', () => {
  ok(I.ema([], 9) === null, 'empty should be null');
  ok(Number.isFinite(I.ema([1, 2, 3, 4, 5], 3)), 'should be finite');
});
check('atrPct clamped to a sane band and always positive', () => {
  seedSymbol('PLTR', 20);
  const a = I.atrPct('PLTR');
  ok(a > 0 && a <= 0.15, `atrPct ${a} out of band`);
});
check('atrPct on an unknown symbol degrades to a default, not NaN', () => {
  const a = I.atrPct('NOSUCHSYMBOL');
  ok(Number.isFinite(a) && a > 0, `got ${a}`);
});

// ════════════════════════════════════════════════════════════════════════════
group('LEARNING MODEL — trains, and cannot be poisoned by bad data');
check('OnlineLogistic ignores NaN/Infinity features and self-heals', () => {
  const m = new engine.OnlineLogistic(3);
  m.update([NaN, Infinity, -Infinity], 1);
  m.update([1, 0, -1], 1);
  ok(m.w.every(Number.isFinite), `weights went non-finite: ${m.w}`);
  ok(Number.isFinite(m.b), 'bias went non-finite');
  ok(Number.isFinite(m.predict([1, 1, 1])), 'prediction non-finite');
});
check('OnlineLogistic predictions stay in (0,1)', () => {
  const m = new engine.OnlineLogistic(2);
  for (let i = 0; i < 200; i++) m.update([1, 1], 1);   // push hard toward 1
  const p = m.predict([1, 1]);
  ok(p > 0 && p < 1, `probability out of range: ${p}`);
});
check('rejects corrupted saved weights instead of loading them', () => {
  const m = new engine.OnlineLogistic(3);
  m.w = [0.5, 0.5, 0.5];
  m.load({ w: [NaN, 1, 2], b: 0, n: 5 });
  ok(m.w.every(Number.isFinite), 'corrupted weights were accepted');
  eq(m.w[0], 0.5, 'original weights should be untouched');
});
check('win-model learns a real pattern (log-loss decreases)', () => {
  const jup = engine.createJupiter({ strategy: I.STRATEGY });
  jup.init({
    strategy: I.STRATEGY, venus: engine.venus,
    capitalSystem: { safeMode: false, tradingCapital: 1000 },
    riskSystem: { consecutiveLosses: 0, currentDrawdown: 0 },
    aiSystem: { aggressionLevel: 0.5 },
    helpers: {
      atrPct: () => 0.02, calculateATR: () => 0.5, calculateRVOL: () => 1.2,
      calculateMarketStress: () => 0.1, getGapSizeAdjust: () => 1,
      calculateTradeExpectancy: () => ({ winRate: 0.5, profitFactor: 1, avgWin: 10, avgLoss: 8 }),
      isHighVolatility: () => false, closedTradeCount: () => 25,
      adx: () => ({ adx: 25 }), rsi: () => 55, regimeNumeric: () => 1,
      sessionFraction: () => 0.5, spread: () => 0.001,
      quote: () => ({ price: 10, prevClose: 9.9 })
    }
  });
  for (let i = 0; i < 40; i++) {
    jup.observeEntry('TEST', 'LONG', 10);
    jup.recordOutcome({ ticker: 'TEST', direction: 'LONG', realizedPnL: i % 3 ? 12 : -8 });
  }
  const m = jup.getState().model;
  eq(m.samples, 40, 'samples trained');
  ok(m.logLoss < 0.693, `log-loss ${m.logLoss} should beat coin-flip (0.693)`);
});
check('sizing never exceeds the hard risk cap, even with a maxed-out model', () => {
  const jup = engine.createJupiter({ strategy: I.STRATEGY });
  jup.init({
    strategy: I.STRATEGY, venus: engine.venus,
    capitalSystem: { safeMode: false, tradingCapital: 100000 },
    riskSystem: { consecutiveLosses: 0, currentDrawdown: 0 },
    aiSystem: { aggressionLevel: 1.0 },          // max aggression
    helpers: {
      atrPct: () => 0.02, calculateATR: () => 0.5, calculateRVOL: () => 3,
      calculateMarketStress: () => 0, getGapSizeAdjust: () => 1,
      // wildly profitable fake edge → Kelly wants to size up hard
      calculateTradeExpectancy: () => ({ winRate: 0.95, profitFactor: 20, avgWin: 100, avgLoss: 1 }),
      isHighVolatility: () => false, closedTradeCount: () => 500,
      adx: () => ({ adx: 60 }), rsi: () => 70, regimeNumeric: () => 1,
      sessionFraction: () => 0.5, spread: () => 0.0001,
      quote: () => ({ price: 20, prevClose: 19 })
    }
  });
  const price = 20, equity = 100000;
  const shares = jup.computeSize('PLTR', price, 'LONG');
  const stopDistance = I.STRATEGY.ATR_STOP_MULT * 0.02 * price;
  const dollarRisk = shares * stopDistance;
  const cap = I.STRATEGY.RISK_PER_TRADE_MAX * equity;
  ok(dollarRisk <= cap * 1.001, `dollar risk ${dollarRisk.toFixed(2)} exceeds cap ${cap.toFixed(2)}`);
  // and notional must respect the 60% ceiling
  ok(shares * price <= equity * 0.60 + price, 'notional exceeded 60% cap');
});

// ════════════════════════════════════════════════════════════════════════════
group('DRAWDOWN MATH — degenerate state must not disable the risk pipeline');
// Every risk check is a comparison against currentDrawdown. A NaN there makes every
// `<=`/`>=` false, so safe mode and the emergency stop would silently never arm.
check('normal case computes the expected drawdown', () => {
  const r = I.computeDrawdown(1000, 800);
  near(r.drawdown, 0.2, 1e-9, 'drawdown');
  eq(r.peak, 1000, 'peak');
});
check('peak of 0 (corrupt state) does NOT yield NaN', () => {
  for (const tv of [0, 500, 1000]) {
    const r = I.computeDrawdown(0, tv);
    ok(Number.isFinite(r.drawdown), `drawdown NaN at equity ${tv}`);
    ok(Number.isFinite(r.peak) && r.peak > 0, `peak invalid at equity ${tv}`);
  }
});
check('NaN / negative / undefined peak all degrade safely', () => {
  for (const bad of [NaN, -100, undefined, null, Infinity]) {
    const r = I.computeDrawdown(bad, 500);
    ok(Number.isFinite(r.drawdown) && r.drawdown >= 0 && r.drawdown <= 1,
       `drawdown ${r.drawdown} invalid for peak ${bad}`);
  }
});
check('a NaN equity cannot produce a NaN drawdown', () => {
  const r = I.computeDrawdown(1000, NaN);
  ok(Number.isFinite(r.drawdown), `got ${r.drawdown}`);
});
check('a wiped account on corrupt state ARMS safe mode and the emergency stop', () => {
  // This replaces an earlier tautological assertion (`x === false || x === true`, true
  // for any boolean, so it tested nothing). The real requirement is not "the comparison
  // returns a boolean" — it's that the gates actually FIRE. With a corrupt peak of 0 and
  // zero equity, drawdown must resolve to a real 100%, which trips both thresholds. If
  // the divisor guard regresses, drawdown becomes NaN, both comparisons silently go
  // false, and this test fails — which is exactly the failure mode worth catching.
  const r = I.computeDrawdown(0, 0);
  near(r.drawdown, 1, 1e-9, 'a zero-equity account is a 100% drawdown');
  ok(r.drawdown >= I.capitalSystem.safeModeDrawdown,  'safe mode must arm');
  ok(r.drawdown >= I.capitalSystem.emergencyDrawdown, 'emergency stop must arm');
  ok(r.drawdown >= I.riskSystem.maxDrawdown,          'max-drawdown gate must trip');
});
check('peak ratchets up to current equity when equity exceeds it', () => {
  eq(I.computeDrawdown(1000, 1500).peak, 1500);
  eq(I.computeDrawdown(1000, 1500).drawdown, 0);
});

// ════════════════════════════════════════════════════════════════════════════
group('EARNINGS BLACKOUT — placeholder data must not gate real trades');
check('disabled by default (the calendar holds placeholder dates, not real ones)', () => {
  eq(I.EARNINGS_BLACKOUT_ENABLED, false,
     'EARNINGS_BLACKOUT defaulted ON while the calendar still holds placeholder day-of-month values');
});
check('no symbol is blacked out while disabled', () => {
  // Would otherwise block ~4 days/month per symbol on arbitrary, repeating dates.
  for (const sym of ['PLTR', 'SOFI', 'MARA', 'HOOD', 'SOUN', 'IONQ', 'RKLB', 'BBAI', 'HIMS', 'CIFR']) {
    eq(I.isEarningsBlackout(sym), false, `${sym} blacked out`);
  }
});
check('unknown symbols are never blacked out', () => {
  eq(I.isEarningsBlackout('NOSUCH'), false);
});

// ════════════════════════════════════════════════════════════════════════════
group('GAP HANDLING — blocks expire, size adjust follows');
check('a fresh ≥3% gap blocks entries', () => {
  I.gapData['GAPPY'] = { gapPct: 0.05, absGap: 0.05, direction: 'up',
                         detectedAt: Date.now(), dateStr: 'x', blockUntil: Date.now() + 60000 };
  eq(I.isGapBlocked('GAPPY'), true);
  eq(I.getGapSizeAdjust('GAPPY'), 0.0, 'blocked → no size');
});
check('an EXPIRED gap block settles to half size, not permanent zero', () => {
  I.gapData['GAPPY'] = { gapPct: 0.05, absGap: 0.05, direction: 'up',
                         detectedAt: Date.now() - 7200000, dateStr: 'x', blockUntil: Date.now() - 1000 };
  eq(I.isGapBlocked('GAPPY'), false, 'block should have expired');
  eq(I.getGapSizeAdjust('GAPPY'), 0.5, 'expired → half size');
});
check('no gap → full size', () => {
  delete I.gapData['CLEAN'];
  eq(I.getGapSizeAdjust('CLEAN'), 1.0);
});

// ════════════════════════════════════════════════════════════════════════════
group('VOLATILITY HALT — median, measured from the open');
check('one wild outlier does not halt the whole book (median, not mean)', () => {
  ['A', 'B', 'C', 'D', 'E'].forEach((s, i) => {
    I.marketData[s] = { price: 100, prevClose: 100, dayOpen: 100, lastUpdate: Date.now() };
  });
  I.marketData['E'].price = 130;                    // one +30% runner
  const med = I.marketIntradayVolMedian(['A', 'B', 'C', 'D', 'E']);
  ok(med < 0.025, `median ${med} should stay under the extreme-vol threshold`);
});
check('a genuinely wild tape does trip the threshold', () => {
  ['A', 'B', 'C'].forEach(s => {
    I.marketData[s] = { price: 105, prevClose: 100, dayOpen: 100, lastUpdate: Date.now() };
  });
  const med = I.marketIntradayVolMedian(['A', 'B', 'C']);
  ok(med > 0.025, `median ${med} should exceed the threshold when everything is moving`);
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`\nFailed:\n${failures.map(f => '  • ' + f).join('\n')}`);
}
console.log('');

// The suite books fake positions into the real module state, which arms the 5s
// debounced queueSaveState(). Cancel it DETERMINISTICALLY rather than relying on
// process.exit() to win that race — a slow run or any future async teardown would
// otherwise let it fire and overwrite the live atlas-solar-state.json with fixtures.
const wasArmed = I.cancelPendingSave();
if (wasArmed) console.log('(cancelled a pending state save — live state file untouched)\n');
process.exit(failed ? 1 : 0);
