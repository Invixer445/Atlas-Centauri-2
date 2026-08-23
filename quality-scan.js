#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — quality-scan.js  ·  can the bot tell a good setup from a bad one?
//
//  THE QUESTION THIS ANSWERS
//  "Bet bigger on the safer trades" only works if the bot can actually IDENTIFY
//  the safer trades in advance. That is a measurable claim, and this measures it.
//
//  METHOD
//  Replays the SAME trade population the real backtest takes (same gate, same
//  plan, same costs), but for every accepted trade it records:
//    · the decision-time quality features (ADX, RSI, ATR, net R:R, cost, RVOL,
//      trend agreement, momentum, EMA spread) — all computed from bars STRICTLY
//      BEFORE the entry bar, so there is no lookahead
//    · the realised outcome as an R-MULTIPLE: profit divided by the risk taken.
//
//  WHY R-MULTIPLES: they remove position size from the measurement entirely.
//  A +2R trade is +2R whether you bet $5 or $500. That isolates SIGNAL QUALITY
//  from SIZING, which is exactly the thing in question. If some feature sorts
//  trades by mean R, tiered sizing has something real to bite on. If every
//  bucket has the same mean R, then "bet bigger on the good ones" is just
//  "bet bigger", which raises variance and lowers nothing else.
//
//  THE BAR A RESULT HAS TO CLEAR
//  A bucket is only interesting if it is (a) positive, (b) statistically
//  distinguishable from the pooled mean, and (c) STILL positive on a window
//  that was not used to pick it. (c) is the one that has killed every previous
//  candidate edge in this project. --persist runs it.
//
//  USAGE
//    node quality-scan.js --days 60 --end 2025-04-04
//    node quality-scan.js --days 60 --persist     split-sample persistence test
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const engine = require('./server.js');
const I = engine._internals;
const fs = require('fs');
const https = require('https');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes(n);

const BARS    = arg('--bars', '1Min');
const DAYS    = Math.max(1, Math.min(60, parseInt(arg('--days', '60'), 10)));
const END_DATE= arg('--end', null);
const PERSIST = flag('--persist');
const TRAIL_ARM_R = parseFloat(arg('--arm', '1.0'));
const WARMUP  = 32;
const SYMBOLS = arg('--symbols', 'PLTR,SOFI,MARA,HOOD,SOUN,IONQ,RKLB,BBAI,HIMS,CIFR,F,BAC,JPM,WFC,GE,XOM,MRK,JNJ,PFE,KO')
                  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const KEY = process.env.APCA_API_KEY_ID, SEC = process.env.APCA_API_SECRET_KEY;
if (!KEY || !SEC) { console.error('✖ Set APCA_API_KEY_ID / APCA_API_SECRET_KEY.'); process.exit(1); }
const FEED = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();
const CACHE_DIR = '.backtest-cache';

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
async function fetchBars(sym, startISO, endISO) {
  const out = []; let token = null;
  do {
    const q = `symbols=${sym}&timeframe=${BARS}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}` +
              `&limit=10000&adjustment=raw&feed=${FEED}&sort=asc` + (token ? `&page_token=${token}` : '');
    const j = await get(`/v2/stocks/bars?${q}`);
    const arr = (j && j.bars && j.bars[sym]) || [];
    for (const b of arr) if (b.h > 0 && b.l > 0 && b.c > 0)
      out.push({ t: Math.floor(new Date(b.t).getTime()/1000), o:b.o,h:b.h,l:b.l,c:b.c,v:b.v });
    token = j && j.next_page_token;
  } while (token);
  return out;
}

// ── stats ────────────────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1));
}
// t-statistic of the mean against zero. |t| > 2 ≈ 5% significance for n > 30.
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a)/(s/Math.sqrt(a.length)) : 0; };

