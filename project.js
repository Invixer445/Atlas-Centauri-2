#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — project.js  ·  what could this actually earn, with compounding?
//
//  WHY THIS IS NOT "measured return × 12 months"
//  The measured per-trade edge is +0.113R with t = 1.52. t = 1.52 means the true
//  edge is NOT pinned down: the data are consistent with anything from slightly
//  negative to strongly positive. Projecting the point estimate forward as if it
//  were a fact is the single most common way trading projections lie. So this
//  simulator propagates that uncertainty explicitly:
//
//    for each simulated future:
//      1. DRAW a true edge from the sampling distribution of the measured mean
//         (Normal(mean, standard error)) — the future does not know our estimate
//         is right, and neither do we
//      2. generate a year of trades by BLOCK-bootstrapping the real measured
//         outcomes, recentred on that drawn edge
//      3. compound at the live risk setting, deducting real running costs
//
//  BLOCK bootstrap, not per-trade: the bot holds up to 8 positions at once, so
//  losses arrive in clusters. Resampling single trades would shatter that
//  correlation and understate drawdown — it would make the ride look smoother
//  than it is.
//
//  Reported as a DISTRIBUTION, never a number. A projection with one number in it
//  is a forecast; a projection with percentiles in it is an honest statement of
//  what is and is not known.
//
//  USAGE
//    node project.js --trades trades60.json
//    node project.js --trades trades60.json --years 3 --hosting 10
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i+1] ? argv[i+1] : d; };

const FILE     = arg('--trades', null);
const CAPITAL  = parseFloat(arg('--capital', '1000'));
const RISK     = parseFloat(arg('--risk', '0.015'));     // fraction of equity risked per trade
const YEARS    = parseFloat(arg('--years', '1'));
const HOSTING  = parseFloat(arg('--hosting', '10'));     // $/month to keep it running
const PATHS    = parseInt(arg('--paths', '20000'), 10);
const BLOCK    = parseInt(arg('--block', '15'), 10);
const SESSIONS = 252;                                     // trading days per year
const WINDOW_SESSIONS = 60;                               // each measured window
const WINDOWS  = 7;

