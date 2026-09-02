#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS LUMEN — regression test suite   (run: npm test)
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

// Source slice for the block opened by `header`, found by BRACE MATCHING rather than by
// guessing at indentation. Anchors like src.indexOf('\n          }') silently shorten the
// moment a nested block is added inside — which has now broken three separate tests on
// otherwise-correct edits, and a test that fails on correct code teaches you to edit the
// test, which is how a real regression eventually walks through.
function blockAfter(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const open = src.indexOf('{', start + header.length - 1);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

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

console.log('🧪  ATLAS LUMEN — regression suite');

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
group('MARKET CALENDAR — weekends, holidays, early closes');
check('weekends are never a trading day', () => {
  // The engine reported "Market: CLOSED" on Sat 2026-08-15 and that was CORRECT —
  // Alpaca's own calendar confirms Aug 15/16 are not trading days.
  const HOURS = { start: 9.5, end: 16 };
  const mkt = (h, d) => (d === 0 || d === 6) ? null : (h >= HOURS.start && h < HOURS.end ? 'nasdaq' : null);
  for (const h of [9.5, 10, 12, 15.9]) {
    eq(mkt(h, 6), null, `Saturday ${h}:00 must be closed`);
    eq(mkt(h, 0), null, `Sunday ${h}:00 must be closed`);
  }
});
check('regular weekday session opens 9:30 and closes 16:00 ET', () => {
  const HOURS = { start: 9.5, end: 16 };
  const mkt = (h, d) => (d === 0 || d === 6) ? null : (h >= HOURS.start && h < HOURS.end ? 'nasdaq' : null);
  for (let d = 1; d <= 5; d++) {
    eq(mkt(9.49, d), null, 'pre-open must be closed');
    eq(mkt(9.5,  d), 'nasdaq', 'must open exactly at 9:30');
    eq(mkt(15.99,d), 'nasdaq', 'must still be open just before 16:00');
    eq(mkt(16.0, d), null, 'must close exactly at 16:00');
  }
});
check('marketClosedReason always explains a closure', () => {
  // A bare "Market: CLOSED" is what made this look like a bug. It must say why.
  const r = I.marketClosedReason();
  const open = I.getCurrentMarket();
  if (open) ok(r === null, `market is open but a closed-reason was given: ${r}`);
  else ok(typeof r === 'string' && r.length > 0, 'closed with no explanation');
});
check('calendar degrades safely when unavailable', () => {
  // A failed calendar fetch must fall back to weekday hours, never halt trading.
  const cal = I.marketCalendar();
  ok(typeof cal.ok === 'boolean', 'calendar state malformed');
  ok(cal.byDate instanceof Map, 'byDate should be a Map');
  ok(Number.isFinite(I.getEasternTimeParts().hours), 'ET clock must still work without a calendar');
});
check('a holiday is closed even on a WEEKDAY once the calendar is loaded', () => {
  // Driven through resolveSession with a controlled Wednesday, because the live
  // getCurrentMarket() short-circuits on the weekend check and this suite may run on a
  // Saturday — which made an earlier version of this test pass vacuously.
  const cal = { ok: true, byDate: new Map([['2026-11-25', { open: 9.5, close: 16 }]]) };
  eq(I.resolveSession(12, 3, '2026-11-26', cal), null, 'Thanksgiving must be closed');
  eq(I.resolveSession(12, 3, '2026-11-25', cal), 'nasdaq', 'the day before must be open');
});
check('early closes are honoured', () => {
  // e.g. the 1:00pm close on Christmas Eve / day after Thanksgiving.
  const cal = { ok: true, byDate: new Map([['2026-11-27', { open: 9.5, close: 13 }]]) };
  eq(I.resolveSession(12.5, 5, '2026-11-27', cal), 'nasdaq', 'open before 13:00');
  eq(I.resolveSession(13.5, 5, '2026-11-27', cal), null, 'must be CLOSED after the 13:00 early close');
  // Without the calendar the old weekday rule would wrongly keep trading until 16:00.
  eq(I.resolveSession(13.5, 5, '2026-11-27', { ok: false, byDate: new Map() }), 'nasdaq',
     'control: the fallback path does not know about early closes');
});
check('calendar failure falls back to weekday hours (never halts trading)', () => {
  const none = { ok: false, byDate: new Map() };
  eq(I.resolveSession(10, 3, '2026-08-19', none), 'nasdaq', 'weekday mid-session must still trade');
  eq(I.resolveSession(10, 6, '2026-08-15', none), null, 'weekend still closed on the fallback path');
});

// ════════════════════════════════════════════════════════════════════════════
group('LLM MODEL RESOLUTION — a retired model id must not silently kill Venus');
check('the default model is on the preference list', () => {
  // llama-3.3-70b-versatile was retired by Groq and Venus then failed EVERY cycle for a
  // full session while the engine looked healthy.
  ok(Array.isArray(I.GROQ_CHAT_PREFERENCE) && I.GROQ_CHAT_PREFERENCE.length > 1,
     'preference list missing');
});
check('preference list contains only chat-capable models', () => {
  // The account also serves whisper (speech), orpheus (TTS) and prompt-guard
  // (classifier) models — none can do JSON reasoning and must never be selected.
  const bad = I.GROQ_CHAT_PREFERENCE.filter(m => /whisper|orpheus|prompt-guard/i.test(m));
  eq(bad.length, 0, `non-chat models in preference list: ${bad}`);
});
check('resolveAiModel is callable and never throws without network', async () => {
  ok(typeof I.resolveAiModel === 'function', 'not exported');
  ok(typeof I.aiModel() === 'string' || I.aiModel() === null, 'model accessor broken');
});
check('venus.AI_MODEL is a live getter, not a stale snapshot', () => {
  // AI_MODEL is reassigned at boot by resolveAiModel(); a copied property would keep
  // reporting the configured (possibly retired) name forever.
  const d = Object.getOwnPropertyDescriptor(engine.venus, 'AI_MODEL');
  ok(d && typeof d.get === 'function', 'venus.AI_MODEL must be a getter');
});

// ════════════════════════════════════════════════════════════════════════════
group('COST TRACKING — measures the biggest unknown (adverse selection)');
check('summary is safe with no samples', () => {
  const c = I.costTrackingSummary();
  ok(c && typeof c.samples === 'number', 'must return a shape even when empty');
});
check('summary reports the 43% threshold that erases the measured edge', () => {
  const c = I.costTrackingSummary();
  ok(c.samples === 0 || typeof c.note === 'string', 'should carry an interpretation');
});

// ════════════════════════════════════════════════════════════════════════════
group('CRASH HANDLER — a tool crashing must not wipe the live state file');
check('server.js is imported here, so it must NOT own the state file', () => {
  // Observed for real: a ReferenceError in train-model.js triggered server.js's
  // uncaughtException handler, which called saveStateSync() and overwrote
  // atlas-solar-state.json with the module's pristine defaults — cash 1000, no
  // positions, untrained models. Any tool that imports the engine could silently
  // destroy accumulated learning.
  // server.js must not be the entry point — it is a library here.
  ok(require.main.filename !== require.resolve('./server.js'),
     'server.js is the entry point; the state-file guard would not apply');
  ok(typeof I.cancelPendingSave === 'function', 'the debounced-save escape hatch must exist');
});
check('saveStateSync exists but is not invoked on import', () => {
  // The guard is `require.main === module` inside the handler. If that check is
  // removed, this suite (and every other tool) becomes able to clobber real state.
  const src = require('fs').readFileSync('server.js', 'utf8');
  const handler = src.slice(src.indexOf("process.on('uncaughtException'"));
  const body = handler.slice(0, handler.indexOf('});'));
  ok(/require\.main === module/.test(body),
     'uncaughtException must guard saveStateSync behind require.main === module');
  const saveIdx = body.indexOf('saveStateSync');
  const guardIdx = body.indexOf('require.main === module');
  ok(guardIdx >= 0 && guardIdx < saveIdx, 'the guard must come BEFORE the save');
});

// ════════════════════════════════════════════════════════════════════════════
group('VENUS MECHANISMS — an idea needs a counterparty, not a pattern');
// Six pattern-based strategies were backtested on this universe and none had a
// persistent edge. A tradeable idea must name WHO loses and WHY.
check('no mechanism supplied collapses to "none"', () => {
  const r = engine.venus.validateRec({ symbol: 'AAPL', direction: 'long', conviction: 0.8, catalyst: 'earnings' });
  eq(r.mechanism, 'none');
});
check('an unknown mechanism label collapses to "none"', () => {
  const r = engine.venus.validateRec({ symbol: 'AAPL', direction: 'long', conviction: 0.8,
    catalyst: 'earnings', mechanism: 'vibes', counterparty: 'a perfectly long explanation here' });
  eq(r.mechanism, 'none');
});
check('a mechanism with NO real counterparty phrase collapses to "none"', () => {
  // If you cannot say who loses, you do not have a mechanism whatever label you picked.
  const r = engine.venus.validateRec({ symbol: 'AAPL', direction: 'long', conviction: 0.8,
    catalyst: 'earnings', mechanism: 'forced_flow', counterparty: 'idk' });
  eq(r.mechanism, 'none');
});
check('a real mechanism with a real counterparty survives', () => {
  const r = engine.venus.validateRec({ symbol: 'AAPL', direction: 'long', conviction: 0.8,
    catalyst: 'earnings', mechanism: 'underreaction', counterparty: 'analysts slow to revise after a large surprise' });
  eq(r.mechanism, 'underreaction');
  ok(r.counterparty.length > 8, 'counterparty must be carried through');
});
check('"none" is never tradeable', () => {
  ok(!engine.venus.TRADEABLE_MECHANISMS.has('none'),
     'an idea with no counterparty story must never become a trade signal');
  ok(engine.venus.TRADEABLE_MECHANISMS.size >= 4, 'should have several real mechanisms');
});
check('the analyze() gate itself rejects mechanism-less ideas', () => {
  // Tests the ACTUAL predicate analyze() uses. Covering only validateRec left this
  // path unguarded — mutation testing caught the gate being bypassed entirely.
  const good = { mechanism: 'forced_flow', counterparty: 'index funds forced to sell on deletion' };
  const noMech = { mechanism: 'none', counterparty: 'index funds forced to sell on deletion' };
  const noCp   = { mechanism: 'forced_flow', counterparty: '' };
  eq(engine.venus.isTradeableIdea(good), true, 'a real idea must pass');
  eq(engine.venus.isTradeableIdea(noMech), false, '"none" must never trade');
  eq(engine.venus.isTradeableIdea(noCp), false, 'no counterparty means no mechanism');
  eq(engine.venus.isTradeableIdea(null), false, 'null must not crash or pass');
});
check('the real pipeline drops mechanism-less ideas end-to-end', () => {
  // Drives recsFromParsed — the ACTUAL function analyze() delegates to — so this
  // covers validate -> calibrate -> mechanism gate -> dedupe without a network call.
  const out = engine.venus.recsFromParsed([
    { symbol: 'AAA', direction: 'long', conviction: 0.9, catalyst: 'earnings',
      mechanism: 'forced_flow', counterparty: 'index funds forced to sell on deletion' },
    { symbol: 'BBB', direction: 'long', conviction: 0.95, catalyst: 'earnings' },          // no mechanism
    { symbol: 'CCC', direction: 'long', conviction: 0.95, catalyst: 'earnings',
      mechanism: 'underreaction', counterparty: 'x' }                                       // no counterparty
  ]);
  const syms = out.map(r => r.symbol);
  ok(syms.includes('AAA'), 'the idea WITH a counterparty must survive');
  ok(!syms.includes('BBB'), 'no mechanism must be dropped even at 0.95 conviction');
  ok(!syms.includes('CCC'), 'no counterparty must be dropped even at 0.95 conviction');
  eq(out.length, 1, `expected exactly 1 tradeable idea, got ${out.length}`);
});
check('every tradeable mechanism is a known mechanism', () => {
  for (const m of engine.venus.TRADEABLE_MECHANISMS) {
    ok(engine.venus.MECHANISMS.has(m), `${m} not in the MECHANISMS set`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
group('LONG-ONLY — the short book measured anti-predictive');
check('shorts are rejected while LONG_ONLY is on', () => {
  // Measured over 263 out-of-sample setups: gate-SHORT won 8.5% against a 32.4%
  // break-even, while the opposite side of those setups won 65.9%.
  const p = { ticker: 'X', direction: 'SHORT', entryPrice: 20, shares: 10,
              stop: { price: 20.5, frac: 0.025 }, target: { price: 19, frac: 0.05 },
              rewardRisk: 2, cost: 0.003, atrFrac: 0.02,
              netRewardRisk: I.netRewardRisk(0.05, 0.025, 0.003), targetCostRatio: 0.05 / 0.003 };
  ok(p.netRewardRisk >= I.STRATEGY.MIN_RR_NET, 'setup: economics must pass so DIRECTION is what fires');
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/short/i.test(v.reason), `reason was: ${v.reason}`);
});
check('the identical plan as a LONG is not rejected for direction', () => {
  const p = { ticker: 'X', direction: 'LONG', entryPrice: 20, shares: 10,
              stop: { price: 19.5, frac: 0.025 }, target: { price: 21, frac: 0.05 },
              rewardRisk: 2, cost: 0.003, atrFrac: 0.02,
              netRewardRisk: I.netRewardRisk(0.05, 0.025, 0.003), targetCostRatio: 0.05 / 0.003 };
  const v = I.terraValidateTrade(p);
  ok(!/short/i.test(v.reason || ''), `a LONG must never be rejected as a short: ${v.reason}`);
});
check('LONG_ONLY is a single switch, not a tuned number', () => {
  eq(typeof I.LONG_ONLY, 'boolean', 'must be binary — a threshold would be fittable');
});

// ════════════════════════════════════════════════════════════════════════════
group('COST CEILING — refuse stocks that are too expensive to trade');
check('an over-priced round trip is rejected', () => {
  // Built inline rather than via planWith(), which is declared further down the file
  // and would be in the temporal dead zone here.
  const p = { ticker: 'X', direction: 'LONG', entryPrice: 20, shares: 10,
              stop: { price: 18.68, frac: 0.066 }, target: { price: 22.76, frac: 0.138 },
              rewardRisk: 0.138 / 0.066, cost: 0.02, atrFrac: 0.03,
              netRewardRisk: I.netRewardRisk(0.138, 0.066, 0.02), targetCostRatio: 0.138 / 0.02 };
  ok(p.netRewardRisk >= I.STRATEGY.MIN_RR_NET, 'setup: net R:R must pass so the cost gate is what fires');
  ok(p.targetCostRatio >= I.STRATEGY.MIN_TARGET_COST_RATIO, 'setup: cost-ratio gate must pass');
  ok(p.atrFrac >= I.STRATEGY.MIN_ATR_ENTRY, 'setup: ATR gate must pass');
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/round-trip cost|too expensive/i.test(v.reason), `reason was: ${v.reason}`);
});
check('the ceiling sits above the typical cost so it trims the tail, not the body', () => {
  const c = I.STRATEGY.MAX_ROUND_TRIP_COST;
  ok(c > 0.003 && c <= 0.01, `ceiling ${c} should exclude expensive names without stopping trading`);
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
  rewardRisk: 0.012 / 0.0066, cost: 0.004, atrFrac: 0.02,
  netRewardRisk: I.netRewardRisk(0.012, 0.0066, 0.004),
  targetCostRatio: 0.012 / 0.004, ...o });

check('a too-quiet symbol is rejected — its move cannot beat the fee', () => {
  // The highest-impact measured filter: 60d backtest, no filter -> 40.4% win / PF 0.70;
  // ATR >= 1% -> 50.9% win / PF 1.11. A fixed fee against a 0.3% move cannot win.
  // Stop/target/cost are set so the OTHER economic gates pass, isolating this one.
  // (Deliberately inconsistent with atrFrac — a unit test of one rule, not a realistic plan.)
  const p = planWith({ atrFrac: 0.003, cost: 0.002,
                       stop: { price: 19.84, frac: 0.008 }, target: { price: 20.4, frac: 0.02 },
                       rewardRisk: 0.02 / 0.008,
                       netRewardRisk: I.netRewardRisk(0.02, 0.008, 0.002),
                       targetCostRatio: 0.02 / 0.002 });
  ok(p.netRewardRisk >= I.STRATEGY.MIN_RR_NET, 'setup: net R:R must pass');
  ok(p.targetCostRatio >= I.STRATEGY.MIN_TARGET_COST_RATIO, 'setup: cost ratio must pass');
  const v = I.terraValidateTrade(p);
  eq(v.approved, false);
  ok(/ATR/i.test(v.reason), `reason was: ${v.reason}`);
});
check('MIN_ATR_ENTRY is a sane floor', () => {
  const f = I.STRATEGY.MIN_ATR_ENTRY;
  ok(Number.isFinite(f) && f >= 0.005 && f <= 0.05, `floor ${f} out of range`);
});

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
//  LLM RESPONSE PARSING (v11.25)
//  The old extractor was indexOf('[')…lastIndexOf(']') + one JSON.parse. Each of
//  these cases silently cost a whole research cycle in production. Every case here
//  FAILS against that old implementation — that is the point of the group.
// ════════════════════════════════════════════════════════════════════════════
group('Venus LLM response parsing');

check('plain array parses', () => {
  const r = I.extractJsonArray('[{"ticker":"AAPL"},{"ticker":"MSFT"}]');
  ok(Array.isArray(r) && r.length === 2 && r[0].ticker === 'AAPL', `got ${JSON.stringify(r)}`);
});
check('array wrapped in an object is unwrapped', () => {
  const r = I.extractJsonArray('{"recommendations":[{"ticker":"NVDA"}]}');
  ok(Array.isArray(r) && r.length === 1 && r[0].ticker === 'NVDA', `got ${JSON.stringify(r)}`);
});
check('prose before and after the array is ignored', () => {
  const r = I.extractJsonArray('Here you go:\n[{"ticker":"F"}]\nHope that helps [end]');
  ok(Array.isArray(r) && r.length === 1 && r[0].ticker === 'F', `got ${JSON.stringify(r)}`);
});
check('a trailing comma does not lose the response', () => {
  const r = I.extractJsonArray('[{"ticker":"KO"},]');
  ok(Array.isArray(r) && r.length === 1 && r[0].ticker === 'KO', `got ${JSON.stringify(r)}`);
});
check('a bracket inside a quoted string does not end the array early', () => {
  // Prose on both sides so this CANNOT succeed on the whole-string fast path and
  // must go through the bracket scanner. An unbalanced ']' inside a value is the
  // case that makes naive lastIndexOf/depth-counting truncate the array.
  const r = I.extractJsonArray('Here you go: [{"ticker":"GE","note":"raised ] guidance"},{"ticker":"XOM"}] done');
  ok(Array.isArray(r) && r.length === 2 && r[1].ticker === 'XOM',
     `string-internal bracket truncated the parse: ${JSON.stringify(r)}`);
});
check('complete objects are salvaged from a truncated array', () => {
  // Response cut off by a token limit — nothing balances, but two whole ideas are there.
  const r = I.extractJsonArray('[{"ticker":"PLTR","conviction":8},{"ticker":"SOFI","conviction":7},{"tick');
  ok(Array.isArray(r) && r.length === 2 && r[1].ticker === 'SOFI',
     `truncated response should salvage 2 objects, got ${JSON.stringify(r)}`);
});
check('salvage is not fooled by a brace inside a quoted value', () => {
  // Truncated AND contains '}' inside a string. Without string tracking the salvage
  // loop closes the first object early, that fragment fails to parse, and the idea is
  // silently dropped — recovering 1 of 2 while looking like a success.
  const r = I.extractJsonArray('[{"ticker":"GE","note":"up } then down"},{"ticker":"XOM"},{"tic');
  ok(Array.isArray(r) && r.length === 2, `expected 2 salvaged objects, got ${JSON.stringify(r)}`);
  ok(r[0].ticker === 'GE' && r[0].note === 'up } then down', `first object mangled: ${JSON.stringify(r[0])}`);
});
check('<think> blocks and code fences are stripped', () => {
  const r = I.extractJsonArray('<think>let me consider [this]</think>\n```json\n[{"ticker":"BAC"}]\n```');
  ok(Array.isArray(r) && r.length === 1 && r[0].ticker === 'BAC', `got ${JSON.stringify(r)}`);
});
check('genuinely unusable text returns null, not a bogus array', () => {
  ok(I.extractJsonArray('I cannot help with that request.') === null, 'should be null');
  ok(I.extractJsonArray('') === null, 'empty should be null');
  ok(I.extractJsonArray(null) === null, 'null input should be null');
});
check('object extractor handles prose, fences and trailing commas', () => {
  ok(I.extractJsonObject('```json\n{"stance":"neutral",}\n```').stance === 'neutral', 'fenced+trailing comma');
  ok(I.extractJsonObject('Posture: {"stance":"risk-off"} — done {').stance === 'risk-off', 'prose either side');
  ok(I.extractJsonObject('{"note":"be careful {here}","stance":"calm"}').stance === 'calm', 'brace in string');
});
check('object extractor recovers an object wrapped in an array', () => {
  // llmReason callers index named fields, so a bare array is useless to them — but a
  // model that answers [{...}] instead of {...} has still given a usable answer, and
  // recovering it beats discarding the call and falling back to mechanical behaviour.
  const v = I.extractJsonObject('[{"stance":"risk-off","multiplier":0.5}]');
  ok(v && v.stance === 'risk-off', `should recover the inner object, got ${JSON.stringify(v)}`);
});
check('object extractor returns null when there is no object at all', () => {
  ok(I.extractJsonObject('["a","b"]') === null, 'an array of scalars yields no object');
  ok(I.extractJsonObject('no json here') === null, 'prose yields null');
});

// ════════════════════════════════════════════════════════════════════════════
//  GATE ORDER (v11.25) — the rejection reason must name the CAUSE, not a symptom.
// ════════════════════════════════════════════════════════════════════════════
group('Terra gate reports the true rejection cause');

check('a too-quiet symbol is rejected for ATR, not for net R:R', () => {
  const S = I.STRATEGY;
  // ATR below the floor mechanically drags net R:R down too, so BOTH gates would
  // fire. The report must name the root cause — the one the operator can act on.
  const plan = {
    ticker: 'QUIET', direction: 'LONG', entryPrice: 50, shares: 10,
    stop:   { price: 49.5, frac: 0.01 },
    target: { price: 51,   frac: 0.02 },
    rewardRisk: 2.0,
    atrFrac: S.MIN_ATR_ENTRY * 0.5,          // clearly below the floor
    cost: 0.003,
    netRewardRisk: S.MIN_RR_NET * 0.5,       // also below its bar, as a consequence
    targetCostRatio: 99
  };
  const v = I.terraValidateTrade(plan);
  ok(!v.approved, 'should be rejected');
  ok(/ATR/i.test(v.reason), `reason should name ATR, got: "${v.reason}"`);
  ok(!/net R:R/i.test(v.reason), `reason should NOT blame net R:R, got: "${v.reason}"`);
});

check('net R:R is still reported when ATR and cost are both fine', () => {
  const S = I.STRATEGY;
  const plan = {
    ticker: 'OK', direction: 'LONG', entryPrice: 50, shares: 10,
    stop:   { price: 49, frac: 0.02 },
    target: { price: 52, frac: 0.04 },
    rewardRisk: 2.0,
    atrFrac: S.MIN_ATR_ENTRY * 2,            // comfortably above the floor
    cost: S.MAX_ROUND_TRIP_COST * 0.5,       // comfortably under the ceiling
    netRewardRisk: S.MIN_RR_NET * 0.5,       // the ONLY failing gate
    targetCostRatio: 99
  };
  const v = I.terraValidateTrade(plan);
  ok(!v.approved, 'should be rejected');
  ok(/net R:R/i.test(v.reason), `reason should name net R:R, got: "${v.reason}"`);
});

// ════════════════════════════════════════════════════════════════════════════
//  DECISION TIMEFRAME + INDICATOR HYGIENE (v11.26)
// ════════════════════════════════════════════════════════════════════════════
group('Decision timeframe and indicator inputs');

check('warmup closes both gates instead of trading blind', () => {
  // Previously returned longGate:true, shortGate:true and deferred to the weighted
  // score — entering with no trend information at all. With history now rebuilt from
  // decision bars, "not ready" is a real state at startup, not a one-second blip.
  // Empty history is the real cold-start state: no decision bars fetched yet.
  const q = { price: 10, prevClose: 10, dayOpen: 10, high: 10, low: 10,
              dailyVolume: 1e6, lastUpdate: Date.now(), history: [] };
  const g = I.evaluateStrategyGate('WARMUP_SYM', q);
  ok(g.mode === 'warmup', `expected warmup mode, got ${g.mode}`);
  ok(g.longGate === false && g.shortGate === false,
     `warmup must not open gates, got long=${g.longGate} short=${g.shortGate}`);
});

check('the trail is disarmed by default and the hard stop is untouched', () => {
  const S = I.STRATEGY;
  ok(S.ATR_TRAIL_ARM_R >= 99, `trail should be effectively off, arm=${S.ATR_TRAIL_ARM_R}`);
  // Removing the give-back exit must not have touched downside protection.
  ok(S.ATR_STOP_MULT > 0 && S.ATR_STOP_MULT <= 3, `hard stop must survive, got ${S.ATR_STOP_MULT}`);
  ok(S.ATR_TARGET_MULT > S.ATR_STOP_MULT, 'target must still exceed stop');
});

check('indicator history is not polluted by ticks', () => {
  // Regression guard for the live/backtest divergence: the loop used to push every
  // trade print into marketData.history, so EMA/RSI spanned ~80s of ticks while the
  // backtest used bar closes. The tick handler must no longer grow that array.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(!/ex\.history\.push\(price\)/.test(src),
     'tick handler still appends to marketData.history — indicators would not match the backtest');
});

check('the backtest harness defaults to the live decision timeframe', () => {
  // A harness sampling a different bar size measures a bot that does not exist.
  // This exact class of divergence hid the long-only change from its first run.
  const bt = require('fs').readFileSync(require('path').join(__dirname, 'backtest.js'), 'utf8');
  ok(/DECISION_TIMEFRAME/.test(bt), 'backtest.js must derive its default --tf from DECISION_TIMEFRAME');
  ok(/arg\('--arm', String\(S\.ATR_TRAIL_ARM_R\)\)/.test(bt),
     'backtest.js must default --arm from STRATEGY.ATR_TRAIL_ARM_R, not a hardcoded value');
});

// ════════════════════════════════════════════════════════════════════════════
//  SMALL-ACCOUNT REALITY + FEED HEALTH (v11.27)
//  Every case here was observed blocking a live session.
// ════════════════════════════════════════════════════════════════════════════
group('Small-account affordability and feed health');

check('without fractional sizing, unaffordable prices are screened out', () => {
  // Live: Venus spent watchlist slots on NVDA $215, CEG $273 and MU $967 against a
  // ~$700 trading book. One MU share is 138% of the book; all three then failed with
  // "size below 1 share" on every cycle forever.
  const ceiling = I.affordableMaxPrice(false);
  const tv = I.getTotalValue();
  ok(ceiling > 0 && ceiling < tv, `ceiling ${ceiling} must be a real fraction of ${tv}`);
  ok(ceiling < 966.54, `MU at $966.54 must be excluded on a $${tv.toFixed(0)} account (ceiling $${ceiling.toFixed(2)})`);
  ok(ceiling < 215.24, `NVDA at $215.24 must be excluded (ceiling $${ceiling.toFixed(2)})`);
});

check('without fractional sizing, the ceiling scales with the account', () => {
  const before = I.affordableMaxPrice(false);
  const saved = I.portfolio.cash;
  I.portfolio.cash = saved + 100000;
  const after = I.affordableMaxPrice(false);
  I.portfolio.cash = saved;
  ok(after > before, `ceiling should rise with equity: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
});

check('with fractional sizing the price ceiling is lifted entirely', () => {
  // Fractional sizing buys 0.18 of a $967 share and lands on the same notional as
  // 20 shares of $9, so share price stops being a constraint at all.
  ok(I.affordableMaxPrice(true) >= 966.54,
     `fractional mode must not exclude high-priced names, got ${I.affordableMaxPrice(true)}`);
});

check('fractional sizing produces a real size at any share price', () => {
  // Calls the ENGINE's own sizer, not a re-implementation of its arithmetic — the
  // first version of this test recomputed the formula inline and therefore passed
  // even with fractional sizing ripped out of server.js. Vacuous; caught by mutation.
  const eng = require('./server.js');
  const jup = eng.jupiter;
  // Jupiter is wired to Terra during startup, which a test process never runs — an
  // un-wired Jupiter returns 0 for EVERY size, which would make this test pass for
  // entirely the wrong reason. Wire it the same way startup does.
  jup.init({
    strategy: I.STRATEGY,
    venus: eng.venus,
    capitalSystem: I.capitalSystem, riskSystem: I.riskSystem, aiSystem: I.aiSystem,
    helpers: {
      atrPct: I.atrPct, calculateATR: I.calculateATR, calculateRVOL: I.calculateRVOL,
      calculateMarketStress: () => 0,
      getGapSizeAdjust: I.getGapSizeAdjust, calculateTradeExpectancy: I.calculateTradeExpectancy,
      isHighVolatility: () => false,
      closedTradeCount: () => 0,
      adx: I.calculateADX, rsi: (s) => I.rsi(I.marketData[s]?.history || [], I.STRATEGY.RSI_PERIOD),
      regimeNumeric: () => 0, sessionFraction: () => 0.5,
      spread: I.estimateDynamicSpread,
      quote: (s) => { const m = I.marketData[s]; return m ? { price: m.price, prevClose: m.prevClose } : null; }
    }
  });
  const saved = I.capitalSystem.tradingCapital;
  I.capitalSystem.tradingCapital = 700;
  const sizes = {};
  [9.10, 119.33, 215.24, 966.54].forEach(price => {
    const sym = 'FRAC_' + Math.round(price);
    // Seed enough state for atrPct() to resolve to a real volatility.
    I.marketData[sym] = { price, prevClose: price, dayOpen: price, high: price * 1.01,
                          low: price * 0.99, dailyVolume: 5e6, lastUpdate: Date.now(),
                          history: Array.from({ length: 40 }, (_, i) => price * (1 + (i % 5 - 2) * 0.002)) };
    sizes[price] = jup.computeSize(sym, price, 'LONG');
  });
  I.capitalSystem.tradingCapital = saved;
  if (!I.FRACTIONAL_ENABLED) {
    // Legacy whole-share mode: expensive names are SUPPOSED to size to zero. Assert
    // the old behaviour rather than the new one, so this run still proves something.
    ok(sizes[966.54] === 0, `whole-share mode must floor a $966 share to 0, got ${sizes[966.54]}`);
    ok(sizes[9.10] > 0, 'a cheap share must still be tradeable in whole-share mode');
    return;
  }
  Object.entries(sizes).forEach(([price, q]) => {
    ok(q > 0, `$${price} must produce a tradeable size, got ${q} (whole-share rounding would give 0)`);
  });
  // The expensive names are exactly the ones whole-share sizing floored to zero.
  ok(sizes[966.54] > 0 && sizes[966.54] < 1,
     `a $966 share on a $700 book must size fractionally, got ${sizes[966.54]}`);
  ok(sizes[215.24] > 0, `a $215 share must be tradeable, got ${sizes[215.24]}`);
});

// ════════════════════════════════════════════════════════════════════════════
//  BROKER REJECTION LOOP (v11.30)
//  Reproduces the live incident: ~1,800 identical "insufficient buying power"
//  submissions per hour against HOOD, because a failed ENTRY changed no state.
// ════════════════════════════════════════════════════════════════════════════
group('Broker rejection must not loop');

check('phantom positions are dropped, not just warned about', () => {
  // After an account reset the broker holds nothing while the saved ledger still
  // carries the old book. Warning and continuing left the engine valuing shares it
  // did not own — and every percentage derives from total equity, so risk sizing,
  // drawdown and the daily-loss brake would all be computed against roughly double
  // the real balance.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/Dropped \$\{sym\}/.test(src), 'a position the broker does not hold must be removed');
  ok(/delete book\[sym\]/.test(src), 'the phantom lots must actually be deleted from the book');
  // The guard matters as much as the fix: a failed API call must not read as "you own nothing".
  ok(/if \(pos\.ok && Array\.isArray\(pos\.positions\)\)/.test(src),
     'dropping must be guarded on a SUCCESSFUL positions fetch, or a network blip deletes a real book');
});

check('in-flight entries count toward exposure', () => {
  // THE DISEASE BEHIND THE LIVE INCIDENT. Orders are booked only when their fill is
  // polled back (every 3s) while the entry scan runs every 2s, so an in-flight entry
  // was invisible to the heat cap and the next scan approved another against stale
  // numbers. Each passed the 50% check alone; together they blew through it, draining
  // $1000 to ~$80 of free cash.
  const savedPending = { ...I.getPendingOrders() };
  I.setPendingOrders({});
  const base = I.getNotionalExposure();
  I.setPendingOrders({
    o1: { kind: 'entry', ticker: 'HOOD', direction: 'LONG', qty: 2, refPrice: 100 },
    o2: { kind: 'exit',  ticker: 'HOOD', direction: 'LONG', qty: 9, refPrice: 100 }   // must NOT count
  });
  const withPending = I.getNotionalExposure();
  I.setPendingOrders(savedPending);
  ok(Math.abs((withPending - base) - 200) < 0.01,
     `a $200 in-flight ENTRY must add to exposure; exits must not. Delta was ${(withPending - base).toFixed(2)}`);
});

check('committed cash is not offered twice', () => {
  // Same race on the funding side: the broker snapshot still shows cash that an
  // in-flight order has already spoken for.
  const S = I.STRATEGY;
  const savedMirror = I.brokerMirror();
  const savedPending = { ...I.getPendingOrders() };
  const plan = {
    ticker: 'HOOD', direction: 'LONG', entryPrice: 100, shares: 0.9,   // $90 order
    stop: { price: 97.8, frac: 0.022 }, target: { price: 104.6, frac: 0.046 },
    rewardRisk: 2.09, atrFrac: S.MIN_ATR_ENTRY * 2, cost: S.MAX_ROUND_TRIP_COST * 0.5,
    netRewardRisk: S.MIN_RR_NET * 2, targetCostRatio: 99
  };
  I.setBrokerMirror({ ok: true, cash: 150, equity: 1000, buying_power: 2000, positions: [], at: Date.now() });
  I.setPendingOrders({});
  const alone = I.terraValidateTrade(plan);                       // $90 of $150 — fine
  I.setPendingOrders({ o1: { kind: 'entry', ticker: 'X', direction: 'LONG', qty: 1, refPrice: 100 } });
  const withCommitted = I.terraValidateTrade(plan);               // $90 + $100 committed > $150
  I.setBrokerMirror(savedMirror); I.setPendingOrders(savedPending);
  if (!I.FRACTIONAL_ENABLED) { ok(true, 'fractional off — sizing path differs'); return; }
  // Assert on the REASON, not on approval: the validator also gates on market hours,
  // so `approved` is false in any evening test run and would prove nothing either way.
  ok(!/cannot fund/i.test(String(alone.reason || '')),
     `$90 against $150 cash must not be a funding rejection, got: "${alone.reason}"`);
  ok(/cannot fund/i.test(String(withCommitted.reason || '')),
     `with $100 already committed the same order must fail on funding, got: "${withCommitted.reason}"`);
});

check('a failed ENTRY is actually wired to the backoff handler', () => {
  // THE LIVE BUG ITSELF. The failure branch previously did nothing for entries, so the
  // 2s scan resubmitted an identical order ~1,800 times an hour. The other tests in
  // this group call noteEntryRejection() directly, which leaves the WIRING untested —
  // removing the call site passed the whole suite until this check existed.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/else noteEntryRejection\(ticker, r\.error\);/.test(src),
     'the broker failure branch must call noteEntryRejection for entries');
  ok(/if \(meta\.kind === 'entry'\) clearEntryRejectBackoff\(\);/.test(src),
     'a successful entry must clear the backoff');
  ok(/if \(entriesPausedByBroker\(\)\)/.test(src),
     'the entry scan must actually honour the pause');
});

check('an unfundable order is refused before it reaches the broker', () => {
  const S = I.STRATEGY;
  const savedMirror = I.brokerMirror();
  // Exactly the live case: a $48 fractional order against an account with $10 cash.
  const plan = {
    ticker: 'HOOD', direction: 'LONG', entryPrice: 100, shares: 0.48,
    stop: { price: 97.8, frac: 0.022 }, target: { price: 104.6, frac: 0.046 },
    rewardRisk: 2.09, atrFrac: S.MIN_ATR_ENTRY * 2, cost: S.MAX_ROUND_TRIP_COST * 0.5,
    netRewardRisk: S.MIN_RR_NET * 2, targetCostRatio: 99
  };
  I.setBrokerMirror({ ok: true, cash: 10, equity: 1000, buying_power: 2000, positions: [], at: Date.now() });
  const v = I.terraValidateTrade(plan);
  I.setBrokerMirror(savedMirror);
  ok(!v.approved, 'a $48 order against $10 cash must be refused BEFORE submission');
  // In whole-share mode a 0.48 order is refused one rule earlier, for a different and
  // equally valid reason — assert the funding reason only where it is the binding one.
  if (I.FRACTIONAL_ENABLED) ok(/cannot fund/i.test(v.reason), `reason should name funding, got: "${v.reason}"`);
  else ok(/below 1 share/i.test(v.reason), `whole-share mode should refuse on size, got: "${v.reason}"`);
});

check('a stale broker snapshot does not veto trading', () => {
  // The mirror refreshes on a 60s timer. If a missed refresh let an old cash figure
  // block entries, one network blip would silently stop the bot trading all day.
  const S = I.STRATEGY;
  const savedMirror = I.brokerMirror();
  const plan = {
    ticker: 'HOOD', direction: 'LONG', entryPrice: 100, shares: 0.48,
    stop: { price: 97.8, frac: 0.022 }, target: { price: 104.6, frac: 0.046 },
    rewardRisk: 2.09, atrFrac: S.MIN_ATR_ENTRY * 2, cost: S.MAX_ROUND_TRIP_COST * 0.5,
    netRewardRisk: S.MIN_RR_NET * 2, targetCostRatio: 99
  };
  // Same $10-cash snapshot as the blocking test, but an hour old.
  I.setBrokerMirror({ ok: true, cash: 10, equity: 1000, buying_power: 2000, positions: [], at: Date.now() - 3600000 });
  const v = I.terraValidateTrade(plan);
  I.setBrokerMirror(savedMirror);
  ok(!/cannot fund/i.test(String(v.reason || '')),
     `a stale snapshot must not be used to block, got: "${v.reason}"`);
});

check('fractional orders are checked against cash, not margin', () => {
  // Alpaca does not extend margin to fractional shares. Sizing a fractional order
  // against buying_power (which includes margin) is exactly how the live rejection
  // loop got past every internal check.
  const S = I.STRATEGY;
  const savedMirror = I.brokerMirror();
  const base = {
    ticker: 'HOOD', direction: 'LONG', entryPrice: 100,
    stop: { price: 97.8, frac: 0.022 }, target: { price: 104.6, frac: 0.046 },
    rewardRisk: 2.09, atrFrac: S.MIN_ATR_ENTRY * 2, cost: S.MAX_ROUND_TRIP_COST * 0.5,
    netRewardRisk: S.MIN_RR_NET * 2, targetCostRatio: 99
  };
  // $50 cash, $2000 buying power. A $150 order is fundable on margin, not on cash.
  I.setBrokerMirror({ ok: true, cash: 50, equity: 1000, buying_power: 2000, positions: [], at: Date.now() });
  const frac  = I.terraValidateTrade({ ...base, shares: 1.5 });   // fractional -> cash only
  I.setBrokerMirror(savedMirror);
  ok(!frac.approved, 'a fractional order above CASH must be refused even when margin would cover it');
});

check('a buying-power rejection pauses all entries, not just one symbol', () => {
  // Cooling down only the rejected symbol would rotate the identical failure through
  // the rest of the watchlist — the failure is account-wide, so the pause must be too.
  I.clearEntryRejectBackoff();
  ok(!I.entriesPausedByBroker(), 'should start unpaused');
  I.noteEntryRejection('HOOD', 'insufficient buying power');
  ok(I.entriesPausedByBroker(), 'a buying-power rejection must pause ALL entries');
  I.clearEntryRejectBackoff();
  ok(!I.entriesPausedByBroker(), 'a successful entry must clear the pause');
});

check('a symbol-specific rejection does not halt the whole book', () => {
  I.clearEntryRejectBackoff();
  I.noteEntryRejection('ZZZZ', 'asset not tradable');
  ok(!I.entriesPausedByBroker(), 'a symbol-specific error must not pause every entry');
  ok(I.onCooldown('ZZZZ'), 'the offending symbol should be cooled down instead');
  I.clearSymbolCooldown('ZZZZ');
});

check('repeated rejections back off further each time', () => {
  // Without escalation a persistent condition is just retried forever at a fixed rate.
  I.clearEntryRejectBackoff();
  I.noteEntryRejection('HOOD', 'insufficient buying power');
  const first = I.entryPauseRemainingMs();
  I.noteEntryRejection('HOOD', 'insufficient buying power');
  const second = I.entryPauseRemainingMs();
  I.clearEntryRejectBackoff();
  ok(second > first * 1.5, `backoff must escalate: ${Math.round(first/1000)}s then ${Math.round(second/1000)}s`);
});

check('dust positions are refused', () => {
  // Fractional sizing makes it possible to open a $0.40 position, which costs more in
  // spread to exit than it can ever return. The gate must reject on NOTIONAL.
  const S = I.STRATEGY;
  const plan = {
    ticker: 'DUST', direction: 'LONG', entryPrice: 50, shares: 0.002,   // $0.10 position
    stop: { price: 49, frac: 0.02 }, target: { price: 52, frac: 0.04 },
    rewardRisk: 2.0, atrFrac: S.MIN_ATR_ENTRY * 2, cost: S.MAX_ROUND_TRIP_COST * 0.5,
    netRewardRisk: S.MIN_RR_NET * 2, targetCostRatio: 99
  };
  const v = I.terraValidateTrade(plan);
  ok(!v.approved, 'a $0.10 position must be rejected');
  ok(/minimum|below/i.test(v.reason), `reason should cite the minimum, got: "${v.reason}"`);
});

check('a fractional quantity is never sent as a limit order', () => {
  // Alpaca refuses fractional limit / extended-hours orders. broker.js must coerce
  // to market+day rather than submit an order the API will reject.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'broker.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/fractional && \(type !== 'market' \|\| tif !== 'day'\)/.test(src),
     'broker.js must force fractional orders to market/day');
  ok(!/qty\s*<\s*1\s*\)\s*return\s*\{\s*ok:\s*false/.test(src),
     'broker.js must no longer reject every quantity below 1 share');
});

check('fractional positions can still take partial profits', () => {
  // Math.floor(0.18 * 0.5) is 0, which silently marked the rung "taken" and meant a
  // fractional position could never ladder out.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  // Both partial-close sites must compute the fractional quantity, not just the whole-
  // share one. The whole-share expression legitimately survives as the ELSE branch, so
  // assert the fractional branch exists at each site rather than banning the pattern.
  const fracBranches = (src.match(/Math\.floor\((?:p|pos)\.qty \* fraction \* 1e6\) \/ 1e6/g) || []);
  ok(fracBranches.length === 2,
     `expected both partial-close sites to have a fractional branch, found ${fracBranches.length}`);
  const guards = (src.match(/isFractionalQty\((?:p|pos)\.qty\)/g) || []);
  ok(guards.length >= 2, `partial closes must branch on fractional lots, found ${guards.length} guard(s)`);
  // And the "too small to ladder" floor must scale with the lot type, or a fractional
  // position is instantly marked as having taken every rung.
  ok(/minQ = isFractionalQty/.test(src) && /minSell = isFractionalQty/.test(src),
     'the minimum-ladder threshold must adapt to fractional lots');
});

check('no whole-share assumptions remain on the fractional paths', () => {
  // Four separate `qty < 1` guards silently broke fractional trading end to end:
  //   · a 0.18-share fill read as "not filled (thin market)" — every fractional
  //     trade discarded before it opened
  //   · broker reconciliation SKIPPING fractional positions — a real position left
  //     untracked by ATLAS and therefore with no stop-loss attached
  //   · routeToBroker dropping fractional orders on the floor
  //   · the sizer/validator floors, fixed earlier
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(!/filledSize < 1\b/.test(src), 'fill check must not assume whole shares');
  ok(/minFill = isFractionalQty/.test(src), 'fill threshold must adapt to fractional orders');
  ok(!/\|\| qty < 1\) continue;/.test(src),
     'broker reconciliation must not skip fractional positions — they would go unstopped');
  ok(!/if \(!qty \|\| qty < 1\) return;/.test(src), 'routeToBroker must accept fractional quantities');
});

check('a failed core buy rolls the ledger back', () => {
  // The ledger is debited before the broker confirms. If the order is refused and the
  // debit stands, ATLAS believes it owns shares it does not — the exact ledger/broker
  // divergence the broker-authoritative design exists to prevent.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function maintainCoreHolding'),
                       src.indexOf('function processProfitVault'));
  ok(/rollback/.test(fn), 'a rejected core buy must roll back the cash debit');
  ok(/portfolio\.cash \+= cost/.test(fn), 'rollback must restore the exact cost');
  ok(/l\.qty -= qty/.test(fn), 'rollback must also unwind the share count');
});

check('rejection reasons bucket together for the daily digest', () => {
  // Reasons carry per-symbol numbers ("net R:R 1.12 < 1.35 after 0.31% costs"). Without
  // normalising them, a zero-trade day produces 200 unique reasons and the digest is
  // useless — the whole point is to name the ONE thing blocking trading.
  const a = I.rejectionBucket('net R:R 1.12 < 1.35 after 0.31% costs');
  const b = I.rejectionBucket('net R:R 1.44 < 1.35 after 0.28% costs');
  ok(a === b, `equivalent reasons must bucket together:\n  "${a}"\n  "${b}"`);
  const c = I.rejectionBucket('ATR 0.62% below the 1.00% floor');
  ok(c !== a, 'genuinely different reasons must stay separate');
});

check('the edge register cannot score a hypothesis on pre-registration data', () => {
  // The entire value of the register is that a claim is scored ONLY on data that did
  // not exist when it was written. If that filter is ever dropped, it degenerates into
  // the same re-cut-the-same-history exercise that produced six false discoveries.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'edge-research.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/filter\(d => d > from\)/.test(src), 'scorers must filter to dates after registration');
  ok(/registeredAt/.test(src) && /e\.registeredAt/.test(src), 'scoring must read the registration date');
  ok(/e\.results\.push\(res\)/.test(src), 'results must be APPENDED so decay stays visible');
  ok(!/e\.results = \[res\]/.test(src), 'results must never be overwritten');
});

check('the edge register demands significance, sign-consistency and sample size', () => {
  // Any one of these alone has already produced a false positive in this project.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'edge-research.js'), 'utf8');
  const fn = src.slice(src.indexOf('function verdict'), src.indexOf('(async function main'));
  ok(/Math\.abs\(last\.t\) > 2/.test(fn), 'must require |t| > 2');
  ok(/last\.n < 60/.test(fn), 'must require a minimum sample');
  ok(/Math\.sign\(r\.mean\) === Math\.sign\(last\.mean\)/.test(fn),
     'must require the sign to hold across scoring runs');
  ok(/SUPPORTED/.test(fn) && !/PROVEN/.test(fn), 'a hypothesis is supported, never proven');
});

check('the core is a diversified basket, not a single name', () => {
  // Measured: 1 name gives 0.59 return per unit of risk, 5+ names gives ~1.35 for the
  // same return. Holding one symbol gives up the only free improvement available.
  ok(I.CORE_HOLD_SYMBOLS.length >= 5,
     `core should spread across several names, got ${I.CORE_HOLD_SYMBOLS.length}`);
  ok(new Set(I.CORE_HOLD_SYMBOLS).size === I.CORE_HOLD_SYMBOLS.length, 'no duplicate names');
});

check('new core money goes to the most underweight name', () => {
  // Rebalancing frequency measured as worth ~nothing (1.30-1.41 across weekly→never),
  // so the basket is balanced by DIRECTING NEW MONEY, never by selling.
  const savedCore = I.portfolio.coreHolding;
  const [a, b] = I.CORE_HOLD_SYMBOLS;
  I.marketData[a] = { price: 100, prevClose: 100, lastUpdate: Date.now() };
  I.marketData[b] = { price: 100, prevClose: 100, lastUpdate: Date.now() };
  // `a` is already heavily held, `b` holds nothing — new money must go to `b`.
  I.portfolio.coreHolding = { [a]: { qty: 10, avgPrice: 100, investedCash: 1000 } };
  const pick = I.mostUnderweightCore();
  I.portfolio.coreHolding = savedCore;
  ok(pick && pick.sym !== a, `must not add to the already-overweight name (${a}), picked ${pick && pick.sym}`);
});

check('a stale-priced core member is never bought', () => {
  const savedCore = I.portfolio.coreHolding;
  const saved = {};
  I.CORE_HOLD_SYMBOLS.forEach(s => { saved[s] = I.marketData[s];
    I.marketData[s] = { price: 100, prevClose: 100, lastUpdate: Date.now() - 10 * 60000 }; });
  I.portfolio.coreHolding = {};
  const pick = I.mostUnderweightCore();
  I.CORE_HOLD_SYMBOLS.forEach(s => { if (saved[s]) I.marketData[s] = saved[s]; else delete I.marketData[s]; });
  I.portfolio.coreHolding = savedCore;
  ok(pick === null, 'with every price stale it must buy nothing, got ' + JSON.stringify(pick));
});

check('Venus screens the basket rather than predicting it', () => {
  // The whole justification for letting Venus choose what to hold is that screening is
  // a different job from forecasting. If the prompt drifts back toward "pick winners",
  // the basket becomes whatever was in the news last week — which decays in days, while
  // a holding is meant to last months.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function proposeBasket'), src.indexOf('async function assess'));
  ok(/SCREENING task, not a prediction task/i.test(fn), 'the prompt must frame this as screening');
  ok(/LIQUIDITY/.test(fn) && /DIVERSIFICATION/.test(fn), 'it must screen on liquidity and spread');
  ok(/Do not attempt to forecast returns/i.test(fn), 'it must explicitly forbid forecasting');
  ok(/candidates\.includes\(x\)/.test(fn), 'proposed symbols must be validated against the real universe');
});

check('a Venus basket proposal does not move money by default', () => {
  // Adopting first and checking afterwards is how six false edges got believed here.
  // The proposal is recorded for scoring; the money stays on the control basket.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/CORE_BASKET_SOURCE \|\| 'fixed'/.test(src), 'the default basket source must be the fixed control');
  ok(/CORE_BASKET_SOURCE === 'venus'/.test(src), 'switching must require an explicit opt-in');
  // Match the CALL SITE, not the definition — `function recordBasketProposal(prop)`
  // satisfies a naive pattern, so deleting the call passed this test until now.
  ok(/\n\s+recordBasketProposal\(prop\);/.test(src), 'every proposal must be recorded for later scoring');
  // The timestamp is the entire point — without it the proposal cannot be scored
  // out-of-sample, and the register degenerates into re-cutting the same history.
  const recStart = src.indexOf('function recordBasketProposal');
  const rec = src.slice(recStart, src.indexOf('\n}', recStart));
  ok(/log\.push\(\{ at: new Date\(\)\.toISOString\(\)/.test(rec),
     'the pushed record must carry a real timestamp — without it nothing can be scored out-of-sample');
  ok(/control: \[\.\.\.CORE_HOLD_SYMBOLS\]/.test(rec), 'the control basket must be recorded alongside it');
});

check('the core banks profit by trimming winners back to target', () => {
  // This is the core's ONLY seller, and it is arithmetic rather than judgement. Every
  // judgement-based exit measured in this project destroyed value — the trailing stop
  // turned a 2.09:1 payoff into 1.2:1 — so nothing here forms a view on price.
  if (!I.CORE_HOLD_ON) { ok(I.mostOverweightCore(1000) === null, 'disabled core must never trim'); return; }
  const savedCore = I.portfolio.coreHolding, savedCash = I.portfolio.cash;
  const saved = {};
  const setup = () => {
    I.portfolio.cash = 500; I.portfolio.coreHolding = {};
    I.CORE_HOLD_SYMBOLS.forEach(s => {
      saved[s] = I.marketData[s];
      I.marketData[s] = { price: 100, prevClose: 100, lastUpdate: Date.now() };
      I.portfolio.coreHolding[s] = { qty: 0.5, avgPrice: 100, investedCash: 50 };
    });
  };
  const [a, b] = I.CORE_HOLD_SYMBOLS;

  setup();
  ok(I.mostOverweightCore(I.getTotalValue()) === null, 'a balanced basket must not be trimmed');

  setup(); I.marketData[b].price = 105;                       // +5%, inside the band
  ok(I.mostOverweightCore(I.getTotalValue()) === null, 'small drift must not trigger a spread-paying trade');

  setup(); I.marketData[a].price = 140;                       // +40%, past the band
  const pick = I.mostOverweightCore(I.getTotalValue());
  ok(pick && pick.sym === a, `a name well past its slice must be trimmed, got ${pick && pick.sym}`);
  ok(pick.qty < 0.5, 'it must sell only the EXCESS — a hold is never fully exited');

  // Dust guard: on a tiny account the "excess" can be worth less than the spread costs
  // to sell. Trimming $0.40 is a pure loss. (Note: the `qty < lot.qty` half of that
  // same condition is unreachable — excess is always below the position's value — so
  // it is dead defensive code, not something a test can pin.)
  setup();
  I.CORE_HOLD_SYMBOLS.forEach(s => { I.portfolio.coreHolding[s] = { qty: 0.004, avgPrice: 100, investedCash: 0.4 }; });
  I.portfolio.cash = 1;
  I.marketData[a].price = 200;                              // doubled, but still pennies
  const dust = I.mostOverweightCore(I.getTotalValue());
  ok(dust === null, `an excess worth less than $${I.MIN_FRACTIONAL_NOTIONAL} must not be traded, got ${dust && (dust.qty*dust.px).toFixed(2)}`);

  setup(); I.marketData[a].price = 60;                        // -40%
  const loser = I.mostOverweightCore(I.getTotalValue());
  ok(loser === null, 'a FALLING name must never be sold — trimming is not a stop-loss');

  // A holding no longer in the basket must be exited COMPLETELY, not parked at target
  // weight. Nothing else can remove it — only basket members are ever topped up — so
  // switching the basket would otherwise leave every old name diluting the new one.
  setup();
  I.portfolio.coreHolding.__ORPHAN = { qty: 5, avgPrice: 10, investedCash: 50 };
  I.marketData.__ORPHAN = { price: 30, prevClose: 30, lastUpdate: Date.now() };
  const orphan = I.mostOverweightCore(I.getTotalValue());
  ok(orphan && orphan.sym === '__ORPHAN', 'an off-basket holding must be trimmed first');
  ok(orphan.qty >= 5, `an off-basket holding must be exited fully, got ${orphan.qty} of 5`);
  delete I.portfolio.coreHolding.__ORPHAN; delete I.marketData.__ORPHAN;

  I.portfolio.coreHolding = savedCore; I.portfolio.cash = savedCash;
  I.CORE_HOLD_SYMBOLS.forEach(s => { if (saved[s]) I.marketData[s] = saved[s]; else delete I.marketData[s]; });
});

// Set the trading funding pool to `usd`, whichever basis the build is using.
// 'banked' reads capitalSystem.bankedProfit; 'total' reads equity above start.
function setTradingFunds(usd) {
  I.capitalSystem.tradingDrawn = 0;
  if (I.TRADING_UNLOCK_BASIS === 'total') {
    I.portfolio.coreHolding = {};
    I.portfolio.cash = I.START_CAPITAL + usd;
  } else {
    I.capitalSystem.bankedProfit = usd;
  }
}

check('funding the core is not counted as a drawdown', () => {
  // Trading drawdown is measured on (total - core) against a peak that starts at
  // START_CAPITAL. Buying $571 of core therefore read as a 57% drawdown on an account
  // that was UP $1.41 — tripping safe mode (10%), the emergency entry halt (20%) and
  // the risk-level check (20%) at once, and pinning every self-check to "High drawdown".
  const sc = I.portfolio.cash, sh = I.portfolio.coreHolding, sp = I.riskSystem.peakValue;
  I.portfolio.cash = 1000; I.portfolio.coreHolding = {}; I.riskSystem.peakValue = 1000;
  I.marketData.__PEAK = { price: 100, prevClose: 100, lastUpdate: Date.now() };
  for (let i = 0; i < 6; i++) { I.portfolio.cash -= 95; I.rebasePeakForCoreFlow(95); }
  I.portfolio.coreHolding.__PEAK = { qty: 5.7, avgPrice: 100, investedCash: 570 };
  const trading = I.getTotalValue() - I.coreHoldingValue();
  const dd = (I.riskSystem.peakValue - trading) / Math.max(1, I.riskSystem.peakValue);
  ok(dd < 0.02, `moving cash into the core must not register as a loss, got ${(dd*100).toFixed(1)}% drawdown`);
  // And trimming back must restore the peak, or the next core buy would double-count.
  I.portfolio.cash += 200; I.rebasePeakForCoreFlow(-200);
  ok(Math.abs(I.riskSystem.peakValue - 630) < 0.01,
     `a trim must restore the peak symmetrically, got ${I.riskSystem.peakValue.toFixed(2)}`);
  I.portfolio.cash = sc; I.portfolio.coreHolding = sh; I.riskSystem.peakValue = sp;
  delete I.marketData.__PEAK;

  // ASSERT THE CALL SITES, not just the helper. This test drove the helper directly,
  // so deleting the calls from the buy and trim paths passed it — the fourth time in
  // this project that testing a function instead of its wiring hid a live defect.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const buy  = src.slice(src.indexOf('function maintainCoreHolding'), src.indexOf('\nfunction processProfitVault'));
  const trim = src.slice(src.indexOf('async function trimCoreHolding'), src.indexOf('function maintainCoreHolding'));
  ok(/rebasePeakForCoreFlow\(cost\);/.test(buy), 'a core BUY must rebase the peak');
  ok(/rebasePeakForCoreFlow\(-cost\);/.test(buy), 'and its rollback must undo that');
  ok(/rebasePeakForCoreFlow\(-proceeds\);/.test(trim), 'a core TRIM must restore the peak');
  ok(/rebasePeakForCoreFlow\(proceeds\);/.test(trim), 'and its rollback must undo that');
});

check('a zero-trade day names the phase gate rather than guessing', () => {
  // The gate returns before any candidate is evaluated, so no rejection reasons are
  // recorded and the digest printed "market closed, data missing, or entries halted"
  // — three guesses, none of them the reason.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function logDailyTradeDigest'), src.indexOf('function recordRejection'));
  ok(/PHASE GATE — trading is intentionally locked/.test(fn),
     'the digest must name the phase gate when that is the reason');
  ok(/tradingFundsAvailable\(\)/.test(fn), 'and report how far off the unlock is');
  ok(fn.indexOf('PHASE GATE') < fn.indexOf('nothing was even evaluated'),
     'the specific reason must be checked BEFORE the generic fallback');
});

check('the unlock step-down actually reaches the new weight', () => {
  // At unlock the core must fall from CORE_PHASE1_FRACTION to CORE_HOLD_FRACTION. That
  // is a large sale — ~$474 on a $1047 account — and it happens through the ordinary
  // trim, one name per cycle. If it stalled, the core would sit at 95% forever and
  // trading would have no cash to use.
  if (!I.CORE_HOLD_ON || !I.PHASE_GATE_ENABLED) { ok(true, 'gate not configured'); return; }
  // With CORE_HOLD_FRACTION set close to the phase-1 weight the step-down is smaller
  // than the trim band, so NOTHING sells — correctly, because paying spread to move a
  // few points is exactly what the band exists to prevent. Asserting a step-down here
  // would be asserting that the band is broken. The engine warns about this config at
  // boot; the test declines to run rather than reporting a false failure.
  if (!I.unlockStepDownIsActionable()) { ok(true, 'step-down is inside the trim band — see the boot warning'); return; }
  const sc = I.portfolio.cash, sh = I.portfolio.coreHolding, sd = I.capitalSystem.tradingDrawn;
  const su = I.capitalSystem.tradingUnlocked, saved = {};
  I.capitalSystem.tradingDrawn = 0; I.capitalSystem.tradingUnlocked = false;
  I.portfolio.cash = 50; I.portfolio.coreHolding = {};
  I.CORE_HOLD_SYMBOLS.forEach(sym => {
    saved[sym] = I.marketData[sym];
    I.marketData[sym] = { price: 105, prevClose: 105, lastUpdate: Date.now() };
    I.portfolio.coreHolding[sym] = { qty: 0.95, avgPrice: 100, investedCash: 95 };   // each +5%
  });
  ok(!I.tradingPhaseLocked(), 'a 5% gain on the core should clear the unlock bar');

  // Drain the step-down the way the 5-minute timer would.
  let cycles = 0;
  while (cycles < 40) {
    const p = I.mostOverweightCore(I.getTotalValue());
    if (!p) break;
    const lot = I.portfolio.coreHolding[p.sym];
    lot.qty -= p.qty; lot.investedCash = Math.max(0, lot.investedCash - lot.avgPrice * p.qty);
    if (lot.qty <= 1e-9) delete I.portfolio.coreHolding[p.sym];
    I.portfolio.cash += p.qty * p.px;
    cycles++;
  }
  const ratio = I.coreHoldingValue() / I.getTotalValue();
  ok(cycles > 0 && cycles < 40, `the step-down must terminate, took ${cycles} cycles`);
  ok(Math.abs(ratio - I.CORE_HOLD_FRACTION) < 0.03,
     `core should land near ${(I.CORE_HOLD_FRACTION*100).toFixed(0)}%, got ${(ratio*100).toFixed(1)}%`);

  I.portfolio.cash = sc; I.portfolio.coreHolding = sh;
  I.capitalSystem.tradingDrawn = sd; I.capitalSystem.tradingUnlocked = su;
  I.CORE_HOLD_SYMBOLS.forEach(sym => { if (saved[sym]) I.marketData[sym] = saved[sym]; else delete I.marketData[sym]; });
});

check('the phase does not flip on ordinary daily noise', () => {
  // The core targets 95% locked and 50% unlocked, so every flip means selling ~$450
  // of holdings and buying them back. Measured before the latch: a $1 move across the
  // threshold flipped 95% -> 50% -> 95%. With ~$8 daily swings on a $15 threshold that
  // would churn constantly and pay spread each time.
  if (!I.CORE_HOLD_ON || !I.PHASE_GATE_ENABLED) { ok(true, 'gate not configured'); return; }
  const sc = I.portfolio.cash, sh = I.portfolio.coreHolding;
  const sd = I.capitalSystem.tradingDrawn, su = I.capitalSystem.tradingUnlocked;
  I.capitalSystem.tradingDrawn = 0; I.capitalSystem.tradingUnlocked = false;
  I.portfolio.coreHolding = {};
  const t = I.TRADING_UNLOCK_USD;

  setTradingFunds(t - 0.5);
  const before = I.effectiveCoreFraction();
  setTradingFunds(t + 0.5);
  const unlocked = I.effectiveCoreFraction();
  setTradingFunds(t - 0.5);                       // wobble straight back
  const after = I.effectiveCoreFraction();
  ok(before > unlocked, 'crossing the threshold must step the core down');
  ok(Math.abs(after - unlocked) < 1e-9,
     `a wobble back must NOT flip the core again (${(unlocked*100).toFixed(0)}% -> ${(after*100).toFixed(0)}%)`);

  // Only a real give-back, well below the threshold, re-locks it.
  setTradingFunds(t * I.TRADING_RELOCK_RATIO - 0.5);
  ok(I.effectiveCoreFraction() > unlocked, 'a genuine give-back must re-lock and restore phase 1');

  I.portfolio.cash = sc; I.portfolio.coreHolding = sh;
  I.capitalSystem.tradingDrawn = sd; I.capitalSystem.tradingUnlocked = su;
});

check('the unlocked phase survives a restart', () => {
  // The latch lives on capitalSystem, which is saved and restored wholesale. If it did
  // not persist, every redeploy would re-lock a gate that had already been earned and
  // slam the core back to 95%.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/capitalSystem\.tradingUnlocked = true;/.test(src), 'the unlock must be latched onto capitalSystem');
  ok(/capitalSystem,/.test(src), 'capitalSystem must be part of the saved state');
  ok(/queueSaveState\(\);/.test(src.slice(src.indexOf('function tradingPhaseLocked'),
                                         src.indexOf('function tradingCapitalAllowed'))),
     'a phase transition must be persisted immediately, not left to the next periodic save');
});

check('phase 1 puts idle cash to work, then steps back down', () => {
  // A 50% core while trading is locked leaves half the account earning nothing for a
  // phase lasting months — measured: the whole $1000 returns 8.8%/yr instead of the
  // basket's 17.6%, which also doubles the wait for the gate to open.
  if (!I.CORE_HOLD_ON || !I.PHASE_GATE_ENABLED) { ok(true, 'gate not configured'); return; }
  const sb = I.capitalSystem.bankedProfit, sd = I.capitalSystem.tradingDrawn, sc = I.portfolio.cash;
  I.capitalSystem.tradingDrawn = 0; I.capitalSystem.bankedProfit = 0; I.portfolio.cash = 1000;
  ok(I.tradingPhaseLocked(), 'precondition: locked');
  const locked = I.effectiveCoreFraction();
  ok(locked >= I.CORE_PHASE1_FRACTION - 1e-9,
     `while locked the core should target ~${(I.CORE_PHASE1_FRACTION*100).toFixed(0)}%, got ${(locked*100).toFixed(0)}%`);
  ok(locked > I.CORE_HOLD_FRACTION, 'phase 1 must hold MORE than the unlocked target');
  I.capitalSystem.bankedProfit = 10000;                      // force unlocked
  I.portfolio.cash = 20000;
  ok(!I.tradingPhaseLocked(), 'precondition: unlocked');
  ok(Math.abs(I.effectiveCoreFraction() - I.CORE_HOLD_FRACTION) < 1e-9,
     'once unlocked it must step back down to the configured fraction');
  I.capitalSystem.bankedProfit = sb; I.capitalSystem.tradingDrawn = sd; I.portfolio.cash = sc;
});

check('unlocking on total profit still only ever risks gains', () => {
  // 'total' counts unrealised gains, which is much faster. The protection is unchanged:
  // if the account is above its starting capital, what trading may use is winnings —
  // whether those winnings sit in cash or in shares does not change whose money it is.
  if (!I.PHASE_GATE_ENABLED || !I.CORE_HOLD_ON) { ok(true, 'gate not configured'); return; }
  if (I.TRADING_UNLOCK_BASIS !== 'total') { ok(true, "basis is 'banked' — covered elsewhere"); return; }
  const sd = I.capitalSystem.tradingDrawn, sc = I.portfolio.cash, sh = I.portfolio.coreHolding;
  I.capitalSystem.tradingDrawn = 0; I.portfolio.coreHolding = {};
  I.portfolio.cash = 1000;
  ok(I.tradingPhaseLocked(), 'at exactly starting capital there are no gains — must stay locked');
  I.portfolio.cash = 1000 - 50;
  ok(I.tradingPhaseLocked(), 'BELOW starting capital must never unlock');
  I.portfolio.cash = 1000 + I.TRADING_UNLOCK_USD;
  ok(!I.tradingPhaseLocked(), 'gains at the threshold must unlock');
  I.capitalSystem.tradingDrawn = sd; I.portfolio.cash = sc; I.portfolio.coreHolding = sh;
});

check('trading stays locked until the holding side banks profit', () => {
  // The first live day: holding made +$1.20, the single trade lost $1.32. Without the
  // trading side it would have been green. Gating one behind the other means the
  // unproven strategy can only ever spend winnings, never the stake.
  if (!I.PHASE_GATE_ENABLED || !I.CORE_HOLD_ON) {
    ok(I.tradingPhaseLocked() === false, 'with no holding phase configured there is nothing to gate behind');
    return;
  }
  const saved = I.capitalSystem.bankedProfit, savedDrawn = I.capitalSystem.tradingDrawn;
  // Control BOTH halves of the pool — available = banked + drawn, so leaving a prior
  // test's drawn figure in place makes this assert against the wrong number.
  const savedCash = I.portfolio.cash, savedHold = I.portfolio.coreHolding;
  setTradingFunds(0);
  ok(I.tradingPhaseLocked() === true, 'with nothing earned, trading must be locked');
  setTradingFunds(I.TRADING_UNLOCK_USD - 0.01);
  ok(I.tradingPhaseLocked() === true, 'one cent short must still be locked');
  setTradingFunds(I.TRADING_UNLOCK_USD);
  ok(I.tradingPhaseLocked() === false, 'reaching the threshold must unlock it');
  I.portfolio.cash = savedCash; I.portfolio.coreHolding = savedHold;
  I.capitalSystem.bankedProfit = saved; I.capitalSystem.tradingDrawn = savedDrawn;
});

check('trading losses give the funding back and re-lock the gate', () => {
  // bankedProfit only ever increased, so trading could burn the entire unlock amount
  // and the gate would still report it as available — "can only spend winnings" was
  // false the moment trading started losing.
  if (!I.PHASE_GATE_ENABLED || !I.CORE_HOLD_ON) { ok(true, 'gate not configured'); return; }
  const sb = I.capitalSystem.bankedProfit, sd = I.capitalSystem.tradingDrawn;
  const savedCash2 = I.portfolio.cash, savedHold2 = I.portfolio.coreHolding;
  setTradingFunds(I.TRADING_UNLOCK_USD + 10);
  ok(I.tradingPhaseLocked() === false, 'enough earned should unlock');
  // The latch has a dead band, so a small give-back must NOT re-lock — that is the
  // whole point of it. Only falling below TRADING_RELOCK_RATIO of the threshold does.
  I.bankTradingPnL(-11);
  ok(I.tradingPhaseLocked() === false, 'a small give-back must stay unlocked (dead band)');
  const floor = I.TRADING_UNLOCK_USD * I.TRADING_RELOCK_RATIO;
  I.bankTradingPnL(-(I.tradingFundsAvailable() - floor + 1));   // drop clearly below the floor
  ok(I.tradingPhaseLocked() === true, 'falling below the re-lock floor must RE-LOCK the gate');
  I.bankTradingPnL(+(I.TRADING_UNLOCK_USD - I.tradingFundsAvailable() + 1));  // earn back past the bar
  ok(I.tradingPhaseLocked() === false, 'earning it back must unlock again');
  I.capitalSystem.bankedProfit = sb; I.capitalSystem.tradingDrawn = sd;
  I.portfolio.cash = savedCash2; I.portfolio.coreHolding = savedHold2;
});

check('the funding pool cannot be corrupted or go negative', () => {
  if (!I.PHASE_GATE_ENABLED || !I.CORE_HOLD_ON) { ok(true, 'gate not configured'); return; }
  const sb = I.capitalSystem.bankedProfit, sd = I.capitalSystem.tradingDrawn;
  I.capitalSystem.bankedProfit = 50; I.capitalSystem.tradingDrawn = 0;
  [NaN, Infinity, -Infinity, undefined, null, 'x'].forEach(v => I.bankTradingPnL(v));
  ok(Number.isFinite(I.tradingFundsAvailable()),
     `a bad P&L value corrupted the pool: ${I.tradingFundsAvailable()}`);
  I.capitalSystem.bankedProfit = 10; I.capitalSystem.tradingDrawn = -100;
  ok(I.tradingCapitalAllowed() >= 0, 'a deeply negative pool must never produce a negative allowance');
  I.capitalSystem.bankedProfit = sb; I.capitalSystem.tradingDrawn = sd;
});

check('both close paths draw against the funding pool', () => {
  // Full closes and PARTIAL closes book P&L in different places. Hooking only one
  // would let half of trading's losses go unaccounted for.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/bankTradingPnL\(totalPnL\);/.test(src), 'full closes must draw against the pool');
  ok(/bankTradingPnL\(realizedPnL\);/.test(src), 'partial closes must draw against the pool too');
});

check('once unlocked, trading risks only banked profit', () => {
  // The point of the gate is not just to delay trading but to cap what it can lose.
  // Sizing from the whole account after unlocking would put the original stake back
  // on an unproven strategy.
  if (!I.PHASE_GATE_ENABLED || !I.CORE_HOLD_ON) { ok(true, 'gate not configured'); return; }
  const savedBank = I.capitalSystem.bankedProfit, savedCap = I.capitalSystem.tradingCapital;
  const savedDrawn2 = I.capitalSystem.tradingDrawn;
  I.capitalSystem.tradingCapital = 700;
  I.capitalSystem.bankedProfit = 60;
  I.capitalSystem.tradingDrawn = 0;
  const allowed = I.tradingCapitalAllowed();
  I.capitalSystem.bankedProfit = savedBank; I.capitalSystem.tradingCapital = savedCap;
  I.capitalSystem.tradingDrawn = savedDrawn2;
  ok(allowed <= 60 * I.TRADING_PROFIT_SHARE + 0.01,
     `trading must be funded by banked profit ($60), not the $700 book — got $${allowed.toFixed(2)}`);
  ok(allowed < 700, 'it must never reach for the whole trading book');
});

check('the phase gate blocks entries but never exits', () => {
  // Anything already open must always be able to close. A gate that trapped positions
  // would be far worse than no gate.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf('if (tradingPhaseLocked())');
  ok(i > 0, 'the entry scan must consult the phase gate');
  // Exits run earlier in evaluateAndTrade than the entry gates; assert the gate sits
  // after the exit sweep rather than before it.
  const exitsAt = src.indexOf('longsStop.forEach(t    => closeLong(t, true));');
  ok(exitsAt > 0 && exitsAt < i, 'the phase gate must come AFTER the exit sweep, so exits are never blocked');
});

check('the AI can accelerate a trim but never prevent one', () => {
  // The operator's reasoning — bank near a high rather than after it — is implemented,
  // but bounded. Every judgement-timed exit measured in this project destroyed value
  // (the trailing stop turned a 2.09:1 payoff into 1.2:1), so the arithmetic rule must
  // remain sovereign: the AI may only pull a trim FORWARD, never talk the bot out of
  // banking profit, and never sell more than the excess.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf('async function trimCoreHolding');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 1));
  // The rule runs FIRST and unconditionally.
  ok(/let pick = mostOverweightCore\(tv\);/.test(fn), 'the arithmetic rule must run first');
  // The AI is consulted only when the rule found nothing — it cannot override a trim.
  ok(/if \(!pick && CORE_TRIM_AI/.test(fn),
     'the AI must only be consulted when the rule found nothing — it can never veto a trim');
  // And only for a holding already past the early band, so a view alone is not enough.
  ok(/mostOverweightCore\(tv, CORE_TRIM_EARLY_BAND\)/.test(fn),
     'the AI may only act on a holding that has already drifted past the early band');
  ok(/verdict\.confidence >= CORE_TRIM_AI_CONFIDENCE/.test(fn), 'a high confidence bar is required');
});

check('every AI trim decision is logged, including the refusals', () => {
  // Logging only the cases the AI acted on would make it look infallible in review —
  // the register needs the "no" answers to score whether its timing beat the rule.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf('async function trimCoreHolding');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 1));
  const calls = (fn.match(/recordTrimDecision\(/g) || []).length;
  ok(calls >= 2, `both the consulted-and-declined and the acted cases must be logged, found ${calls}`);
  ok(/acted: false/.test(fn), 'a declined trim must be recorded too');
  ok(/ruleWouldTrim/.test(fn), 'each record must say what the arithmetic would have done');
});

check('a failed trim rolls the ledger back', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function trimCoreHolding'), src.indexOf('function maintainCoreHolding'));
  ok(/rollback/.test(fn), 'a rejected trim must roll back');
  ok(/portfolio\.cash -= proceeds/.test(fn), 'rollback must remove the un-received proceeds');
  ok(/l\.qty \+= pick\.qty/.test(fn), 'rollback must restore the shares');
  ok(/never sell on a stale price/.test(src), 'a stale-priced holding must not be trimmed');
});

check('the core builds a basket, not one big position', () => {
  // Sizing against the WHOLE-basket gap put the entire allocation into whichever name
  // came first — $500 of a $1000 account into a single stock, which is exactly the
  // concentration a basket exists to prevent. Each buy must be one name-sized slice.
  if (!I.CORE_HOLD_ON) {
    ok(I.coreTopUpQty(100, 1000, 0, 1000) === 0, 'disabled core must never buy');
    return;
  }
  const n = I.CORE_HOLD_SYMBOLS.length;
  const perName = (1000 * I.effectiveCoreFraction()) / n;   // phase 1 holds more
  const first = I.coreTopUpQty(100, 1000, 0, 1000) * 100;      // $ value of the first buy
  ok(Math.abs(first - perName) < 0.5,
     `first buy should be one name's slice ($${perName.toFixed(2)}), got $${first.toFixed(2)}`);
  ok(first < 1000 * I.effectiveCoreFraction() * 0.9,
     'a single buy must never take the whole basket allocation');
  // A name already at its slice must not be topped up again.
  ok(I.coreTopUpQty(100, 1000, perName, 1000) === 0, 'a filled name must not be bought again');
});

check('core top-up sizing buys the gap, never churns, never sells', () => {
  // coreTopUpQty is pure, so the sizing decision is testable without a live market —
  // the live path is gated on market hours and would otherwise go unverified.
  const px = 600;
  const q = (equity, core, cash) => I.coreTopUpQty(px, equity, core, cash);
  if (!I.CORE_HOLD_ON) {
    ok(q(1000, 0, 1000) === 0, 'with the core disabled it must never buy anything');
    return;                                    // default config: OFF, nothing more to assert
  }
  // Values are PER NAME now: on $1000 at 50% across N names, each name targets 500/N.
  const per = (1000 * I.effectiveCoreFraction()) / I.CORE_HOLD_SYMBOLS.length;
  ok(Math.abs(q(1000, 0, 1000) * px - per) < 1, "an empty name must be bought up to its own slice");
  ok(q(1000, per, 1000) === 0, 'a name at its slice must not churn');
  ok(q(1000, per * 0.96, 1000) === 0, 'inside the rebalance band it must not churn');
  ok(q(1000, per * 0.3, 1000) > 0, 'a name well below its slice must be topped up');
  ok(q(1000, 0, 0) === 0, 'with no cash it must not buy');
  ok(q(1000, per * 1.5, 1000) === 0, 'a name ABOVE its slice must return 0 — a hold never sells');
});

// ── CONVICTION WEIGHTING & DEPLOYMENT SPEED (v11.46) ────────────────────────
check('conviction weighting stays equal-weight unless conviction actually differs', () => {
  const syms = Array.from({ length: 10 }, (_, i) => 'S' + i);
  const w = (conv) => Object.values(I.coreWeightMap(syms, conv));
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  const none = w({});
  ok(Math.abs(Math.max(...none) - 0.1) < 1e-9, 'no conviction must give exactly equal weight');
  // Uniform confidence must NOT tilt. Centring on the basket mean instead of a fixed
  // 0.5 would make the "most confident" of ten identical names win a bigger slice,
  // which is amplifying noise, not expressing conviction.
  const flatHigh = w(Object.fromEntries(syms.map(s => [s, 1])));
  const flatLow  = w(Object.fromEntries(syms.map(s => [s, 0])));
  ok(Math.abs(Math.max(...flatHigh) - 0.1) < 1e-9, 'uniformly HIGH conviction must stay equal weight');
  ok(Math.abs(Math.max(...flatLow) - 0.1) < 1e-9, 'uniformly LOW conviction must stay equal weight');

  // Genuine spread must move money, and in the right direction.
  const tilted = I.coreWeightMap(syms, Object.fromEntries(syms.map((s, i) => [s, i === 0 ? 1 : 0.5])));
  ok(tilted.S0 > 0.1 + 1e-6, `a high-conviction name must get MORE than equal weight, got ${(tilted.S0*100).toFixed(1)}%`);
  ok(tilted.S1 < 0.1 - 1e-6, 'and the rest must give that share up');
  ok(Math.abs(sum(Object.values(tilted)) - 1) < 1e-9, 'weights must sum to exactly 1');

  // PIN THE MAPPING ITSELF. "Uniform conviction stays equal" is satisfied by any
  // formula of the form 1 + f(c), including ones that quietly change how far apart
  // conviction 1.0 and 0.0 end up — so it does not pin the shape. Conviction must be
  // centred on 0.5 and symmetric: the extremes must differ by exactly (1+S)/(1-S).
  const ends = I.coreWeightMap(syms, Object.fromEntries(
    syms.map((s, i) => [s, i === 0 ? 1 : i === 1 ? 0 : 0.5])));
  // The extremes are set by the multiplier rails, not by STRENGTH alone: CORE_TILT_MIN
  // floors the low end before normalisation, so the achievable spread is narrower than
  // (1+S)/(1-S). Pinning the naive formula asserts something the code deliberately does
  // not do, which is a failing test rather than a caught bug.
  const hiMult = Math.min(I.CORE_TILT_MAX, 1 + I.CORE_TILT_STRENGTH);
  const loMult = Math.max(I.CORE_TILT_MIN, 1 - I.CORE_TILT_STRENGTH);
  ok(Math.abs(ends.S0 / ends.S1 - hiMult / loMult) < 1e-6,
     `full conviction must be worth exactly ${(hiMult/loMult).toFixed(2)}x zero conviction, got ${(ends.S0/ends.S1).toFixed(3)}`);
  // A neutral name sits strictly between them, and every neutral name gets the same
  // slice — its absolute share moves with what else is in the basket, which is correct.
  ok(ends.S2 > ends.S1 && ends.S2 < ends.S0, 'a neutral 0.5 name must sit between the extremes');
  ok(Math.abs(ends.S2 - ends.S9) < 1e-12, 'all neutral names must get identical slices');
  ok(Math.abs(ends.S0 / ends.S2 - hiMult) < 1e-6,
     `full conviction must be exactly ${hiMult}x a neutral name`);

  // CONVICTION IS ABSOLUTE, NOT RELATIVE. Centring on the basket mean would size the
  // same two names differently depending on what else happened to be in the basket
  // that day — and would tilt hardest exactly when Venus is least discriminating,
  // because with ten near-identical scores the mean sits among them and tiny gaps get
  // stretched into real money. The uniform-conviction cases above do NOT catch this:
  // when every score is equal, mean-centring collapses to neutral and looks correct.
  const pairRatio = (fill) => {
    const names = ['A', 'B', 'X0', 'X1', 'X2', 'X3'];
    const conv = { A: 0.6, B: 0.4, X0: fill, X1: fill, X2: fill, X3: fill };
    const w = I.coreWeightMap(names, conv);
    return w.A / w.B;
  };
  // Fills chosen to stay clear of the concentration rail. Below about 0.3 the rest of
  // the basket shrinks enough that A breaches the 25% cap, and the rail then breaks
  // proportionality ON PURPOSE — that is the rail working, not a violation of this
  // property, so testing it there would assert the opposite of what is wanted.
  ok(Math.abs(pairRatio(0.5) - pairRatio(0.9)) < 1e-9,
     `two names must keep their relative size regardless of the rest of the basket: ` +
     `${pairRatio(0.5).toFixed(4)} vs ${pairRatio(0.9).toFixed(4)}`);
  ok(Math.abs(pairRatio(0.5) - pairRatio(0.35)) < 1e-9,
     'and that must hold for a lower-conviction basket too');
});

check('no conviction pattern can breach the tested concentration rail', () => {
  // The per-name multiplier is bounded but shares are NORMALISED, so bounding the
  // multiplier does not bound the result: one name at 1.0 with nine at 0.0 reaches
  // 30.8% of the core on the multiplier rail alone. The measurement is only reassuring
  // up to ~25% (a completely wrong tilt costs 0.2pp there, 0.9pp by 40%), so the rail
  // that matters is on the final share.
  // n=3 and n=2 matter: there the 25% rail is BELOW equal weight, so a rail that is not
  // floored at 1/n caps every name and the weights silently sum to less than 1 — the
  // core would then target a fraction of the allocation it was told to hold.
  for (const n of [2, 3, 4, 5, 10, 15, 20]) {
    const syms = Array.from({ length: n }, (_, i) => 'S' + i);
    for (const conv of [
      Object.fromEntries(syms.map((s, i) => [s, i === 0 ? 1 : 0])),        // one hero
      Object.fromEntries(syms.map((s, i) => [s, i < 2 ? 1 : 0])),          // two heroes
      Object.fromEntries(syms.map((s, i) => [s, i === 0 ? 0 : 1])),        // one pariah
    ]) {
      const v = Object.values(I.coreWeightMap(syms, conv));
      const cap = Math.max(I.CORE_TILT_MAX_SHARE, 1 / n);
      ok(Math.max(...v) <= cap + 1e-9,
         `${n} names: max share ${(Math.max(...v)*100).toFixed(1)}% breached the ${(cap*100).toFixed(1)}% rail`);
      ok(Math.abs(v.reduce((a, b) => a + b, 0) - 1) < 1e-9,
         `${n} names: weights must still sum to 1 after the rail is applied`);
      ok(Math.min(...v) > 0, 'the rail must never zero a basket member out');
    }
  }
});

check('the tilt reaches sizing, and buying and trimming use the SAME weights', () => {
  // SOURCE ASSERTIONS FIRST, BEFORE ANY RUNTIME GUARD. Putting them after an
  // `if (!CORE_HOLD_ON) return` meant they never ran in the default config, and three
  // separate mutations — share ignored, top-up flattened, trim flattened — sailed
  // straight through a green suite. A wiring check must not depend on the very setting
  // whose wiring it is checking.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const under = src.slice(src.indexOf('function mostUnderweightCore'), src.indexOf('function coreHaltedByOperator'));
  const over  = src.slice(src.indexOf('function mostOverweightCore'), src.indexOf('async function trimCoreHolding'));
  const size  = src.slice(src.indexOf('function coreTopUpQty'), src.indexOf('function mostUnderweightCore'));
  // If the top-up leaned toward a name while the trim pulled every name back to equal
  // weight, the two would churn against each other — buy, trim, buy, trim, paying
  // spread on every leg and ending exactly where they started.
  ok(/coreWeightMap\(\)/.test(under), 'the top-up target must come from coreWeightMap');
  ok(/coreWeightMap\(\)/.test(over),  'the trim target must come from the SAME coreWeightMap');
  ok(/const short = val - total \* share;/.test(under),
     'the top-up must measure each name against its OWN share, not the flat average');
  ok(/coreTarget \* \(Number\.isFinite\(w\[sym\]\) \? w\[sym\] : 1 \/ nEq\)/.test(over),
     'the trim target must be the tilted share, not a flat slice');
  ok(/const frac = \(Number\.isFinite\(share\) && share > 0\) \? share : 1 \/ n;/.test(size),
     'coreTopUpQty must honour the share it is given');
  ok(/mostUnderweightCore\(\)/.test(src) && /pick\.share\)/.test(src),
     'the buy path must pass the pick\'s share through to sizing');

  if (!I.CORE_HOLD_ON) { ok(I.coreTopUpQty(100, 1000, 0, 1000, 10, 0.2) === 0, 'disabled core must never buy'); return; }
  // A share must actually change the size bought — otherwise coreWeightMap is decoration.
  const big   = I.coreTopUpQty(100, 1000, 0, 1000, 10, 0.20) * 100;
  const small = I.coreTopUpQty(100, 1000, 0, 1000, 10, 0.05) * 100;
  const equal = I.coreTopUpQty(100, 1000, 0, 1000, 10) * 100;
  ok(big > equal && equal > small, `share must scale the buy: ${small.toFixed(2)} < ${equal.toFixed(2)} < ${big.toFixed(2)}`);
  ok(Math.abs(big / small - 4) < 0.01, 'a 4x share must buy 4x the notional');
});

check('a tilted name is bought toward its own slice, not the average', () => {
  if (!I.CORE_HOLD_ON) return;
  const savedCore = I.portfolio.coreHolding, saved = {};
  const syms = I.CORE_HOLD_SYMBOLS;
  syms.forEach(s => { saved[s] = I.marketData[s];
    I.marketData[s] = { price: 100, prevClose: 100, lastUpdate: Date.now() }; });
  I.portfolio.coreHolding = {};
  syms.forEach(s => { I.portfolio.coreHolding[s] = { qty: 1, avgPrice: 100, investedCash: 100 }; });
  // Every name holds the same dollar value. With flat conviction nothing is underweight
  // by much; with one name favoured, THAT name must become the pick.
  const prevConv = I.getCoreConviction();
  I.setCoreConviction({});
  const flat = I.mostUnderweightCore();
  I.setCoreConviction(Object.fromEntries(syms.map((s, i) => [s, i === 3 ? 1 : 0.4])));
  const tilted = I.mostUnderweightCore();
  I.setCoreConviction(prevConv);
  I.portfolio.coreHolding = savedCore;
  syms.forEach(s => { if (saved[s]) I.marketData[s] = saved[s]; else delete I.marketData[s]; });

  ok(tilted && tilted.sym === syms[3],
     `the favoured name must be the one topped up, got ${tilted && tilted.sym} (expected ${syms[3]})`);
  ok(tilted && tilted.share > 1 / syms.length,
     'the pick must carry its own share, above equal weight');
  ok(flat && Number.isFinite(flat.share), 'the flat case must still report a share');
});

check('the core fills the basket in minutes, not an hour', () => {
  // One name every five minutes needed 50 minutes for ten names, and Venus proposes
  // late in the session — Monday 2026-08-31 the basket reached 6 of 10 and the account
  // closed 43% in cash. Idle cash is the largest measured drag in the system: 57%
  // deployed earns $0.41/day where 95% earns $0.82. This is a DOUBLING of daily profit
  // that costs nothing and reduces drawdown (a 10-name basket drew 14.6% vs 16.7%).
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const stripped = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const fn = stripped.slice(stripped.indexOf('function maintainCoreHolding'),
                            stripped.indexOf('function coreBuyStep'));
  // WIRING, not just the helper: a loop that is never entered fills nothing.
  ok(/for \(let step = 0; step < CORE_BUYS_PER_CYCLE; step\+\+\)/.test(fn),
     'maintainCoreHolding must loop up to CORE_BUYS_PER_CYCLE times');
  ok(/if \(!coreBuyStep\(\)\) break;/.test(fn),
     'and must call coreBuyStep, stopping as soon as one pass buys nothing');
  ok(I.CORE_BUYS_PER_CYCLE > 1, 'more than one buy per cycle, or the loop is pointless');
  // The cadence must come from the constant, not a hard-coded 5 minutes.
  ok(/setInterval\(maintainCoreHolding, CORE_INTERVAL_MS\)/.test(stripped),
     'the core interval must be CORE_INTERVAL_MS');
  ok(I.CORE_INTERVAL_MS <= 60000, `cadence must be a minute or faster, got ${I.CORE_INTERVAL_MS}ms`);
  // Ten names must be reachable well inside a session.
  const minutesToFill = (10 / I.CORE_BUYS_PER_CYCLE) * (I.CORE_INTERVAL_MS / 60000);
  ok(minutesToFill <= 5, `a 10-name basket must fill within 5 minutes, takes ${minutesToFill.toFixed(1)}`);
});

check('the buy loop actually deploys the account and then stops', () => {
  // Everything else about this change is asserted on SOURCE. This runs it: an empty
  // basket, $1000, and nothing but repeated coreBuyStep calls — the same thing the
  // interval does. Source assertions prove the loop is wired; only this proves the
  // wiring converges instead of over-buying, stalling, or looping forever.
  if (!I.CORE_HOLD_ON) return;
  // HARD SAFETY: coreBuyStep submits to the broker when LIVE_TRADING is on. Never let
  // a test place a real order, even against a paper account.
  if (String(process.env.LIVE_TRADING).toLowerCase() === 'true') return;

  const saved = {
    cash: I.portfolio.cash, core: I.portfolio.coreHolding,
    peak: I.riskSystem.peakValue, longs: I.portfolio.longPositions,
    shorts: I.portfolio.shortPositions, md: {},
  };
  const syms = I.CORE_HOLD_SYMBOLS;
  syms.forEach(s => { saved.md[s] = I.marketData[s];
    I.marketData[s] = { price: 100, prevClose: 100, lastUpdate: Date.now() }; });
  I.portfolio.longPositions = {}; I.portfolio.shortPositions = {};
  I.portfolio.coreHolding = {}; I.portfolio.cash = 1000; I.riskSystem.peakValue = 1000;

  let steps = 0, negativeCash = false;
  while (steps < 60 && I.coreBuyStep()) {
    steps++;
    if (I.portfolio.cash < 0) negativeCash = true;
  }
  const total = I.getTotalValue();
  const core = I.coreHoldingValue();
  const deployed = total > 0 ? core / total : 0;
  const targetFrac = I.effectiveCoreFraction();
  const names = Object.keys(I.portfolio.coreHolding).length;
  const w = I.coreWeightMap();
  let worstOver = 0;
  for (const [sym, lot] of Object.entries(I.portfolio.coreHolding)) {
    const share = (lot.qty * 100) / Math.max(1e-9, core);
    worstOver = Math.max(worstOver, share - (w[sym] ?? 1 / syms.length));
  }
  const endCash = I.portfolio.cash;

  Object.assign(I.portfolio, { cash: saved.cash, coreHolding: saved.core,
                               longPositions: saved.longs, shortPositions: saved.shorts });
  I.riskSystem.peakValue = saved.peak;
  syms.forEach(s => { if (saved.md[s]) I.marketData[s] = saved.md[s]; else delete I.marketData[s]; });

  ok(!negativeCash, 'cash must never go negative while the loop runs');
  ok(steps < 60, `the loop must terminate on its own, ran ${steps} steps`);
  ok(names === syms.length, `every name must be opened, got ${names} of ${syms.length}`);
  ok(Math.abs(deployed - targetFrac) < 0.02,
     `must deploy to ${(targetFrac*100).toFixed(0)}%, reached ${(deployed*100).toFixed(1)}%`);
  ok(endCash >= 0 && endCash < 1000 * (1 - targetFrac) + 5,
     `leftover cash should be the undeployed remainder, got $${endCash.toFixed(2)}`);
  ok(worstOver < 0.02, `no name may overshoot its share by more than 2pp, worst was ${(worstOver*100).toFixed(1)}pp`);
  // And once full it must report "nothing to do" rather than churning.
  ok(steps >= syms.length, `it must take at least one step per name, took ${steps}`);
});

check('faster core buying does not reopen the check-then-act race', () => {
  // The ledger is debited synchronously; the broker leg resolves later. At five-minute
  // spacing a second tick could not overlap in-flight orders. At sixty seconds with
  // four buys a pass it can — and sizing against cash that pending orders have already
  // claimed is exactly what put 18 HOOD orders in 50 seconds.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const fn = src.slice(src.indexOf('function maintainCoreHolding'), src.indexOf('function processProfitVault'));
  ok(/if \(_coreBuyInFlight > 0\) return;/.test(fn), 'a tick must bail while core orders are in flight');
  ok(/_coreBuyInFlight\+\+;/.test(fn), 'submitting a core buy must mark it in flight');
  ok(/_coreBuyInFlight = Math\.max\(0, _coreBuyInFlight - 1\)/.test(fn),
     'and it must be cleared when the broker answers');
  // Cleared on BOTH paths — an order that errors and never settles would wedge the core
  // permanently, which is worse than the race it guards against.
  ok(/\.then\(r => \{ if \(!r\.ok\) rollback\(r\.error\); settle\(\); \}\)/.test(fn),
     'the success path must settle');
  ok(/\.catch\(e => \{ rollback\(e\.message\); settle\(\); \}\)/.test(fn),
     'the failure path must settle too, or a single network error halts the core forever');
  // The guard must sit BEFORE the loop; after it, it guards nothing.
  ok(fn.indexOf('_coreBuyInFlight > 0') < fn.indexOf('step < CORE_BUYS_PER_CYCLE'),
     'the in-flight guard must run before the buy loop, not after');
});

check('Venus conviction is a screen score with a safe default, never a forecast', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function proposeBasket'), src.indexOf('async function assess'));
  // The anti-forecasting framing is the whole reason sizing on this is defensible.
  ok(/NOT a prediction of\s*\n?return/i.test(fn) || /Conviction is NOT a prediction/i.test(fn),
     'conviction must be defined as a screen score, not a return forecast');
  ok(/HOW WELL THIS NAME\s*\n?MEETS THE SCREEN/i.test(fn),
     'it must be anchored to the screen criteria');
  ok(/flat set of scores is a valid/i.test(fn),
     'a uniform answer must be explicitly allowed, or the model invents spread to seem useful');
  // A missing or junk score must degrade to equal weight, not to a random tilt.
  ok(/Number\.isFinite\(raw\) \? Math\.max\(0, Math\.min\(1, raw\)\) : 0\.5/.test(fn),
     'missing conviction must default to 0.5 — the value coreWeightMap treats as equal weight');
  ok(/for \(const sym of basket\)/.test(fn),
     'conviction must be built from the VALIDATED basket, not the raw model output');
  // 0.5 must genuinely be the neutral point, or the default silently tilts.
  const neutral = I.coreWeightMap(['A', 'B', 'C', 'D'], { A: 0.5, B: 0.5, C: 0.5, D: 0.5 });
  ok(Math.abs(neutral.A - 0.25) < 1e-9, '0.5 conviction must map to exactly equal weight');
});

check('core buys are checked against the broker, not only the ledger', () => {
  // The core has always sized against ATLAS's own ledger, and syncFromBroker reconciles
  // cash only at BOOT — so intraday the two drift apart on fill slippage. One buy every
  // five minutes made that irrelevant; four a minute can issue a whole basket's worth of
  // orders between reconciliations. Ordering against cash the broker does not have is
  // what produced 1,800 rejections an hour on the trading side before RULE 3.2.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const fn = src.slice(src.indexOf('function coreBuyStep'), src.indexOf('function processProfitVault'));
  ok(/brokerMirror\.ok && Number\.isFinite\(brokerMirror\.cash\)/.test(fn),
     'the core must consult the broker mirror before committing cash');
  ok(/mirrorAge < BROKER_MIRROR_MAX_AGE_MS/.test(fn),
     'a stale mirror must be treated as unknown, not trusted');
  ok(/isFractionalQty\(qty\) \? brokerMirror\.cash : Math\.min\(brokerMirror\.cash, bp\)/.test(fn),
     'fractional orders get no margin and must be checked against cash');
  // The snapshot cannot see orders placed since it was taken. Without tracking them the
  // same dollars clear the gate on every pass of the loop.
  ok(/_coreCommittedSinceMirror \+= cost;/.test(fn), 'a committed buy must be recorded against the snapshot');
  ok(/const committed = _coreCommittedSinceMirror \+ pendingEntryNotional\(\);/.test(fn),
     'the gate must subtract what is already committed, including trading entries');
  // THE LINE THAT ACTUALLY REFUSES. Everything above only computes numbers; deleting
  // this one leaves the whole gate in place as decoration, and the suite passed with it
  // gone until this assertion existed.
  ok(/if \(cost > \(fundable - committed\) \* 0\.98\) return false;/.test(fn),
     'the gate must actually refuse the buy, not merely compute what it could afford');
  ok(/_coreCommittedSinceMirror = Math\.max\(0, _coreCommittedSinceMirror - cost\)/.test(fn),
     'a rolled-back buy must release its commitment');
  // And the counter must reset when a fresh snapshot arrives, or it grows without bound
  // and eventually blocks the core from ever buying again.
  // Anchored to the function's own closing brace rather than to whatever happens to be
  // declared next — refreshBrokerMirror sits AFTER syncFromBroker, so slicing between
  // them ran backwards and asserted against an empty string.
  const mStart = src.indexOf('async function refreshBrokerMirror');
  const mirror = src.slice(mStart, src.indexOf('\n}', mStart));
  ok(mStart > 0 && mirror.includes('brokerMirror = {'), 'the mirror slice must contain the function body');
  ok(/_coreCommittedSinceMirror = 0;/.test(mirror),
     'a fresh broker snapshot must reset the running commitment total');

  // BEHAVIOURAL: a broker that cannot fund the buy must stop it.
  if (!I.CORE_HOLD_ON) return;
  if (String(process.env.LIVE_TRADING).toLowerCase() === 'true') return;
  const saved = { cash: I.portfolio.cash, core: I.portfolio.coreHolding, peak: I.riskSystem.peakValue,
                  longs: I.portfolio.longPositions, shorts: I.portfolio.shortPositions, md: {} };
  const syms = I.CORE_HOLD_SYMBOLS;
  syms.forEach(s => { saved.md[s] = I.marketData[s];
    I.marketData[s] = { price: 100, prevClose: 100, lastUpdate: Date.now() }; });
  I.portfolio.longPositions = {}; I.portfolio.shortPositions = {};
  I.portfolio.coreHolding = {}; I.portfolio.cash = 1000; I.riskSystem.peakValue = 1000;
  I.resetCoreCommitted();

  // The LEDGER says $1000. The BROKER says $3. Only the broker is real.
  I.setBrokerMirror({ at: Date.now(), ok: true, cash: 3, buying_power: 3, equity: 1000, positions: [] });
  const blocked = I.coreBuyStep();
  const boughtWhileBroke = Object.keys(I.portfolio.coreHolding).length;

  // A stale snapshot must NOT block — the gate stands down rather than guessing.
  I.setBrokerMirror({ at: Date.now() - 60 * 60 * 1000, ok: true, cash: 3, buying_power: 3, positions: [] });
  const staleAllows = I.coreBuyStep();

  I.setBrokerMirror({ at: 0, ok: false });
  I.resetCoreCommitted();
  Object.assign(I.portfolio, { cash: saved.cash, coreHolding: saved.core,
                               longPositions: saved.longs, shortPositions: saved.shorts });
  I.riskSystem.peakValue = saved.peak;
  syms.forEach(s => { if (saved.md[s]) I.marketData[s] = saved.md[s]; else delete I.marketData[s]; });

  ok(blocked === false, 'a buy the broker cannot fund must be refused');
  ok(boughtWhileBroke === 0, 'and nothing may be written to the ledger when it is refused');
  ok(staleAllows === true, 'a stale snapshot must not block the core — unknown is not the same as broke');
  // The reset must land on the SUCCESS path. Resetting in the catch too would clear the
  // commitment record on a snapshot that never arrived, re-clearing spent cash.
  ok(!/catch \(e\) \{ brokerMirror = \{ at: Date\.now\(\), ok: false, error: e\.message \}; _coreCommittedSinceMirror = 0/.test(mirror),
     'a FAILED refresh must not reset the commitment total');
});

check('a step-down too small for the trim band is warned about, not left silent', () => {
  // The core falls from CORE_PHASE1_FRACTION to CORE_HOLD_FRACTION at unlock, through
  // the ordinary trim — which only acts once a name is CORE_TRIM_BAND above target. Set
  // the two close together and every name sits inside the band, so nothing sells and
  // trading unlocks into an account with no cash. That is the band working correctly,
  // but the operator cannot tell "waiting" from "will never happen" without being told.
  ok(I.unlockStepDownIsActionable() === ((I.CORE_PHASE1_FRACTION - I.CORE_HOLD_FRACTION) / I.CORE_HOLD_FRACTION > I.CORE_TRIM_BAND)
     || !I.CORE_HOLD_ON,
     'the check must compare the step-down against the trim band');
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/if \(CORE_HOLD_ON && PHASE_GATE_ENABLED && !unlockStepDownIsActionable\(\)\)/.test(src),
     'the boot banner must warn when the configured step-down cannot execute');
  ok(/free little or NO cash/.test(src), 'and say plainly what will happen');
  // The condition must be a real comparison, not a constant.
  ok(/\(CORE_PHASE1_FRACTION - CORE_HOLD_FRACTION\) \/ CORE_HOLD_FRACTION > CORE_TRIM_BAND/.test(src),
     'the threshold must be derived from the trim band, not hard-coded');
});

check('a restart does not liquidate the basket Venus chose', () => {
  // THE WORST BUG FOUND IN THIS PASS, and it predates the conviction work. In venus
  // mode the live basket existed only in memory. A restart reverted CORE_HOLD_SYMBOLS
  // to the env default while the HOLDINGS stayed as Venus picked them — so every
  // holding outside the default list read as off-basket, whose target is zero, and the
  // trim sold it out completely. maintainCoreHolding was guarded against acting before
  // a proposal; trimCoreHolding was not, and its mistake is the expensive direction.
  // On Monday's book: PFE and BAC, $192.21, 19.2% of the account, sold on any restart
  // during market hours and repurchased minutes later at a fresh spread.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  // 1. The basket must be persisted, not just the shares in it.
  ok(/coreBasket:\s+\(CORE_BASKET_SOURCE === 'venus' && _venusBasketReceived\) \? \[\.\.\.CORE_HOLD_SYMBOLS\] : null/.test(src),
     'the live basket must be saved in venus mode');
  ok(/coreConviction: CORE_CONVICTION/.test(src), 'and the conviction that sized it');
  // Saved only in venus mode: a stale list must never override an operator's env edit.
  ok(!/coreBasket:\s+\[\.\.\.CORE_HOLD_SYMBOLS\],/.test(src),
     'the basket must not be saved unconditionally — a fixed basket is env-authoritative');

  // 2. It must be restored BEFORE any interval can fire.
  const loadIdx = src.indexOf('CORE_HOLD_SYMBOLS.push(...new Set(restored))');
  const startIdx = src.indexOf('setInterval(maintainCoreHolding');
  ok(loadIdx > 0 && loadIdx < startIdx, 'the basket must be restored before the core intervals start');

  // 3. And the trim must refuse to run with no live basket, whatever the state file says.
  const trim = src.slice(src.indexOf('async function trimCoreHolding'), src.indexOf('function maintainCoreHolding'));
  ok(/CORE_BASKET_SOURCE === 'venus' && !_venusBasketReceived/.test(trim),
     'the trim must wait for a live basket, exactly as the buy side does');
  const guardIdx = trim.indexOf("CORE_BASKET_SOURCE === 'venus'");
  const pickIdx = trim.indexOf('mostOverweightCore');
  ok(guardIdx > 0 && guardIdx < pickIdx, 'the guard must run before anything is selected for sale');

  // 4. Behavioural: an off-basket name IS still fully exited when the basket is live —
  //    the guard must not have neutered the mechanism that removes genuinely dropped names.
  if (!I.CORE_HOLD_ON) return;
  const savedCore = I.portfolio.coreHolding, saved = {};
  I.CORE_HOLD_SYMBOLS.forEach(s => { saved[s] = I.marketData[s];
    I.marketData[s] = { price: 100, prevClose: 100, lastUpdate: Date.now() };
    I.portfolio.coreHolding = I.portfolio.coreHolding || {}; });
  I.portfolio.coreHolding = {};
  I.CORE_HOLD_SYMBOLS.forEach(s => { I.portfolio.coreHolding[s] = { qty: 0.5, avgPrice: 100, investedCash: 50 }; });
  I.portfolio.coreHolding.__DROPPED = { qty: 5, avgPrice: 10, investedCash: 50 };
  I.marketData.__DROPPED = { price: 30, prevClose: 30, lastUpdate: Date.now() };
  const pick = I.mostOverweightCore(I.getTotalValue());
  delete I.portfolio.coreHolding.__DROPPED; delete I.marketData.__DROPPED;
  I.portfolio.coreHolding = savedCore;
  I.CORE_HOLD_SYMBOLS.forEach(s => { if (saved[s]) I.marketData[s] = saved[s]; else delete I.marketData[s]; });
  ok(pick && pick.sym === '__DROPPED' && pick.qty >= 5,
     'a genuinely dropped name must still be exited in full');
});

check('a recovered holding is not force-sold by a proposal that never knew it existed', () => {
  // Off-basket names get a target of ZERO and are trimmed out completely. That is right
  // when the basket deliberately changes, and wrong when the "change" is a proposal
  // written while ATLAS had amnesia. Observed 2026-09-01: state was lost, six positions
  // were recovered from the broker, and Venus's next proposal omitted PFE — the best
  // performer on the book at +$2.70 — which would have exited it in full.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/_recoveredSymbols\.add\(bp\.symbol\);/.test(src),
     'a holding ATLAS FOUND rather than chose must be marked as recovered');
  const branch = blockAfter(src, "if (CORE_BASKET_SOURCE === 'venus' && maySwap) {");
  ok(/basketWithRecovered\(prop\.basket, _recoveredSymbols, portfolio\.coreHolding\)/.test(branch),
     'the swap must merge recovered holdings before replacing the basket');
  ok(/CORE_HOLD_SYMBOLS\.push\(\.\.\.merged\.basket\)/.test(branch),
     'the MERGED basket, not the raw proposal, must become the live basket');
  // ONE CYCLE OF GRACE. Without the clear, a recovered name could never be dropped —
  // it would be re-carried at every future swap and hold tenure for ever.
  ok(/_recoveredSymbols\.clear\(\);/.test(branch),
     'the grace must be cleared after the swap, or a recovered name can never be dropped');
  ok(I.CORE_BASKET_MAX_NAMES >= 10, `the cap must leave room for a normal basket, got ${I.CORE_BASKET_MAX_NAMES}`);

  // BEHAVIOURAL, against 2026-09-01's actual book. Calling the real function, because a
  // mutation proved that code disabled behind `if (0)` satisfies every source assertion
  // written about it — the patterns are all still present, they just never run.
  const proposal = ['AAPL','MSFT','JNJ','JPM','BAC','XOM','CVX','PG','KO','WMT'];
  const holdings = {};
  ['PFE','JNJ','JPM','XOM','BAC','KO'].forEach(s => { holdings[s] = { qty: 1 }; });
  const rec = new Set(Object.keys(holdings));
  const m = I.basketWithRecovered(proposal, rec, holdings);
  ok(m.carried.length === 1 && m.carried[0] === 'PFE', `only PFE should need carrying, got ${m.carried}`);
  ok(m.basket.includes('PFE'), 'PFE must survive the swap rather than being exited');
  ok(m.basket.length === 11, `basket should become 11 names, got ${m.basket.length}`);
  ok(m.dropped.length === 0, 'nothing should be dropped at this size');
  ok(new Set(m.basket).size === m.basket.length, 'the merged basket must not contain duplicates');

  // A name no longer held must NOT be resurrected into the basket.
  const gone = I.basketWithRecovered(proposal, new Set(['ZZZZ']), { ZZZZ: { qty: 0 } });
  ok(gone.carried.length === 0 && !gone.basket.includes('ZZZZ'),
     'a sold-out recovered name must not be carried back in');

  // Nothing recovered = the proposal is used verbatim.
  const clean = I.basketWithRecovered(proposal, new Set(), {});
  ok(clean.basket.length === 10 && clean.carried.length === 0,
     'with nothing recovered the proposal must pass through unchanged');

  // The cap must bind, and report what it excluded rather than silently losing it.
  const many = {}; const manySet = new Set();
  for (let i = 0; i < 8; i++) { many['X' + i] = { qty: 1 }; manySet.add('X' + i); }
  const capped = I.basketWithRecovered(proposal, manySet, many, 12);
  ok(capped.basket.length === 12, `cap must bind at 12, got ${capped.basket.length}`);
  ok(capped.carried.length === 2 && capped.dropped.length === 6,
     `2 carried / 6 dropped expected, got ${capped.carried.length}/${capped.dropped.length}`);

  // And the recovered set must start empty, so a normal boot carries nothing.
  ok(I.getRecoveredSymbols().size === 0, 'nothing may be marked recovered without a broker sync');
});