// ── the replay, instrumented ────────────────────────────────────────────────
// Mirrors backtest.js::replay exactly for entry/exit logic. The ONLY additions
// are the feature capture at entry and the R-multiple at exit.
function scan(hist, usable) {
  const S = I.STRATEGY;
  const open = {}, rows = [];
  const times = [...new Set(usable.flatMap(s => hist[s].map(b => b.t)))].sort((a,b)=>a-b);
  const idx = {}; usable.forEach(s => idx[s] = 0);

  for (const t of times) {
    for (const sym of usable) {
      const bars = hist[sym];
      while (idx[sym] < bars.length && bars[idx[sym]].t <= t) idx[sym]++;
      const upto = idx[sym];
      if (upto < WARMUP) continue;
      const bar = bars[upto - 1];
      if (bar.t !== t) continue;

      const window = bars.slice(Math.max(0, upto - 61), upto - 1);   // excludes current bar
      if (window.length < WARMUP - 2) continue;
      I.candleData[sym] = { m1: window, m5: [] };
      I.marketData[sym] = {
        price: window[window.length-1].c,
        prevClose: window.length >= 2 ? window[window.length-2].c : window[0].o,
        dayOpen: window[window.length-1].o,
        high: Math.max(...window.map(b=>b.h)), low: Math.min(...window.map(b=>b.l)),
        dailyVolume: window.reduce((s,b)=>s+(b.v||0),0),
        lastUpdate: Date.now(), lastTradeTime: Date.now(),
        history: window.map(b=>b.c).slice(-60)
      };

      const halfSpread = I.estimateDynamicSpread(sym) / 2;
      const gapSlip = 0.10 * I.atrPct(sym);

      const pos = open[sym];
      if (pos) {
        const a = pos.atrFrac;
        const stopPx = pos.dir==='LONG' ? pos.entry*(1-S.ATR_STOP_MULT*a) : pos.entry*(1+S.ATR_STOP_MULT*a);
        const tgtPx  = pos.dir==='LONG' ? pos.entry*(1+S.ATR_TARGET_MULT*a) : pos.entry*(1-S.ATR_TARGET_MULT*a);
        let exit=null, fill=null;
        if (pos.dir==='LONG' && bar.l<=stopPx)      { exit='stop';   fill=stopPx*(1-(halfSpread+gapSlip)); }
        else if (pos.dir==='SHORT'&&bar.h>=stopPx)  { exit='stop';   fill=stopPx*(1+(halfSpread+gapSlip)); }
        else if (pos.dir==='LONG' && bar.h>=tgtPx)  { exit='target'; fill=tgtPx; }
        else if (pos.dir==='SHORT'&&bar.l<=tgtPx)   { exit='target'; fill=tgtPx; }
        else {
          const pnlPct = pos.dir==='LONG' ? (bar.c-pos.entry)/pos.entry : (pos.entry-bar.c)/pos.entry;
          pos.peak = Math.max(pos.peak, pnlPct);
          // trail arm defaults to 1.0R, matching backtest.js's --arm default.
          const armAt = TRAIL_ARM_R * S.ATR_STOP_MULT * a, giveBack = S.ATR_TRAIL_MULT * a;
          if (pos.peak >= armAt && pnlPct <= pos.peak - giveBack) {
            exit='trail';
            fill = pos.dir==='LONG' ? bar.c*(1-halfSpread) : bar.c*(1+halfSpread);
          }
        }
        if (exit) {
          const perShare = pos.dir==='LONG' ? fill-pos.entry : pos.entry-fill;
          const riskPerShare = S.ATR_STOP_MULT * pos.atrFrac * pos.entry;
          // R-MULTIPLE: the outcome expressed in units of risk taken. Size-free.
          pos.feat.R = riskPerShare > 0 ? perShare / riskPerShare : 0;
          pos.feat.exit = exit;
          rows.push(pos.feat);
          delete open[sym];
        }
        continue;
      }

      if (Object.keys(open).length >= 8) continue;
      const gate = I.evaluateStrategyGate(sym, I.marketData[sym]);
      if (!gate.longGate && !gate.shortGate) continue;
      const longOnly = I.LONG_ONLY;
      if (longOnly && !gate.longGate) continue;
      const dir = gate.longGate ? 'LONG' : 'SHORT';

      const refPx = bar.o;
      const plan = I.buildTradePlan(sym, dir, refPx, 5, 'quality-scan');
      if (plan.atrFrac < S.MIN_ATR_ENTRY) continue;
      if (plan.netRewardRisk < S.MIN_RR_NET) continue;
      if (plan.targetCostRatio < S.MIN_TARGET_COST_RATIO) continue;
      if (plan.cost > S.MAX_ROUND_TRIP_COST) continue;
      if (plan.rewardRisk < S.MIN_RR) continue;

      // ── decision-time features (all from `window`, which excludes this bar) ──
      const q = I.marketData[sym];
      const adxD = I.calculateADX(sym);
      const emaF = I.ema(q.history, S.EMA_FAST), emaS = I.ema(q.history, S.EMA_SLOW);
      const rv = I.calculateRVOL ? I.calculateRVOL(sym) : null;
      const { tf15m } = I.getCandleTrend(sym);
      const feat = {
        sym, dir, mode: gate.mode, t,
        adx:      adxD ? adxD.adx : null,
        rsi:      I.rsi(q.history, S.RSI_PERIOD),
        atr:      plan.atrFrac,
        netRR:    plan.netRewardRisk,
        cost:     plan.cost,
        tcr:      plan.targetCostRatio,
        rvol:     (rv && Number.isFinite(rv)) ? rv : null,
        mom:      (q.price - q.prevClose) / q.prevClose,
        emaSpread:(emaF !== null && emaS !== null && q.price>0) ? (emaF-emaS)/q.price : null,
        trendAgree: tf15m === (dir==='LONG' ? 'bullish' : 'bearish') ? 1 : 0,
        price:    refPx
      };

      const entry = dir==='LONG' ? refPx*(1+halfSpread*2) : refPx*(1-halfSpread*2);
      open[sym] = { dir, entry, atrFrac: plan.atrFrac, peak: 0, feat };
    }
  }
  return rows;
}

