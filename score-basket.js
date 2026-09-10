#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS — score-basket.js
//
//  The basket register was WRITE-ONLY. Every research cycle recorded what Venus
//  proposed and what the live basket was, with a timestamp — and nothing ever read it
//  back. The whole discipline this project runs on ("propose, log, score on data that
//  arrived LATER, adopt only if it wins") was therefore aspirational: the evidence
//  accumulated and no one looked.
//
//  This reads it back. For every proposal it compares the proposed basket against the
//  control basket over the window that STARTED when the proposal was made — so the
//  comparison is strictly out-of-sample, which is the only kind that means anything.
//  Six false edges were believed in this project before that rule existed.
//
//  USAGE  node score-basket.js [path-to-atlas-basket-proposals.json]
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs'), https = require('https'), path = require('path');

for (const f of ['env.local', '.env']) {
  try { for (const l of fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  } } catch {}
}
const KEY = process.env.APCA_API_KEY_ID, SEC = process.env.APCA_API_SECRET_KEY;
const FEED = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();
const LOG = process.argv[2] || path.join(process.env.ATLAS_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '.',
                                         'atlas-basket-proposals.json');

const get = p => new Promise(r => {
  https.request({ host: 'data.alpaca.markets', path: p, headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } },
    x => { let b = ''; x.on('data', d => b += d); x.on('end', () => { try { r(JSON.parse(b)); } catch { r(null); } }); })
    .on('error', () => r(null)).end();
});

async function dailyBars(symbols, startISO) {
  const out = {}; let token = null, pages = 0;
  do {
    const j = await get(`/v2/stocks/bars?symbols=${symbols.join(',')}&timeframe=1Day` +
      `&start=${encodeURIComponent(startISO)}&limit=10000&adjustment=all&feed=${FEED}&sort=asc` +
      (token ? `&page_token=${encodeURIComponent(token)}` : ''));
    if (!j || j.message) { if (j && j.message) console.error('  API: ' + j.message); break; }
    Object.entries(j.bars || {}).forEach(([s, a]) => {
      (out[s] = out[s] || []).push(...a.map(b => ({ t: b.t.slice(0, 10), c: b.c })));
    });
    token = j.next_page_token || null; pages++;
  } while (token && pages < 20);
  return out;
}

// Equal-weight total return of a basket from `from` to the end of the data.
function basketReturn(bars, syms, from) {
  const rets = [];
  for (const s of syms) {
    const b = (bars[s] || []).filter(x => x.t >= from);
    if (b.length < 2) continue;
    rets.push(b[b.length - 1].c / b[0].c - 1);
  }
  return rets.length ? { ret: rets.reduce((a, x) => a + x, 0) / rets.length, n: rets.length } : null;
}

(async () => {
  let log;
  try { log = JSON.parse(fs.readFileSync(LOG, 'utf8')); }
  catch (e) { console.error(`\n  No register at ${LOG} — nothing proposed yet, or wrong path.\n`); process.exit(1); }
  if (!Array.isArray(log) || !log.length) { console.error('\n  Register is empty — nothing to score yet.\n'); process.exit(1); }

  // Only proposals with enough elapsed time to mean anything.
  const MIN_DAYS = Number(process.env.SCORE_MIN_DAYS || 5);
  const now = Date.now();
  const scorable = log.filter(p => p.at && (now - Date.parse(p.at)) / 86400000 >= MIN_DAYS);

  console.log(`\n${'='.repeat(76)}`);
  console.log(`  BASKET REGISTER — ${log.length} proposal(s) logged, ${scorable.length} old enough to score`);
  console.log(`  (a proposal needs ${MIN_DAYS}+ days of AFTER-the-fact data to say anything)`);
  console.log(`${'='.repeat(76)}`);
  if (!scorable.length) {
    const newest = log[log.length - 1];
    const age = ((now - Date.parse(newest.at)) / 86400000).toFixed(1);
    console.log(`\n  Newest proposal is ${age}d old. Nothing is scorable yet — that is the`);
    console.log(`  register working, not failing. Come back in a few days.\n`);
    return;
  }
  if (!KEY || !SEC) { console.error('\n  No Alpaca keys — set APCA_API_KEY_ID / APCA_API_SECRET_KEY.\n'); process.exit(1); }

  const universe = [...new Set(scorable.flatMap(p => [...(p.basket || []), ...(p.control || [])]))];
  const earliest = scorable.reduce((m, p) => Math.min(m, Date.parse(p.at)), Infinity);
  process.stderr.write(`  fetching ${universe.length} symbols … `);
  const bars = await dailyBars(universe, new Date(earliest - 5 * 86400000).toISOString());
  process.stderr.write(`${Object.keys(bars).length} returned\n`);
  if (!Object.keys(bars).length) { console.error('\n  No price data returned — cannot score.\n'); process.exit(1); }

  console.log(`\n  proposed on      days   Venus's basket   the control    difference`);
  let wins = 0, scored = 0, totalDiff = 0;
  for (const p of scorable) {
    const from = p.at.slice(0, 10);
    const days = ((now - Date.parse(p.at)) / 86400000).toFixed(0);
    const a = basketReturn(bars, p.basket || [], from);
    const b = basketReturn(bars, p.control || [], from);
    if (!a || !b) { console.log(`  ${from}   ${String(days).padStart(5)}   (insufficient price history)`); continue; }
    const diff = (a.ret - b.ret) * 100;
    scored++; totalDiff += diff; if (diff > 0) wins++;
    console.log(`  ${from}   ${String(days).padStart(5)}   ${((a.ret*100).toFixed(2)+'%').padStart(14)}   ` +
                `${((b.ret*100).toFixed(2)+'%').padStart(11)}   ${((diff>=0?'+':'')+diff.toFixed(2)+'%').padStart(11)}`);
  }
  if (!scored) { console.log('\n  Nothing could be scored — not enough overlapping price history.\n'); return; }

  console.log(`\n  VERDICT`);
  console.log(`  Venus's basket beat the control in ${wins} of ${scored} scorable proposals ` +
              `(${(100*wins/scored).toFixed(0)}%), average ${totalDiff/scored >= 0 ? '+' : ''}${(totalDiff/scored).toFixed(2)}%.`);
  if (scored < 10) {
    console.log(`  ${scored} observations is NOT enough to act on. This project has believed six`);
    console.log(`  false edges on samples this size. Treat it as a progress bar, not a result.`);
  } else if (totalDiff / scored > 0 && wins / scored > 0.5) {
    console.log(`  Positive so far. Still check whether the gap is bigger than the turnover it`);
    console.log(`  would cost before switching CORE_BASKET_SOURCE to venus.`);
  } else {
    console.log(`  Not beating the control. The fixed basket keeps the money — which is exactly`);
    console.log(`  what the default is for.`);
  }
  console.log('');
})();