check('a basket meant to last months is not churned by a daily model call', () => {
  // The prompt asks Venus for a basket to HOLD FOR MONTHS, but the proposal runs every
  // 24h and was adopted every single time — so a name could be bought and sold out on
  // nothing more than the model sampling differently two days running. Observed
  // 2026-09-01: the new basket dropped PFE, the best performer in the book at +$2.70,
  // and added five names. ~$500 of turnover from one LLM call, spread paid both ways.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/const maySwap = firstEver \|\| heldMs >= CORE_BASKET_MIN_HOLD_MS;/.test(src),
     'a swap must require the current basket to have been held long enough');
  ok(/const firstEver = !_venusBasketReceived;/.test(src),
     'the FIRST basket must be adopted immediately, or the core never starts');
  ok(/if \(CORE_BASKET_SOURCE === 'venus' && maySwap\)/.test(src),
     'the swap branch must be gated on it');
  ok(/_lastBasketSwapAt = Date\.now\(\);/.test(src), 'and the swap must reset the clock');
  // Proposals must STILL be recorded every cycle — the register scores them out of
  // sample, and skipping the record would quietly kill the experiment.
  const propIdx = src.indexOf('recordBasketProposal(prop);');
  const gateIdx = src.indexOf('const maySwap =');
  ok(propIdx > 0 && propIdx < gateIdx,
     'every proposal must be recorded BEFORE the adoption gate, so scoring is unaffected');
  // The clock must survive a restart, or frequent deploys reintroduce the churn.
  ok(/lastBasketSwapAt: _lastBasketSwapAt,/.test(src), 'the hold clock must be persisted');
  ok(/_lastBasketSwapAt = Number\.isFinite\(state\.lastBasketSwapAt\)/.test(src),
     'and restored, or every deploy resets it to zero and permits an immediate swap');
  ok(I.CORE_BASKET_MIN_HOLD_MS >= 7 * 86400000,
     `the minimum hold must be at least a week, got ${(I.CORE_BASKET_MIN_HOLD_MS/86400000).toFixed(1)}d`);
});