// ── bucket a numeric feature into quintiles and report mean R per bucket ─────
function bucketReport(rows, key, label) {
  const vals = rows.filter(r => r[key] !== null && Number.isFinite(r[key]));
  if (vals.length < 50) return null;
  const sorted = [...vals].sort((a,b) => a[key]-b[key]);
  const n = sorted.length, per = Math.floor(n/5);
  if (per < 10) return null;
  const buckets = [];
  for (let i=0;i<5;i++) {
    const slice = sorted.slice(i*per, i===4 ? n : (i+1)*per);
    const Rs = slice.map(r=>r.R);
    buckets.push({
      lo: slice[0][key], hi: slice[slice.length-1][key],
      n: slice.length, meanR: mean(Rs), t: tstat(Rs),
      win: slice.filter(r=>r.R>0).length/slice.length
    });
  }
  const spread = buckets[4].meanR - buckets[0].meanR;
  return { label, key, buckets, spread };
}

function printBuckets(rep) {
  console.log(`\n  ${rep.label}`);
  console.log('    quintile          range            n     mean R     win%     t');
  rep.buckets.forEach((b,i) => {
    const rng = `${b.lo.toFixed(4)}…${b.hi.toFixed(4)}`;
    console.log(`    Q${i+1} ${i===0?'(lowest) ':i===4?'(highest)':'         '} ${rng.padEnd(18)} ${String(b.n).padStart(4)}  ${(b.meanR>=0?'+':'')}${b.meanR.toFixed(3)}    ${(b.win*100).toFixed(1)}%   ${b.t>=0?'+':''}${b.t.toFixed(2)}`);
  });
  console.log(`    → top-minus-bottom spread: ${rep.spread>=0?'+':''}${rep.spread.toFixed(3)} R`);
}

// Load one window's history, using the same cache layout backtest.js uses.
async function loadWindow(endDate) {
  const end = new Date(endDate+'T20:00:00Z');
  const start = new Date(end.getTime() - DAYS*24*3600*1000*1.6);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
  const hist = {};
  for (const s of SYMBOLS) {
    const cf = `${CACHE_DIR}/${s}-${BARS}-${DAYS}d-${FEED}-${endDate}.json`;
    if (fs.existsSync(cf)) hist[s] = JSON.parse(fs.readFileSync(cf,'utf8'));
    else { hist[s] = await fetchBars(s, start.toISOString(), end.toISOString());
           try { fs.writeFileSync(cf, JSON.stringify(hist[s])); } catch {} }
  }
  const usable = SYMBOLS.filter(s => hist[s].length >= WARMUP+20);
  return { hist, usable, start: start.toISOString().slice(0,10) };
}

// Seven 60-session windows chosen back-to-back so none of them overlap. Overlapping
// windows are what produced the bogus "five independent tests" claim earlier in this
// project — 331 window-sessions that were only 246 distinct days.
const MULTI_ENDS = ['2025-04-04','2025-06-30','2025-09-23','2025-12-16','2026-03-11','2026-06-04','2026-08-20'];

