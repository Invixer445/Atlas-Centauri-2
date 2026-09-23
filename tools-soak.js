// Adversarial soak: drive the real engine functions with hostile market data and look
// for throws, NaN leaking into persisted state, or unbounded growth.
// ── FAKE CLOCK: a Wednesday at 11:00 ET, advancing 2s a tick ───────────────
// Without this the soak proves nothing: evaluateAndTrade returns at its second line
// when the session is shut, and mercuryTick only records while the market is open.
let FAKE = Date.UTC(2026, 8, 23, 15, 0, 0);   // 2026-09-23 15:00Z = 11:00 ET, Wednesday
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FAKE); else super(...a); }
  static now() { return FAKE; }
};
global.Date.UTC = RealDate.UTC; global.Date.parse = RealDate.parse;
global.__advance = (ms) => { FAKE += ms; };

process.env.CORE_HOLD_FRACTION = '0.5';
process.env.LIVE_TRADING = 'false';
const I = require('/Users/bredl/Downloads/ATLAS/server.js')._internals;

let R = 12345;
const rnd = () => (R = (R * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];

const SYMS = [...I.WATCHLISTS.nasdaq, ...I.WATCHLISTS.nyse].slice(0, 26);
const HOSTILE = [0, -1, NaN, Infinity, -Infinity, 1e-9, 1e12, null, undefined];

function seed(sym, hostile) {
  const n = 70;
  const path = []; let p = 20 + rnd() * 400;
  for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.02; path.push(p); }
  const md = {
    price: path[n - 1], prevClose: path[30], high: Math.max(...path), low: Math.min(...path),
    dailyVolume: Math.floor(rnd() * 2e7), lastUpdate: Date.now() - Math.floor(rnd() * 300000),
    lastTradeTime: Date.now(), history: path,
  };
  if (hostile) {
    const f = pick(['price', 'prevClose', 'high', 'low', 'dailyVolume', 'lastUpdate']);
    md[f] = pick(HOSTILE);
    if (rnd() < 0.2) md.history = pick([[], [NaN, NaN], null, [0, 0, 0]]);
  }
  I.marketData[sym] = md;
  const bars = path.map((c, i) => ({
    t: Date.now() - (n - i) * 60000, o: c, h: c * 1.004, l: c * 0.996, c, v: Math.floor(rnd() * 50000),
  }));
  if (hostile && rnd() < 0.3) {
    const j = Math.floor(rnd() * bars.length);
    bars[j] = pick([{ t: 0, o: 0, h: 0, l: 0, c: 0, v: 0 }, { t: 1, o: NaN, h: NaN, l: NaN, c: NaN, v: NaN }, null]);
  }
  I.candleData[sym] = { m1: bars.filter(Boolean), m5: bars.filter(Boolean).slice(-36) };
}