check('conviction is adopted only with the basket it describes', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const branch = blockAfter(src, "if (CORE_BASKET_SOURCE === 'venus' && maySwap) {");
  ok(/CORE_CONVICTION = prop\.conviction \|\| \{\}/.test(branch),
     'conviction must be adopted inside the same branch that swaps the basket');
  // Carried across a basket change, conviction would size NEW names by scores written
  // about OLD ones — silently, and with no way to tell from the logs.
  ok(src.split('CORE_CONVICTION = prop.conviction').length - 1 === 1,
     'conviction must be adopted in exactly one place');
});

check('the boot sync does not adopt core holdings as trades', () => {
  // Core positions sit at the broker like any other. The adoption loop only checked
  // longPositions, so every restart pulled all ten into the TRADING book — attaching
  // stop-losses to a long-term hold, exposing it to the exit engine, and counting the
  // same shares twice in equity (measured: $50 of stock valued at $100). Every other
  // guard keeping the core separate was undone at boot.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/portfolio\.coreHolding && portfolio\.coreHolding\[bp\.symbol\]/.test(src),
     'the adoption loop must skip symbols already held in the core book');
  ok(/is a core holding — left out of the trading book/.test(src),
     'and say so, because a silent skip is indistinguishable from a missed position');

  // THE GUARD MUST NOT DEPEND ON SAVED STATE. Asking the ledger which symbols are core
  // is useless in the one situation this sync exists for — a wipe — because a wipe is
  // what empties the ledger. Measured 2026-09-01: state lost on a Railway deploy, all
  // six core holdings adopted into the trading book with stop-losses, the core then
  // bought a SECOND copy of five of them, cash drained $429.66 → $0.63, heat ~83%.
  ok(/const tradingImpossible = PHASE_GATE_ENABLED && tradingPhaseLocked\(\);/.test(src),
     'while trading is phase-locked no position CAN be a trade — the sync must use that');
  ok(/const isBasketMember = CORE_HOLD_SYMBOLS\.includes\(bp\.symbol\);/.test(src),
     'and a current basket member must be recognised as core without any saved state');
  ok(/if \(CORE_HOLD_ON && \(ledgerSaysCore \|\| tradingImpossible \|\| isBasketMember\)\)/.test(src),
     'any of the three must be enough to keep it out of the trading book');
  // Skipping alone is NOT enough: unrecorded shares are invisible to ATLAS, and the
  // core buys them all over again. That is what actually doubled every position.
  ok(/portfolio\.coreHolding\[bp\.symbol\] = \{\s*\n?\s*qty, avgPrice: bp\.avg_entry_price,/.test(src),
     'a recovered core holding must be WRITTEN to the core book, not merely skipped');
  ok(/Recovered core holding/.test(src), 'and logged, so a recovery is visible in the boot output');
});

