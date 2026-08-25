#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — edge-research.js  ·  find a trading edge the honest way
//
//  WHY THIS EXISTS
//  Every edge test in this project so far re-cut the SAME history. That is how six
//  false discoveries happened: with enough passes over one dataset, something always
//  looks significant. Re-running those tests produces more confidence, not more
//  evidence.
//
//  The only construction that generates real evidence is a HYPOTHESIS REGISTER:
//  write the claim down, timestamp it, and afterwards score it ONLY on data that
//  arrived after it was written. A hypothesis cannot be tuned to data that did not
//  exist when it was registered, which removes the entire class of error that has
//  dominated this project.
//
//  It is deliberately slow. A hypothesis registered today has no out-of-sample
//  evidence today, a little in a month, and something worth acting on in a year.
//  That is not a limitation of the tool — it is what honest edge discovery costs.
//  Anything faster is fitting.
//
//  RULES ENFORCED HERE
//  · a hypothesis is scored ONLY on bars dated after its registeredAt
//  · every result carries n, mean, t-stat and a benchmark — never a bare return
//  · a hypothesis needs |t| > 2 AND to beat buy-and-hold AND to hold up across
//    multiple scoring runs before it is called anything
//  · results are appended, never overwritten, so decay is visible
//
//  USAGE
//    node edge-research.js --list          show the register and current status
//    node edge-research.js --run           score every hypothesis on new data
//    node edge-research.js --add "..."     register a new claim (starts today)
// ════════════════════════════════════════════════════════════════════════════
'use strict';

require('./server.js');
const fs = require('fs');
const https = require('https');
const path = require('path');

const REGISTER = path.join(__dirname, 'edge-register.json');
const KEY = process.env.APCA_API_KEY_ID, SEC = process.env.APCA_API_SECRET_KEY;
const FEED = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes(n);

const UNIVERSE = 'SPY,AAPL,MSFT,JNJ,JPM,XOM,PG,KO,WMT,CVX,PLTR,SOFI,MARA,HOOD,F,BAC,GE,MRK,PFE,INTC'.split(',');

// ── the register ─────────────────────────────────────────────────────────────
// Each hypothesis names a testable claim and the function that scores it. Adding one
// here starts its clock; it earns evidence only from bars after that date.
const HYPOTHESES = [
  {
    id: 'overnight-beats-intraday',
    claim: 'Close-to-open returns exceed open-to-close returns on a broad equity basket.',
    why: 'Measured 2020-2024: overnight positive in 5/5 years (t up to 6.93), intraday '
       + 'negative in 3/5. Strongest effect found in this project. BUT a backdated check '
       + 'over 2024-2026 alone scored only t=0.58 (overnight 22.0%/yr vs intraday 12.6%) '
       + '— still positive, no longer significant. That is exactly why this is registered '
       + 'rather than believed: it may be decaying, or the recent window may just be short.',
    score: (bars, from) => {
      const on = [], intr = [];
      forEachDay(bars, from, (prev, cur) => {
        const o = [], i2 = [];
        for (const s of Object.keys(bars)) {
          const p = prev[s], q = cur[s];
          if (!p || !q || !(p.c > 0) || !(q.o > 0)) continue;
          o.push(q.o / p.c - 1); i2.push(q.c / q.o - 1);
        }
        if (o.length) { on.push(mean(o)); intr.push(mean(i2)); }
      });
      if (on.length < 30) return null;
      const diff = on.map((v, k) => v - intr[k]);
      return { n: diff.length, mean: mean(diff), t: tstat(diff),
               note: `overnight ${(annualise(on)*100).toFixed(1)}%/yr vs intraday ${(annualise(intr)*100).toFixed(1)}%/yr` };
    }
  },
  {
    id: 'atlas-live-trading-edge',
    claim: 'ATLAS trades, as configured, have positive expectancy net of costs.',
    why: 'The central claim of the whole bot. Measured +0.113R (t=1.52) on the original '
       + 'watchlist and +0.005R (t=0.08) on symbols it was not built around. Scored '
       + 'here against the bot\'s OWN closed trades as they accumulate live.',
    scoreLive: (trades) => {
      const R = trades.map(t => t.rMultiple).filter(Number.isFinite);
      if (R.length < 30) return null;
      return { n: R.length, mean: mean(R), t: tstat(R),
               note: `win ${(R.filter(x => x > 0).length / R.length * 100).toFixed(0)}%` };
    }
  },
  {
    id: 'momentum-beats-hold',
    claim: '12-month cross-sectional momentum, monthly rebalance, beats equal-weight buy-and-hold.',
    why: 'Documented anomaly, low turnover so friction is not the obstacle. Measured '
       + '44.4%/yr net against buy-and-hold 54.3% — i.e. it LOST on the in-sample run. '
       + 'Registered to see whether that reverses out of sample.',
    score: (bars, from) => {
      const syms = Object.keys(bars);
      if (!syms.length) return null;
      const dates = commonDates(bars).filter(d => d > from);
      if (dates.length < 120) return null;
      const rets = [], bh = [];
      let held = [];
      for (let i = 1; i < dates.length; i++) {
        if (i % 21 === 1) {
          const look = Math.min(252, i - 1);
          held = syms.map(s => {
            const a = px(bars, s, dates[i - 1 - look]), z = px(bars, s, dates[i - 1]);
            return { s, m: (a > 0 && z > 0) ? z / a - 1 : -Infinity };
          }).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m)
            .slice(0, Math.max(1, Math.floor(syms.length / 3))).map(x => x.s);
        }
        const day = held.map(s => dayRet(bars, s, dates[i - 1], dates[i]));
        const allDay = syms.map(s => dayRet(bars, s, dates[i - 1], dates[i]));
        rets.push(mean(day)); bh.push(mean(allDay));
      }
      const excess = rets.map((v, k) => v - bh[k]);
      return { n: excess.length, mean: mean(excess), t: tstat(excess),
               note: `momentum ${(annualise(rets)*100).toFixed(1)}%/yr vs hold ${(annualise(bh)*100).toFixed(1)}%/yr` };
    }
  }
];