function scanNaN(obj, path = '', seen = new Set(), out = []) {
  if (obj === null || typeof obj !== 'object') return out;
  if (seen.has(obj)) return out; seen.add(obj);
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${p} = ${v}`);
    else if (v && typeof v === 'object') scanNaN(v, p, seen, out);
  }
  return out;
}

const errors = new Map();
const note = (where, e) => {
  const k = `${where}: ${e && e.message ? e.message : e}`;
  errors.set(k, (errors.get(k) || 0) + 1);
};

const TICKS = parseInt(process.argv[2] || '3000', 10);
let maxOpen = 0, maxDecisions = 0;

for (let tick = 0; tick < TICKS; tick++) {
  global.__advance(2000);
  const hostile = tick % 3 === 0;
  for (const s of SYMS) seed(s, hostile && rnd() < 0.4);
  I.spyData.price = hostile && rnd() < 0.2 ? pick(HOSTILE) : 400 + rnd() * 100;
  I.spyData.prevClose = 400 + rnd() * 100;

  // Randomly open and close positions so the exit paths get exercised.
  if (rnd() < 0.3) {
    const s = pick(SYMS); const px = I.marketData[s]?.price;
    if (px > 0 && !I.portfolio.longPositions[s]) {
      I.portfolio.longPositions[s] = [{
        qty: +(rnd() * 20).toFixed(4), entryPrice: px * (0.8 + rnd() * 0.4),
        highestPnL: rnd() * 0.2, openedAt: Date.now() - Math.floor(rnd() * 1e7),
        atrFrac: 0.005 + rnd() * 0.05, partialsTaken: {},
      }];
    }
  }
  if (rnd() < 0.1) {
    const k = Object.keys(I.portfolio.longPositions); if (k.length) delete I.portfolio.longPositions[pick(k)];
  }
  I.portfolio.cash = Math.max(0, 300 + rnd() * 9000);

  try { typeof I.computeMarketBreadth==="function"&&I.computeMarketBreadth(); } catch (e) { note('computeMarketBreadth', e); }
  try { typeof I.updateSymbolMetrics==="function"&&I.updateSymbolMetrics(); } catch (e) { note('updateSymbolMetrics', e); }
  try { typeof I.updateLearning==="function"&&I.updateLearning(); } catch (e) { note('updateLearning', e); }
  try { typeof I.mercuryTick==="function"&&I.mercuryTick(); } catch (e) { note('mercuryTick', e); }
  try { typeof I.mercuryExitPass==="function"&&I.mercuryExitPass(); } catch (e) { note('mercuryExitPass', e); }
  try { typeof I.evaluateAndTrade==="function"&&I.evaluateAndTrade(); } catch (e) { note('evaluateAndTrade', e); }
  try { typeof I.rebalanceCapital==="function"&&I.rebalanceCapital(); } catch (e) { note('rebalanceCapital', e); }
  try { typeof I.processProfitVault==="function"&&I.processProfitVault(); } catch (e) { note('processProfitVault', e); }
  try { typeof I.maintainCoreHolding==="function"&&I.maintainCoreHolding(); } catch (e) { note('maintainCoreHolding', e); }
  try { typeof I.coreBuyStep==="function"&&I.coreBuyStep(); } catch (e) { note('coreBuyStep', e); }
  try { for (const s of SYMS) I.mercury.forecast(s, { record: true }); I.mercury.sweep(); } catch (e) { note('forecast', e); }
  try { typeof I.desiredWsSymbols==="function"&&I.desiredWsSymbols(); typeof I.syncWsSubscription==="function"&&I.syncWsSubscription(); } catch (e) { note('wsSync', e); }
  try { typeof I.buildIntelSummary==="function"&&I.buildIntelSummary(); } catch (e) { note('buildIntelSummary', e); }

  maxOpen = Math.max(maxOpen, Object.keys(I.mercury.getOpen()).length);
  maxDecisions = Math.max(maxDecisions, I.getMercuryDecisions().length);

  if (tick % 500 === 499) {
    let blob = null;
    try { blob = typeof I.buildStateObject==="function"&&I.buildStateObject(); } catch (e) { note('buildStateObject', e); }
    if (blob) {
      const bad = scanNaN(blob);
      if (bad.length) note('NaN in persisted state', new Error(bad.slice(0, 4).join(' | ')));
      try { JSON.parse(JSON.stringify(blob)); } catch (e) { note('state not serialisable', e); }
    }
  }
}

console.log(`\nSOAK: ${TICKS} ticks (every 3rd with hostile data)`);
console.log(`  mercury open predictions peak : ${maxOpen}`);
console.log(`  decision log peak             : ${maxDecisions} (cap 200)`);
console.log(`  ledger                        : ${I.mercury.getLedger().length} (cap 4000)`);
console.log(`  closedTrades                  : ${I.portfolio.closedTrades.length}`);
console.log(`  trades                        : ${I.portfolio.trades.length}`);
const blob = typeof I.buildStateObject==="function"&&I.buildStateObject();
console.log(`  state size                    : ${(JSON.stringify(blob).length / 1024).toFixed(1)} KB`);
const bad = scanNaN(blob);
console.log(`  non-finite numbers in state   : ${bad.length}${bad.length ? ' -> ' + bad.slice(0, 6).join(' | ') : ''}`);
console.log(`\n  DISTINCT ERRORS: ${errors.size}`);
for (const [k, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) console.log(`    x${n}  ${k}`);
typeof I.cancelPendingSave==="function"&&I.cancelPendingSave();
process.exit(0);