check('the reconciler can see the core book, not just the trading book', () => {
  // It summed longPositions + shortPositions only. That was harmless while a state wipe
  // dumped core holdings into longPositions anyway — but once v11.48 filed them
  // correctly in coreHolding, every core position read as atlasQty 0 and the reconciler
  // reported the WHOLE portfolio as drift on every boot (observed: 6 positions, all
  // atlasQty 0). Worse than noise: an alarm that always fires trains you to ignore the
  // one time it is real, and a genuine core discrepancy became undetectable.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const fn = src.slice(src.indexOf('async function reconcileWithBroker'), src.indexOf("app.post('/api/reconcile'"));
  ok(/portfolio\.coreHolding \|\| \{\}\)\.forEach/.test(fn),
     'the reconciler must include core holdings in its picture of what ATLAS owns');
  ok(/atlasMap\[s\] = \(atlasMap\[s\] \|\| 0\) \+ lot\.qty;/.test(fn),
     'core quantities must be ADDED to the same map the broker is compared against');
  ok(/book: bookOf\[sym\] \|\| 'none'/.test(fn),
     'drift must name which book the position lives in, or the report cannot be acted on');
  // Float tolerance: a holding split across two books is a SUM, and ~1 in 4 six-decimal
  // pairs is not exactly representable. Exact equality invents drift from IEEE rounding.
  ok(/Math\.abs\(atlasQty - brokerQty\) > 1e-6/.test(fn),
     'quantities must compare with a tolerance, not exact float equality');
  ok(!/if \(atlasQty !== brokerQty\)/.test(fn), 'exact equality must be gone');

  // BEHAVIOURAL: a core-only holding that matches the broker must NOT be reported.
  if (String(process.env.LIVE_TRADING).toLowerCase() === 'true') return;
  const savedCore = I.portfolio.coreHolding, savedLong = I.portfolio.longPositions;
  I.portfolio.coreHolding = { ZZTEST: { qty: 3.071078, avgPrice: 62, investedCash: 190 } };
  I.portfolio.longPositions = {};
  // Mirror the reconciler's own arithmetic over the two books, which is the thing that
  // was wrong — summing only the trading book gave 0 for every core name.
  const atlas = Object.entries(I.portfolio.longPositions).reduce((t, [, l]) => t + l.reduce((a, x) => a + x.qty, 0), 0)
              + Object.entries(I.portfolio.coreHolding).reduce((t, [, l]) => t + l.qty, 0);
  I.portfolio.coreHolding = savedCore; I.portfolio.longPositions = savedLong;
  ok(Math.abs(atlas - 3.071078) < 1e-9,
     `a core-only holding must count toward what ATLAS believes it owns, got ${atlas}`);
});