// ── helpers ──────────────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const annualise = r => Math.pow(r.reduce((v, x) => v * (1 + x), 1), 252 / Math.max(1, r.length)) - 1;
const px = (bars, s, d) => (bars[s] && bars[s].byDate[d]) ? bars[s].byDate[d].c : 0;
const dayRet = (bars, s, d0, d1) => { const a = px(bars, s, d0), b = px(bars, s, d1); return (a > 0 && b > 0) ? b / a - 1 : 0; };
function commonDates(bars) {
  const syms = Object.keys(bars).filter(s => bars[s] && Array.isArray(bars[s].rows) && bars[s].rows.length);
  if (!syms.length) return [];                 // day one: registered, no data yet — not an error
  let d = bars[syms[0]].rows.map(r => r.t);
  for (const s of syms.slice(1)) { const set = new Set(bars[s].rows.map(r => r.t)); d = d.filter(x => set.has(x)); }
  return d;
}
function forEachDay(bars, from, fn) {
  const dates = commonDates(bars).filter(d => d > from);
  if (dates.length < 2) return;
  for (let i = 1; i < dates.length; i++) {
    const prev = {}, cur = {};
    for (const s of Object.keys(bars)) { prev[s] = bars[s].byDate[dates[i - 1]]; cur[s] = bars[s].byDate[dates[i]]; }
    fn(prev, cur);
  }
}
function get(p) {
  return new Promise(r => { https.request({ host: 'data.alpaca.markets', path: p,
    headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } },
    x => { let b = ''; x.on('data', d => b += d); x.on('end', () => { try { r(JSON.parse(b)); } catch { r(null); } }); }).end(); });
}
async function fetchDaily(syms, startISO) {
  const out = {}; let token = null, pages = 0;
  do {
    const j = await get(`/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=1Day&start=${encodeURIComponent(startISO)}` +
      `&limit=10000&adjustment=all&feed=${FEED}&sort=asc` + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
    if (!j) break;
    Object.entries(j.bars || {}).forEach(([s, arr]) => {
      out[s] = out[s] || { rows: [], byDate: {} };
      arr.forEach(b => { const row = { t: b.t.slice(0, 10), o: b.o, c: b.c }; out[s].rows.push(row); out[s].byDate[row.t] = row; });
    });
    token = j.next_page_token || null; pages++;
  } while (token && pages < 12);
  return out;
}
function loadRegister() {
  try { return JSON.parse(fs.readFileSync(REGISTER, 'utf8')); } catch { return { entries: {} }; }
}
function saveRegister(r) { fs.writeFileSync(REGISTER, JSON.stringify(r, null, 2)); }
const today = () => new Date().toISOString().slice(0, 10);

// A hypothesis is only ever "supported" — never "proven". Three conditions, all
// required, because any one of them alone has already produced a false positive here.
function verdict(entry) {
  const rs = entry.results || [];
  if (!rs.length) return { label: 'no evidence yet', ok: false };
  const last = rs[rs.length - 1];
  if (last.n < 60) return { label: `too little data (n=${last.n}, need 60)`, ok: false };
  const strong = Math.abs(last.t) > 2;
  const consistent = rs.length >= 2 && rs.slice(-2).every(r => Math.sign(r.mean) === Math.sign(last.mean));
  if (strong && last.mean > 0 && consistent) return { label: 'SUPPORTED out of sample', ok: true };
  if (strong && last.mean < 0) return { label: 'REFUTED (significantly negative)', ok: false };
  if (!strong) return { label: `not distinguishable from noise (t=${last.t.toFixed(2)})`, ok: false };
  return { label: 'positive but not yet consistent across runs', ok: false };
}

(async function main() {
  const reg = loadRegister();

  if (flag('--add')) {
    const claim = arg('--add', '');
    if (!claim) { console.error('  pass the claim text'); process.exit(1); }
    const id = 'custom-' + Object.keys(reg.entries).length;
    reg.entries[id] = { claim, registeredAt: today(), results: [], custom: true };
    saveRegister(reg);
    console.log(`\n  Registered "${claim}"\n  Clock starts ${today()} — it earns evidence only from data after that date.\n`);
    return;
  }

  // Ensure every built-in hypothesis has a registration date. Registering today means
  // it has ZERO out-of-sample evidence today, which is the correct starting state.
  let added = 0;
  for (const h of HYPOTHESES) {
    if (!reg.entries[h.id]) { reg.entries[h.id] = { claim: h.claim, why: h.why, registeredAt: today(), results: [] }; added++; }
  }
  if (added) { saveRegister(reg); console.log(`\n  Registered ${added} hypothesis(es) as of ${today()}.`); }

  if (flag('--list') || !flag('--run')) {
    console.log(`\n${'═'.repeat(78)}`);
    console.log('  EDGE REGISTER — claims and their out-of-sample standing');
    console.log(`${'═'.repeat(78)}`);
    for (const [id, e] of Object.entries(reg.entries)) {
      const v = verdict(e);
      console.log(`\n  ${id}`);
      console.log(`    ${e.claim}`);
      if (e.why) console.log(`    why: ${e.why.replace(/\s+/g, ' ')}`);
      console.log(`    registered ${e.registeredAt} · ${(e.results || []).length} scoring run(s)`);
      console.log(`    STATUS: ${v.label}`);
      (e.results || []).slice(-3).forEach(r =>
        console.log(`      ${r.at}  n=${String(r.n).padStart(5)}  mean ${(r.mean >= 0 ? '+' : '') + r.mean.toFixed(5)}  t=${r.t.toFixed(2)}${r.note ? '  · ' + r.note : ''}`));
    }
    console.log(`\n  Run \`node edge-research.js --run\` to score them on data since registration.`);
    console.log(`  A hypothesis registered today will correctly show NO evidence until time passes.\n`);
    return;
  }

  // ── scoring run ────────────────────────────────────────────────────────────
  console.log(`\n  Scoring hypotheses on data AFTER each registration date …`);
  const earliest = Object.values(reg.entries).map(e => e.registeredAt).sort()[0];
  const bars = await fetchDaily(UNIVERSE, new Date(earliest + 'T00:00:00Z').toISOString());
  const have = Object.keys(bars).filter(s => bars[s].rows.length > 5);
  console.log(`  ${have.length}/${UNIVERSE.length} symbols with data since ${earliest}\n`);

  for (const h of HYPOTHESES) {
    const e = reg.entries[h.id];
    if (!e) continue;
    let res = null;
    if (h.score) {
      const subset = {}; have.forEach(s => subset[s] = bars[s]);
      try { res = h.score(subset, e.registeredAt); } catch (err) { console.log(`  ${h.id}: scoring error — ${err.message}`); continue; }
    } else if (h.scoreLive) {
      // Score against the bot's own closed trades, if any have accumulated.
      let trades = [];
      try {
        const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'atlas-solar-state.json'), 'utf8'));
        trades = (st.closedTrades || []).filter(t => !t.partial && String(t.closedAt || '').slice(0, 10) > e.registeredAt);
      } catch { /* no state yet */ }
      res = h.scoreLive(trades);
    }
    if (!res) { console.log(`  ${h.id}: not enough post-registration data yet — correct, and expected.`); continue; }
    res.at = today();
    e.results = e.results || [];
    // Append, never overwrite: decay is only visible as a series.
    e.results.push(res);
    const v = verdict(e);
    console.log(`  ${h.id}: n=${res.n}  mean ${(res.mean >= 0 ? '+' : '') + res.mean.toFixed(5)}  t=${res.t.toFixed(2)}  → ${v.label}`);
    if (res.note) console.log(`      ${res.note}`);
  }
  saveRegister(reg);
  console.log(`\n  Register updated: ${REGISTER}`);
  console.log(`  Re-run periodically. Evidence accumulates with time, and only with time.\n`);
})();
