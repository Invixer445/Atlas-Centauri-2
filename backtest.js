#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — backtest.js  ·  does this strategy actually make money?
//
//  Replays historical 1-minute bars through the REAL decision functions exported
//  by server.js — evaluateStrategyGate, buildTradePlan, terraValidateTrade, the
//  ATR exit geometry, and the v11.20 net-of-cost economics — and reports
//  expectancy, win rate, profit factor and max drawdown.
//
//  WHY IT REUSES server.js RATHER THAN REIMPLEMENTING:
//  a backtest that re-codes the strategy tests the re-code, not the bot. Every
//  entry decision here goes through the same gate the live engine uses, so a
//  result that looks good here is a statement about the actual bot.
//
//  WHAT IT IS NOT: a promise. It is an out-of-sample-free, single-path replay on
//  past data with modelled costs. Real fills, real spreads and real queue position
//  will all be worse. Treat a positive result as "worth paper-trading", never as
//  "this will earn money".
//
//  USAGE
//    node backtest.js                      last 5 trading days, core watchlist
//    node backtest.js --days 20            longer window (Alpaca free tier: ~2y)
//    node backtest.js --symbols PLTR,MARA  specific names
//    node backtest.js --capital 1000       starting equity
//    node backtest.js --costs 0            turn costs OFF to isolate their impact
//    node backtest.js --verbose            print every trade
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const engine = require('./server.js');
const I = engine._internals;

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes(n);
if (flag('--help') || flag('-h')) {
  console.log(require('fs').readFileSync(__filename, 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const DAYS     = Math.max(1, Math.min(60, parseInt(arg('--days', '5'), 10)));
const CAPITAL  = Math.max(100, parseFloat(arg('--capital', '1000')));
const VERBOSE  = flag('--verbose');
const COSTS_ON = arg('--costs', '1') !== '0';
const SYMBOLS  = arg('--symbols', 'PLTR,SOFI,MARA,HOOD,SOUN,IONQ,RKLB,BBAI,HIMS,CIFR,F,BAC,JPM,WFC,GE,XOM,MRK,JNJ,PFE,KO')
                  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const KEY = process.env.APCA_API_KEY_ID, SEC = process.env.APCA_API_SECRET_KEY;
if (!KEY || !SEC) { console.error('✖ Set APCA_API_KEY_ID / APCA_API_SECRET_KEY (paper keys work).'); process.exit(1); }
const FEED = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();

const https = require('https');
function get(path) {
  return new Promise(res => {
    const req = https.request({ host: 'data.alpaca.markets', path, method: 'GET',
      headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, Accept: 'application/json' } },
      r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
    req.on('error', () => res(null));
    req.setTimeout(30000, () => { req.destroy(); res(null); });
    req.end();
  });
}

// ── fetch history (paged) ────────────────────────────────────────────────────
async function fetchBars(sym, startISO, endISO) {
  const out = []; let token = null;
  do {
    const q = `symbols=${sym}&timeframe=1Min&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}` +
              `&limit=10000&adjustment=raw&feed=${FEED}&sort=asc` + (token ? `&page_token=${token}` : '');
    const j = await get(`/v2/stocks/bars?${q}`);
    const arr = (j && j.bars && j.bars[sym]) || [];
    for (const b of arr) {
      if (b.h > 0 && b.l > 0 && b.c > 0) {
        out.push({ t: Math.floor(new Date(b.t).getTime() / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }
    token = j && j.next_page_token;
  } while (token);
  return out;
}

// ── metrics ──────────────────────────────────────────────────────────────────
function report(trades, equityCurve, startCap) {
  const n = trades.length;
  if (!n) { console.log('\nNo trades were taken. Nothing to measure.\n'); return null; }
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgW = wins.length ? gw / wins.length : 0, avgL = losses.length ? gl / losses.length : 0;
  const wr = wins.length / n;
  const expectancy = avgW * wr - avgL * (1 - wr);
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  let peak = -Infinity, maxDD = 0;
  for (const e of equityCurve) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / (peak || 1)); }
  const totalCost = trades.reduce((s, t) => s + (t.cost || 0), 0);

  const pct = x => (x * 100).toFixed(1) + '%';
  const usd = x => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
  console.log('\n' + '═'.repeat(64));
  console.log('  RESULT');
  console.log('═'.repeat(64));
  console.log(`  Trades                ${n}   (${wins.length}W / ${losses.length}L)`);
  console.log(`  Win rate              ${pct(wr)}`);
  console.log(`  Avg win / avg loss    ${usd(avgW)} / ${usd(avgL)}`);
  console.log(`  Realised R:R          ${avgL > 0 ? (avgW / avgL).toFixed(2) : 'n/a'}`);
  console.log(`  EXPECTANCY per trade  ${usd(expectancy)}   <-- the number that matters`);
  console.log(`  Profit factor         ${pf === Infinity ? '∞' : pf.toFixed(2)}   (>1 makes money)`);
  console.log(`  Net P&L               ${usd(net)}  on ${usd(startCap)} = ${pct(net / startCap)}`);
  console.log(`  Max drawdown          ${pct(maxDD)}`);
  console.log(`  Paid in costs         ${usd(totalCost)}   (${net !== 0 ? (totalCost / Math.abs(net)).toFixed(1) : '—'}x the net result)`);
  console.log('═'.repeat(64));
  const verdict = expectancy > 0 && pf > 1.1
    ? '  ✅ POSITIVE expectancy on this sample. Worth paper-trading — not proof.'
    : expectancy > 0
      ? '  ⚠️  Barely positive. Inside noise for this sample size; do not size up.'
      : '  ❌ NEGATIVE expectancy. This configuration loses money. Do not run it live.';
  console.log(verdict);
  console.log('═'.repeat(64) + '\n');
  return { n, wr, expectancy, pf, net, maxDD, totalCost };
}

// ── one replay pass ──────────────────────────────────────────────────────────
// cfg: { stopMult, targetMult, trailMult, trailArmR, costsOn }
//   trailArmR = how much profit (in R, i.e. multiples of the stop) must be banked
//               before the trailing stop is allowed to arm at all.
function replay(hist, usable, cfg, capital, verbose = false) {
  const S = I.STRATEGY;
  const savedStop = S.ATR_STOP_MULT, savedTgt = S.ATR_TARGET_MULT;
  S.ATR_STOP_MULT = cfg.stopMult; S.ATR_TARGET_MULT = cfg.targetMult;   // buildTradePlan reads these

  let cash = capital;
  const open = {}, trades = [], equity = [capital];
  const rej = { strategyGate:0, sizeBelow1:0, notionalCap:0, netRR:0, targetCost:0, grossRR:0, maxPositions:0, accepted:0 };
  const netRRSamples = [], costSamples = [], atrSamples = [];

  const times = [...new Set(usable.flatMap(s => hist[s].map(b => b.t)))].sort((a, b) => a - b);
  const idx = {}; usable.forEach(s => idx[s] = 0);

  for (const t of times) {
    for (const sym of usable) {
      const bars = hist[sym];
      while (idx[sym] < bars.length && bars[idx[sym]].t <= t) idx[sym]++;
      const upto = idx[sym];
      if (upto < 30) continue;
      const bar = bars[upto - 1];
      if (bar.t !== t) continue;

      const window = bars.slice(Math.max(0, upto - 60), upto);
      I.candleData[sym] = { m1: window, m5: [] };
      I.marketData[sym] = {
        price: bar.c, prevClose: window[0].o, dayOpen: window[0].o,
        high: Math.max(...window.map(b => b.h)), low: Math.min(...window.map(b => b.l)),
        dailyVolume: window.reduce((s, b) => s + (b.v || 0), 0),
        lastUpdate: Date.now(), lastTradeTime: Date.now(),
        history: window.map(b => b.c).slice(-60)
      };

      const pos = open[sym];
      if (pos) {
        const pnlPct = pos.dir === 'LONG' ? (bar.c - pos.entry) / pos.entry
                                          : (pos.entry - bar.c) / pos.entry;
        pos.peak = Math.max(pos.peak, pnlPct);
        const a = pos.atrFrac;
        const stopPct = cfg.stopMult * a;
        const armAt   = cfg.trailArmR * stopPct;          // profit needed before trailing starts
        const giveBack= cfg.trailMult * a;
        const tgtPct  = cfg.targetMult * a;
        let exit = null;
        if (pnlPct <= -stopPct)                                        exit = 'stop';
        else if (pnlPct >= tgtPct)                                     exit = 'target';
        else if (pos.peak >= armAt && pnlPct <= pos.peak - giveBack)   exit = 'trail';
        if (exit) {
          const costPct = cfg.costsOn ? pos.cost : 0;
          const netPct  = pnlPct - costPct;
          const pnl     = netPct * pos.entry * pos.qty;
          cash += pnl;
          trades.push({ sym, dir: pos.dir, exit, pnl, netPct, cost: costPct * pos.entry * pos.qty });
          equity.push(cash);
          if (verbose) console.log(`    ${exit.padEnd(6)} ${pos.dir} ${sym.padEnd(5)} ${(netPct*100).toFixed(2).padStart(7)}%  ${pnl>=0?'+':''}${pnl.toFixed(2)}`);
          delete open[sym];
        }
        continue;
      }

      if (Object.keys(open).length >= 8) { rej.maxPositions++; continue; }
      const gate = I.evaluateStrategyGate(sym, I.marketData[sym]);
      if (!gate.longGate && !gate.shortGate) { rej.strategyGate++; continue; }
      const dir = gate.longGate ? 'LONG' : 'SHORT';

      const plan = I.buildTradePlan(sym, dir, bar.c, 5, 'backtest');
      const stopDist = plan.stop.frac * bar.c;
      let qty = Math.max(0, Math.floor((cash * S.RISK_PER_TRADE_BASE) / (stopDist || 1e9)));
      const maxShares = Math.floor((cash * 0.60) / bar.c);
      if (qty > maxShares) { rej.notionalCap++; qty = maxShares; }
      if (qty < 1) { rej.sizeBelow1++; continue; }

      if (cfg.costsOn) {
        if (plan.netRewardRisk < S.MIN_RR_NET) {
          rej.netRR++; netRRSamples.push(plan.netRewardRisk); costSamples.push(plan.cost); atrSamples.push(plan.atrFrac); continue;
        }
        if (plan.targetCostRatio < S.MIN_TARGET_COST_RATIO) { rej.targetCost++; continue; }
      }
      if (plan.rewardRisk < S.MIN_RR) { rej.grossRR++; continue; }
      rej.accepted++;
      open[sym] = { dir, entry: bar.c, qty, atrFrac: plan.atrFrac, peak: 0, cost: plan.cost };
    }
  }

  S.ATR_STOP_MULT = savedStop; S.ATR_TARGET_MULT = savedTgt;   // restore
  return { trades, equity, rej, netRRSamples, costSamples, atrSamples };
}

function metrics(trades, equity, startCap) {
  const n = trades.length;
  if (!n) return { n:0, wr:0, expectancy:0, pf:0, net:0, maxDD:0, totalCost:0, avgW:0, avgL:0 };
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s,t)=>s+t.pnl,0), gl = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const avgW = wins.length ? gw/wins.length : 0, avgL = losses.length ? gl/losses.length : 0;
  const wr = wins.length/n;
  let peak=-Infinity, maxDD=0;
  for (const e of equity) { peak=Math.max(peak,e); maxDD=Math.max(maxDD,(peak-e)/(peak||1)); }
  return { n, wr, expectancy: avgW*wr - avgL*(1-wr), pf: gl>0?gw/gl:(gw>0?Infinity:0),
           net: trades.reduce((s,t)=>s+t.pnl,0), maxDD, avgW, avgL,
           totalCost: trades.reduce((s,t)=>s+(t.cost||0),0) };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async function main() {
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 24 * 3600 * 1000 * 1.6);
  console.log(`\n🔬  ATLAS backtest — ${SYMBOLS.length} symbols, ~${DAYS} trading days, feed=${FEED}, costs ${COSTS_ON?'ON':'OFF'}`);
  console.log(`    ${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)}`);

  const hist = {};
  for (const s of SYMBOLS) {
    process.stdout.write(`    fetching ${s} … `);
    hist[s] = await fetchBars(s, start.toISOString(), end.toISOString());
    console.log(`${hist[s].length} bars`);
  }
  const usable = SYMBOLS.filter(s => hist[s].length >= 60);
  if (!usable.length) { console.error('\n✖ Not enough bars. Try --days 20 or a paid sip feed.\n'); process.exit(1); }

  const S = I.STRATEGY;
  if (arg('--minrr', null)) S.MIN_RR_NET = parseFloat(arg('--minrr'));
  if (arg('--tcr', null))   S.MIN_TARGET_COST_RATIO = parseFloat(arg('--tcr'));
  const base = { stopMult: S.ATR_STOP_MULT, targetMult: S.ATR_TARGET_MULT,
                 trailMult: S.ATR_TRAIL_MULT, trailArmR: 1.0, costsOn: COSTS_ON };

  if (flag('--sweep')) {
    // Search the exit geometry. The live default arms the trail at 1R and gives back
    // 0.91R, so a winner that peaks at 1R exits at ~0.09R while every loser costs a
    // full 1R — which is exactly why realised R:R (0.64) collapsed vs planned (2.09).
    console.log('\n  Sweeping exit geometry (stop fixed at 2.2xATR)…\n');
    const rows = [];
    for (const targetMult of [3.0, 4.6, 6.0])
      for (const trailMult of [0.8, 1.2, 2.0])
        for (const trailArmR of [1.0, 1.5, 2.5, 99]) {     // 99 = trail effectively off
          const cfg = { ...base, targetMult, trailMult, trailArmR };
          const r = replay(hist, usable, cfg, CAPITAL);
          rows.push({ targetMult, trailMult, trailArmR, ...metrics(r.trades, r.equity, CAPITAL) });
        }
    // Rank only configs that actually traded — a zero-trade config scores $0.00
    // expectancy and would otherwise sort above every genuinely-tested losing one.
    rows.sort((a,b) => (b.n?b.expectancy:-1e9) - (a.n?a.expectancy:-1e9));
    console.log('  tgt   trail  armAt   trades   win%    expectancy      PF     net%   maxDD');
    console.log('  ' + '─'.repeat(72));
    for (const r of rows.slice(0, 14)) {
      console.log('  ' + String(r.targetMult).padEnd(6) + String(r.trailMult).padEnd(7) +
        (r.trailArmR===99?'off':r.trailArmR+'R').padEnd(8) + String(r.n).padStart(5) +
        (r.wr*100).toFixed(0).padStart(8) + '%' + ('$'+r.expectancy.toFixed(2)).padStart(13) +
        (r.pf===Infinity?'∞':r.pf.toFixed(2)).padStart(8) +
        ((r.net/CAPITAL*100).toFixed(1)+'%').padStart(9) + ((r.maxDD*100).toFixed(0)+'%').padStart(7));
    }
    console.log('  ' + '─'.repeat(72));
    const best = rows[0];
    console.log(best.expectancy > 0
      ? `\n  Best on this sample: target ${best.targetMult}xATR, trail ${best.trailMult}xATR armed at ${best.trailArmR===99?'never':best.trailArmR+'R'}\n  → expectancy $${best.expectancy.toFixed(2)}/trade, PF ${best.pf.toFixed(2)}, ${(best.net/CAPITAL*100).toFixed(1)}% over the window.\n  This is ONE sample. Re-run on a different window before believing it.\n`
      : '\n  ❌ No configuration in this grid is profitable on this sample.\n');
    process.exit(0);
  }

  const r = replay(hist, usable, base, CAPITAL, VERBOSE);
  const med = a => a.length ? [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)] : null;
  console.log('\n' + '─'.repeat(64));
  console.log('  ENTRY FUNNEL');
  console.log('─'.repeat(64));
  const tot = Object.values(r.rej).reduce((a,b)=>a+b,0);
  for (const [k,v] of Object.entries(r.rej)) if (v) console.log('  '+k.padEnd(16)+String(v).padStart(9)+'  '+(v/tot*100).toFixed(1)+'%');
  if (r.netRRSamples.length) {
    console.log('  median net R:R rejected : '+med(r.netRRSamples).toFixed(2)+'  (need >= '+S.MIN_RR_NET+')');
    console.log('  median round-trip cost  : '+(med(r.costSamples)*100).toFixed(2)+'%');
    console.log('  median ATR              : '+(med(r.atrSamples)*100).toFixed(2)+'%');
  }
  console.log('─'.repeat(64));

  const m = metrics(r.trades, r.equity, CAPITAL);
  const usd = x => (x<0?'-$':'$')+Math.abs(x).toFixed(2);
  const pct = x => (x*100).toFixed(1)+'%';
  if (!m.n) { console.log('\nNo trades were taken.\n'); process.exit(0); }
  const byExit = {}; r.trades.forEach(t => byExit[t.exit] = (byExit[t.exit]||0)+1);
  console.log('\n' + '═'.repeat(64));
  console.log('  RESULT');
  console.log('═'.repeat(64));
  console.log(`  Trades                ${m.n}   (${Math.round(m.wr*m.n)}W / ${m.n-Math.round(m.wr*m.n)}L)`);
  console.log(`  Exits                 ${JSON.stringify(byExit)}`);
  console.log(`  Win rate              ${pct(m.wr)}`);
  console.log(`  Avg win / avg loss    ${usd(m.avgW)} / ${usd(m.avgL)}`);
  console.log(`  Realised R:R          ${m.avgL>0?(m.avgW/m.avgL).toFixed(2):'n/a'}`);
  console.log(`  EXPECTANCY per trade  ${usd(m.expectancy)}   <-- the number that matters`);
  console.log(`  Profit factor         ${m.pf===Infinity?'∞':m.pf.toFixed(2)}   (>1 makes money)`);
  console.log(`  Net P&L               ${usd(m.net)} on ${usd(CAPITAL)} = ${pct(m.net/CAPITAL)}`);
  console.log(`  Max drawdown          ${pct(m.maxDD)}`);
  console.log(`  Paid in costs         ${usd(m.totalCost)}`);
  console.log('═'.repeat(64));
  console.log(m.expectancy > 0 && m.pf > 1.1 ? '  ✅ POSITIVE expectancy on this sample. Worth paper-trading — not proof.'
    : m.expectancy > 0 ? '  ⚠️  Barely positive — inside noise. Do not size up.'
    : '  ❌ NEGATIVE expectancy. This configuration loses money. Do not run it live.');
  console.log('═'.repeat(64) + '\n');
  process.exit(0);
})();