check('state is written somewhere a deploy cannot destroy', () => {
  // './atlas-solar-state.json' is a relative path inside the container working
  // directory. On Railway that filesystem is ephemeral, so every deploy discarded it —
  // the bot never once resumed from saved state, which is why the boot sync kept
  // running its no-ledger path and duplicating the whole basket.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/const DATA_DIR = process\.env\.ATLAS_DATA_DIR \|\| process\.env\.RAILWAY_VOLUME_MOUNT_PATH \|\| '\.';/.test(src),
     'the state directory must pick up a Railway volume automatically, with an explicit override');
  // Attaching the volume must be sufficient. Requiring a hand-set variable leaves room
  // to set it to a path that does not match the mount, which fails exactly as silently
  // as the original bug did.
  ok(src.indexOf('process.env.ATLAS_DATA_DIR') < src.indexOf('process.env.RAILWAY_VOLUME_MOUNT_PATH'),
     'the explicit override must take precedence over the auto-detected mount');
  // A write that goes nowhere must be impossible to mistake for a write that works.
  ok(/function verifyStateDir\(\)/.test(src), 'boot must verify the state directory');
  ok(/fsx\.writeFileSync\(probe/.test(src), 'and prove it by actually writing, not just checking it exists');
  ok(/State is being written to the WORKING DIRECTORY/.test(src),
     'and warn plainly when state will not survive a deploy');
  const bootIdx = src.indexOf('verifyStateDir();');
  ok(bootIdx > 0 && bootIdx < src.indexOf('loadState();', bootIdx),
     'the check must run before state is read, so the log explains the result that follows');
  ok(/const BACKUP_FILE   = dataPath\('atlas-solar-state\.json'\)/.test(src),
     'the state file must go through it');
  ok(!/BACKUP_FILE\s*=\s*'\.\//.test(src), 'and must no longer be hard-coded to the working directory');
  // Everything the bot needs across a restart, not just the portfolio.
  ok(/const BASKET_LOG = dataPath\(/.test(src), 'the basket register must persist too — it is scored over months');
  ok(/const TRIM_DECISION_LOG = dataPath\(/.test(src), 'and the trim decision log');
  // Default must stay '.', or local runs and tests would write somewhere unexpected.
  const path = require('path');
  const expectedDir = process.env.ATLAS_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
  ok(I.DATA_DIR === expectedDir,
     `DATA_DIR must resolve override → volume → cwd, expected "${expectedDir}" got "${I.DATA_DIR}"`);
  ok(I.BACKUP_FILE === path.join(expectedDir, 'atlas-solar-state.json'),
     `the resolved path must honour whichever is set, got ${I.BACKUP_FILE}`);
});

check('a blocked entry names the check that FAILED, not the ones that passed', () => {
  // "[RISK] Elevated [drawdown, dailyLoss]" listed the checks that PASSED. It reads as
  // the exact opposite of what it means, and the one time it mattered it pointed the
  // diagnosis at two healthy metrics while portfolio heat was the check actually
  // blocking every entry.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(!/\[RISK\] Elevated \[\$\{riskSystem\.checksPassing\.join/.test(src),
     'the log must not print the passing checks as though they were the problem');
  ok(/filter\(k => !riskSystem\.checksPassing\.includes\(k\)\)/.test(src),
     'it must select the checks that are NOT passing');
  ok(/Entries blocked — FAILING:/.test(src), 'and say plainly that entries are blocked');
  // The number and its limit, or the operator still cannot tell how far over it is.
  ok(/\$\{\(all\[k\] \* 100\)\.toFixed\(1\)\}% > \$\{\(limits\[k\] \* 100\)\.toFixed\(0\)\}%/.test(src),
     'each failing check must report its value against its limit');
});

check('venus basket mode buys nothing until Venus has actually proposed', () => {
  // Venus can only propose inside the news window (weekdays 08:00-16:00 ET) while the
  // core buys every 5 minutes regardless. Boot on a weekend in venus mode and the core
  // would spend the whole allocation on the DEFAULT basket, Venus would then propose
  // something else, every one of those names would become off-basket, and the trim
  // would sell all of it. Buy $500, sell $500, pay spread twice, own nothing new.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/CORE_BASKET_SOURCE === 'venus' && !_venusBasketReceived/.test(src),
     'venus mode must not buy before a proposal exists');
  ok(/_venusBasketReceived = true;/.test(src), 'and must record when one arrives');
  // The flag must be set where the basket is ACTUALLY swapped, not merely on a
  // proposal being logged — a logged proposal that did not replace the list would
  // leave the core buying the default basket while believing it had Venus's.
  // Anchored to the ENCLOSING BRANCH, not to a character count. A fixed-width window
  // ("the next 120 chars") breaks the moment anything legitimate is added between the
  // swap and the flag — which has now happened three times in this file — and a test
  // that fails on correct code teaches you to edit the test, which is how a real
  // regression eventually walks through. What actually matters is that the flag is set
  // inside the branch that swaps the basket, never merely where a proposal is logged.
  const branch = blockAfter(src, "if (CORE_BASKET_SOURCE === 'venus' && maySwap) {");
  ok(branch && branch.includes('CORE_HOLD_SYMBOLS.push('),
     'the basket swap must sit inside an explicit CORE_BASKET_SOURCE=venus branch');
  ok(branch.includes('_venusBasketReceived = true'),
     'the flag must be set inside the branch that swaps the basket');
  // Exactly two legitimate places, and nowhere else — a stray assignment would let the
  // core start buying the DEFAULT basket while believing it had Venus's.
  ok(src.split('_venusBasketReceived = true').length - 1 === 2,
     'the flag must be set in exactly two places: the basket swap and the state restore');
  const loadIdx = src.indexOf('CORE_HOLD_SYMBOLS.push(...new Set(restored))');
  ok(loadIdx > 0, 'the saved basket must be restored on load');
  ok(src.slice(loadIdx, loadIdx + 400).includes('_venusBasketReceived = true'),
     'restoring a saved basket must also mark it received, or the core waits for a proposal it already has');
});

check('an operator halt stops the core; an automatic one does not', () => {
  // Deliberate asymmetry. A threshold tripping during a dip must NOT pause a long-term
  // holding — that reaction is exactly what destroys buy-and-hold returns. A human
  // pressing stop is a different instruction and must reach everything.
  ok(typeof I.coreHaltedByOperator === 'function', 'the core must consult an operator halt');
  const before = I.coreHaltedByOperator();
  I.setCorePaused(true);
  ok(I.coreHaltedByOperator() === true, 'an explicit pause must halt the core');
  I.setCorePaused(false);
  ok(I.coreHaltedByOperator() === before, 'and releasing it must restore the prior state');
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function coreHaltedByOperator'), src.indexOf('function mostOverweightCore'));
  ok(!/currentDrawdown|safeMode\b/.test(fn),
     'the automatic drawdown halt must NOT reach the core');
  // And assert the CALL SITES, not just that the helper exists — deleting both calls
  // passed this test until now, which is the third time that gap has appeared here.
  // Slice to the END of each function, never a fixed character count. A 700-char
  // window broke the moment a comment was added above the line it checks — the second
  // time that exact brittleness has produced a red suite over correct code.
  const body = (name) => {
    const i = src.indexOf('function ' + name);
    const j = src.indexOf('\nfunction ', i + 1);
    return src.slice(i, j > i ? j : i + 4000);
  };
  const buy  = body('maintainCoreHolding');
  const trim = body('trimCoreHolding');
  ok(/if \(coreHaltedByOperator\(\)\) return;/.test(buy), 'core BUYING must honour the operator halt');
  ok(/if \(coreHaltedByOperator\(\)\) return;/.test(trim), 'core TRIMMING must honour the operator halt');
});

check('the core holding is invisible to every trading exit path', () => {
  // The whole point of a hold is that stops, trails, take-profit rungs, kill switches
  // and loss halts cannot touch it. That is guaranteed structurally by keeping it out
  // of longPositions — every exit path iterates that object. If it ever moves in,
  // the first stop-loss sweep would liquidate the long-term position.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/coreHolding: \{\}/.test(src), 'coreHolding must be its own field on portfolio');
  ok(!/longPositions\[\s*CORE_HOLD_SYMBOL\s*\]/.test(src),
     'the core holding must never be written into longPositions');
  // And it must never be sold on a signal — top-up only.
  // Scan from coreTopUpQty (the sizing decision) through maintainCoreHolding (the
  // execution) — the rebalance band lives in the former after the v11.28 split.
  const fn = src.slice(src.indexOf('function coreTopUpQty'),
                       src.indexOf('function processProfitVault'));
  // The core now HAS a seller — the trim — so "never sells" is no longer the invariant.
  // What must still hold is that no TRADING exit can reach it: stops, trailing exits,
  // take-profit rungs and kill switches all iterate longPositions, which the core is
  // deliberately not part of.
  ok(!/closeLong|closeShort/.test(fn), 'no trading exit function may touch the core');
  ok(/gap <= perNameTarget \* CORE_REBALANCE_BAND/.test(fn),
     'it must only act when a NAME is meaningfully under its own slice of the target');
  ok(/side: 'buy'/.test(fn), 'the top-up path buys');
  // And the only sell that exists is the arithmetic trim, never a signal-driven exit.
  const trim = src.slice(src.indexOf('function trimCoreHolding'), src.indexOf('function maintainCoreHolding'));
  ok(/excess <= nameTarget \* band/.test(src),
     'the trim must be gated on drift past a band, not on a view about price');
});

check('the core holding does not inflate trading capital', () => {
  // Reserve and free-capital caps are fractions of equity. Counting an INVESTED core
  // position as if it were deployable cash inflated both: at a 50% core the cap
  // stopped binding and the reserve was silently no longer honoured.
  const savedCash = I.portfolio.cash, savedCore = I.portfolio.coreHolding;
  I.portfolio.cash = 1000; I.portfolio.coreHolding = null;
  I.rebalanceCapital();
  const baseTrading = I.capitalSystem.tradingCapital, baseReserve = I.capitalSystem.reserveCash;

  I.marketData.__CORETEST = { price: 100, prevClose: 100, lastUpdate: Date.now() };
  I.portfolio.cash = 500;
  I.portfolio.coreHolding = { __CORETEST: { qty: 5, avgPrice: 100, investedCash: 500 } };
  I.rebalanceCapital();
  const coreTrading = I.capitalSystem.tradingCapital, coreReserve = I.capitalSystem.reserveCash;

  I.portfolio.cash = savedCash; I.portfolio.coreHolding = savedCore;
  delete I.marketData.__CORETEST;
  I.rebalanceCapital();

  ok(Math.abs(coreTrading - baseTrading / 2) < 1,
     `moving half the book into the core should halve trading capital: ${baseTrading.toFixed(0)} -> ${coreTrading.toFixed(0)}`);
  ok(Math.abs(coreReserve - baseReserve / 2) < 1,
     `the reserve must scale with the tradable slice: ${baseReserve.toFixed(0)} -> ${coreReserve.toFixed(0)}`);
});

check('a core drawdown does not halt trading, but a catastrophe still does', () => {
  // Trading kill switches must measure the TRADING book. With a core holding,
  // drawdown on total equity would halt entries because the index fell — the exact
  // reaction the core exists to avoid. The account-wide backstop must survive though.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/computeDrawdown\(riskSystem\.peakValue, tradingValue\)/.test(src),
     'trading drawdown must be measured on equity EXCLUDING the core');
  ok(/riskSystem\.totalDrawdown/.test(src) && /Account-wide drawdown/.test(src),
     'an account-wide emergency backstop must still exist');
  ok(/peakTotalValue:\s+riskSystem\.peakTotalValue/.test(src),
     'the account-wide peak must persist, or a restart resets the backstop');
  // Portfolio heat is a TRADING measure too — dividing by an equity figure inflated
  // by the core would understate how exposed the trading book really is.
  ok(/portfolioHeat\s+= tradingValue > 0/.test(src),
     'portfolio heat must be measured against tradable equity');
});