if (!FILE || !fs.existsSync(FILE)) { console.error('✖ pass --trades <file from quality-scan --dump>'); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const R = rows.map(r => r.R).filter(Number.isFinite);
if (R.length < 50) { console.error('✖ not enough trades'); process.exit(1); }

const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
function sd(a){ const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
const pct = (sorted, p) => sorted[Math.min(sorted.length-1, Math.max(0, Math.floor(p*sorted.length)))];

const m   = mean(R), s = sd(R);
const se  = s / Math.sqrt(R.length);                       // uncertainty in the edge itself
const t   = m / se;
const tradesPerYear = R.length / (WINDOWS * WINDOW_SESSIONS) * SESSIONS;

// Deterministic PRNG so the same command reproduces the same figures.
let seed = 20260822;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const norm = () => { let u=0,v=0; while(!u) u=rnd(); while(!v) v=rnd();
                     return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };

// One simulated future. edgeShift recentres the resampled outcomes onto the drawn
// true edge, preserving the real shape of wins and losses (fat left tail included).
function simulate(trueEdge) {
  const n = Math.round(tradesPerYear * YEARS);
  const shift = trueEdge - m;
  let eq = CAPITAL, peak = CAPITAL, maxDD = 0;
  const monthly = HOSTING * 12 * YEARS / n;                // running cost spread per trade
  for (let i = 0; i < n; ) {
    const start = Math.floor(rnd() * R.length);            // block bootstrap keeps clustering
    for (let b = 0; b < BLOCK && i < n; b++, i++) {
      const r = R[(start + b) % R.length] + shift;
      eq *= (1 + RISK * r);
      eq -= monthly;
      if (eq <= 0) return { end: 0, maxDD: 1, busted: true };
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
    }
  }
  return { end: eq, maxDD, busted: false };
}

function run(label, drawEdge) {
  const ends = [], dds = []; let bust = 0;
  for (let p = 0; p < PATHS; p++) {
    const r = simulate(drawEdge());
    ends.push(r.end); dds.push(r.maxDD); if (r.busted) bust++;
  }
  ends.sort((a,b)=>a-b); dds.sort((a,b)=>a-b);
  const ret = x => ((x - CAPITAL) / CAPITAL * 100);
  console.log(`\n  ${label}`);
  console.log(`    worst 5%    $${pct(ends,0.05).toFixed(0).padStart(6)}   (${ret(pct(ends,0.05)).toFixed(0)}%)`);
  console.log(`    lower 25%   $${pct(ends,0.25).toFixed(0).padStart(6)}   (${ret(pct(ends,0.25)).toFixed(0)}%)`);
  console.log(`    MEDIAN      $${pct(ends,0.50).toFixed(0).padStart(6)}   (${ret(pct(ends,0.50)).toFixed(0)}%)   <-- the typical outcome`);
  console.log(`    upper 25%   $${pct(ends,0.75).toFixed(0).padStart(6)}   (${ret(pct(ends,0.75)).toFixed(0)}%)`);
  console.log(`    best 5%     $${pct(ends,0.95).toFixed(0).padStart(6)}   (${ret(pct(ends,0.95)).toFixed(0)}%)`);
  console.log(`    chance of LOSING money      ${(ends.filter(x=>x<CAPITAL).length/PATHS*100).toFixed(0)}%`);
  console.log(`    chance of beating +10%/yr   ${(ends.filter(x=>x>=CAPITAL*Math.pow(1.10,YEARS)).length/PATHS*100).toFixed(0)}%`);
  console.log(`    typical worst drawdown      ${(pct(dds,0.50)*100).toFixed(0)}%   (1-in-20 case: ${(pct(dds,0.95)*100).toFixed(0)}%)`);
  if (bust) console.log(`    account wiped out           ${(bust/PATHS*100).toFixed(1)}% of paths`);
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`  PROJECTION — $${CAPITAL} compounding for ${YEARS} year${YEARS===1?'':'s'}`);
console.log(`${'═'.repeat(70)}`);
console.log(`  measured edge      ${m>=0?'+':''}${m.toFixed(3)}R per trade  (t = ${t.toFixed(2)})`);
console.log(`  spread of outcomes  ${s.toFixed(2)}R  ·  ${R.length} real trades  ·  ~${tradesPerYear.toFixed(0)} trades/yr`);
console.log(`  risk per trade      ${(RISK*100).toFixed(1)}% of equity, reinvested`);
console.log(`  running cost        $${HOSTING}/month  (= ${(HOSTING*12/CAPITAL*100).toFixed(0)}%/yr drag on $${CAPITAL})`);
console.log(`\n  Three scenarios, because the edge is NOT statistically pinned down (t = ${t.toFixed(2)},`);
console.log(`  and |t| below 2 means "could be luck"). Each is 20,000 simulated futures.`);

// A: takes the measured edge at face value. The optimistic reading.
run(`A. IF the measured edge is real and persists  (best case, assumes we got it right)`,
    () => m);
// B: the honest predictive case — propagates estimation uncertainty.
run(`B. HONEST CASE — edge drawn from its real uncertainty range each future`,
    () => m + norm() * se);
// C: zero edge. This is NO LONGER a hypothetical null. Running the identical strategy
// over 20 fresh symbols — picked for liquidity and affordability, never used to tune
// anything — gives +0.005R at t = 0.08 over 562 trades. That is zero to three decimal
// places, on a LARGER sample than the +0.113R that scenarios A and B are built on.
// The measured edge appears only on the original 20-name watchlist, which is a
// high-beta basket that returned 34.6% in a window where the neutral set returned 8.4%.
// Read C as "what happens on stocks the bot was not built around", i.e. the honest
// out-of-sample case — not as a pessimistic what-if.
run(`C. ZERO EDGE — measured on 20 fresh symbols (+0.005R, t=0.08). The real out-of-sample case.`,
    () => 0);
// D: the one that matters most. Every measured window sits inside a strong bull
// run: the bot's per-window edge correlates 0.67 with the market's own return, and
// regressing edge on market return puts the FLAT-market edge at +0.047R (t = 0.69).
// So most of what looks like skill is the market carrying it. If stocks stop going
// up, this is the honest expectation — and it is not distinguishable from zero.
const FLAT_EDGE = 0.047, FLAT_SE = 0.068;
run(`D. IF THE MARKET GOES FLAT  (the sample was all bull market — read this one)`,
    () => FLAT_EDGE + norm() * FLAT_SE);

console.log(`\n${'─'.repeat(70)}`);
console.log(`  Scenario B is the one to believe. A assumes we measured the future correctly;`);
console.log(`  C assumes we measured nothing. B admits we do not know which, and prices it in.`);
console.log('');