// ── main ─────────────────────────────────────────────────────────────────────
(async function main() {
  const MULTI = flag('--multi');
  let rows = [];

  if (MULTI) {
    console.log(`\n🔎  QUALITY SCAN (pooled) — can the bot rank its own trades?`);
    console.log(`    ${MULTI_ENDS.length} non-overlapping ${DAYS}-session windows, ${SYMBOLS.length} symbols, feed=${FEED}\n`);
    for (const e of MULTI_ENDS) {
      process.stdout.write(`    window ending ${e} … `);
      const { hist, usable, start } = await loadWindow(e);
      if (!usable.length) { console.log('no data'); continue; }
      const r = scan(hist, usable).map(x => ({ ...x, wnd: e }));
      rows.push(...r);
      console.log(`${start} → ${e}, ${usable.length} symbols, ${r.length} trades`);
    }
  } else {
    const endStr = END_DATE || new Date().toISOString().slice(0,10);
    const { hist, usable, start } = await loadWindow(endStr);
    console.log(`\n🔎  QUALITY SCAN — can the bot rank its own trades?`);
    console.log(`    ${start} → ${endStr}, ${SYMBOLS.length} symbols, feed=${FEED}`);
    if (!usable.length) { console.error('\n✖ Not enough bars.\n'); process.exit(1); }
    rows = scan(hist, usable).map(x => ({ ...x, wnd: endStr }));
  }
  if (rows.length < 50) { console.error(`\n✖ Only ${rows.length} trades — too few to bucket.\n`); process.exit(1); }

  const allR = rows.map(r=>r.R);
  console.log(`\n  POOLED: ${rows.length} trades, mean ${mean(allR)>=0?'+':''}${mean(allR).toFixed(3)}R, ` +
              `win ${(rows.filter(r=>r.R>0).length/rows.length*100).toFixed(1)}%, t=${tstat(allR).toFixed(2)}`);
  console.log(`  (mean R > 0 means the average trade makes money after costs. This is the`);
  console.log(`   number that has to be positive before ANY sizing scheme can help.)`);

  const FEATURES = [
    ['adx','ADX — trend strength'], ['rsi','RSI'], ['atr','ATR % — volatility'],
    ['netRR','net reward:risk'], ['cost','round-trip cost'], ['tcr','target:cost ratio'],
    ['rvol','relative volume'], ['mom','momentum (day change)'], ['emaSpread','EMA spread — trend slope'],
    ['price','share price']
  ];
  const reports = [];
  for (const [k,l] of FEATURES) { const r = bucketReport(rows,k,l); if (r) { reports.push(r); printBuckets(r); } }

  // categorical: regime mode and trend agreement
  for (const [key,label] of [['mode','regime mode'],['trendAgree','15m trend agreement'],['dir','direction']]) {
    const groups = {};
    rows.forEach(r => { const g = String(r[key]); (groups[g] = groups[g]||[]).push(r.R); });
    console.log(`\n  ${label}`);
    console.log('    group                  n     mean R     win%     t');
    Object.entries(groups).filter(([,v])=>v.length>=20).forEach(([g,v]) =>
      console.log(`    ${g.padEnd(18)} ${String(v.length).padStart(4)}  ${(mean(v)>=0?'+':'')}${mean(v).toFixed(3)}    ${(v.filter(x=>x>0).length/v.length*100).toFixed(1)}%   ${tstat(v)>=0?'+':''}${tstat(v).toFixed(2)}`));
  }

  // ── the verdict ────────────────────────────────────────────────────────────
  reports.sort((a,b)=>Math.abs(b.spread)-Math.abs(a.spread));
  console.log(`\n${'═'.repeat(78)}`);
  console.log('  VERDICT — is there anything to size on?');
  console.log(`${'═'.repeat(78)}`);
  const best = reports[0];
  const positiveBuckets = reports.flatMap(r => r.buckets.map((b,i)=>({...b, feat:r.label, q:i+1})))
                                 .filter(b => b.meanR > 0 && b.t > 2);
  console.log(`  Widest ranking feature: ${best.label} (spread ${best.spread>=0?'+':''}${best.spread.toFixed(3)}R)`);
  console.log(`  Buckets that are BOTH positive and significant (t>2): ${positiveBuckets.length}`);
  if (positiveBuckets.length) {
    positiveBuckets.sort((a,b)=>b.meanR-a.meanR).slice(0,6).forEach(b =>
      console.log(`    · ${b.feat} Q${b.q}: ${b.meanR>=0?'+':''}${b.meanR.toFixed(3)}R over ${b.n} trades (t=${b.t.toFixed(2)})`));
    console.log(`\n  → A candidate exists. It is NOT an edge until it survives a window it was`);
    console.log(`    not chosen on. Re-run with --persist, or with a different --end date.`);
  } else {
    console.log(`\n  → NOTHING to size on. No feature bucket is both profitable and`);
    console.log(`    statistically distinguishable from noise. Betting more on the`);
    console.log(`    "best" trades would just bet more on trades that lose at the same`);
    console.log(`    rate as the rest — it raises variance and lowers nothing.`);
  }

  // Per-window breakdown: a pooled average can hide the fact that one window
  // carries everything. That is exactly how the earlier "bear hedge" result
  // survived as long as it did.
  const wins = [...new Set(rows.map(r=>r.wnd))].sort();
  if (wins.length > 1) {
    console.log(`\n  PER-WINDOW mean R (pooled averages hide regime dependence):`);
    console.log('    window          n     mean R      t');
    for (const w of wins) {
      const v = rows.filter(r=>r.wnd===w).map(r=>r.R);
      console.log(`    ${w}  ${String(v.length).padStart(4)}  ${(mean(v)>=0?'+':'')}${mean(v).toFixed(3)}   ${tstat(v)>=0?'+':''}${tstat(v).toFixed(2)}`);
    }
  }

  if (PERSIST) {
    console.log(`\n${'═'.repeat(78)}`);
    console.log('  PERSISTENCE — pick the rule on data it is not scored on');
    console.log(`${'═'.repeat(78)}`);

    // Pick the best-looking bucket on a training set, then score that EXACT rule
    // on data never used to choose it. With several windows, rotate the held-out
    // window (leave-one-out) — a rule that only survives one particular split is
    // not a rule. This is the test that has killed every prior candidate here.
    const pickRule = (train) => {
      let best = null;
      for (const [k,l] of FEATURES) {
        const rep = bucketReport(train,k,l); if (!rep) continue;
        rep.buckets.forEach((b,i) => {
          if (b.n >= 20 && (!best || b.meanR > best.meanR))
            best = {key:k,label:l,q:i+1,lo:b.lo,hi:b.hi,meanR:b.meanR,n:b.n,t:b.t};
        });
      }
      return best;
    };
    const scoreRule = (rule, test) =>
      test.filter(r => r[rule.key]!==null && r[rule.key]>=rule.lo && r[rule.key]<=rule.hi);

    const folds = [];
    if (wins.length > 1) {
      console.log(`  leave-one-window-out over ${wins.length} non-overlapping windows\n`);
      for (const held of wins) {
        const train = rows.filter(r=>r.wnd!==held), test = rows.filter(r=>r.wnd===held);
        const rule = pickRule(train); if (!rule) continue;
        const hit = scoreRule(rule, test);
        if (hit.length < 10) { console.log(`    hold out ${held}: rule "${rule.label} Q${rule.q}" → only ${hit.length} trades, skipped`); continue; }
        const hR = hit.map(r=>r.R);
        folds.push(mean(hR));
        console.log(`    hold out ${held}: picked "${rule.label} Q${rule.q}" (${rule.meanR>=0?'+':''}${rule.meanR.toFixed(3)}R in-sample)`);
        console.log(`                     → out-of-sample ${mean(hR)>=0?'+':''}${mean(hR).toFixed(3)}R over ${hit.length} trades (t=${tstat(hR).toFixed(2)})`);
      }
    } else {
      const chron = [...rows].sort((a,b)=>a.t-b.t);
      const cut = Math.floor(chron.length/2);
      const rule = pickRule(chron.slice(0,cut));
      if (rule) {
        const hit = scoreRule(rule, chron.slice(cut));
        if (hit.length >= 10) {
          const hR = hit.map(r=>r.R); folds.push(mean(hR));
          console.log(`  picked "${rule.label} Q${rule.q}" on first half (${rule.meanR>=0?'+':''}${rule.meanR.toFixed(3)}R)`);
          console.log(`  → second half: ${mean(hR)>=0?'+':''}${mean(hR).toFixed(3)}R over ${hit.length} trades (t=${tstat(hR).toFixed(2)})`);
        } else console.log(`  only ${hit.length} matching trades out-of-sample — inconclusive.`);
      } else console.log('  not enough data to pick a rule');
    }

    if (folds.length) {
      const good = folds.filter(x=>x>0).length;
      console.log(`\n  Out-of-sample folds profitable: ${good}/${folds.length}   average ${mean(folds)>=0?'+':''}${mean(folds).toFixed(3)}R`);
      console.log(mean(folds) > 0 && good > folds.length/2
        ? `\n  → SURVIVED. Worth a full out-of-sample backtest before believing it.`
        : `\n  → DID NOT SURVIVE. The best-looking rule describes the data it was picked\n    on and does not carry forward. Sizing up on it would size up on noise.`);
    }
  }
  console.log('');
})();