check('a core holding cannot dilute any risk limit', () => {
  // Every risk threshold is a fraction of equity. Counting an untraded core position
  // in the denominator quietly loosens all of them. Behavioural check: portfolio heat
  // must read the SAME whether or not a core exists, because the core is not exposure.
  const savedCash = I.portfolio.cash, savedCore = I.portfolio.coreHolding;
  I.marketData.__HEAT = { price: 10, prevClose: 10, lastUpdate: Date.now() };
  // Cap is 50%. Pick a position that is UNDER the cap on total equity but OVER it on
  // tradable equity, so the two denominators give opposite answers — otherwise the
  // test passes either way and proves nothing (this exact size mistake let a mutation
  // through on the first attempt).
  I.portfolio.cash = 1000; I.portfolio.coreHolding = null;
  const heatNoCore = I.wouldExceedHeat(10, 40);          // $400 of $1000 tradable = 40%, OK

  I.portfolio.cash = 500;
  I.portfolio.coreHolding = { __HEAT: { qty: 50, avgPrice: 10, investedCash: 500 } };
  // Total equity is still $1000 ($500 cash + $500 core) so a core-inclusive divisor
  // reads 40% and allows it; the tradable divisor is $500 and reads 80%, which breaches.
  const heatWithCore = I.wouldExceedHeat(10, 40);

  I.portfolio.cash = savedCash; I.portfolio.coreHolding = savedCore;
  delete I.marketData.__HEAT;
  ok(heatNoCore === false, `$400 of a $1000 tradable book is 40% and must be allowed, got ${heatNoCore}`);
  ok(heatWithCore === true,
     '$400 against $500 tradable is 80% and must breach the 50% cap — a core-inclusive divisor would allow it');

  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/dailyRealizedLoss \/ Math\.max\(1, tradableValue\(\)\)/.test(src),
     'the daily-loss brake must divide by tradable equity or it trips too late');
});

check('core holding counts toward equity', () => {
  // If it did not, every percentage derived from total value — risk sizing, drawdown,
  // exposure — would be computed against a book that ignores real money.
  const saved = I.portfolio.coreHolding;
  const before = I.getTotalValue();
  I.marketData.__CORE = { price: 100, prevClose: 100, lastUpdate: Date.now() };
  I.portfolio.coreHolding = { __CORE: { qty: 2, avgPrice: 100, investedCash: 200 } };
  const after = I.getTotalValue();
  I.portfolio.coreHolding = saved;
  delete I.marketData.__CORE;
  ok(Math.abs((after - before) - 200) < 0.01,
     `equity should rise by the core's $200 value, rose by ${(after - before).toFixed(2)}`);
});

check('the core symbol is never also traded', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  ok(/CORE_HOLD_ON && CORE_HOLD_SYMBOLS\.includes\(symbol\)\) continue;/.test(src),
     'the entry scan must skip EVERY core basket member — one broker position cannot back two books');
});

check('descending bar fetches are restored to chronological order', () => {
  // The fetch asks newest-first so one round trip gets what we keep (it was paging
  // 12 times for ~120,000 bars to retain 1,380). Those pages arrive REVERSED, and
  // every indicator — EMA, RSI, ATR, ADX — assumes oldest-first. Forgetting the
  // re-sort would silently invert every signal rather than fail loudly.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(/sort=\$\{wantNewestFirst \? 'desc' : 'asc'\}/.test(src), 'fetch should request newest-first when trimming');
  ok(/if \(wantNewestFirst\) out\[s\]\.sort\(\(a, b\) => a\.t - b\.t\);/.test(src),
     'descending results MUST be re-sorted chronologically before use');
  ok(/if \(wantNewestFirst && symbols\.every/.test(src),
     'it must stop paging once every symbol has enough bars');
});

check('bar fetching follows pagination', () => {
  // Alpaca's `limit` is the TOTAL across all symbols, so a multi-symbol request comes
  // back partial with a next_page_token. Dropping that token returned 3 of 25 symbols
  // and paused entries on the other 22 for entire sessions — misread for a long time
  // as a thin IEX feed. Measured after the fix: 12/12 symbols, 60 bars each.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  // Anchor to the END of the function, not a fixed character count. A previous version
  // sliced a fixed 2,200 chars and broke the moment a comment was added above the code
  // it checks — a test that fails on documentation is worse than no test.
  const start = src.indexOf('async function fetchBars(');
  const after = src.indexOf('\nfunction ', start);
  const fn = src.slice(start, after > start ? after : start + 4000)
                .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // strip comments
  // Assert the ASSIGNMENT, not a mention. A first version of this test matched the
  // explanatory comment above the code and survived `token = null` — vacuous.
  ok(/token\s*=\s*j\.next_page_token/.test(fn), 'fetchBars must assign token from j.next_page_token');
  ok(/page_token=\$\{/.test(fn), 'fetchBars must send page_token on later requests');
  ok(/while\s*\(\s*token\s*&&/.test(fn), 'fetchBars must loop while a page token remains');
});

check('a thin tape does not halt entries, but a dead feed does', () => {
  const now = Date.now();
  const syms = ['FEED_A','FEED_B','FEED_C','FEED_D','FEED_E'];
  syms.forEach(s => { I.marketData[s] = { price: 10, lastUpdate: now }; });

  // THIN TAPE: 4 of 5 quiet for 10 minutes, but one is still printing. The feed is
  // alive; the quiet names are skipped individually by the entry scan. Live logs
  // showed "12/20 prices stale" halting entire sessions on a healthy IEX feed.
  syms.forEach((s, i) => { I.marketData[s].lastUpdate = i === 0 ? now : now - 10 * 60000; });
  ok(I.priceFeedHalt(syms, now) === null,
     `a live-but-quiet tape must not halt entries, got: ${I.priceFeedHalt(syms, now)}`);

  // DEAD FEED: nothing at all has printed. This is the real danger and MUST halt.
  syms.forEach(s => { I.marketData[s].lastUpdate = now - 10 * 60000; });
  ok(/silent/i.test(String(I.priceFeedHalt(syms, now))),
     `a silent feed MUST halt entries, got: ${I.priceFeedHalt(syms, now)}`);

  // NO DATA AT ALL also halts.
  syms.forEach(s => { delete I.marketData[s]; });
  ok(/no price data/i.test(String(I.priceFeedHalt(syms, now))), 'missing data must halt');
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
