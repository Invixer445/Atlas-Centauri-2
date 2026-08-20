// ════════════════════════════════════════════════════════════════════════════
//  ATLAS CENTAURI — Unified Engine  v11.20   (US Markets Only: NASDAQ + NYSE)
//
//  ONE engine, three named subsystems:
//
//    ♀ VENUS  — the RESEARCH AI. Scans the web — SEC EDGAR 13F institutional
//                  holdings (what large funds hold/accumulate), live news catalysts,
//                  and real-time relative volume — then analyzes it into a ranked
//                  WATCHLIST with per-symbol ideas (what to watch, bias, why). Also
//                  learns per-catalyst calibration so its confidence is honest.
//                  Decides WHAT to watch and WHERE to look.
//
//    🔭 JUPITER    — the TRADING AI. Consumes Venus's research, then sizes and
//                  decides: an online win-probability model (logistic regression)
//                  trained on every closed trade learns which setups actually win,
//                  and drives ¼-Kelly sizing and direction. Decides HOW MUCH and
//                  which DIRECTION, and LEARNS from every trade it sends to Terra.
//                  (Both AIs live in the "CENTAURI BRAIN" section below.)
//
//    🌍 TERRA   — the EXECUTION ENGINE. Everything dedicated to carrying out what
//                  Venus and Jupiter decide: order routing to the broker, fills,
//                  position lifecycle, the strategy gate and the full risk
//                  pipeline (kill switches, caps, safe mode, cooldowns, gap
//                  handling). Terra sizes nothing and picks no direction on its
//                  own — it executes the brain's decisions and enforces the rules.
//                  Its supporting infrastructure (Alpaca market-data feed, the
//                  indicator library, persistence, and the dashboard server for
//                  LUNA) lives alongside it in this file.
//
//  Previously the brain (intelligence.js) and Terra (this file) were separate;
//  they are now integrated into one unified engine. The brain is still exposed via
//  module.exports when this file is imported (e.g. by train.js), so the AIs can be
//  trained/inspected without booting the execution engine.
//
//  Run:   node server.js          → boot the full engine
//         node train.js           → specialize the AIs offline (see train.js --help)
//
//  Honest stance: this is not guaranteed profitable. Validate in the simulator
//  before connecting real money. Not financial advice.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ── Load .env (if present) — zero-dependency, ~20 lines, keeps the near-zero-dep
// philosophy intact instead of pulling in the `dotenv` package. Real environment
// variables (Railway config, shell exports, etc.) always WIN over the file — this
// only fills in what isn't already set, so it's safe in every deployment context.
//
// Tries several filenames, in order, and uses the FIRST one that exists:
//   .env            the standard name (needs Terminal on Mac — Finder/TextEdit
//                   often refuse to save a filename that starts with a dot)
//   env.local       a normal, dot-free name any Mac Finder/TextEdit save dialog
//                   accepts without a fight — use this if ".env" gives you trouble
//   env.txt         same idea, in case a ".txt" got appended automatically
(function loadDotEnv() {
  const fs = require('fs'), path = require('path');
  const candidates = ['.env', 'env.local', 'env.txt'];
  let envPath = null;
  for (const name of candidates) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) { envPath = p; break; }
  }
  if (!envPath) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    let loaded = 0;
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip a single layer of matching quotes: KEY="value" or KEY='value'
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) { process.env[key] = val; loaded++; }
    }
    if (loaded > 0) console.log(`[ENV] Loaded ${loaded} variable(s) from ${path.basename(envPath)}`);
  } catch (e) {
    console.error(`[ENV] Could not read ${path.basename(envPath)} — falling back to real environment variables:`, e.message);
  }
})();

const express  = require('express');
const app      = express();
const path     = require('path');
const https    = require('https');
const WebSocket = require('ws');
const fs       = require('fs');
const { createBroker } = require('./broker');

const PORT        = process.env.PORT || 3000;

// ─── MARKET DATA (Alpaca) ────────────────────────────────────────────────
// ATLAS now uses Alpaca for BOTH market data and execution. Data uses the same
// API keys as trading (paper or live keys both grant data access).
//   • REST  : https://data.alpaca.markets/v2  (snapshots + historical bars)
//   • Stream: wss://stream.data.alpaca.markets/v2/<feed>
// Free plan → feed "iex" (real-time IEX trades, ~3% of consolidated volume but
// genuinely live and free). Paid plan → "sip" (full consolidated tape).
const APCA_API_KEY_ID     = process.env.APCA_API_KEY_ID     || '';
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY || '';
const ALPACA_DATA_FEED    = (process.env.ALPACA_DATA_FEED || 'iex').toLowerCase();  // iex (free) | sip (paid)
const ALPACA_DATA_REST    = 'data.alpaca.markets';
const ALPACA_DATA_WS      = `wss://stream.data.alpaca.markets/v2/${ALPACA_DATA_FEED}`;

const START_CAPITAL = 1000;
const BACKUP_FILE   = './atlas-solar-state.json';

// ─── LIVE TRADING CONFIG ─────────────────────────────────────────────────
// LIVE_TRADING must be the literal string "true" to route real orders.
// Even then, the broker itself decides paper vs live (see broker.js / ALPACA_PAPER).
// ATLAS always runs its full risk pipeline FIRST; the broker is only the "hands".
const LIVE_TRADING = (process.env.LIVE_TRADING || 'false').toLowerCase() === 'true';
// AUTONOMOUS_TRADING=true (default): ATLAS opens its own positions from its engine.
// Set to "false" to make ATLAS a PURE EXECUTOR — it still manages exits, risk, and
// kill switches, but new entries come ONLY from the TradingView webhook. Use this
// when you want a TradingView Pine strategy to be the sole brain.
const AUTONOMOUS_TRADING = (process.env.AUTONOMOUS_TRADING || 'true').toLowerCase() !== 'false';
const TRADINGVIEW_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
// Optional admin token for state-MUTATING endpoints (/api/emergency, /api/aplus,
// /api/retrain, /api/reconcile, /api/intel/analyze). Unset (default) = open, same
// as before — fine on a private machine. SET THIS on any public deployment
// (Railway etc.), otherwise anyone who finds the URL can resume a halted bot or
// toggle aggressive mode. Callers pass it as ?token=... or an X-Admin-Token header.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function adminAllowed(req) {
  if (!ADMIN_TOKEN) return true;   // not configured → open (back-compatible)
  const supplied = (req.query && req.query.token) || req.headers['x-admin-token'] || '';
  return supplied === ADMIN_TOKEN;
}
const broker = createBroker();

// ── v11.18 EXECUTION MODE ─────────────────────────────────────────────────────
// LIVE_TRADING=false  → pure internal simulation (unchanged, the default).
// LIVE_TRADING=true   → BROKER-AUTHORITATIVE: orders go to the broker as a pending
//   lifecycle, and positions/P&L are booked from the broker's REAL fills
//   (filled_avg_price / filled_qty). The old fire-and-forget shadow routing is retired.
const EXEC_BROKER_AUTH = LIVE_TRADING;

// ── HARD SAFETY: this build is PAPER-ONLY. No real money, no exceptions. ──────
// Broker-authoritative execution against a LIVE Alpaca account is refused at boot.
// (Real-money support is a deliberate future step gated on GUIDE_1 validation +
// GUIDE_2 — not an env flag away.)
if (EXEC_BROKER_AUTH && broker.isLive) {
  console.error('');
  console.error('══════════════════════════════════════════════════════════════════');
  console.error('[FATAL] LIVE broker endpoint detected with broker-authoritative');
  console.error('        execution. This build is PAPER-ONLY by design.');
  console.error('        Set ALPACA_PAPER=true (and use paper keys), or set');
  console.error('        LIVE_TRADING=false for pure simulation. See GUIDE_2 for the');
  console.error('        (future, deliberate) path to real money.');
  console.error('══════════════════════════════════════════════════════════════════');
  process.exit(1);
}

// ─── BRAIN CONFIG — knobs for Venus (research AI) + Jupiter (trading AI) ──────
// The brain itself is defined above (CENTAURI BRAIN section). These are Terra's
// runtime knobs for wiring it in. Without an API key Venus is disabled and
// ATLAS runs pure-technical (Jupiter's win-model still learns and sizes; there are
// simply no news recommendations to act on).
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  CENTAURI BRAIN — the two AIs that decide WHAT and HOW to trade            ║
// ║    ♀ VENUS   · research AI (scans web + SEC 13F holdings + news → ideas)   ║
// ║    🔭 JUPITER · trading AI  (sizes, decides & learns: win-model + Kelly)   ║
// ║  Merged inline (was intelligence.js) so brain + execution are ONE engine.  ║
// ║  Terra (below) is the EXECUTION engine that carries out their decisions.   ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  PART 1 — ML TOOLKIT  (zero-dependency online-learning primitives)         ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const clip   = (x, lo, hi) => (x < lo ? lo : (x > hi ? hi : x));
const sigmoid = (z) => 1 / (1 + Math.exp(-clip(z, -30, 30)));
const logit  = (p) => { const q = clip(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)); };

// ── Online logistic regression (SGD + L2) ───────────────────────────────────
// predict(x) → P(label=1); update(x, y) trains on one (features, label) pair.
class OnlineLogistic {
  constructor(dim, opts = {}) {
    this.dim   = dim;
    this.w     = new Array(dim).fill(0);
    this.b     = 0;
    this.lr    = opts.lr ?? 0.06;     // learning rate
    this.l2    = opts.l2 ?? 1e-3;     // L2 regularization
    this.n     = 0;                   // training samples seen (persists)
    this.loss  = 0;                   // EWMA log-loss (lower = better)
    this.names = opts.names || null;  // optional feature names for introspection
    this.wins  = 0;                   // label balance (for reporting)
    this.total = 0;
  }
  _raw(x) {
    let s = this.b;
    for (let i = 0; i < this.dim; i++) {
      const v = x[i];
      s += this.w[i] * ((typeof v === 'number' && Number.isFinite(v)) ? v : 0);  // ignore bad inputs
    }
    return s;
  }
  predict(x) { return sigmoid(this._raw(x)); }
  update(x, y) {
    // Defensive: a single NaN/Inf feature (e.g. an indicator with no data yet)
    // must never corrupt the model. Sanitize the input vector + label, and
    // self-heal any weight that goes non-finite, so the model can't be poisoned.
    const xs = new Array(this.dim);
    for (let i = 0; i < this.dim; i++) { const v = x[i]; xs[i] = (typeof v === 'number' && Number.isFinite(v)) ? v : 0; }
    y = y >= 0.5 ? 1 : 0;
    const p = this.predict(xs);
    const eps = 1e-9;
    const ll = -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
    this.loss = this.n === 0 ? ll : (this.loss * 0.98 + ll * 0.02);  // EWMA
    const err = y - p;                                               // gradient of log-loss
    for (let i = 0; i < this.dim; i++) {
      const wi = this.w[i] + this.lr * (err * xs[i] - this.l2 * this.w[i]);  // SGD step + L2
      this.w[i] = Number.isFinite(wi) ? wi : 0;                     // self-heal
    }
    const nb = this.b + this.lr * err;
    this.b = Number.isFinite(nb) ? nb : 0;
    this.n++; this.total++; if (y === 1) this.wins++;
    return p;
  }
  // Feature importances = |weight|, largest first (with names if provided)
  importance(topK = 5) {
    const arr = this.w.map((wi, i) => ({ name: this.names ? this.names[i] : ('f' + i), weight: +wi.toFixed(3), abs: Math.abs(wi) }));
    arr.sort((a, b) => b.abs - a.abs);
    return arr.slice(0, topK).map(({ name, weight }) => ({ name, weight }));
  }
  toJSON() { return { w: this.w, b: this.b, n: this.n, loss: this.loss, wins: this.wins, total: this.total }; }
  load(o) {
    if (!o || !Array.isArray(o.w) || o.w.length !== this.dim) return;
    if (!o.w.every(v => typeof v === 'number' && Number.isFinite(v))) return;  // reject corrupted weights
    this.w = o.w.slice();
    this.b = Number.isFinite(o.b) ? o.b : 0; this.n = o.n || 0;
    this.loss = Number.isFinite(o.loss) ? o.loss : 0; this.wins = o.wins || 0; this.total = o.total || 0;
  }
}

// ── Platt calibration ───────────────────────────────────────────────────────
// Learns a, b so that calibrated = sigmoid(a·logit(raw) + b) matches reality.
// Starts at identity (a=1, b=0). Used by Venus to make LLM convictions honest.
class PlattCalibrator {
  constructor(opts = {}) {
    this.a  = 1; this.b = 0;
    this.lr = opts.lr ?? 0.05;
    this.n  = 0;
    this.wins = 0; this.total = 0;
  }
  calibrate(raw) { return sigmoid(this.a * logit(raw) + this.b); }
  update(raw, y) {
    const z = logit(raw);
    const p = sigmoid(this.a * z + this.b);
    const err = y - p;
    this.a += this.lr * err * z;
    this.b += this.lr * err;
    this.a = clip(this.a, 0.1, 4);     // keep stable on small samples
    this.b = clip(this.b, -4, 4);
    this.n++; this.total++; if (y >= 0.5) this.wins++;
    return p;
  }
  // How much this calibrator currently bends a typical 0.7 confidence
  shift() { return +(this.calibrate(0.7) - 0.7).toFixed(3); }
  toJSON() { return { a: this.a, b: this.b, n: this.n, wins: this.wins, total: this.total }; }
  load(o) {
    if (!o) return;
    this.a = o.a ?? 1; this.b = o.b ?? 0; this.n = o.n ?? 0;
    this.wins = o.wins ?? 0; this.total = o.total ?? 0;
  }
}

// Blend a model probability toward a neutral prior, weighted by experience.
// n samples, pseudo-count k → weight = n/(n+k). Untrained → ~prior; seasoned → ~model.
function blendWithPrior(pModel, n, k = 25, prior = 0.5) {
  const w = n / (n + k);
  return prior * (1 - w) + pModel * w;
}

// ── Batch / experience-replay training (offline specialization) ─────────────
// The online learners above see each sample once. To make a model HIGHLY
// SPECIALIZED, we replay an accumulated dataset over many epochs with shuffling,
// hold out a validation split, and keep the best-validation weights. This squeezes
// far more signal out of limited data than single-pass online updates, while the
// validation split + L2 guard against overfitting.
function _shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function meanLogLoss(model, samples) {
  if (!samples.length) return 0;
  let s = 0; const eps = 1e-9;
  for (const { x, y } of samples) { const yy = y >= 0.5 ? 1 : 0; const p = model.predict(x); s += -(yy * Math.log(p + eps) + (1 - yy) * Math.log(1 - p + eps)); }
  return s / samples.length;
}
function accuracyOf(model, samples) {
  if (!samples.length) return 0;
  let c = 0; for (const { x, y } of samples) { if ((model.predict(x) >= 0.5 ? 1 : 0) === (y >= 0.5 ? 1 : 0)) c++; }
  return c / samples.length;
}
function trainLogisticBatch(samples, dim, opts = {}) {
  const epochs   = Math.max(1, Math.min(300, opts.epochs ?? 12));
  const valSplit = Math.max(0, Math.min(0.5, opts.valSplit ?? 0.2));
  const names    = opts.names || null;
  const data = _shuffle(samples.slice());
  const nVal = Math.floor(data.length * valSplit);
  const val = data.slice(0, nVal), train = data.slice(nVal);
  const model = new OnlineLogistic(dim, { lr: opts.lr ?? 0.06, l2: opts.l2 ?? 1e-3, names });
  if (opts.warmFrom) model.load(opts.warmFrom);
  let bestVal = Infinity, bestW = model.w.slice(), bestB = model.b, bestEpoch = 0;
  const history = [];
  for (let e = 1; e <= epochs; e++) {
    _shuffle(train);
    for (const { x, y } of train) model.update(x, y);
    const trLoss = meanLogLoss(model, train);
    const vaLoss = val.length ? meanLogLoss(model, val) : trLoss;
    history.push({ epoch: e, trainLoss: +trLoss.toFixed(4), valLoss: +vaLoss.toFixed(4) });
    if (vaLoss <= bestVal) { bestVal = vaLoss; bestW = model.w.slice(); bestB = model.b; bestEpoch = e; }
  }
  model.w = bestW; model.b = bestB;          // restore best-validation weights
  model.n = samples.length;                  // influence reflects total data trained on
  model.loss = meanLogLoss(model, train);
  return {
    model, history, bestEpoch,
    trainLoss: meanLogLoss(model, train),
    valLoss: val.length ? meanLogLoss(model, val) : null,
    valAccuracy: val.length ? accuracyOf(model, val) : null,
    trainSize: train.length, valSize: val.length
  };
}


// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  PART 2 — ♀ VENUS · the Research AI  (web + SEC 13F + news → watchlist)    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ── Provider selection ──────────────────────────────────────────────────────
const GROQ_KEY      = process.env.GROQ_API_KEY      || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const FORCED        = (process.env.AI_PROVIDER || '').toLowerCase();

let PROVIDER = '';
if (FORCED === 'groq' && GROQ_KEY)                PROVIDER = 'groq';
else if (FORCED === 'anthropic' && ANTHROPIC_KEY) PROVIDER = 'anthropic';
else if (!FORCED && GROQ_KEY)                     PROVIDER = 'groq';
else if (!FORCED && ANTHROPIC_KEY)                PROVIDER = 'anthropic';

const DEFAULT_MODELS = { groq: 'openai/gpt-oss-120b', anthropic: 'claude-sonnet-4-6' };
// MUTABLE (v11.21): resolved against the provider's live model list at boot.
// A hardcoded model id is a time bomb — `llama-3.3-70b-versatile` was retired by Groq
// and Venus then failed EVERY cycle for a whole session ("does not exist or you do not
// have access to it"), silently killing all news analysis while the engine looked
// healthy. Pinning a new name just resets the timer, so instead we ask the provider
// what it actually serves and pick the best available.
let AI_MODEL = PROVIDER ? (process.env.AI_MODEL || DEFAULT_MODELS[PROVIDER]) : null;

// Preference order for Groq chat models, best-for-this-job first. Anything not on this
// list is ignored — the account also exposes speech (whisper), TTS (orpheus) and
// classifier (prompt-guard) models that cannot do JSON reasoning.
const GROQ_CHAT_PREFERENCE = [
  'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b',
  'groq/compound', 'groq/compound-mini', 'openai/gpt-oss-safeguard-20b',
  'llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant'
];

function httpsGetJson(host, path, headers) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(th); resolve(v); } };
    const th = setTimeout(() => { try { req.destroy(); } catch {} finish(null); }, 10000);
    const req = https.request({ host, path, method: 'GET', headers }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { finish(JSON.parse(b)); } catch { finish(null); } });
    });
    req.on('error', () => finish(null));
    req.end();
  });
}

// Ask the provider which models it actually serves and adopt the best usable one.
// Returns the resolved id, or null if the check could not run (we then keep the
// configured value and let the normal error path report it).
async function resolveAiModel() {
  if (PROVIDER !== 'groq' || !GROQ_KEY) return AI_MODEL;      // only Groq exposes a list we use
  const j = await httpsGetJson('api.groq.com', '/openai/v1/models', { authorization: 'Bearer ' + GROQ_KEY });
  const ids = (j && Array.isArray(j.data)) ? j.data.map(m => m && m.id).filter(Boolean) : null;
  if (!ids || !ids.length) {
    console.warn('[VENUS] Could not read the Groq model list — keeping configured model ' + AI_MODEL);
    return AI_MODEL;
  }
  // An explicitly configured model wins IF the account can actually serve it.
  if (process.env.AI_MODEL) {
    if (ids.includes(process.env.AI_MODEL)) { AI_MODEL = process.env.AI_MODEL; return AI_MODEL; }
    console.warn(`[VENUS] AI_MODEL="${process.env.AI_MODEL}" is not available on this key — auto-selecting instead.`);
  }
  const picked = GROQ_CHAT_PREFERENCE.find(m => ids.includes(m));
  if (!picked) {
    console.error(`[VENUS] ⚠️ None of the known chat models are available on this key. Saw: ${ids.join(', ')}`);
    console.error('[VENUS]   Venus news analysis will not work until AI_MODEL is set to a chat model this key can serve.');
    return AI_MODEL;
  }
  if (picked !== AI_MODEL) console.log(`[VENUS] Model auto-selected: ${picked} (configured "${AI_MODEL}" unavailable)`);
  else                     console.log(`[VENUS] Model confirmed available: ${picked}`);
  AI_MODEL = picked;
  return AI_MODEL;
}
// Venus's calibration learning rate. VENUS_CALIB_LR is correct (this IS Venus's model);
// JUPITER_CALIB_LR is kept as a deprecated alias — it was backwards pre-v11.8.
const CALIB_LR = Math.max(0.005, Math.min(0.2, parseFloat(process.env.VENUS_CALIB_LR || process.env.JUPITER_CALIB_LR || '0.05')));

function isConfigured() { return !!PROVIDER; }

const CATALYSTS = new Set([
  'earnings','guidance','analyst','ma','product','regulatory',
  'legal','macro','insider','partnership','contract','other'
]);

// ── MECHANISMS (v11.22) — WHY would this trade pay? ──────────────────────────
// The architectural point of Venus is to form an idea, investigate it, and hand a
// reasoned setup to Jupiter. Until now it handed over a *catalyst* ("earnings") and
// a confidence number, which says what happened but not why anyone should profit.
// That is pattern-matching, and backtesting six such patterns found no persistent
// edge — they were either market beta, smaller than the fee, or decayed to zero.
//
// A tradeable idea needs a COUNTERPARTY STORY: who is on the other side of this
// trade, and why are they willing to lose money to me? If that question has no
// answer, there is no edge — only a shape on a chart that thousands of faster
// participants already found.
//
// These are the mechanisms with a real economic reason behind them:
const MECHANISMS = new Set([
  // Someone MUST trade regardless of price — index funds tracking a rebalance,
  // funds dumping a stock that fell out of an index, forced margin liquidation,
  // tax-loss selling. Price-insensitive sellers pay whoever absorbs their supply.
  'forced_flow',
  // Information is genuinely new and the stock is small/neglected enough that it
  // prices in slowly. The edge is being early where few analysts are looking.
  'slow_diffusion',
  // Prices under-react to earnings surprises and drift for weeks afterward (PEAD).
  'underreaction',
  // Somebody needs liquidity NOW and pays a premium for immediacy — the classic
  // market-maker's edge, available when a name gaps on no fundamental news.
  'liquidity_premium',
  // A structural, calendar-driven flow: index adds/deletes, month-end rebalancing,
  // options-expiry pinning. Mechanical, documented, and dated in advance.
  'structural_flow',
  // Explicitly "no mechanism identified" — the honest answer, and the DEFAULT.
  // Ideas that land here are watchlist-grade only and never become trade signals.
  'none'
]);
// Only these carry a genuine counterparty story. 'none' is tracked but never traded.
const TRADEABLE_MECHANISMS = new Set(['forced_flow','slow_diffusion','underreaction','liquidity_premium','structural_flow']);

// ════════════════════════════════════════════════════════════════════════════
//  VENUS'S LEARNING — calibration models + per-catalyst track record
// ════════════════════════════════════════════════════════════════════════════
let calibGlobal = new PlattCalibrator({ lr: CALIB_LR });        // overall confidence calibration
let calibByCat  = {};                                          // catalyst → PlattCalibrator
let calibration = {};                                          // catalyst → {wins,losses,totalPnL}
// Per-MECHANISM outcomes. Catalyst says what happened; mechanism says why it should
// pay. Tracking the latter is how Venus learns which counterparty stories are real.
let mechanismRecord = {};                                      // mechanism → {wins,losses,totalPnL}
let mechanismStats  = { rejectedNoMechanism: 0, byMechanism: {} };
let learnLog    = [];                                          // last 200 learned outcomes
let calibLog    = [];                                          // experience replay buffer: {rawConv,cat,won}

function catCalibrator(cat) {
  if (!calibByCat[cat]) calibByCat[cat] = new PlattCalibrator({ lr: CALIB_LR });
  return calibByCat[cat];
}

// Apply learned calibration to a raw LLM conviction for a given catalyst.
// Blends the per-catalyst and global calibrators by how much data each has.
function calibrateConviction(rawConv, cat) {
  const cc = catCalibrator(cat);
  const pc = cc.calibrate(rawConv);            // per-catalyst view
  const pg = calibGlobal.calibrate(rawConv);   // global view
  const wc = cc.n / (cc.n + 12);               // trust per-catalyst more as it gains data
  const blended = pg * (1 - wc) + pc * wc;
  // Keep within the sane signalling band
  return Math.max(0.5, Math.min(0.95, blended));
}

// Jupiter reports an outcome back here when a Venus-recommended trade closes.
// Venus updates BOTH its statistical record AND its calibration models.
function learn(outcome) {
  if (!outcome || !outcome.catalyst) return;
  const cat = CATALYSTS.has(outcome.catalyst) ? outcome.catalyst : 'other';
  const pnl = Number(outcome.pnl) || 0;
  const won = pnl >= 0 ? 1 : 0;
  const rawConv = Number(outcome.convictionRaw ?? outcome.conviction) || 0.6;

  // Statistical record
  calibration[cat] = calibration[cat] || { wins: 0, losses: 0, totalPnL: 0 };
  if (won) calibration[cat].wins++; else calibration[cat].losses++;
  calibration[cat].totalPnL += pnl;

  // Same record, keyed by the REASON the trade was supposed to work.
  const mech = MECHANISMS.has(outcome.mechanism) ? outcome.mechanism : 'none';
  mechanismRecord[mech] = mechanismRecord[mech] || { wins: 0, losses: 0, totalPnL: 0 };
  if (won) mechanismRecord[mech].wins++; else mechanismRecord[mech].losses++;
  mechanismRecord[mech].totalPnL += pnl;

  // Learning models (this is the real "gets smarter as it goes" part)
  calibGlobal.update(rawConv, won);
  catCalibrator(cat).update(rawConv, won);

  // Accumulate experience for offline specialization (capped)
  calibLog.push({ rawConv: +rawConv.toFixed(4), cat, won });
  if (calibLog.length > 4000) calibLog = calibLog.slice(-4000);

  learnLog.push({
    catalyst: cat, ticker: outcome.ticker || '', direction: outcome.direction || '',
    convictionRaw: +rawConv.toFixed(2), pnl: +pnl.toFixed(2),
    correct: !!won, at: new Date().toISOString()
  });
  if (learnLog.length > 200) learnLog = learnLog.slice(-200);

  const s = calibration[cat];
  const shift = catCalibrator(cat).shift();
  console.log(`[VENUS] 📚 Learned ${outcome.ticker || '?'} ${outcome.direction || ''} $${pnl.toFixed(2)} → ${cat} ${s.wins}W/${s.losses}L | calib shift ${shift >= 0 ? '+' : ''}${shift}`);
}

function getCalibration() { return calibration; }

// ── Offline specialization: refit calibrators over the accumulated experience ──
// Multi-pass training over calibLog makes Venus's confidence calibration sharper
// and more catalyst-specialized than single-pass online updates. Reports the Brier
// score (mean squared calibration error) before/after so improvement is measurable.
function trainOffline(opts = {}) {
  const epochs = Math.max(1, Math.min(200, opts.epochs ?? 12));
  if (calibLog.length < 10) return { ok: false, reason: 'need ≥10 resolved recommendations to train', samples: calibLog.length };
  const brier = (calFn) => calibLog.reduce((s, r) => s + Math.pow(calFn(r.rawConv, r.cat) - r.won, 2), 0) / calibLog.length;
  const before = brier(calibrateConviction);                 // uses current calibrators
  const ng = new PlattCalibrator({ lr: CALIB_LR });
  const byCat = {};
  for (let e = 0; e < epochs; e++) {
    const rows = _shuffle(calibLog.slice());
    for (const r of rows) {
      ng.update(r.rawConv, r.won);
      (byCat[r.cat] || (byCat[r.cat] = new PlattCalibrator({ lr: CALIB_LR }))).update(r.rawConv, r.won);
    }
  }
  calibGlobal = ng; calibByCat = byCat;                      // adopt the specialized calibrators
  // Multi-epoch training inflates each calibrator's update counter (unique × epochs).
  // Reset n to the TRUE unique-sample counts so trust-weighting (and reported sample
  // counts) stay meaningful and consistent with online operation.
  const catCounts = {};
  for (const r of calibLog) catCounts[r.cat] = (catCounts[r.cat] || 0) + 1;
  calibGlobal.n = calibLog.length;
  for (const [cat, c] of Object.entries(byCat)) c.n = catCounts[cat] || 0;
  const after = brier(calibrateConviction);
  console.log(`[VENUS] 🎓 Offline calibration: ${calibLog.length} samples × ${epochs} epochs → Brier ${before.toFixed(4)} → ${after.toFixed(4)}`);
  return {
    ok: true, samples: calibLog.length, epochs,
    brierBefore: +before.toFixed(4), brierAfter: +after.toFixed(4),
    globalShift: calibGlobal.shift(),
    perCatalyst: Object.fromEntries(Object.entries(byCat).map(([k, c]) => [k, { samples: c.n, shift: c.shift() }]))
  };
}

// Seed calibration experience from an external dataset (for bootstrapping).
// rows: [{ conviction|rawConv, catalyst, pnl|won }]
function ingestCalibrationData(rows) {
  let added = 0;
  for (const r of (rows || [])) {
    const rawConv = Number(r.rawConv ?? r.conviction);
    if (!Number.isFinite(rawConv)) continue;
    const cat = CATALYSTS.has(r.catalyst) ? r.catalyst : 'other';
    const won = (r.won != null) ? (r.won >= 0.5 ? 1 : 0) : ((Number(r.pnl) || 0) >= 0 ? 1 : 0);
    calibLog.push({ rawConv: +Math.max(0.5, Math.min(0.95, rawConv)).toFixed(4), cat, won });
    added++;
  }
  if (calibLog.length > 4000) calibLog = calibLog.slice(-4000);
  return added;
}

function getTrainStats() { return { calibrationSamples: calibLog.length }; }

function getState() {
  const resolved = learnLog.length;
  const correct  = learnLog.filter(o => o.correct).length;
  return {
    enabled: !!PROVIDER,
    provider: PROVIDER || null,
    model: AI_MODEL,
    accuracy: resolved > 0 ? ((correct / resolved) * 100).toFixed(0) + '%' : null,
    resolvedRecommendations: resolved,
    // The learning model's state — proof it's a real AI that improves
    learning: {
      calibrationSamples: calibGlobal.n,
      trainingSamples: calibLog.length,
      globalConfidenceShift: calibGlobal.shift(),   // how much it bends a 0.7 now
      perCatalystShift: Object.fromEntries(
        Object.entries(calibByCat)
          .filter(([, c]) => c.n >= 1)
          .map(([cat, c]) => [cat, { samples: c.n, shift: c.shift() }])
      )
    },
    // WHICH REASONS ACTUALLY PAY. This is the number that tells you whether Venus is
    // finding real edges or just labelling patterns — a mechanism with a losing record
    // over a real sample is a story that isn't true.
    mechanisms: {
      rejectedNoMechanism: mechanismStats.rejectedNoMechanism,
      proposed: mechanismStats.byMechanism,
      record: Object.fromEntries(Object.entries(mechanismRecord).map(([m, r]) => {
        const tot = r.wins + r.losses;
        return [m, { wins: r.wins, losses: r.losses,
                     winRate: tot ? ((r.wins / tot) * 100).toFixed(0) + '%' : '—',
                     totalPnL: +(r.totalPnL || 0).toFixed(2) }];
      }))
    },
    calibration: Object.fromEntries(Object.entries(calibration).map(([cat, s]) => {
      const total = s.wins + s.losses;
      return [cat, {
        wins: s.wins, losses: s.losses,
        accuracy: total ? ((s.wins / total) * 100).toFixed(0) + '%' : '—',
        totalPnL: +(s.totalPnL || 0).toFixed(2)
      }];
    })),
    recentLearnings: learnLog.slice(-30)
  };
}

function serialize() {
  return {
    calibration,
    mechanismRecord,
    learnLog: learnLog.slice(-200),
    calibLog: calibLog.slice(-4000),
    calibGlobal: calibGlobal.toJSON(),
    calibByCat: Object.fromEntries(Object.entries(calibByCat).map(([k, c]) => [k, c.toJSON()]))
  };
}
function venusLoadState(s) {
  if (!s || typeof s !== 'object') return;
  if (s.calibration && typeof s.calibration === 'object') calibration = s.calibration;
  if (s.mechanismRecord && typeof s.mechanismRecord === 'object') mechanismRecord = s.mechanismRecord;
  if (Array.isArray(s.learnLog)) learnLog = s.learnLog.slice(-200);
  if (Array.isArray(s.calibLog)) calibLog = s.calibLog.filter(r => r && Number.isFinite(r.rawConv)).slice(-4000);
  if (s.calibGlobal) calibGlobal.load(s.calibGlobal);
  if (s.calibByCat && typeof s.calibByCat === 'object') {
    Object.entries(s.calibByCat).forEach(([k, o]) => { catCalibrator(k).load(o); });
  }
}

// ── Generic HTTPS POST ──────────────────────────────────────────────────────
function httpsPost(host, path, headers, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    let done = false;
    const req = https.request({
      host, path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, headers)
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (done) return; done = true; clearTimeout(th);
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { return resolve({ ok:false, error:'bad-json-response' }); }
        if (res.statusCode === 401 || res.statusCode === 403)
          return resolve({ ok:false, error:`auth-failed (check your ${PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'})` });
        if (res.statusCode === 429) return resolve({ ok:false, error:'rate-limited' });
        if (res.statusCode === 529 || res.statusCode === 503) return resolve({ ok:false, error:'api-overloaded' });
        if (res.statusCode >= 400) return resolve({ ok:false, error: parsed?.error?.message || ('http-' + res.statusCode) });
        resolve({ ok:true, data: parsed });
      });
    });
    req.on('error', e => { if (!done) { done = true; clearTimeout(th); resolve({ ok:false, error:e.message }); } });
    const th = setTimeout(() => { if (!done) { done = true; req.destroy(); resolve({ ok:false, error:'timeout' }); } }, 45000);
    req.write(payload);
    req.end();
  });
}

async function callGroq(prompt) {
  const r = await httpsPost('api.groq.com', '/openai/v1/chat/completions',
    { 'authorization': 'Bearer ' + GROQ_KEY },
    { model: AI_MODEL, max_tokens: 1200, temperature: 0.2, messages: [{ role: 'user', content: prompt }] });
  if (!r.ok) return r;
  const text = r.data?.choices?.[0]?.message?.content || '';
  const u    = r.data?.usage || {};
  return { ok:true, text, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 } };
}
async function callAnthropic(prompt) {
  const r = await httpsPost('api.anthropic.com', '/v1/messages',
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    { model: AI_MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
  if (!r.ok) return r;
  const text = (r.data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('').trim();
  const u    = r.data?.usage || {};
  return { ok:true, text, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 } };
}

// ── Build the analysis prompt — includes Venus's learned calibration ──────
function buildPrompt(articles) {
  const accuracyLines = Object.entries(calibration)
    .filter(([, s]) => (s.wins + s.losses) >= 2)
    .map(([cat, s]) => {
      const total = s.wins + s.losses;
      const acc = ((s.wins / total) * 100).toFixed(0);
      const shift = catCalibrator(cat).shift();
      const tag = shift <= -0.03 ? ' (you tend to be OVERconfident here)' : (shift >= 0.03 ? ' (you tend to be UNDERconfident here)' : '');
      return `  • ${cat}: ${acc}% correct over ${total} resolved (net $${(s.totalPnL || 0).toFixed(2)})${tag}`;
    });

  const articleBlock = articles.map((a, i) =>
    `[${i + 1}] (${a.source || 'unknown'}, ${a.created_at || ''}) symbols=[${(a.symbols || []).join(',')}]\n` +
    `HEADLINE: ${a.headline}\n` + (a.summary ? `SUMMARY: ${String(a.summary).slice(0, 400)}\n` : '')
  ).join('\n');

  return `You are VENUS, the research engine of a US-equity trading system. You form ideas,
investigate them, and hand only the defensible ones to the trading engine (Jupiter).

THE ONE QUESTION THAT MATTERS: for each idea, WHO is on the other side of this trade,
and WHY are they willing to lose money to us? A price pattern is not an answer —
patterns are found instantly by faster participants and stop working. A trade is only
worth taking when you can name the counterparty and their reason.

Backtesting confirmed this the hard way: six pattern-based strategies were tested on
this exact universe and NONE had a persistent edge. They were market drift in disguise,
smaller than trading costs, or decayed to nothing in recent data. Do not hand over
another pattern. Hand over a situation with a mechanism.

${accuracyLines.length ? `YOUR OWN TRACK RECORD & CALIBRATION BY CATALYST (a learning model derived this from
real outcomes — heed the OVER/UNDERconfident notes when setting conviction):
${accuracyLines.join('\n')}\n` : ''}
MECHANISMS — pick the one that genuinely applies, or "none":
  forced_flow       someone MUST trade regardless of price (index rebalance, fund
                    forced to sell a deleted name, margin liquidation, tax-loss
                    selling). Price-insensitive sellers pay whoever absorbs them.
  slow_diffusion    genuinely new information in a small/neglected name that few
                    analysts cover, so it prices in over hours-days rather than seconds.
  underreaction     an earnings surprise the market is under-reacting to; documented
                    to drift for weeks afterward.
  liquidity_premium someone needs out NOW and pays for immediacy — a gap on no real
                    fundamental news, where we are paid to provide liquidity.
  structural_flow   a dated, mechanical flow: index add/delete, month-end rebalance,
                    options-expiry pinning.
  none              you cannot name a counterparty or reason. THIS IS THE RIGHT ANSWER
                    MOST OF THE TIME and costs you nothing.

RULES:
- US-listed common stocks only. Skip ETFs, indices, crypto, foreign listings, OTC.
- A mega-cap reacting to widely-covered news is almost never an edge — it is priced in
  within seconds by participants far faster than us. Prefer neglect over headlines.
- If the only thing you can say is "this seems bullish", the mechanism is "none".
- conviction is YOUR probability the direction is right, 0.50-0.95. Be honest; an empty
  array is an EXCELLENT answer and is expected on most cycles.
- counterparty: one short phrase naming who loses and why. Required when mechanism is
  not "none". If you cannot write it, the mechanism IS "none".
- catalyst ∈ {earnings, guidance, analyst, ma, product, regulatory, legal, macro, insider, partnership, contract, other}
- horizon_minutes: how long the edge likely lasts (30-390).
- Max 6 recommendations. One per symbol.

NEWS ITEMS:
${articleBlock}

Respond with ONLY a JSON array (no fences, no commentary):
[{"symbol":"TICKER","direction":"long"|"short","conviction":0.0,"catalyst":"...",
  "mechanism":"forced_flow|slow_diffusion|underreaction|liquidity_premium|structural_flow|none",
  "counterparty":"who loses and why, one phrase",
  "horizon_minutes":120,"reasoning":"one short sentence"}]
If nothing qualifies: []`;
}

// Is this idea allowed to become a trade signal? Pure and exported so the gate is
// regression-testable without a live LLM call — analyze() needs the network, so a test
// that only covered validateRec left this path unguarded (mutation testing caught it).
function isTradeableIdea(rec) {
  if (!rec) return false;
  if (!TRADEABLE_MECHANISMS.has(rec.mechanism)) return false;
  if (!rec.counterparty || String(rec.counterparty).trim().length < 8) return false;
  return true;
}

function validateRec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol || '').toUpperCase().trim();
  if (!/^[A-Z]{1,5}$/.test(symbol)) return null;
  const direction = raw.direction === 'long' || raw.direction === 'short' ? raw.direction : null;
  if (!direction) return null;
  let conviction = Number(raw.conviction);
  if (!Number.isFinite(conviction)) return null;
  conviction = Math.max(0, Math.min(0.95, conviction));
  if (conviction < 0.5) return null;
  const catalyst = CATALYSTS.has(raw.catalyst) ? raw.catalyst : 'other';
  // MECHANISM (v11.22). Unknown/absent collapses to 'none' — an idea with no named
  // counterparty is watchlist-grade, never a trade signal. A counterparty phrase is
  // required alongside a real mechanism: if the model cannot say who loses and why,
  // it does not actually have a mechanism, whatever label it picked.
  let mechanism = MECHANISMS.has(raw.mechanism) ? raw.mechanism : 'none';
  const counterparty = String(raw.counterparty || '').slice(0, 160).trim();
  if (mechanism !== 'none' && counterparty.length < 8) mechanism = 'none';
  let horizon = parseInt(raw.horizon_minutes, 10);
  if (!Number.isFinite(horizon)) horizon = 120;
  horizon = Math.max(30, Math.min(390, horizon));
  const reasoning = String(raw.reasoning || '').slice(0, 200);
  return { symbol, direction, conviction, catalyst, mechanism, counterparty, horizonMinutes: horizon, reasoning };
}

// Parsed LLM array -> validated, calibrated, mechanism-gated recommendations.
// Split out of analyze() so the FULL pipeline (validate -> calibrate -> mechanism gate
// -> dedupe) is testable without a network call. Testing the gate predicate alone left
// analyze() free to skip calling it, which mutation testing caught.
function recsFromParsed(parsed) {
  const bySymbol = {};
  for (const raw of (Array.isArray(parsed) ? parsed : []).slice(0, 10)) {
    const rec = validateRec(raw);
    if (!rec) continue;
    // Apply LEARNED calibration: keep the LLM's raw conviction for training, but
    // hand Jupiter the empirically-calibrated conviction for decision-making.
    rec.convictionRaw = rec.conviction;
    rec.conviction    = calibrateConviction(rec.conviction, rec.catalyst);
    // An idea with no counterparty story is not tradeable, however confident the model
    // sounds. This is the gate that stops Venus handing Jupiter another chart pattern.
    if (!isTradeableIdea(rec)) { mechanismStats.rejectedNoMechanism++; continue; }
    mechanismStats.byMechanism[rec.mechanism] = (mechanismStats.byMechanism[rec.mechanism] || 0) + 1;
    if (!bySymbol[rec.symbol] || rec.conviction > bySymbol[rec.symbol].conviction) bySymbol[rec.symbol] = rec;
  }
  return Object.values(bySymbol).slice(0, 6);
}

// ── Main entry: analyze articles → calibrated recommendations ───────────────
async function analyze(articles) {
  if (!PROVIDER) return { ok:false, error:'no-api-key (set GROQ_API_KEY or ANTHROPIC_API_KEY)' };
  if (!Array.isArray(articles) || articles.length === 0) return { ok:true, recommendations: [], usage: null };

  const prompt = buildPrompt(articles.slice(0, 15));
  const r = PROVIDER === 'groq' ? await callGroq(prompt) : await callAnthropic(prompt);
  if (!r.ok) return { ok:false, error: r.error };

  const cleaned = r.text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('['), end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return { ok:false, error:'no-json-array-in-response' };

  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
  catch (e) { return { ok:false, error:'unparseable-json' }; }
  if (!Array.isArray(parsed)) return { ok:false, error:'not-an-array' };

  const recommendations = recsFromParsed(parsed);
  return { ok:true, recommendations, usage: r.usage || null, model: AI_MODEL, provider: PROVIDER };
}


// Venus's public surface (same shape Terra has always consumed, plus training).
// ════════════════════════════════════════════════════════════════════════════
//  VENUS RESEARCH — scan the web (SEC 13F institutional holdings) + news, see what
//  serious money holds and where the action is, and produce a WATCHLIST + ideas.
//
//  HONEST SCOPE: 13F filings are quarterly and lag ~45 days, so institutional data
//  is a "what large funds hold / are accumulating" signal for the WATCHLIST and
//  directional bias — NOT intraday timing. Individual "successful retail accounts"
//  cannot be scraped reliably or within terms of service, so Venus uses authoritative
//  SEC filings + live news catalysts + real-time relative volume. Every source
//  degrades gracefully: if one is unreachable, Venus uses the others and never crashes.
// ════════════════════════════════════════════════════════════════════════════

const SEC_UA = process.env.SEC_USER_AGENT || 'ATLAS-Centauri-research';
// SEC 13F lists holdings by company name/CUSIP, not ticker, so map the core universe.
// Unknown (dynamic) symbols fall back to querying the ticker itself.
// v11.19: the original map only covered mega-caps that AREN'T in WATCHLISTS below —
// only JPM actually overlapped. Every other core-watchlist symbol was falling back to
// `symbol` itself as the SEC full-text search query (e.g. searching literally "PLTR"
// instead of "Palantir Technologies"), which is a weak/noisy match against 13F filing
// text — Venus's institutional-interest signal was effectively broken for the stocks
// this bot actually trades. Filled in the real issuer names for the whole watchlist.
const COMPANY_NAMES = {
  // core NASDAQ watchlist
  PLTR:'Palantir Technologies', SOFI:'SoFi Technologies', MARA:'MARA Holdings',
  HOOD:'Robinhood Markets', SOUN:'SoundHound AI', IONQ:'IonQ',
  RKLB:'Rocket Lab USA', BBAI:'BigBear.ai Holdings', HIMS:'Hims & Hers Health', CIFR:'Cipher Mining',
  // core NYSE watchlist
  F:'Ford Motor', BAC:'Bank of America', JPM:'JPMorgan Chase', WFC:'Wells Fargo',
  GE:'General Electric', XOM:'Exxon Mobil', MRK:'Merck', JNJ:'Johnson & Johnson',
  PFE:'Pfizer', KO:'Coca-Cola',
  // extra mega-caps, kept for when a dynamic (Venus-discovered) symbol lands on one
  AAPL:'Apple Inc', MSFT:'Microsoft Corp', NVDA:'NVIDIA Corp', AMZN:'Amazon.com',
  GOOGL:'Alphabet Inc', META:'Meta Platforms', TSLA:'Tesla Inc', AMD:'Advanced Micro Devices',
  NFLX:'Netflix Inc', V:'Visa Inc', AVGO:'Broadcom Inc'
};
const _instCache = {};   // symbol → { filings, score, at } ; 13F is quarterly so cache 12h

function secGet(path) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(th); resolve(v); } };
    // Hard wall-clock timeout. req.setTimeout only fires on socket INACTIVITY — a server
    // that keeps trickling bytes (headers sent, body stalled) never trips it. This does.
    const th = setTimeout(() => { try { req.destroy(); } catch {} finish(null); }, 8000);
    let req;
    try {
      req = https.request(
        { hostname: 'efts.sec.gov', path, method: 'GET',
          headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' } },
        (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { finish(JSON.parse(b)); } catch { finish(null); } }); }
      );
      req.on('error', () => finish(null));
      req.end();
    } catch { finish(null); }
  });
}

// 13F filing count → [0,1] institutional-interest score.
// v11.19: the divisor was `2`, which saturated at 1.0 by just 100 filings — and every
// real US-listed stock has thousands, so 242 filings and 10,000+ scored IDENTICALLY.
// Live effect: every watchlist symbol scored 1.0, which pinned conviction at 0.65–0.70
// across the board (the "conv 65/66/67%" wall in the logs) — the signal carried zero
// information while presenting as confident research. `/4` spreads the realistic
// 50–10,000 range across roughly [0.43, 1.0] so it can actually discriminate.
// Pure + exported so the discrimination property is regression-tested.
function institutionalScore(filings) {
  const f = Number(filings);
  if (!Number.isFinite(f) || f <= 0) return 0;
  return Math.max(0, Math.min(1, Math.log10(1 + f) / 4));
}

// Recent 13F-HR filings that mention a company → institutional-interest score (cached).
async function institutionalInterest(symbol) {
  const cached = _instCache[symbol];
  if (cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached;
  const name = COMPANY_NAMES[symbol] || symbol;
  const data = await secGet(`/LATEST/search-index?q=${encodeURIComponent('"' + name + '"')}&forms=13F-HR`);
  let filings = 0, capped = false;
  if (data && data.hits) {
    filings = (data.hits.total && Number.isFinite(data.hits.total.value)) ? data.hits.total.value
            : (Array.isArray(data.hits.hits) ? data.hits.hits.length : 0);
    // Elasticsearch caps total at 10,000 with relation 'gte' — the real count is higher.
    capped  = !!(data.hits.total && data.hits.total.relation === 'gte');
  }
  const score = institutionalScore(filings);
  const out = { filings, capped, score, at: Date.now() };
  _instCache[symbol] = out;
  return out;
}

// Direction for a research idea — NEWS ONLY (v11.19). instScore is accepted purely to
// make the invariant explicit at the call site: institutional interest ranks what to
// WATCH, it never picks a side.
// This was `newsDir || (instScore >= 0.3 ? 'long' : null)`. Combined with the score
// saturation bug (see institutionalScore), instScore was always 1.0, so the test was
// always true and EVERY research idea was forced LONG — a structural long-only bias
// with no path to ever emit a short. Every rec in the live log was LONG. It is also
// wrong on the merits: 13F filings are QUARTERLY and lag ~45 days, so "institutions
// hold this" says nothing about direction today. This file's own header agrees ("a
// watchlist/bias signal, NOT intraday timing"). News decides the side; failing that,
// Terra's technical scan does — and that scan is fully direction-symmetric.
function ideaDirection(newsDir, instScore) {
  return (newsDir === 'long' || newsDir === 'short') ? newsDir : null;
}

const researchData = { watchlist: [], bySymbol: {}, lastRun: 0, institutions: 0, posture: null };

// The research pass. Combines institutional interest (13F) + the latest news analysis
// + real-time relative volume into a ranked watchlist with per-symbol ideas, shaped as
// recommendations Jupiter can consume (symbol, direction, conviction, catalyst).
//   recs        = Venus's own news-analysis output (from analyze())
//   universe    = symbols to research (core + dynamic)
//   rvolOf(sym) = helper returning current relative volume (Terra provides it)
async function research({ recs = [], universe = [], rvolOf = () => 1, max = 8 } = {}) {
  const recBy = {};
  recs.forEach(r => { if (r && r.symbol) recBy[r.symbol] = r; });
  const symbols = Array.from(new Set([...universe, ...Object.keys(recBy)])).slice(0, 40);

  const bySymbol = {};
  let institutions = 0;
  for (const sym of symbols) {
    const inst = await institutionalInterest(sym).catch(() => ({ filings: 0, score: 0 }));
    if (inst.filings > 0) institutions++;
    const rec  = recBy[sym] || null;
    const rvol = Number(rvolOf(sym)) || 0;

    const newsConv = rec ? (rec.conviction || 0) : 0;
    const newsDir  = rec ? (rec.direction === 'short' ? 'short' : 'long') : null;
    const volScore = Math.max(0, Math.min(1, (rvol - 1) / 2));            // rvol 1→0, 3→1
    const score    = 0.45 * inst.score + 0.35 * newsConv + 0.20 * volScore;
    // DIRECTION comes from NEWS ONLY (v11.19).
    // This was `newsDir || (inst.score >= 0.3 ? 'long' : null)`. Combined with the
    // saturation bug above, inst.score was always 1.0, so that test was always true and
    // EVERY research idea was forced LONG — a structural long-only bias with no way to
    // ever emit a short (every single rec in the live log was LONG). It is also just
    // wrong on the merits: 13F filings are QUARTERLY and lag ~45 days, so "institutions
    // hold this" says nothing about direction TODAY. This file's own header says as much
    // ("a watchlist/bias signal, NOT intraday timing"), so honour it: institutional
    // interest ranks what to WATCH, and news (or Terra's own technical scan, which is
    // fully direction-symmetric) decides which WAY to trade.
    const direction = ideaDirection(newsDir, inst.score);
    const bias = direction === 'short' ? 'bearish' : direction === 'long' ? 'bullish' : 'neutral';

    const sources = [];
    if (inst.filings > 0) sources.push(`${inst.filings}${inst.capped ? '+' : ''} recent 13F filings`);
    if (rec)              sources.push(`news: ${rec.catalyst || 'catalyst'}`);
    if (rvol >= 1.5)      sources.push(`RVOL ${rvol.toFixed(1)}×`);

    // score      = composite RANKING metric (orders the watchlist; not a probability).
    // conviction = probability-like confidence on the SAME [0.5, 0.95] scale the LLM
    //   news pipeline uses. This matters: Jupiter's score-nudge math treats conviction
    //   as centered on 0.5 — feeding it a raw composite score (which runs much lower)
    //   made weak ideas nudge the WRONG direction. News-backed ideas inherit the
    //   (calibrated) news conviction with a small confirmation boost from institutions
    //   + volume; institutional-only ideas are honest watchlist-grade confidence
    //   (0.5–0.70) — enough to watch, rarely enough to trade on alone.
    const conviction = !direction ? 0
      : rec ? clip(newsConv + 0.10 * inst.score + 0.05 * volScore, 0.5, 0.95)
            : clip(0.5 + 0.15 * inst.score + 0.05 * volScore, 0.5, 0.95);

    bySymbol[sym] = {
      symbol: sym, score, bias, direction,
      conviction, catalyst: rec ? rec.catalyst : (inst.filings > 0 ? 'institutional' : 'momentum'),
      // Institutional interest alone is NOT a mechanism — 13F data is quarterly and
      // lags ~45 days, so it cannot explain why anyone loses to us today.
      mechanism: rec ? (rec.mechanism || 'none') : 'none',
      counterparty: rec ? (rec.counterparty || '') : '',
      institutional: inst.score, institutionalFilings: inst.filings,
      newsConviction: newsConv, rvol,
      rationale: sources.join(' · ') || 'no strong signal'
    };
  }

  const watchlist = Object.values(bySymbol).sort((a, b) => b.score - a.score).slice(0, max);
  researchData.watchlist = watchlist;
  researchData.bySymbol  = bySymbol;
  researchData.institutions = institutions;
  researchData.lastRun = Date.now();
  return { watchlist, bySymbol, institutions };
}

// Research ideas, shaped as recommendations Jupiter can consume (only actionable ones).
function researchRecommendations() {
  return researchData.watchlist
    // ≥0.55: meaningfully above the 0.5 neutral floor of the conviction scale. Below
    // that, a stored signal's nudge is ~zero or wrong-signed — pure noise in the scorer.
    // (Dynamic-watchlist candidates are additionally gated at AI_CONVICTION_MIN inside
    // Jupiter's consumeRecommendations.)
    .filter(w => w.direction && w.conviction >= 0.55 && TRADEABLE_MECHANISMS.has(w.mechanism))
    .map(w => ({
      symbol: w.symbol, direction: w.direction,
      conviction: w.conviction, convictionRaw: w.conviction,
      catalyst: w.catalyst, mechanism: w.mechanism || 'none', counterparty: w.counterparty || '',
      horizonMinutes: 240,
      reasoning: 'Venus research — ' + w.rationale
    }));
}

function getResearch()        {
  // Mirror Jupiter's staleness rule: a posture older than 90 min is marked stale so
  // consumers (Luna, the cycle) can see the reasoning has aged out.
  let posture = researchData.posture;
  if (posture) posture = { ...posture, ageMin: Math.round((Date.now() - (posture.at || 0)) / 60000), stale: (Date.now() - (posture.at || 0)) >= 90 * 60000 };
  return { watchlist: researchData.watchlist, institutions: researchData.institutions, lastRun: researchData.lastRun, count: Object.keys(researchData.bySymbol).length, posture };
}
function getResearchFor(sym)  { return researchData.bySymbol[sym] || null; }

// ── Venus REASONING — beyond the fixed formula. Venus's LLM looks at the whole
//    board (institutional 13F interest, news, relative volume, market context) and
//    forms its OWN view: an overall market posture and a refined, reasoned set of
//    ideas — including the discipline to say "stand aside" when conditions are poor.
//    Purely advisory: it can sharpen or veto an idea and set a cautious posture, but
//    its convictions still flow through Jupiter's sizing and Terra's risk gate.
async function assess(ctx = {}) {
  const names = researchData.watchlist.slice(0, 12).map(w =>
    `${w.symbol}: 13F=${(w.institutional||0).toFixed(2)} (${w.institutionalFilings||0} filings), news=${(w.newsConviction||0).toFixed(2)}${w.catalyst?` [${w.catalyst}]`:''}, RVOL=${(w.rvol||0).toFixed(1)}`
  ).join('\n');
  if (!names) return null;
  const prompt =
`You are VENUS, the research brain of an intraday US-equity trading bot. You are NOT bound to
any fixed scoring formula — reason for yourself and stay disciplined. Market context:
  • broad market stress (0 calm → 1 stressed): ${(ctx.stress ?? 0).toFixed(2)}
  • regime: ${ctx.regime || 'unknown'}
  • our recent win rate: ${(Number(ctx.sample) || 0) === 0 ? 'NO CLOSED TRADES YET (cold start — absence of data, NOT a losing streak; do not treat missing history as a reason for risk_off on its own)' : `${ctx.winRate != null ? (ctx.winRate*100).toFixed(0)+'%' : 'n/a'} over ${ctx.sample} trades`}

Candidate names (institutional interest from SEC 13F holdings, news conviction, relative volume):
${names}

Decide:
1) the overall market POSTURE for an account whose #1 job is survival ("risk_on" only when the
   edge is clearly there; "risk_off" when it isn't — bias toward caution),
2) which names are genuinely worth watching and the directional bias, dropping the weak ones,
3) any names to AVOID.
Output ONLY JSON:
{"posture":"risk_on|neutral|risk_off","reasoning":"one sentence","avoid":["SYM"],
 "ideas":[{"symbol":"SYM","direction":"long|short|none","conviction":0.0-1.0,"why":"short"}]}`;

  const out = await llmReason(prompt);
  if (!out) return null;

  const stance = ['risk_on','neutral','risk_off'].includes(out.posture) ? out.posture : 'neutral';
  researchData.posture = {
    stance,
    reasoning: String(out.reasoning || '').slice(0, 240),
    avoid: Array.isArray(out.avoid) ? out.avoid.slice(0, 10) : [],
    at: Date.now()
  };
  // Fold Venus's reasoned convictions back into the per-symbol research (bounded blend),
  // and let it veto names by marking direction 'none'.
  if (Array.isArray(out.ideas)) {
    for (const idea of out.ideas) {
      const sym = idea && idea.symbol; if (!sym || !researchData.bySymbol[sym]) continue;
      const row = researchData.bySymbol[sym];
      const c = Math.max(0, Math.min(1, Number(idea.conviction)));
      if (Number.isFinite(c)) row.conviction = +clip(0.5 * row.conviction + 0.5 * c, 0, 0.95).toFixed(3);
      if (idea.direction === 'long' || idea.direction === 'short') row.direction = idea.direction;
      else if (idea.direction === 'none') { row.direction = null; row.conviction = 0; }
      if (idea.why) row.rationale = 'Venus: ' + String(idea.why).slice(0, 120);
    }
  }
  // Honor avoid-list and risk_off posture: drop or de-rate ideas Venus doesn't trust.
  const avoid = new Set(researchData.posture.avoid);
  for (const sym of Object.keys(researchData.bySymbol)) {
    if (avoid.has(sym)) { researchData.bySymbol[sym].direction = null; researchData.bySymbol[sym].conviction = 0; }
  }
  researchData.watchlist = Object.values(researchData.bySymbol).sort((a,b)=>b.conviction-a.conviction).slice(0, researchData.watchlist.length || 8);
  return researchData.posture;
}

// ── Venus's public surface: the RESEARCH engine (news analysis + web/13F + watchlist).
const venus = {
  isConfigured, PROVIDER,
  // getter, not a snapshot: AI_MODEL is resolved against the provider's live model
  // list at boot, so a copied value here would report the stale configured name.
  get AI_MODEL() { return AI_MODEL; },
  resolveAiModel,
  analyze, research, assess, researchRecommendations, getResearch, getResearchFor, institutionalInterest,
  learn, calibrateConviction, getCalibration, getState, serialize, loadState: venusLoadState,
  MECHANISMS, TRADEABLE_MECHANISMS, validateRec, isTradeableIdea, recsFromParsed,
  trainOffline, ingestCalibrationData, getTrainStats
};


// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  PART 3 — 🔭 JUPITER · the Trading AI  (online win-probability model + sizing) ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Feature names (order matters — must match _features()). All pre-scaled ~[-1,1].
const FEATURES = [
  'jupiterConv',   // calibrated Venus conviction, centered
  'catalystEdge',  // catalyst historical win-rate, centered
  'adx',           // trend strength
  'atr',           // volatility
  'rvol',          // relative volume
  'rsiAlign',      // RSI momentum in the trade's direction
  'momAlign',      // price momentum in the trade's direction
  'session',       // time of day (morning → afternoon)
  'regimeAlign',   // market regime in the trade's direction
  'spread'         // execution friction
];

function createJupiter(config = {}) {
  const SIGNAL_WEIGHT  = Math.min(0.20, Math.max(0, config.signalWeight ?? 0.12));
  const CONVICTION_MIN = Math.min(0.9, Math.max(0.5, config.convictionMin ?? 0.65));
  let   STRATEGY       = config.strategy || {};

  // Model hyperparameters (env-overridable, sane defaults). These control JUPITER'S
  // win-probability model. JUPITER_MODEL_* is correct; VENUS_MODEL_* is kept as a
  // deprecated alias — it was backwards pre-v11.8 (this factory builds Jupiter, not
  // Venus — see the createJupiter rename in v11.7).
  const MODEL_LR  = Math.max(0.005, Math.min(0.2,  parseFloat(process.env.JUPITER_MODEL_LR  || process.env.VENUS_MODEL_LR  || '0.06')));
  const MODEL_L2  = Math.max(0,     Math.min(0.05, parseFloat(process.env.JUPITER_MODEL_L2  || process.env.VENUS_MODEL_L2  || '0.001')));
  const MODEL_K   = Math.max(5,     Math.min(200,  parseInt(process.env.JUPITER_MODEL_PSEUDOCOUNT || process.env.VENUS_MODEL_PSEUDOCOUNT || '25', 10)));
  const MODEL_ON  = (process.env.JUPITER_MODEL || process.env.VENUS_MODEL || 'on').toLowerCase() !== 'off';

  // ── Jupiter-owned state ──
  let signals      = {};   // SYM → live recommendation (time-decaying)
  let outcomeLog   = [];    // resolved trades (trading-side record)
  let edgeSnapshot = { winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, sample: 0, riskFraction: 0.01 };

  // THE LEARNING MODEL — predicts P(win) for a setup; trained on every close.
  const winModel = new OnlineLogistic(FEATURES.length, { lr: MODEL_LR, l2: MODEL_L2, names: FEATURES });
  let pendingFeatures = {};   // 'SYM_DIR' → feature vector captured at entry, await outcome
  let trainLog        = [];   // experience replay buffer: {f,y,cat,dir,pnl,at} for offline training
  let lastModelEval   = null; // for diagnostics/dashboard

  // ── Jupiter's SELF-CHECK posture. Jupiter reasons about its own recent behaviour
  //    (win rate, drawdown, streaks, exposure) and may choose to carry LESS risk than
  //    the mechanical rules — never more. `multiplier` ∈ [0,1] only ever scales size
  //    DOWN; `hold` is an advisory pause on NEW entries (exits are never blocked).
  //    This is the engine keeping itself in check; the hard caps + Terra's gate remain
  //    absolute on top of it.
  let jupiterPosture = { multiplier: 1, hold: false, note: '', concerns: [], at: 0 };
  const POSTURE_TTL_MS = 90 * 60000;   // a self-check older than this decays to neutral,
                                       // so a stale LLM result can never freeze trading
  let lastTraining    = null; // summary of the last offline training run

  // Injected refs to Terra's live state + helpers, and a DIRECT Venus handle.
  let T = null, JUP = null;
  function init(terra) {
    T = terra;
    JUP = terra.venus || null;                 // direct, zero-latency link to Venus
    if (terra.strategy) STRATEGY = terra.strategy;
    edgeSnapshot.riskFraction = STRATEGY.RISK_PER_TRADE_BASE ?? 0.01;
  }

  // ── Feature extraction (pure, synchronous; all values pre-scaled ~[-1,1]) ──
  // Split into a direction-INDEPENDENT indicator read (_rawIndicators) and a
  // direction-dependent vector build (_featuresFrom). This lets the hot path build
  // both LONG and SHORT vectors from ONE indicator pass (no double computation),
  // and the final vector is sanitized so bad data can never reach the model.
  function _rawIndicators(symbol) {
    const h = T.helpers;
    const sig = signals[symbol];
    const conv = (sig && sig.expiresAt >= Date.now()) ? sig.conviction : 0.5;
    let catWin = 0.5, catKnown = false;
    if (sig && T.venus) {
      const cal = T.venus.getCalibration()[sig.catalyst];
      if (cal && (cal.wins + cal.losses) >= 2) { catWin = cal.wins / (cal.wins + cal.losses); catKnown = true; }
    }
    const adxData = h.adx ? h.adx(symbol) : null;
    const q       = h.quote ? h.quote(symbol) : null;
    return {
      conv, catWin, catKnown,
      adxRaw:     (adxData && Number.isFinite(adxData.adx)) ? adxData.adx : 18,
      atrRaw:     h.atrPct        ? h.atrPct(symbol)        : 0.02,
      rvolRaw:    h.calculateRVOL ? h.calculateRVOL(symbol) : 1.0,
      rsiRaw:     h.rsi           ? h.rsi(symbol)           : 50,
      momRaw:     (q && q.prevClose > 0 && Number.isFinite(q.price)) ? (q.price - q.prevClose) / q.prevClose : 0,
      sessionRaw: h.sessionFraction ? h.sessionFraction() : 0.5,
      regimeRaw:  h.regimeNumeric   ? h.regimeNumeric()    : 0,
      spreadRaw:  h.spread          ? h.spread(symbol)     : 0.001
    };
  }
  function _featuresFrom(R, direction) {
    const dir = (direction === 'SHORT' || direction === 'short') ? -1 : 1;
    const f = [
      clip((R.conv - 0.5) * 2, -1, 1),                  // jupiterConv
      R.catKnown ? clip((R.catWin - 0.5) * 2, -1, 1) : 0, // catalystEdge
      clip((R.adxRaw - 20) / 30, -1, 1),                // adx       (20→0, 50→1)
      clip((R.atrRaw - 0.02) / 0.03, -1, 1),            // atr       (2%→0)
      clip((R.rvolRaw - 1) / 1.5, -1, 1),               // rvol      (1.0→0)
      clip((dir * (R.rsiRaw - 50)) / 50, -1, 1),        // rsiAlign
      clip(dir * R.momRaw * 20, -1, 1),                 // momAlign
      clip((R.sessionRaw - 0.5) * 2, -1, 1),            // session
      clip(dir * R.regimeRaw, -1, 1),                   // regimeAlign
      clip((R.spreadRaw - 0.001) / 0.002, -1, 1)        // spread
    ];
    for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i])) f[i] = 0;  // NaN-proof
    return f;
  }
  function _features(symbol, direction) { return _featuresFrom(_rawIndicators(symbol), direction); }

  // Model P(win) for a setup, blended toward 0.5 by how much the model has learned.
  function _winProb(symbol, direction) {
    if (!MODEL_ON || !T) return { p: 0.5, raw: 0.5, n: winModel.n };
    const f = _features(symbol, direction);
    const raw = winModel.predict(f);
    const p = blendWithPrior(raw, winModel.n, MODEL_K, 0.5);
    return { p, raw, n: winModel.n, features: f };
  }

  // ── Venus → Jupiter: ingest recommendations ──
  function consumeRecommendations(recs) {
    const now = Date.now();
    const dynamicCandidates = [];
    for (const rec of (recs || [])) {
      // A re-reported idea must keep its ORIGINAL birth time. Previously createdAt and
      // expiresAt were stamped `now` on every cycle, so the time-decay term in
      // scoreAdjustment (which scales by remaining/total life) was pinned near full
      // strength forever — a 240-minute "horizon" refreshed every few minutes never
      // aged at all. Research that keeps saying the same thing is not new information.
      const prev = signals[rec.symbol];
      const sameIdea = prev && prev.direction === rec.direction && prev.catalyst === rec.catalyst
                       && prev.expiresAt > now;
      signals[rec.symbol] = {
        direction: rec.direction, conviction: rec.conviction,
        convictionRaw: rec.convictionRaw ?? rec.conviction,
        catalyst: rec.catalyst, mechanism: rec.mechanism || 'none',
        counterparty: rec.counterparty || '', reasoning: rec.reasoning,
        createdAt: sameIdea ? prev.createdAt : now,
        expiresAt: sameIdea ? prev.expiresAt : now + rec.horizonMinutes * 60000,
        traded: prev?.traded || false
      };
      // Log only genuinely new/changed ideas. Re-logging an unchanged watchlist every
      // cycle is what turned the live log into an unreadable wall of identical lines.
      if (!sameIdea || Math.abs((prev.conviction || 0) - rec.conviction) >= 0.05) {
        console.log(`[JUPITER] ◀ Venus rec: ${rec.direction.toUpperCase()} ${rec.symbol} conv ${(rec.conviction*100).toFixed(0)}% [${rec.catalyst}] — ${rec.reasoning}`);
      }
      if (rec.conviction >= CONVICTION_MIN) dynamicCandidates.push({ symbol: rec.symbol, rec });
    }
    return dynamicCandidates;
  }

  // ── Bounded score adjustment (HOT PATH — pure sync) ──
  // Combines Venus's conviction nudge with a small learned-model tilt; the
  // total stays within ±SIGNAL_WEIGHT and decays over the signal's life.
  function scoreAdjustment(symbol) {
    const sig = signals[symbol];
    const now = Date.now();
    const hasLive = sig && sig.expiresAt >= now;

    // Model tilt (works even with no Venus signal — Jupiter's own intelligence).
    // Build BOTH direction vectors from a single indicator pass (hot-path optimization).
    let modelTilt = 0;
    if (MODEL_ON && T && winModel.n >= 10) {
      const R = _rawIndicators(symbol);
      const long  = blendWithPrior(winModel.predict(_featuresFrom(R, 'LONG')),  winModel.n, MODEL_K, 0.5);
      const short = blendWithPrior(winModel.predict(_featuresFrom(R, 'SHORT')), winModel.n, MODEL_K, 0.5);
      // net "long-ness" the model sees, scaled into a fraction of the signal weight
      modelTilt = clip(long - short, -0.5, 0.5) * SIGNAL_WEIGHT * 0.6;
    }

    if (!hasLive) {
      if (modelTilt === 0) return { long: 0, short: 0, note: '' };
      return { long: modelTilt, short: -modelTilt, note: ` MODEL:${modelTilt >= 0 ? '+' : ''}${modelTilt.toFixed(3)}` };
    }

    const life  = sig.expiresAt - sig.createdAt;
    const decay = life > 0 ? Math.max(0, (sig.expiresAt - now) / life) : 0;
    const jupStrength = ((sig.conviction - 0.5) / 0.45) * SIGNAL_WEIGHT * decay;
    const dirSign = sig.direction === 'long' ? 1 : -1;
    // Both terms are in consistent "long-ness" units, so they simply add. (Earlier
    // code mishandled the sign for SHORT signals — agreement weakened them; fixed.)
    let favored = dirSign * jupStrength + modelTilt;
    favored = clip(favored, -SIGNAL_WEIGHT, SIGNAL_WEIGHT);   // hard bound
    const note = ` JUP:${sig.direction}@${(sig.conviction*100).toFixed(0)}%[${sig.catalyst}]` +
                 (winModel.n >= 10 ? ` +model` : '');
    return { long: favored, short: -favored, note };
  }

  function hasSignal(symbol) { const s = signals[symbol]; return !!s && s.expiresAt >= Date.now(); }
  function getSignal(symbol) { return signals[symbol] || null; }

  function markTraded(symbol, direction) {
    const sig = signals[symbol];
    if (!sig) return null;
    const matches = (sig.direction === 'long' && direction === 'LONG') ||
                    (sig.direction === 'short' && direction === 'SHORT');
    if (!matches) return null;
    sig.traded = true;
    return { catalyst: sig.catalyst, mechanism: sig.mechanism || 'none', conviction: sig.conviction, convictionRaw: sig.convictionRaw };
  }

  // ── Position sizing (HOT PATH — pure sync): dollar-risk × Kelly × MODEL ──
  function kellyRiskFraction() {
    const base = STRATEGY.RISK_PER_TRADE_BASE ?? 0.015;
    const cap  = STRATEGY.RISK_PER_TRADE_MAX  ?? 0.03;
    const kf   = STRATEGY.KELLY_FRACTION      ?? 0.25;
    const e = T.helpers.calculateTradeExpectancy();
    const sample = T.helpers.closedTradeCount();
    edgeSnapshot = { winRate: e.winRate, profitFactor: e.profitFactor, avgWin: e.avgWin, avgLoss: e.avgLoss, sample, riskFraction: base };
    if (sample < 20 || e.avgLoss <= 0 || e.winRate <= 0) { edgeSnapshot.riskFraction = base; return base; }
    const b = e.avgWin / e.avgLoss, p = e.winRate, q = 1 - p;
    const fullKelly = b > 0 ? (b * p - q) / b : 0;
    if (fullKelly <= 0) { edgeSnapshot.riskFraction = base * 0.5; return base * 0.5; }
    const blended = base * 0.5 + (fullKelly * kf) * 0.5;
    const out = Math.max(0.004, Math.min(cap, blended));
    edgeSnapshot.riskFraction = out;
    return out;
  }

  function computeSize(symbol, price, direction) {
    if (!T) return 0;
    if (!Number.isFinite(price) || price <= 0) return 0;
    const cap = STRATEGY.RISK_PER_TRADE_MAX ?? 0.03;

    const a = T.helpers.atrPct(symbol);
    const stopFrac = Math.max(0.004, (STRATEGY.ATR_STOP_MULT ?? 2.2) * a);
    const stopDistance = stopFrac * price;
    if (stopDistance <= 0) return 0;

    let riskFraction = kellyRiskFraction();

    // ── LEARNED MODEL multiplier — the AI's edge estimate, bounded ──
    if (MODEL_ON) {
      const dir = direction || (signals[symbol]?.direction === 'short' ? 'SHORT' : 'LONG');
      const wp = _winProb(symbol, dir);
      lastModelEval = { symbol, dir, pWin: +wp.p.toFixed(3), modelRaw: +wp.raw.toFixed(3), n: wp.n };
      const conf = clip((wp.p - 0.5) * 2, -1, 1);          // -1..1
      const mult = clip(1 + conf * 0.5, 0.5, 1.5);          // 0.5x..1.5x, grows with learning
      riskFraction *= mult;
    }

    const safeAdjust       = T.capitalSystem.safeMode ? 0.5 : 1.0;
    const aggrAdjust       = 0.7 + T.aiSystem.aggressionLevel * 0.45;
    const stressAdjust     = 1 - (T.helpers.calculateMarketStress() * 0.4);
    const lossStreakAdjust = Math.max(0.4, 1 - T.riskSystem.consecutiveLosses * 0.15);
    const drawdownAdjust   = Math.max(0.5, 1 - T.riskSystem.currentDrawdown * 2);
    const symbolAdjust     = T.helpers.isHighVolatility(symbol) ? 0.8 : 1.0;
    const rvol             = T.helpers.calculateRVOL(symbol);
    const volumeAdjust     = rvol < 0.5 ? 0.5 : 1.0;
    const gapAdjust        = T.helpers.getGapSizeAdjust(symbol);
    // Jupiter's own self-check — clamped to ≤1 so reasoning can only REDUCE size, never
    // lift it past the hard cap below. Ignored once stale, so it can never silently stick.
    const postureFresh     = (Date.now() - jupiterPosture.at) < POSTURE_TTL_MS;
    const postureAdjust    = postureFresh ? clip(jupiterPosture.multiplier, 0, 1) : 1;

    riskFraction *= safeAdjust * aggrAdjust * stressAdjust * lossStreakAdjust
                  * drawdownAdjust * symbolAdjust * volumeAdjust * gapAdjust * postureAdjust;
    if (!Number.isFinite(riskFraction)) return 0;              // never size on bad math
    riskFraction = Math.max(0, Math.min(cap, riskFraction));   // hard cap unchanged
    if (riskFraction <= 0) return 0;

    const equity = Math.max(0, T.capitalSystem.tradingCapital);
    let shares = Math.floor((equity * riskFraction) / stopDistance);
    if (!Number.isFinite(shares)) return 0;
    const maxShares = Math.floor((equity * 0.60) / price);
    if (maxShares >= 0) shares = Math.min(shares, maxShares);
    return Math.max(0, shares);
  }

  // ── Terra calls this the instant a position opens (any trade, AI-sourced or
  //    not) so the model captures the entry conditions to learn from later. ──
  function observeEntry(symbol, direction, price) {
    if (!MODEL_ON || !T) return;
    const key = symbol + '_' + (direction === 'SHORT' ? 'SHORT' : 'LONG');
    if (pendingFeatures[key]) return;             // keep first entry's features for adds
    pendingFeatures[key] = { f: _features(symbol, direction), at: Date.now() };
  }

  // ── Jupiter learning: record a closed trade, train the model, tell Venus ──
  function recordOutcome(trade) {
    if (!trade) return null;
    const pnl = Number(trade.realizedPnL ?? trade.pnl) || 0;
    const won = pnl >= 0 ? 1 : 0;
    const dir = trade.direction === 'SHORT' ? 'SHORT' : 'LONG';

    // TRAIN the win-probability model on the captured entry features
    const key = trade.ticker + '_' + dir;
    if (MODEL_ON && pendingFeatures[key]) {
      const before = winModel.loss;
      const fv = pendingFeatures[key].f;
      winModel.update(fv, won);
      // Accumulate experience for offline specialization (capped, rounded to save space)
      trainLog.push({ f: fv.map(v => +(+v).toFixed(4)), y: won, cat: trade.aiCatalyst || null, dir, pnl: +pnl.toFixed(2), at: Date.now() });
      if (trainLog.length > 4000) trainLog = trainLog.slice(-4000);
      delete pendingFeatures[key];
      console.log(`[JUPITER] 🧠 Model trained on ${trade.ticker} ${dir} (${won ? 'WIN' : 'loss'}) → ${winModel.n} samples, log-loss ${winModel.loss.toFixed(3)}${winModel.loss < before ? ' ↓' : ''}`);
    }

    outcomeLog.push({
      ticker: trade.ticker, direction: trade.direction,
      catalyst: trade.aiCatalyst || null,
      pnl: +pnl.toFixed(2), correct: !!won, at: new Date().toISOString()
    });
    if (outcomeLog.length > 200) outcomeLog = outcomeLog.slice(-200);

    // Report straight back to Venus (DIRECT call → zero latency) if AI-sourced
    if (!trade.aiCatalyst) return null;
    const outcome = {
      ticker: trade.ticker, direction: trade.direction,
      catalyst: trade.aiCatalyst, mechanism: trade.aiMechanism || 'none',
      conviction: trade.aiConviction || 0,
      convictionRaw: trade.aiConvictionRaw ?? trade.aiConviction ?? 0, pnl
    };
    console.log(`[JUPITER] ▶ Reporting outcome to Venus: ${trade.ticker} ${dir} $${pnl.toFixed(2)} [${trade.aiCatalyst}]`);
    if (JUP) JUP.learn(outcome);                 // tight, synchronous feedback loop
    return outcome;
  }

  // ── Offline specialization: replay accumulated trades over many epochs ──
  // Single-pass online learning sees each trade once; this re-trains the win-model
  // over the whole accumulated experience with shuffling + a validation hold-out,
  // keeping the best-validation weights. The result is a genuinely more specialized
  // model. Reports train/val loss so overfitting is visible.
  function trainOffline(opts = {}) {
    if (!MODEL_ON) return { ok: false, reason: 'model disabled (JUPITER_MODEL=off)' };
    if (trainLog.length < 20) return { ok: false, reason: 'need ≥20 closed trades to train', samples: trainLog.length };
    const samples = trainLog.map(r => ({ x: r.f, y: r.y }));
    const res = trainLogisticBatch(samples, FEATURES.length, {
      epochs: opts.epochs ?? 15, valSplit: opts.valSplit ?? 0.2,
      lr: opts.lr ?? MODEL_LR, l2: opts.l2 ?? MODEL_L2, names: FEATURES,
      warmFrom: opts.warmStart ? winModel.toJSON() : null
    });
    winModel.w = res.model.w.slice(); winModel.b = res.model.b;   // adopt specialized weights
    winModel.n = res.model.n; winModel.loss = res.trainLoss;
    const overfit = (res.valLoss != null && res.valLoss > res.trainLoss * 1.4);
    lastTraining = {
      at: new Date().toISOString(), samples: trainLog.length, bestEpoch: res.bestEpoch,
      trainLoss: +res.trainLoss.toFixed(4), valLoss: res.valLoss != null ? +res.valLoss.toFixed(4) : null,
      valAccuracy: res.valAccuracy != null ? +(res.valAccuracy * 100).toFixed(1) : null, overfitWarning: overfit
    };
    console.log(`[JUPITER] 🎓 Offline training: ${trainLog.length} samples, best epoch ${res.bestEpoch} → train-loss ${res.trainLoss.toFixed(4)}${res.valLoss != null ? `, val-loss ${res.valLoss.toFixed(4)}` : ''}${overfit ? ' ⚠ possible overfit' : ''}`);
    return { ok: true, ...lastTraining, topFactors: winModel.importance(6), history: res.history };
  }

  // Seed training experience from an external dataset (for bootstrapping a cold model).
  // rows: [{ features:[...10], win|pnl }] or [{ <featureName>:val, ... , win|pnl }]
  function ingestTrainingData(rows) {
    let added = 0;
    for (const r of (rows || [])) {
      let f = null;
      if (Array.isArray(r.features) && r.features.length === FEATURES.length) f = r.features;
      else if (FEATURES.every(n => typeof r[n] === 'number')) f = FEATURES.map(n => r[n]);
      if (!f) continue;
      const fv = f.map(v => (typeof v === 'number' && Number.isFinite(v)) ? +(+v).toFixed(4) : 0);
      const y = (r.win != null) ? (r.win >= 0.5 ? 1 : 0) : ((Number(r.pnl) || 0) >= 0 ? 1 : 0);
      trainLog.push({ f: fv, y, cat: r.catalyst || null, dir: r.direction || null, pnl: +(Number(r.pnl) || 0).toFixed(2), at: Date.now() });
      added++;
    }
    if (trainLog.length > 4000) trainLog = trainLog.slice(-4000);
    return added;
  }
  function getTrainStats() { return { samples: trainLog.length, lastTraining }; }

  function prune() {
    const now = Date.now();
    const expired = [];
    for (const sym of Object.keys(signals)) {
      if (signals[sym].expiresAt < now) { delete signals[sym]; expired.push(sym); }
    }
    return expired;
  }
  function activeSymbols() { return Object.keys(signals); }

  function getState() {
    const now = Date.now();
    const resolved = outcomeLog.length;
    const correct  = outcomeLog.filter(o => o.correct).length;
    return {
      signalWeight: SIGNAL_WEIGHT,
      // Jupiter's self-check posture — its own reasoning about how to carry risk now
      selfCheck: (() => {
        const fresh = (Date.now() - jupiterPosture.at) < POSTURE_TTL_MS;
        return {
          sizeMultiplier: fresh ? +clip(jupiterPosture.multiplier, 0, 1).toFixed(2) : 1,
          hold: fresh && jupiterPosture.hold === true,
          note: jupiterPosture.note || null,
          concerns: jupiterPosture.concerns || [],
          ageMin: jupiterPosture.at ? Math.round((Date.now() - jupiterPosture.at) / 60000) : null,
          stale: jupiterPosture.at ? !fresh : false
        };
      })(),
      activeSignals: Object.entries(signals).map(([sym, s]) => ({
        symbol: sym, direction: s.direction,
        conviction: (s.conviction * 100).toFixed(0) + '%',
        catalyst: s.catalyst, reasoning: s.reasoning,
        ageMin: Math.round((now - s.createdAt) / 60000),
        expiresInMin: Math.max(0, Math.round((s.expiresAt - now) / 60000)),
        traded: !!s.traded
      })),
      tradingAccuracy: resolved > 0 ? ((correct / resolved) * 100).toFixed(0) + '%' : null,
      resolvedTrades: resolved,
      edge: {
        winRate: (edgeSnapshot.winRate * 100).toFixed(0) + '%',
        profitFactor: edgeSnapshot.profitFactor === 999 ? '∞' : edgeSnapshot.profitFactor.toFixed(2),
        sample: edgeSnapshot.sample,
        riskPerTradePct: (edgeSnapshot.riskFraction * 100).toFixed(2) + '%'
      },
      // THE LEARNING MODEL's state — proof Jupiter is a real AI that improves
      model: {
        enabled: MODEL_ON,
        samples: winModel.n,
        trainingSamples: trainLog.length,            // accumulated experience for offline training
        logLoss: +winModel.loss.toFixed(3),         // trends DOWN as it learns
        winsSeen: winModel.wins, totalSeen: winModel.total,
        influence: (blendWithPrior(1, winModel.n, MODEL_K, 0.5) - 0.5).toFixed(2),  // 0→0.5 as it matures
        topFactors: winModel.importance(5),
        lastEval: lastModelEval,
        lastTraining,
        openTracked: Object.keys(pendingFeatures).length
      },
      recentOutcomes: outcomeLog.slice(-30)
    };
  }

  function serialize() {
    return {
      signals,
      outcomeLog: outcomeLog.slice(-200),
      winModel: winModel.toJSON(),
      pendingFeatures,
      trainLog: trainLog.slice(-4000)
    };
  }
  function loadState(s) {
    if (!s || typeof s !== 'object') return;
    const now = Date.now();
    if (Array.isArray(s.outcomeLog)) outcomeLog = s.outcomeLog.slice(-200);
    if (s.winModel) winModel.load(s.winModel);        // learning survives restarts
    if (Array.isArray(s.trainLog)) {
      trainLog = s.trainLog.filter(r => r && Array.isArray(r.f) && r.f.length === FEATURES.length
        && r.f.every(v => typeof v === 'number' && Number.isFinite(v))).slice(-4000);
    }
    if (s.pendingFeatures && typeof s.pendingFeatures === 'object') {
      // drop any stashed vectors that are malformed/non-finite (would poison the model)
      pendingFeatures = {};
      for (const [k, v] of Object.entries(s.pendingFeatures)) {
        if (v && Array.isArray(v.f) && v.f.length === FEATURES.length && v.f.every(n => Number.isFinite(n))) pendingFeatures[k] = v;
      }
    }
    if (s.signals && typeof s.signals === 'object') {
      Object.entries(s.signals).forEach(([sym, sig]) => { if (sig && sig.expiresAt > now) signals[sym] = sig; });
    }
  }

  // ── Jupiter REASONING / SELF-CHECK — beyond the mechanical rules. Jupiter's LLM
  //    reviews how the system is actually doing and how exposed it is, then decides how
  //    to carry itself: a risk-posture multiplier (≤1, discipline only) and, if things
  //    look bad, an advisory hold on new entries. It CANNOT raise risk past the hard
  //    caps — its job here is to keep the engine honest and survive drawdowns.
  async function deliberate(ctx = {}) {
    const sample    = Math.max(0, Number(ctx.sample) || 0);
    const coldStart = sample < 5;   // almost no track record yet
    // COLD-START HONESTY: "0% over 0 trades" reads to an LLM like catastrophic
    // performance. It isn't — it's absence of data, and an account can never BUILD a
    // record if caution-on-no-data zeroes the size (the deadlock seen live in v11.14:
    // size ×0.00 → every plan rejected "below 1 share" → still 0 trades → still ×0.00).
    const trackLine = sample === 0
      ? `  • track record: NO CLOSED TRADES YET (cold start). This is ABSENCE of data, not poor
    performance — the system can only build a record by trading. Do NOT set riskPosture
    below 0.5 and do NOT hold merely because history is missing.`
      : `  • recent win rate: ${ctx.winRate != null ? (ctx.winRate*100).toFixed(0)+'%' : 'n/a'} over ${sample} closed trades${coldStart ? ' (very small sample — weak evidence either way)' : ''}`;
    const prompt =
`You are JUPITER, the trading brain of an intraday US-equity bot. You size trades and you keep
YOURSELF in check. You CANNOT increase risk beyond the hard caps the system enforces — your role
right now is discipline and survival. Review the system honestly:
${trackLine}
  • profit factor: ${ctx.profitFactor != null && sample > 0 ? ctx.profitFactor.toFixed(2) : 'n/a'}
  • current drawdown: ${((ctx.drawdown ?? 0)*100).toFixed(1)}%   consecutive losses: ${ctx.consecutiveLosses ?? 0}
  • open positions: ${ctx.openPositions ?? 0} / ${ctx.maxPositions ?? 8}   capital deployed: ${((ctx.deployed ?? 0)*100).toFixed(0)}%
  • Venus market posture: ${ctx.venusPosture || 'n/a'}

Decide how Jupiter should carry itself for the next stretch. Bias toward caution: a small account
survives by NOT overtrading drawdowns or crowding into correlated names.
Output ONLY JSON:
{"riskPosture":0.0-1.0,   // 1.0 = full (still under the hard caps), lower = scale size down
 "hold":true|false,        // true = pause NEW entries entirely (exits always still allowed)
 "strategyNote":"one short sentence on why",
 "concerns":["short","..."]}`;

    const out = await llmReason(prompt);
    if (!out) return null;
    const m = Number(out.riskPosture);
    // ENFORCED FLOORS (code, not just prompt):
    //   • cold start (<5 closed trades): multiplier ≥0.5 and NO hold — lack of data can
    //     never freeze the bot into never getting data.
    //   • with a track record: multiplier ≥0.25 — zero-size is a degenerate duplicate of
    //     `hold` that spams "size below 1 share" instead of a clean rejection reason.
    //     Pausing is what `hold` is for; the multiplier is for scaling.
    // Asymmetric autonomy intact: reasoning can only ever REDUCE risk, never raise it.
    const floor = coldStart ? 0.5 : 0.25;
    const guarded = coldStart && (( Number.isFinite(m) && m < 0.5 ) || out.hold === true);
    jupiterPosture = {
      multiplier: Number.isFinite(m) ? clip(m, floor, 1) : 1,
      hold: coldStart ? false : out.hold === true,
      note: String(out.strategyNote || '').slice(0, 200),
      concerns: Array.isArray(out.concerns) ? out.concerns.slice(0, 5).map(c => String(c).slice(0, 100)) : [],
      at: Date.now()
    };
    if (guarded) console.log(`[JUPITER] 🛡 Cold-start guard — self-check wanted ×${Number.isFinite(m) ? m.toFixed(2) : '?'}${out.hold ? ' + hold' : ''}, floored to ×${jupiterPosture.multiplier.toFixed(2)}, no hold (${sample} closed trades is absence of data, not evidence)`);
    return jupiterPosture;
  }
  function getPosture()  { const fresh = (Date.now() - jupiterPosture.at) < POSTURE_TTL_MS; return { ...jupiterPosture, multiplier: fresh ? jupiterPosture.multiplier : 1, hold: fresh && jupiterPosture.hold, stale: !fresh }; }
  function isOnHold()    { return jupiterPosture.hold === true && (Date.now() - jupiterPosture.at) < POSTURE_TTL_MS; }

  return {
    init,
    deliberate, getPosture, isOnHold,
    consumeRecommendations,
    scoreAdjustment, hasSignal, getSignal, markTraded,
    computeSize, observeEntry,
    recordOutcome, prune, activeSymbols,
    trainOffline, ingestTrainingData, getTrainStats,
    getState, serialize, loadState,
    CONVICTION_MIN, SIGNAL_WEIGHT, FEATURES
  };
}
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  END CENTAURI BRAIN.  Everything below is 🌍 TERRA — the EXECUTION ENGINE   ║
// ║  and its supporting infrastructure (market data, indicators, risk gates,   ║
// ║  order routing, persistence, dashboard server). Terra does only what       ║
// ║  Venus and Jupiter tell it to: it sizes nothing and decides no direction —  ║
// ║  it executes, manages positions, and enforces the risk pipeline.           ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
const AI_ENABLED            = venus.isConfigured();
// v11.19 REVERTED to 5min/40. The 3min/60 tune caused sustained Groq 429s in the live
// session ("Analysis rate-limited … cooling down 90s" on nearly every cycle): each cycle
// makes up to 3 LLM calls, so 3min ≈ 60 calls/hr against a free-tier per-minute token
// cap. The damage was not just missing news — when analysis fails the cycle falls back
// to the institutional-only path, so the tune actively INCREASED the share of
// low-information signals reaching Jupiter.
const NEWS_POLL_MS          = Math.max(60000, parseInt(process.env.NEWS_POLL_MS || '300000', 10));        // default 5 min
const AI_MAX_CALLS_PER_HOUR = Math.max(1, parseInt(process.env.AI_MAX_CALLS_PER_HOUR || '40', 10));   // both engines now reason via LLM each cycle
const AI_CONVICTION_MIN     = Math.min(0.9, Math.max(0.5, parseFloat(process.env.AI_CONVICTION_MIN || '0.60')));
const AI_SIGNAL_WEIGHT      = Math.min(0.20, Math.max(0, parseFloat(process.env.AI_SIGNAL_WEIGHT || '0.12'))); // max score boost
const DYNAMIC_WATCHLIST_ON  = (process.env.DYNAMIC_WATCHLIST || 'on').toLowerCase() !== 'off';
const DYNAMIC_MAX_SYMBOLS   = Math.max(0, Math.min(15, parseInt(process.env.DYNAMIC_MAX_SYMBOLS || '10', 10)));
const DYNAMIC_MIN_PRICE     = 2.0;       // avoid sub-$2 names (manipulation, wide spreads)
const DYNAMIC_MAX_PRICE     = 1000;      // sizing sanity on a small account
// Liquidity floor, expressed in CONSOLIDATED-tape shares.
const DYNAMIC_MIN_DAY_VOL   = 750000;
// …but the volume we actually observe comes from ALPACA_DATA_FEED, and the free `iex`
// feed reports IEX-only prints — roughly 2–4% of consolidated volume. Comparing a
// consolidated threshold against IEX volume demanded ~25M consolidated ADV and rejected
// genuinely liquid mid-caps: the live log shows MP (220,090), NBIS (314,679) and BYND
// (91,975) all rejected as "too thin" — and those were the bot's HIGHEST-conviction,
// news-driven ideas (82% regulatory, 86% earnings), while meaningless 65% institutional
// recs sailed through. Scale the floor to the feed so the test means the same thing on
// both. 0.04 is the conservative end of the IEX share range.
const FEED_VOLUME_FACTOR    = ALPACA_DATA_FEED === 'sip' ? 1.0 : 0.04;
const EFFECTIVE_MIN_DAY_VOL = Math.round(DYNAMIC_MIN_DAY_VOL * FEED_VOLUME_FACTOR);

// Jupiter is instantiated now; it's wired to Terra's live state after those
// objects are declared (see jupiter.init below, after capitalSystem/riskSystem).
const jupiter = createJupiter({
  signalWeight:  AI_SIGNAL_WEIGHT,
  convictionMin: AI_CONVICTION_MIN,
  strategy:      null   // set to STRATEGY in jupiter.init once STRATEGY is defined
});

// The engine requires Alpaca data keys to BOOT. When this file is imported as a
// module (e.g. by train.js or a test) we skip the hard exit so the brain can be
// used without booting the execution engine.
if (require.main === module && (!APCA_API_KEY_ID || !APCA_API_SECRET_KEY)) {
  console.error('[FATAL] Alpaca data keys not set — export APCA_API_KEY_ID and APCA_API_SECRET_KEY');
  console.error('        (paper keys work for data; get them at https://app.alpaca.markets)');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ─── MARKET HOURS (Eastern Time) — NASDAQ/NYSE only ──────────────────────
const NASDAQ_NYSE_HOURS = { start: 9.5, end: 16 };

// ─── WATCHLISTS — NASDAQ + NYSE only ─────────────────────────────────────
const WATCHLISTS = {
  nasdaq: ['PLTR','SOFI','MARA','HOOD','SOUN','IONQ','RKLB','BBAI','HIMS','CIFR'],
  nyse:   ['F','BAC','JPM','WFC','GE','XOM','MRK','JNJ','PFE','KO']
};
const HIGH_VOLATILITY = new Set(['MARA','SOUN','IONQ','RKLB','BBAI','CIFR','HIMS']);

// ── EARNINGS BLACKOUT ────────────────────────────────────────────────────────
// ⚠️ DEFAULT OFF (v11.19). These are PLACEHOLDER day-of-month values, not real
// earnings dates, and the structure cannot represent real ones: it stores only a
// day-of-month, so it repeats EVERY MONTH — while earnings are QUARTERLY. Left
// enabled it blacked out ~4 days/month for each of the 10 symbols (the window is
// diff 0/1/2 plus the day after) on essentially arbitrary dates: it blocked real
// tradeable days ~13% of the time while giving ZERO protection on the actual
// earnings days it's supposed to guard. A gate driven by false data is worse than
// no gate — it costs opportunity and buys no safety.
//
// The genuine earnings risk (a big overnight move) is already covered by the
// OVERNIGHT GAP system, which is measured from real prices: ≥3% gap blocks entries
// 30 min, ≥1.5% halves size. That protection is unaffected by this flag.
//
// To turn this on: populate REAL upcoming earnings days below, then set
// EARNINGS_BLACKOUT=on. Values are days-of-month in Eastern time.
const EARNINGS_BLACKOUT_ENABLED = (process.env.EARNINGS_BLACKOUT || 'off').toLowerCase() === 'on';
const EARNINGS_CALENDAR = {
  PLTR: [15], SOFI: [22], MARA: [18], HOOD: [25], SOUN: [10],
  IONQ: [12], RKLB: [8], BBAI: [20], HIMS: [14], CIFR: [5]
};

// ✅ NEW: Market volatility thresholds
// v11.19: dropped HIGH_VOL_THRESHOLD, NORMAL_VOL_BASELINE and DYNAMIC_SPREAD_BUFFER —
// all three had ZERO references anywhere in the codebase. Their comments described
// behaviour that does not exist ("1.5% = reduce position size" etc.), so reading this
// block gave a false picture of what the engine enforces. The real equivalents live
// elsewhere and are actually wired: volatility-based size reduction is Jupiter's
// isHighVolatility/stress/gap adjustments in computeSize(), and spread estimation is
// estimateDynamicSpread(). Only the two constants below are used.
const VOLATILITY_FILTERS = {
  EXTREME_VOL_THRESHOLD:    0.025,   // median intraday move (from the open) → halt entries
  MIN_VOLUME_THRESHOLD:     500000,  // RVOL fallback floor when candle data is unavailable
};

// Sector map — used for concentration limits so the bot can't stack 5 correlated
// crypto-adjacent momentum names at the same time.
const SYMBOL_SECTOR = {
  PLTR:'tech', SOFI:'fintech', MARA:'crypto', HOOD:'fintech', SOUN:'tech',
  IONQ:'tech', RKLB:'tech', BBAI:'tech', HIMS:'health', CIFR:'crypto',
  F:'auto', BAC:'banking', JPM:'banking', WFC:'banking', GE:'industrial',
  XOM:'energy', MRK:'pharma', JNJ:'pharma', PFE:'pharma', KO:'consumer'
};
const MAX_SECTOR_EXPOSURE = 2;   // at most 2 open positions in the same sector

// ─── MARKET DATA ─────────────────────────────────────────────────────────
// history[] = last 60 tick prices, used for EMA/RSI
// lastTradeTime = Alpaca trade timestamp (ms) of last accepted tick (stale-tick guard)
let marketData = {};
let wsConnected = false;

// ─── GAP DATA ─────────────────────────────────────────────────────────────
// Overnight gap detection results per symbol.
// gapData[symbol] = { gapPct, direction, detectedAt, blockUntil }
let gapData = {};

// ─── PORTFOLIO ────────────────────────────────────────────────────────────
let portfolio = {
  cash: START_CAPITAL,
  longPositions:  {},   // { SYMBOL: [{ qty, entryPrice, highestPnL, openedAt }] }
  shortPositions: {},
  trades:       [],
  closedTrades: []
};

// ─── CAPITAL MANAGEMENT ──────────────────────────────────────────────────
let capitalSystem = {
  reserveCash:      0,
  tradingCapital:   START_CAPITAL,
  profitVault:      0,
  reserveRatio:     0.30,
  reinvestRatio:    0.70,
  vaultTrigger:     0.10,
  lastVaultValue:   START_CAPITAL,
  safeMode:         false,
  safeModeManual:   false,   // set via Luna/API — auto-recovery will not clear it
  safeModeDrawdown: 0.10,
  emergencyStop:    false,
  emergencyDrawdown:0.20
};

// ─── TRADE LOG ────────────────────────────────────────────────────────────
let tradeLogger = [];
function logTrade(entry) {
  tradeLogger.push(`${new Date().toISOString()} ${entry}`);
  if (tradeLogger.length > 200) tradeLogger = tradeLogger.slice(-200);
}
// Drop the oldest closed trades beyond the cap, PRESERVING chronological order.
// The previous form rebuilt the array as [...open, ...closed] — which reorders it so
// every open trade sits at the front. `/api/portfolio` builds its Live Trade Tracker
// from `portfolio.trades.slice(-12)`, i.e. it assumes chronological order, so after the
// first trim (>200 closed) the tail was ALL closed trades and open positions silently
// vanished from Luna. Filtering in place keeps insertion order intact.
function trimTrades() {
  const closed = portfolio.trades.filter(t => t.status === 'closed');
  if (closed.length <= 200) return;
  const drop = new Set(closed.slice(0, closed.length - 200));   // oldest closed, by identity
  portfolio.trades = portfolio.trades.filter(t => !drop.has(t));
}

// ─── AI / LEARNING SYSTEM ─────────────────────────────────────────────────
let aiSystem = {
  aggressionLevel: 0.5,
  strategy: 'balanced',
  recentWinRate:   0.5,
  smoothedWinRate: 0.5,
  winningStreak:   0,
  losingStreak:    0,
  _lastCountedTradeTime:    null,
  _lastSentimentUpdateTime: null,
  _lastPerfHistoryTime:     null,
  performanceHistory: [],
  a_plus_mode: false,  // ✅ NEW: Only trade top 10% signals when enabled
  currentReasoning: {
    winRate: 0, volatility: 0, trend: 'neutral', confidence: 0, nextAction: 'waiting',
    signalScore: 0, regime: 'neutral', breadth: 0.5
  },
  reinvestmentSystem: { enabled: true, profitThreshold: 100, profitsReinvested: 0, totalReinvestments: 0 },
  // ✅ Trade Quality Analytics System (Layer 4: Real Adaptive Learning)
  tradeAnalytics: {
    setupMetrics: {},    // { setupType: { wins, losses, avgPnL, times } }
    regimeMetrics: {},   // { regime: { wins, losses, avgPnL } }
    sectorMetrics: {},   // { sector: { wins, losses, avgPnL } }
    timeMetrics: {},     // { hour: { wins, losses } }
    bestSetups: [],      // Top 3 performing setups
    symbolMetrics: {}    // { symbol: { momentum, strength, rank } }
  }
};

// ─── RISK SYSTEM ──────────────────────────────────────────────────────────
let riskSystem = {
  maxDrawdown:      0.20,
  maxPortfolioHeat: 0.50,
  dailyLossLimit:   0.05,
  // v11.19 aggression tune: raised from 12 — this is a PACING cap, not a capital-
  // protection cap. dailyLossLimit/maxDrawdown/emergencyStop above (untouched) are
  // what actually bound how much the account can lose in a day; this just lets more
  // trades happen within that same protected budget.
  maxTradesPerDay:  18,
  currentDrawdown:  0,
  portfolioHeat:    0,
  riskLevel:        'normal',
  checksPassing:    [],
  dailyRealizedLoss:0,
  dailyTradeCount:  0,
  dailyResetDate:   null,
  peakValue:        START_CAPITAL,
  consecutiveLosses:0,           // kill-switch counter
  maxConsecutiveLosses: 4,       // halt after 4 straight losses
  lossHaltUntil:    0            // v11.19: when that halt actually expires (see LOSS_HALT_MS)
};

// ─── SENTIMENT (computed from real breadth) ───────────────────────────────
// No longer random. computeMarketBreadth() replaces the random drift with
// real intraday breadth: how many watchlist names are trading above prevClose.
let sentimentData = {
  general:  0.5,
  byMarket: { nasdaq: 0.5, nyse: 0.5 },
  breadthScore: 0.5,          // fraction of symbols trading above prevClose
  spyMomentum:  0,            // daily move of SPY (fetched alongside quotes)
  uptickRatio:  0.5,          // fraction of last-N 1m candles closing higher than open
};
// Reference cadence the sentiment EMA's 0.2 step was originally tuned against (~31s
// half-life). computeMarketBreadth derives its real alpha from elapsed time against
// this, so the filter behaves identically no matter how fast the main loop ticks.
const SENTIMENT_EMA_REF_MS = 10000;
// Elapsed-time → EMA weight. Pure and exported so the cadence-independence property
// is directly regression-testable (see test.js) rather than re-derived in the test.
// dt === SENTIMENT_EMA_REF_MS reproduces the original 0.2 step exactly.
// dt is capped at 60s so a long gap (overnight, restart) refreshes hard toward the
// current reading without pinning alpha at exactly 1.0 — a stale EMA shouldn't drag,
// but shouldn't teleport either.
function sentimentAlpha(dtMs) {
  const dt = Math.min(Math.max(Number(dtMs) || 0, 0), 60000);
  return 1 - Math.pow(0.8, dt / SENTIMENT_EMA_REF_MS);
}

// Track SPY separately for regime confirmation
let spyData = { price: null, prevClose: null };

// ─── MARKET TRANSITION ────────────────────────────────────────────────────
let marketTransitionData = { lastMarket: null };

// ─── COOLDOWNS ────────────────────────────────────────────────────────────
let symbolCooldowns  = {};
let symbolLossCount  = {};
// v11.19: REVERTED to 20min. Combined with the broken ATR, the 12min variant meant
// re-entering the same name that had just stopped out on noise, roughly twice as often.
// REPEAT_LOSS_MULTIPLIER still escalates this per-symbol on repeat losses.
const STOP_LOSS_COOLDOWN_MS    = 20 * 60 * 1000;
const REPEAT_LOSS_MULTIPLIER   = 2;

// v11.19 aggression tune: raised from 6 (was hardcoded in three separate places —
// centralized here). More concurrent slots to deploy capital into, still bounded by
// MAX_SECTOR_EXPOSURE (unchanged, 2/sector) so it can't stack into one correlated bet,
// and by portfolioHeat/dailyLossLimit/drawdown (unchanged) for total account risk.
const MAX_OPEN_POSITIONS = 8;

// ─── EXECUTION CONSTANTS ─────────────────────────────────────────────────
const SLIPPAGE_RATE     = 0.0015;    // ✅ FIX Bug #3: Realistic 0.15% slippage
const SPREAD_RATE       = 0.0010;    // 0.10% bid-ask spread
const EXECUTION_COST    = SLIPPAGE_RATE + SPREAD_RATE;  // Total ~0.25% per side

// ✅ FIX Bug #3: Realistic fill price simulation
// ✅ IMPROVEMENT #7: Dynamic slippage that scales with volatility.
//    Fixed slippage makes backtests lie — real fills get much worse when a
//    name is moving fast. We scale the execution cost by a volatility
//    multiplier (1.0× in calm conditions, up to ~3× in extreme volatility)
//    and optionally take a symbol's measured intraday range into account.
function simulateFillPrice(marketPrice, direction, symbol = null, qty = 1, opts = {}) {
  // v11.20: a LIMIT entry does not cross the spread, so the simulator must not charge
  // for crossing it — otherwise sim results would understate live profitability and we
  // would tune against the wrong economics. Slippage is still charged (halved), and
  // market impact still applies. Exits pass no flag and are costed as before.
  const isLimit = opts.limit === true;
  const baseCost = isLimit ? (SLIPPAGE_RATE * 0.5) : EXECUTION_COST;
  let executionCost = baseCost;

  if (symbol) {
    const vol = calculateVolatility(symbol);
    const volMultiplier = Math.max(1.0, Math.min(3.0, 1 + (vol - 0.01) * 40));
    executionCost = baseCost * volMultiplier;

    // Add market impact — scales with sqrt(qty / avg5minVol)
    const impact = getMarketImpactCost(symbol, qty);
    executionCost += impact;
  }

  const randomSlippage = (Math.random() - 0.5) * 0.0003;
  if (direction === 'buy') {
    return marketPrice * (1 + executionCost + randomSlippage);
  } else {
    return marketPrice * (1 - executionCost + randomSlippage);
  }
}

// ── EXECUTION COST MODEL (v11.20) ────────────────────────────────────────────
// One shared estimate of what a round trip actually costs, used by BOTH the entry gate
// and the simulator so they can never disagree about the economics.
//
// LIMIT ENTRIES are the single biggest lever on profitability here. A market order
// crosses the spread every time; a limit order resting at our price does not. Cutting
// the round trip from ~0.55% to ~0.34% drops the minimum viable ATR from ~0.79% to
// ~0.49%, which roughly doubles the set of symbols that can be traded profitably.
// The trade-off is non-fill — which is fine: a missed entry costs nothing, and the
// scan re-evaluates seconds later. EXITS stay market orders, always: getting out is
// not optional and must never hinge on a resting order.
const LIMIT_ENTRIES = (process.env.LIMIT_ENTRIES || 'on').toLowerCase() !== 'off';

// Fraction-of-price cost for ONE side.
//   entry+limit  : no spread crossed; a quarter-spread allowance for queue position
//                  and adverse selection, plus half the usual slippage
//   market side  : half the spread + full slippage
function sideCost(symbol, { limit = false } = {}) {
  const spread = estimateDynamicSpread(symbol);          // vol/RVOL-aware, already a fraction
  return limit ? (spread * 0.25 + SLIPPAGE_RATE * 0.5)
               : (spread * 0.50 + SLIPPAGE_RATE);
}
// Round trip = entry (limit or market) + exit (always market).
function estimateRoundTripCost(symbol) {
  const c = sideCost(symbol, { limit: LIMIT_ENTRIES }) + sideCost(symbol, { limit: false });
  return Number.isFinite(c) ? Math.max(0.0005, Math.min(0.05, c)) : 0.0055;
}

// Reward:risk AFTER execution costs — the number that actually decides profitability.
// gross target/stop are fractions of price; cost is the full round trip.
function netRewardRisk(tgtFrac, stopFrac, cost) {
  const net = (tgtFrac - cost) / (stopFrac + cost);
  return Number.isFinite(net) ? net : 0;
}

// ─── SHORT BORROW RATE ────────────────────────────────────────────────────
// Returns daily borrow rate for a symbol.
// HIGH_VOLATILITY names (hard-to-borrow) carry a higher rate.
// If RVOL > 3× and symbol is in HIGH_VOLATILITY set, we also block new shorts
// (liquidity exhaustion — too dangerous to establish a short in a squeeze).
function getShortBorrowRate(symbol) {
  return HIGH_VOLATILITY.has(symbol) ? SHORT_BORROW_HTB : SHORT_BORROW_DAILY;
}

function isShortBorrowAvailable(symbol) {
  if (!HIGH_VOLATILITY.has(symbol)) return true;
  const rvol = calculateRVOL(symbol);
  // RVOL > 3× on a hard-to-borrow name = potential squeeze, block new shorts
  if (rvol > 3.0) {
    console.log(`[RISK] SHORT ${symbol} blocked — RVOL ${rvol.toFixed(2)}× (borrow unavailable)`);
    return false;
  }
  return true;
}

// ─── PARTIAL FILL SIMULATION ─────────────────────────────────────────────
// Returns the actual filled quantity given a requested qty and market conditions.
// Models the reality that large orders in thin markets don't always fill fully.
//
// Fill rate is determined by order size relative to average 5-min candle volume:
//   orderRatio = requestedQty / avg5minVol
//   orderRatio < 0.10 → ~100% fill  (tiny relative to volume)
//   orderRatio = 0.50 → ~85% fill
//   orderRatio = 1.00 → ~70% fill
//   orderRatio > 2.00 → ~55% fill  (floored)
// A small ±5% random component models real order-book variability.
function simulatePartialFill(symbol, requestedQty, direction) {
  if (requestedQty < 1) return 0;

  const candles = candleData[symbol]?.m1;
  let avg5minVol = 0;
  if (candles && candles.length >= 10) {
    const recent10 = candles.slice(-10);
    avg5minVol = recent10.reduce((s, c) => s + (c.v || 0), 0) / 10;
  } else {
    // Fallback: daily volume / 78 (approx 5-min intervals in 6.5h session)
    const dailyVol = marketData[symbol]?.dailyVolume || 0;
    avg5minVol = dailyVol > 0 ? dailyVol / 78 : 50000;
  }

  if (avg5minVol <= 0) return requestedQty;  // can't estimate — assume full fill

  const orderRatio = requestedQty / avg5minVol;
  // Square-root decay: diminishing fill rate as order grows
  const baseFillRate = Math.max(0.55, 1 - 0.45 * Math.sqrt(orderRatio));
  // ±5% random component
  const jitter = (Math.random() - 0.5) * 0.10;
  const fillRate = Math.max(0.50, Math.min(1.0, baseFillRate + jitter));

  const filled = Math.floor(requestedQty * fillRate);
  if (filled < requestedQty) {
    console.log(`[FILL] ${direction} ${symbol} partial fill: ${filled}/${requestedQty} (${(fillRate*100).toFixed(0)}%, RVOL ${calculateRVOL(symbol).toFixed(2)}×)`);
  }
  return Math.max(1, filled);
}

// ─── MARKET IMPACT COST ───────────────────────────────────────────────────
// Square-root market impact model (Almgren-Chriss approximation):
//   impact = 0.1% × sqrt(orderQty / avg5minVol)
// Returns a fractional cost added on top of slippage.
function getMarketImpactCost(symbol, qty) {
  const candles = candleData[symbol]?.m1;
  let avg5minVol = 0;
  if (candles && candles.length >= 10) {
    avg5minVol = candles.slice(-10).reduce((s, c) => s + (c.v || 0), 0) / 10;
  } else {
    const dailyVol = marketData[symbol]?.dailyVolume || 0;
    avg5minVol = dailyVol > 0 ? dailyVol / 78 : 50000;
  }
  if (avg5minVol <= 0) return 0;
  const impact = 0.001 * Math.sqrt(qty / avg5minVol);
  return Math.min(impact, 0.01);  // cap at 1% — prevents extreme outliers
}


// Short borrow rates (daily). Standard names vs hard-to-borrow HIGH_VOLATILITY names.
const SHORT_BORROW_DAILY = 0.0003;  // 0.03%/day standard rate (~11% annualised)
// Hard-to-borrow premium for HIGH_VOLATILITY symbols (~18% annualised)
const SHORT_BORROW_HTB   = 0.0005;  // 0.05%/day for MARA, SOUN, RKLB, etc.
const MARGIN_RATE        = 0.5;
const PRICE_HISTORY_LEN  = 60;   // WS tick history per symbol — 60 gives RSI(14) room to stabilise
// Stale-data guard: don't trade a symbol whose price hasn't updated in >90s
const MAX_PRICE_AGE_MS   = 90000;
// Don't trade in the first 5 or last 5 minutes of a session (high noise)
const SESSION_BUFFER_MIN = 5;
// Gap handling thresholds
const GAP_WARN_PCT       = 0.015;   // 1.5% gap → reduce size 50%, widen stop
const GAP_BLOCK_PCT      = 0.030;   // 3.0% gap → block new entries 30 min
const GAP_BLOCK_MS       = 30 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
//  FORMAL STRATEGY SPEC — "EMA Crossover + RSI Momentum" (quant-grade)
//  This codifies the explicit entry/exit rules the decision engine enforces.
//  It runs as a HARD GATE on top of the weighted multi-factor score, so a trade
//  only fires when BOTH (a) the weighted score clears threshold AND (b) the
//  classic EMA/RSI structure agrees. Toggle with STRATEGY_GATE=off (env).
//
//  LONG ENTRY  — all must hold:
//    1. Trend: EMA(fast) > EMA(slow)            [trend is up]
//    2. Momentum: price > prevClose             [positive day move]
//    3. RSI(14) in [RSI_LONG_MIN, RSI_LONG_MAX] [momentum confirmed, not overbought]
//    4. Higher timeframe (tf15m) not bearish    [no fighting the 15m structure]
//    5. Price >= intraday midpoint              [trading in the upper half of range]
//
//  SHORT ENTRY — mirror image (EMA fast < slow, price < prevClose, RSI in short band,
//    tf15m not bullish, price <= midpoint).
//
//  EXITS (enforced by position management, see managePositions()):
//    • Hard stop:      −STOP_LOSS_PCT from entry        (−1.5%)
//    • Trailing stop:  peak P&L − TRAIL_GIVEBACK        (−1.5% giveback after +2%)
//    • TP ladder:      +3% → sell 40%, +6% → sell 30% of remainder
//    • Hard take:      +HARD_TP_PCT                     (+8%)
//
//  RISK (enforced by computePositionSize() + kill switches):
//    • Risk per trade:   BASE_RISK of trading capital, capped at MAX_RISK
//    • Daily loss limit: 5% of CURRENT equity (not frozen start capital) halts entries
//    • Max positions:    8 concurrent; max 2 per sector
//    • Portfolio heat:   ≤ 50% notional exposure
//    • Kill switches:    WS down, stale data, 4-loss streak, 20% drawdown, extreme vol
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  STRATEGY v11.3 — volatility-normalized, multi-factor, regime-adaptive
//
//  Rewritten around what consistently separates profitable systematic traders
//  from the rest (per quant literature + practitioner consensus):
//    1. ATR-ANCHORED RISK   — stops/targets scale with each symbol's volatility,
//       not fixed %. A 2.5×ATR stop on a calm stock and a wild one represent the
//       same statistical event. Targets sit at ≥2× the stop (positive R:R).
//    2. CONSTANT DOLLAR-RISK — size = (equity × risk%) ÷ (stop distance). Every
//       trade risks the same fraction of capital regardless of the stock's price
//       or volatility. This is the single highest-impact change.
//    3. FRACTIONAL-KELLY OVERLAY — once enough trades resolve, nudge the risk
//       fraction toward ¼-Kelly from the bot's *measured* edge, hard-capped.
//    4. ADX REGIME FILTER   — trend-follow only when ADX shows a real trend;
//       require mean-reversion confirmation when the tape is ranging. Stops the
//       classic failure of buying breakouts in chop.
//    5. R:R GATE            — reject any setup whose target/stop ratio < MIN_RR.
// ════════════════════════════════════════════════════════════════════════════
const STRATEGY = {
  EMA_FAST:     9,    // 5→9: less whipsaw; 9/21 is the practitioner-standard intraday pair
  EMA_SLOW:     21,
  RSI_PERIOD:   14,
  RSI_LONG_MIN: 50,   // trend-mode long: positive momentum, not overbought
  RSI_LONG_MAX: 78,   // widened 72→78: strong trends ride high RSI; don't exit a winner early
  RSI_SHORT_MIN:22,   // widened so genuine downtrends qualify
  RSI_SHORT_MAX:50,

  // Mean-reversion band (used when ADX says "ranging") — fade extremes back to mean
  RSI_MR_OVERSOLD:   30,
  RSI_MR_OVERBOUGHT: 70,

  // ── ATR-anchored risk geometry (the heart of the rewrite) ──
  ATR_PERIOD:      14,
  ATR_STOP_MULT:   2.2,   // stop = entry ∓ 2.2×ATR  (1.5–2.5 is the researched sweet spot)
  ATR_TARGET_MULT: 4.6,   // first target ≈ 4.6×ATR → ~2.1:1 reward:risk before laddering
  MIN_RR:          1.8,   // reject setups below this reward:risk
  ATR_TRAIL_MULT:  2.0,   // trail by 2.0×ATR once in profit (Chandelier-style)

  // ADX trend-strength thresholds (Wilder standard)
  ADX_PERIOD:      14,
  ADX_TREND:       23,    // ≥ → trending: momentum entries allowed
  ADX_RANGE:       18,    // ≤ → ranging: prefer mean-reversion, block fresh breakouts

  // ── NET-OF-COST REWARD:RISK (v11.20) ──────────────────────────────────────
  // MIN_RR above is checked on GROSS prices, which quietly approves losing trades:
  // subtract a ~0.55% round trip and a "2.09 reward:risk" becomes 0.76 at 0.3% ATR
  // (the average loss 30% BIGGER than the average win) and only ~1.5 at 1% ATR. The
  // geometry looked healthy the whole time; the economics never were.
  // MIN_RR_NET is the real bar, applied AFTER costs. 1.35 is deliberately lower than
  // the gross 1.8 because it has to be achievable: at 1.35 net with a 45% win rate the
  // expectancy is +0.13 per unit risked, which is a genuinely profitable system, while
  // demanding 1.8 NET would require ~2.4% ATR and exclude nearly everything.
  MIN_RR_NET:      1.35,
  // ── MINIMUM VOLATILITY TO ENTER (v11.20, measured) ────────────────────────
  // The single highest-impact filter found by backtesting. The fee per round trip is
  // roughly FIXED, so a symbol whose 1-minute ATR is ~0.3% is being asked to pay a
  // 0.30% toll on a 0.30% move — a coin flip that pays the house every flip. Requiring
  // 1% ATR means the move being traded is several times the friction.
  // Measured over 60 trading days, 20 symbols:
  //     no filter : 969 trades, 40.4% win, expectancy -$0.79, PF 0.70, -76.1%
  //     ATR >= 1% : 108 trades, 50.9% win, expectancy +$0.99, PF 1.11, +10.7%
  // Note this RAISES the win rate (40.4% -> 50.9%) rather than buying it back with
  // worse reward:risk — R:R held at ~1.05. Fewer, better trades.
  // Caveat kept in the open: PF 1.11 is thin, and the threshold was chosen by trying
  // several on this data. Treat as promising, not proven.
  MIN_ATR_ENTRY:   0.010,
  // ── MAX ROUND-TRIP COST (v11.22) ──────────────────────────────────────────
  // The real cost lever. Position SIZE is cost-neutral here — Alpaca charges no
  // commission and spread/slippage are percentages, so a $1,000 position pays the
  // same rate as a $100 one. What does vary, hugely, is the stock: a liquid name
  // costs ~5bp round trip while a thin one costs 50bp+. Every basis point of fee is
  // a basis point the strategy must out-earn on EVERY trade, forever, so simply
  // refusing the expensive names is free edge.
  // 0.45% is deliberately above the ~0.30% median so it removes the tail, not the
  // body — the gate is meant to exclude expensive stocks, not stop trading.
  MAX_ROUND_TRIP_COST: 0.0045,
  // Backstop: the target must clear round-trip friction by this multiple, so a trade is
  // never taken for a move that barely pays the fee. This is the "only trade when there
  // is real money in it" rule, stated in cost units instead of price units.
  MIN_TARGET_COST_RATIO: 2.5,

  // Risk budget (fraction of TRADING pool risked per trade — dollar-risk, not notional)
  // v11.19 aggression tune: raised from 1.0%/2.0% so a real edge sizes up faster.
  // Still hard-capped — this is NOT unlimited risk, it's a higher ceiling. The daily
  // loss limit, drawdown halt, and emergency stop (riskSystem/capitalSystem, untouched
  // by this tune) are what actually bound total account risk regardless of this number.
  RISK_PER_TRADE_BASE: 0.015,  // 1.5% baseline
  RISK_PER_TRADE_MAX:  0.030,  // 3.0% hard ceiling, ever
  KELLY_FRACTION:      0.25,   // ¼-Kelly overlay on measured edge
};
// ── LONG-ONLY (v11.24) ───────────────────────────────────────────────────────
// The bot's SHORT book is systematically broken. Measured over 263 out-of-sample
// setups: trades the gate called SHORT won 8.5% of the time against a 32.4%
// break-even, while taking the opposite side of those same setups won 65.9%. It is
// not a tuning problem — the short signal is anti-predictive.
//
// This is NOT a fitted parameter, and that distinction matters given how many
// apparent edges here turned out to be curve-fitting:
//   • ONE binary decision, no value to optimise
//   • a structural prior that existed before the data: equities carry positive
//     long-run drift (the equity risk premium), so shorting fights that drift
//   • shorts additionally pay borrow (0.03-0.05%/day here) and carry unbounded loss
//   • it REDUCES risk rather than reaching for return
//
// Measured across five 60-day windows: pooled -$119.77 -> +$128.49, and it rescues
// the two worst windows. It also holds up in DOWN markets (lost 3.5% while the market
// fell 8.3%), so it is not merely capturing a rising sample.
//
// HONEST CAVEAT, kept here so nobody rediscovers it as a win: the long-only bot still
// UNDERPERFORMS simply buying and holding the same 20 stocks over these windows
// (+$128 vs ~+$163). It reduces damage; it does not create alpha.
const LONG_ONLY = (process.env.LONG_ONLY || 'on').toLowerCase() !== 'off';

const STRATEGY_GATE_ENABLED = (process.env.STRATEGY_GATE || 'on').toLowerCase() !== 'off';
const MEAN_REVERSION_ENABLED = (process.env.MEAN_REVERSION || 'on').toLowerCase() !== 'off';

// ─── CANDLE CACHE ────────────────────────────────────────────────────────
// Stores per-symbol OHLCV candle arrays fetched from Alpaca REST.
// candleData[symbol] = { m1: [{t,o,h,l,c,v},...], m5: [...] }
// Used for true ATR, real multi-timeframe analysis, and RVOL.
let candleData = {};

// ─── PERSISTENCE GUARDS ───────────────────────────────────────────────────
let _saveInProgress = false;
let _savePending    = false;
let _saveTimeout    = null;
let _fetchInProgress = false;

// ════════════════════════════════════════════════════════════════════════════
//  TIME & MARKET DETECTION  (identical to v8.0 — proven correct)
// ════════════════════════════════════════════════════════════════════════════

function getEasternTimeParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
  }).formatToParts(now);
  let hour = 0, minute = 0, weekday = '', y = '', m = '', d = '';
  parts.forEach(p => {
    if (p.type === 'hour')    hour    = parseInt(p.value, 10);
    if (p.type === 'minute')  minute  = parseInt(p.value, 10);
    if (p.type === 'weekday') weekday = p.value;
    if (p.type === 'year')    y       = p.value;
    if (p.type === 'month')   m       = p.value;
    if (p.type === 'day')     d       = p.value;
  });
  if (hour === 24) hour = 0;
  const dayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { hours: hour + minute / 60, day: dayMap[weekday] ?? 0, dateStr: `${y}-${m}-${d}`, minute };
}

// ─── MARKET CALENDAR (v11.20) ────────────────────────────────────────────────
// Weekday-only hours treat every Mon–Fri as a trading day, so market HOLIDAYS
// (Thanksgiving, Christmas, Juneteenth, Good Friday…) read as OPEN and the engine
// scans, logs and tries to trade against a dead tape — and it misses 1:00pm early
// closes entirely, holding positions past the real close. Alpaca publishes the
// official NYSE/NASDAQ calendar; this caches it and consults it synchronously.
// Degrades to the old weekday rules if the calendar is unavailable, so a failed
// fetch can never halt trading.
let marketCalendar = { byDate: new Map(), fetchedAt: 0, ok: false };

async function refreshMarketCalendar() {
  if (typeof broker.getCalendar !== 'function') return false;
  try {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const r = await broker.getCalendar(iso(now - 3 * 86400000), iso(now + 45 * 86400000));
    if (!r || !r.ok || !Array.isArray(r.days) || !r.days.length) {
      if (!marketCalendar.ok) console.log('[CALENDAR] Not available — falling back to standard weekday hours.');
      return false;
    }
    const byDate = new Map();
    for (const d of r.days) {
      if (!d || !d.date) continue;
      const hm = (s, dflt) => {
        const [h, m] = String(s || dflt).split(':').map(Number);
        return (Number.isFinite(h) ? h : 0) + (Number.isFinite(m) ? m : 0) / 60;
      };
      byDate.set(d.date, { open: hm(d.open, '09:30'), close: hm(d.close, '16:00') });
    }
    marketCalendar = { byDate, fetchedAt: now, ok: true };
    const today = getEasternTimeParts().dateStr;
    const t = byDate.get(today);
    console.log(`[CALENDAR] ${byDate.size} trading days loaded — today (${today}) is ${t ? `a trading day ${t.open.toFixed(2)}–${t.close.toFixed(2)} ET` : 'NOT a trading day (weekend/holiday)'}`);
    return true;
  } catch (e) {
    console.warn('[CALENDAR] refresh failed:', e.message);
    return false;
  }
}

// Pure session resolution. Split out of getCurrentMarket so the calendar branch can be
// tested on a controlled weekday: the real function short-circuits on the weekend check
// first, so on a Saturday a holiday test would pass without ever running this code
// (mutation testing caught exactly that).
function resolveSession(hours, day, dateStr, cal) {
  if (day === 0 || day === 6) return null;                       // weekend — never a trading day
  if (cal && cal.ok) {
    const session = cal.byDate.get(dateStr);
    if (!session) return null;                                   // holiday
    return (hours >= session.open && hours < session.close) ? 'nasdaq' : null;
  }
  if (hours >= NASDAQ_NYSE_HOURS.start && hours < NASDAQ_NYSE_HOURS.end) return 'nasdaq';
  return null;
}

function getCurrentMarket() {
  const { hours, day, dateStr } = getEasternTimeParts();
  return resolveSession(hours, day, dateStr, marketCalendar);
}

// Why the market is closed, in words — so a "Market: CLOSED" line is never a mystery.
function marketClosedReason() {
  const { hours, day, dateStr } = getEasternTimeParts();
  if (day === 0 || day === 6) return `weekend (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]})`;
  if (marketCalendar.ok && !marketCalendar.byDate.get(dateStr)) return `market holiday (${dateStr})`;
  const session = (marketCalendar.ok && marketCalendar.byDate.get(dateStr)) || { open: NASDAQ_NYSE_HOURS.start, close: NASDAQ_NYSE_HOURS.end };
  if (hours < session.open)  return `pre-market — opens at ${session.open.toFixed(2)} ET (now ${hours.toFixed(2)})`;
  if (hours >= session.close) return `after-hours — closed at ${session.close.toFixed(2)} ET (now ${hours.toFixed(2)})`;
  return null;
}

function getMarketStatus() {
  const { hours, day } = getEasternTimeParts();
  if (day === 0 || day === 6) return { status: 'CLOSED', reason: 'Weekend' };
  if (hours >= NASDAQ_NYSE_HOURS.start && hours < NASDAQ_NYSE_HOURS.end)
    return { status: 'NASDAQ/NYSE OPEN', openTime: '9:30 AM ET', closeTime: '4:00 PM ET' };
  return { status: 'After Hours', openTime: '9:30 AM ET', closeTime: '4:00 PM ET' };
}

function symbolsForMarket(market) {
  if (market === 'nasdaq') return [...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse];
  return [];
}

// Time-of-day filter — skip the chaotic first and last N minutes of a session.
// Opening prints are often fake breakouts; closing prints spike on order imbalance.
function isInsideSessionBuffer() {
  const { hours, day } = getEasternTimeParts();
  if (day === 0 || day === 6) return false;
  const bufMin  = SESSION_BUFFER_MIN / 60;
  const usOpen  = NASDAQ_NYSE_HOURS.start;
  const usClose = NASDAQ_NYSE_HOURS.end;
  // Only apply during the actual US session
  if (hours < usOpen || hours >= usClose) return false;
  if (hours < usOpen + bufMin) return true;   // first 5 min
  if (hours >= usClose - bufMin) return true; // last 5 min
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET — exponential-backoff reconnect, staggered subscriptions,
//              generation-guarded, stale-tick rejecting
// ════════════════════════════════════════════════════════════════════════════

// ─── WEBSOCKET STATE ──────────────────────────────────────────────────────
let dataWs        = null;
let wsReconnectTimer = null;
let wsGeneration     = 0;
let wsReconnectDelay = 5000;        // starts at 5s, backs off to WS_RECONNECT_MAX
const WS_RECONNECT_MAX = 60000;     // cap at 60s — prevents 429 storms on free tier

// Heartbeat: the data stream can silently drop — the socket stays
// in OPEN state but stops sending data. A ping every 30s detects this. If no
// pong arrives within 10s we close the socket, triggering the close→reconnect path.
let wsHeartbeatTimer   = null;
let wsPingTimeout      = null;
const WS_PING_INTERVAL = 15000;   // ping every 15s (was 30s) — more keepalive traffic helps
                                   // some networks/routers avoid idle-timing-out the socket,
                                   // and any genuinely dead link is caught twice as fast
const WS_PONG_TIMEOUT  = 8000;    // close if no pong within 8s (was 10s)

// Backoff is only reset once a connection proves STABLE (stays open this long).
// Without this, a server that lets the handshake succeed then drops the socket
// ~1s later would reset the backoff on every attempt → endless 5s reconnect storm.
let wsConnectedAt      = 0;
let wsStabilityTimer   = null;
let wsLastActivity     = 0;       // ms of last inbound frame (pong/trade/control) — liveness
const WS_STABILITY_MS  = 60000;   // 60s of continuous uptime = "healthy", reset backoff
let wsInstantDropCount = 0;       // consecutive sub-stability drops (diagnostic)
const WS_INSTANT_MS    = 15000;   // a close within 15s of open counts as an "instant drop"
let wsDiagnosedBadFeed = false;   // so we only print the actionable diagnostic once

function clearWsStabilityTimer() {
  if (wsStabilityTimer) { clearTimeout(wsStabilityTimer); wsStabilityTimer = null; }
}

function clearWsHeartbeat() {
  if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
  if (wsPingTimeout)    { clearTimeout(wsPingTimeout);     wsPingTimeout    = null; }
}

function startWsHeartbeat(ws, gen) {
  clearWsHeartbeat();
  wsHeartbeatTimer = setInterval(() => {
    if (gen !== wsGeneration) { clearWsHeartbeat(); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearWsHeartbeat(); return; }

    // Liveness is based on ANY inbound activity (trades, control messages, or a pong),
    // not just a protocol pong — some servers don't reply to client pings, and during
    // market hours trade frames already prove the link is alive. Only when the stream
    // has been SILENT for a full interval do we actively probe with a ping.
    if (Date.now() - wsLastActivity < WS_PING_INTERVAL) return;

    try {
      ws.ping();
      if (wsPingTimeout) clearTimeout(wsPingTimeout);
      wsPingTimeout = setTimeout(() => {
        if (gen !== wsGeneration) return;
        // Still nothing (no pong, no data) after the grace period → assume dead, recycle.
        if (Date.now() - wsLastActivity >= WS_PING_INTERVAL) {
          console.warn('[WS] No activity/pong — recycling stale connection');
          clearWsHeartbeat();
          try { ws.terminate(); } catch (e) {}   // fires 'close' → reconnect
        }
      }, WS_PONG_TIMEOUT);
    } catch (e) {
      // ws.ping() can throw if the socket is already closing
      clearWsHeartbeat();
    }
  }, WS_PING_INTERVAL);
}

function scheduleWsReconnect(gen) {
  // Guard: don't schedule if a newer generation is already active
  if (gen !== wsGeneration) return;
  if (wsReconnectTimer) return;
  const delay = wsReconnectDelay;
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
  console.log(`[WS] Reconnecting in ${delay / 1000}s (next: ${wsReconnectDelay / 1000}s)`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function connectWebSocket() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (dataWs) { try { dataWs.removeAllListeners(); dataWs.terminate(); } catch (e) {} }
  clearWsHeartbeat();
  clearWsStabilityTimer();

  const gen = ++wsGeneration;
  console.log(`[WS] Connecting to Alpaca data stream (${ALPACA_DATA_FEED})...`);
  dataWs = new WebSocket(ALPACA_DATA_WS);

  // Symbols we want trade ticks for (core + any live dynamic additions, so
  // dynamics survive a reconnect).
  const subSymbols = [...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse, 'SPY',
                      ...Object.keys(dynamicSymbols)];

  dataWs.on('open', () => {
    if (gen !== wsGeneration) return;
    wsConnected = true;
    wsConnectedAt = Date.now();
    wsLastActivity = Date.now();
    console.log('[WS] Connected — authenticating...');

    // Alpaca requires an auth message right after connect, THEN a subscribe.
    try {
      dataWs.send(JSON.stringify({ action: 'auth', key: APCA_API_KEY_ID, secret: APCA_API_SECRET_KEY }));
    } catch (e) {}

    // DO NOT reset the backoff here. A successful handshake (or even auth) does not
    // mean data is flowing. Only reset once the connection proves stable.
    clearWsStabilityTimer();
    wsStabilityTimer = setTimeout(() => {
      if (gen !== wsGeneration) return;
      if (dataWs && dataWs.readyState === WebSocket.OPEN) {
        wsReconnectDelay = 5000;     // healthy connection → reset backoff
        wsInstantDropCount = 0;
        wsDiagnosedBadFeed = false;
        console.log('[WS] Connection stable — backoff reset');
      }
    }, WS_STABILITY_MS);

    // Heartbeat (Alpaca supports standard WS ping/pong).
    startWsHeartbeat(dataWs, gen);
  });

  dataWs.on('pong', () => {
    wsLastActivity = Date.now();
    if (wsPingTimeout) { clearTimeout(wsPingTimeout); wsPingTimeout = null; }
  });

  dataWs.on('message', raw => {
    if (gen !== wsGeneration) return;
    wsLastActivity = Date.now();   // any inbound frame counts as liveness
    if (wsPingTimeout) { clearTimeout(wsPingTimeout); wsPingTimeout = null; }
    let events;
    try { events = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(events)) events = [events];

    for (const m of events) {
      const T = m && m.T;

      // ── Control messages ────────────────────────────────────────────────
      if (T === 'success') {
        if (m.msg === 'authenticated') {
          // Authenticated → subscribe to trades for the whole watchlist in one shot.
          try { dataWs.send(JSON.stringify({ action: 'subscribe', trades: subSymbols })); } catch (e) {}
          console.log(`[WS] Authenticated — subscribing to ${subSymbols.length} symbols`);
        }
        continue;
      }
      if (T === 'subscription') {
        const n = (m.trades && m.trades.length) || 0;
        console.log(`[WS] Subscription confirmed — ${n} trade streams active`);
        continue;
      }
      if (T === 'error') {
        // Common codes: 402 auth failed, 401 not authed, 406 connection limit,
        // 409 insufficient subscription (e.g. asking for SIP on the free plan).
        console.error(`[WS] Stream error ${m.code}: ${m.msg}`);
        if (m.code === 402 || m.code === 401 || m.code === 403 || m.code === 404) {
          if (!wsDiagnosedBadFeed) {
            wsDiagnosedBadFeed = true;
            console.error('────────────────────────────────────────────────────────────────');
            console.error('[WS] ⚠️  Alpaca rejected authentication.');
            console.error('[WS]   • Check APCA_API_KEY_ID / APCA_API_SECRET_KEY are correct, and');
            console.error('[WS]   • that they match the environment (paper keys ↔ paper, live ↔ live).');
            console.error('────────────────────────────────────────────────────────────────');
          }
        } else if (m.code === 406) {
          // Free plan allows only ONE concurrent data connection. Back off hard so
          // the previous connection has time to fully close server-side.
          wsReconnectDelay = WS_RECONNECT_MAX;
          console.error('[WS] Connection limit hit (one stream per account on the free plan) — backing off 60s.');
        } else if (m.code === 409) {
          console.error('[WS] Insufficient subscription for this feed — if ALPACA_DATA_FEED=sip you need a paid plan; use iex.');
        }
        continue;
      }

      // ── Trade tick ──────────────────────────────────────────────────────
      if (T === 't') {
        const symbol = m.S;
        const price  = m.p;
        const ts     = m.t ? new Date(m.t).getTime() : Date.now();   // RFC3339 → ms
        if (!symbol || !Number.isFinite(price) || price <= 0) continue;

        if (symbol === 'SPY') { spyData.price = price; continue; }

        const ex = marketData[symbol];
        if (!ex) {
          marketData[symbol] = {
            price, prevClose: price, high: price, low: price,
            dailyVolume: 0,
            lastUpdate: Date.now(), lastTradeTime: ts, history: [price]
          };
        } else {
          if (ts < ex.lastTradeTime) continue;
          ex.price = price;
          ex.high  = Math.max(ex.high, price);
          ex.low   = Math.min(ex.low,  price);
          ex.lastUpdate    = Date.now();
          ex.lastTradeTime = ts;
          ex.history.push(price);
          if (ex.history.length > PRICE_HISTORY_LEN) ex.history.shift();
        }
        continue;
      }
    }
  });

  dataWs.on('close', (code) => {
    if (gen !== wsGeneration) return;
    wsConnected = false;
    clearWsHeartbeat();
    clearWsStabilityTimer();

    // How long did this connection last? A drop within WS_INSTANT_MS of opening
    // (or right after auth) usually means a credential/plan problem rather than a blip.
    const uptime = wsConnectedAt ? Date.now() - wsConnectedAt : 0;
    if (wsConnectedAt && uptime < WS_INSTANT_MS) {
      wsInstantDropCount++;
    } else {
      wsInstantDropCount = 0;
    }

    if (code === 1006) {
      console.warn('[WS] Abnormal closure (1006) — network drop or server-side reset');
    }
    console.log(`[WS] Disconnected (code ${code} after ${(uptime/1000).toFixed(0)}s) — scheduling reconnect`);

    // After several instant drops in a row, stop pretending it's transient and
    // tell the operator the likely cause, once. The reconnect loop continues
    // (now at the backed-off cadence), but at least it's no longer silent.
    if (wsInstantDropCount >= 3 && !wsDiagnosedBadFeed) {
      wsDiagnosedBadFeed = true;
      console.error('────────────────────────────────────────────────────────────────');
      console.error('[WS] ⚠️  Connection keeps dropping within seconds of connecting.');
      console.error('[WS] This is usually a DATA-FEED / credential problem, not a network blip:');
      console.error('[WS]   • APCA_API_KEY_ID / APCA_API_SECRET_KEY may be wrong or for the wrong env, OR');
      console.error('[WS]   • ALPACA_DATA_FEED=sip without a paid plan (use iex on the free plan), OR');
      console.error('[WS]   • more than one process is using the same key (free plan = 1 stream).');
      console.error('[WS] Quick REST check (should return JSON, not 401/403):');
      console.error('[WS]   curl -H "APCA-API-KEY-ID: $APCA_API_KEY_ID" -H "APCA-API-SECRET-KEY: $APCA_API_SECRET_KEY" \\');
      console.error('[WS]     "https://data.alpaca.markets/v2/stocks/AAPL/snapshot?feed=iex"');
      console.error('[WS] See GUIDE_2 §F1 "Fix the data feed".');
      console.error('────────────────────────────────────────────────────────────────');
    }

    scheduleWsReconnect(gen);
  });

  dataWs.on('error', err => {
    if (gen !== wsGeneration) return;
    wsConnected = false;
    clearWsHeartbeat();
    clearWsStabilityTimer();
    const is429 = err.message && (err.message.includes('429') || err.message.includes('rate'));
    if (is429) {
      // Rate limited — back off to max immediately
      wsReconnectDelay = WS_RECONNECT_MAX;
      console.error('[WS] Rate limited (429) — backing off to 60s');
    } else {
      console.error('[WS] Error:', err.message);
    }
    // IMPORTANT: error does NOT reliably trigger close on all platforms.
    // Explicitly schedule a reconnect here so we don't get stuck in a
    // disconnected state with no recovery path.
    scheduleWsReconnect(gen);
  });
}

// ─── ALPACA REST HELPER ─────────────────────────────────────────────────
// Authenticated GET against data.alpaca.markets. Resolves parsed JSON, or null
// on any error (never throws). 401/403 means bad keys or a data-plan problem.
function alpacaDataGet(pathAndQuery) {
  return new Promise(resolve => {
    let done = false;
    const req = https.request({
      host: ALPACA_DATA_REST,
      path: pathAndQuery,
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID':     APCA_API_KEY_ID,
        'APCA-API-SECRET-KEY': APCA_API_SECRET_KEY,
        'Accept':              'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (done) return; done = true; clearTimeout(th);
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.error(`[DATA] Auth failed (HTTP ${res.statusCode}) — check APCA keys and your data subscription`);
          return resolve(null);
        }
        if (res.statusCode === 429) { console.warn('[DATA] Rate-limited (429)'); return resolve(null); }
        if (res.statusCode >= 400)  { console.warn(`[DATA] HTTP ${res.statusCode}`); return resolve(null); }
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => { if (!done) { done = true; clearTimeout(th); resolve(null); } });
    const th = setTimeout(() => {
      if (!done) { done = true; req.destroy(); resolve(null); }
    }, 10000);
    req.end();
  });
}

// Map an Alpaca snapshot object → ATLAS quote shape.
// price       = latest trade (fallback minute/daily close)
// prevClose   = previous daily bar close (fallback daily open)
// high/low/vol = today's daily bar
function snapshotToQuote(s) {
  if (!s) return null;
  const lt = s.latestTrade || {}, mb = s.minuteBar || {}, db = s.dailyBar || {}, pdb = s.prevDailyBar || {};
  const price = (lt.p > 0 ? lt.p : 0) || (mb.c > 0 ? mb.c : 0) || (db.c > 0 ? db.c : 0);
  if (!price || price <= 0) return null;
  const prevClose = (pdb.c > 0 ? pdb.c : 0) || (db.o > 0 ? db.o : price);
  return {
    price,
    prevClose: prevClose || price,
    dayOpen:   db.o > 0 ? db.o : null,   // official session open — stable anchor for gap + vol math
    high:      db.h > 0 ? db.h : price,
    low:       db.l > 0 ? db.l : price,
    volume:    db.v || 0
  };
}

// ─── REST QUOTE (single symbol — Alpaca snapshot) ─────────────────────────
function fetchQuote(symbol) {
  return alpacaDataGet(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${ALPACA_DATA_FEED}`)
    .then(snapshotToQuote);
}

async function fetchInitialPrices() {
  if (_fetchInProgress) { console.log('[PRICES] Already fetching'); return; }
  _fetchInProgress = true;
  try {
    const symbols = [...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse, 'SPY', ...Object.keys(dynamicSymbols)];
    console.log(`[PRICES] Fetching ${symbols.length} snapshots from Alpaca (feed=${ALPACA_DATA_FEED})...`);
    // Alpaca multi-snapshot returns latest trade + daily + previous-daily bars for
    // ALL symbols in ONE call — no per-symbol batching or rate-limit dance needed.
    const snap = await alpacaDataGet(`/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=${ALPACA_DATA_FEED}`);
    const map  = (snap && (snap.snapshots || snap)) || {};

    let loaded = 0;
    symbols.forEach(sym => {
      const q = snapshotToQuote(map[sym]);
      if (!q) return;
      if (sym === 'SPY') { spyData = { price: q.price, prevClose: q.prevClose }; loaded++; return; }
      const ex = marketData[sym];
      marketData[sym] = {
        price:         ex?.price ?? q.price,
        prevClose:     q.prevClose,
        high:          q.high,
        low:           q.low,
        dailyVolume:   q.volume || ex?.dailyVolume || 0,
        lastUpdate:    Date.now(),
        lastTradeTime: ex?.lastTradeTime ?? 0,
        history:       ex?.history ?? [q.price]
      };
      loaded++;
    });
    console.log(`[PRICES] Loaded ${loaded}/${symbols.length} symbols`);
    if (loaded === 0) {
      console.error('[PRICES] ⚠️  No snapshots returned — verify APCA keys, data plan, and that symbols are valid.');
    }
    computeMarketBreadth();
  } finally {
    _fetchInProgress = false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  REAL CANDLE DATA — fetch 1m and 5m OHLCV bars from Alpaca
//
//  Powers true ATR (per-bar H/L), multi-timeframe trend (real closes), and RVOL.
//
//  Alpaca's bars endpoint returns ALL requested symbols in a SINGLE call, so the
//  whole watchlist is just 2 requests (1Min + 5Min) — no per-symbol rate-limit
//  pacing needed. feed=iex is real-time and free; sip is the full tape (paid).
// ════════════════════════════════════════════════════════════════════════════

// Fetch multi-symbol bars for one timeframe. Returns { SYM: [{t,o,h,l,c,v}], ... }.
// `t` is normalised to epoch SECONDS to match the rest of the engine.
async function fetchBars(symbols, timeframe, startISO, limitPerSym) {
  const qs = `symbols=${symbols.join(',')}&timeframe=${timeframe}` +
             `&start=${encodeURIComponent(startISO)}&limit=${limitPerSym}` +
             `&adjustment=raw&feed=${ALPACA_DATA_FEED}&sort=asc`;
  const j = await alpacaDataGet(`/v2/stocks/bars?${qs}`);
  const raw = (j && j.bars) || {};
  const out = {};
  Object.keys(raw).forEach(sym => {
    const arr = Array.isArray(raw[sym]) ? raw[sym] : [];
    out[sym] = arr.map(b => ({
      t: Math.floor(new Date(b.t).getTime() / 1000),
      o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
    })).filter(c => c.h > 0 && c.l > 0 && c.c > 0);
  });
  return out;
}

let _candleFetchInProgress = false;

// Candle fetch window: allow from 9:00 AM ET (30 min pre-open) so gaps, uptick ratio,
// and the candle-based regime vote are populated BEFORE the 9:30 session start.
function isCandleFetchWindow() {
  const { hours, day } = getEasternTimeParts();
  if (day === 0 || day === 6) return false;   // weekend
  return hours >= 9.0 && hours < 16.0;          // 9:00 AM – 4:00 PM ET
}

async function fetchCandles() {
  // Use a pre-market-inclusive window (getCurrentMarket() is null before 9:30) so
  // startup populates candle data before the open.
  if (!isCandleFetchWindow()) return;
  if (_candleFetchInProgress) return;
  _candleFetchInProgress = true;

  try {
    const symbols  = [...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse, ...Object.keys(dynamicSymbols)];
    // v11.21: the 1-minute window was 60 MINUTES, which starves on the free IEX feed.
    // IEX is ~3% of the consolidated tape, so a thin name simply does not print every
    // minute — measured live: a 1h window returned enough bars for 0 of 20 symbols,
    // a 4h window for 20 of 20. The engine then paused entries on 17/20 symbols
    // ("lack candle-grade ATR") and traded nothing for a whole session. Widening the
    // lookback costs one identical API call and fixes the starvation outright.
    // Sparse bars spread over a longer span can slightly OVERSTATE ATR, which widens
    // stops — the safe direction to err.
    const start1m  = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();    // last 4h
    const start5m  = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();   // last 12h

    // Two batch calls — all symbols at once per timeframe.
    const [bars1m, bars5m] = await Promise.all([
      fetchBars(symbols, '1Min', start1m, 400),   // 1m bars: tf5m trend + true ATR
      fetchBars(symbols, '5Min', start5m, 200)     // 5m bars: tf15m bias
    ]);

    let updated = 0;
    symbols.forEach(sym => {
      const c1m = bars1m[sym], c5m = bars5m[sym];
      if (c1m && c1m.length) { if (!candleData[sym]) candleData[sym] = {}; candleData[sym].m1 = c1m.slice(-60); updated++; }
      if (c5m && c5m.length) { if (!candleData[sym]) candleData[sym] = {}; candleData[sym].m5 = c5m.slice(-36); }
    });
    console.log(`[CANDLES] Updated ${updated}/${symbols.length} symbols from Alpaca (feed=${ALPACA_DATA_FEED})`);
    if (updated === 0) {
      console.warn('[CANDLES] No bars returned — outside market hours, or check data plan/feed.');
    }

    // Run gap detection and uptick ratio after every candle refresh
    detectOvernightGaps();
    computeCandleUptickRatio();
  } finally {
    _candleFetchInProgress = false;
  }
}

// ─── CANDLE UPTICK RATIO ──────────────────────────────────────────────────
// Fraction of last-30 1m candles that closed higher than their open.
// Gives a candle-level microstructure view of buying vs selling pressure.
// More informative than breadth alone: breadth is daily, this is intraday.
function computeCandleUptickRatio() {
  const symbols = symbolsForMarket(getCurrentMarket());
  if (symbols.length === 0) return;

  let upCandles = 0, totalCandles = 0;
  symbols.forEach(sym => {
    const m1 = candleData[sym]?.m1;
    if (!m1 || m1.length < 5) return;
    const recent = m1.slice(-10);
    recent.forEach(c => {
      totalCandles++;
      if (c.c > c.o) upCandles++;
    });
  });

  if (totalCandles === 0) return;
  const ratio = upCandles / totalCandles;
  // Smooth 20% toward new value to resist single-bar spikes
  sentimentData.uptickRatio = sentimentData.uptickRatio * 0.8 + ratio * 0.2;
}

// ════════════════════════════════════════════════════════════════════════════
//  TERRA ⇄ VENUS ⇄ JUPITER ORCHESTRATION
//
//  Data flow each cycle (every NEWS_POLL_MS during 8:00–16:00 ET):
//    Terra.fetchNews()                  — pull fresh articles (Alpaca/Benzinga)
//      → VENUS.analyze(articles)      — LLM → validated news recommendations
//      → VENUS.research(recs,universe) — + SEC 13F institutional holdings + RVOL
//                                          → ranked watchlist with directional ideas
//        → JUPITER.consumeRecommendations — Venus ideas → live signals + dynamics
//          → Terra.addDynamicSymbol     — liquidity-screen & subscribe new names
//    Entry scan:
//      → JUPITER.scoreAdjustment(symbol)  — bounded ± nudge to the weighted score
//    On close (finalizeClose):
//      → JUPITER.recordOutcome(trade)     — Jupiter learns its edge; returns outcome
//        → VENUS.learn(outcome)       — Venus recalibrates by catalyst
//    All of it → LUNA via /api/portfolio (venus + jupiter blocks).
//
//  Safety: Venus only advises; Jupiter's nudge is hard-bounded and decays; the
//  strategy gate + full risk pipeline (in Terra) hold absolute veto. No API key
//  → Venus off, Jupiter runs technical-only.
// ════════════════════════════════════════════════════════════════════════════

// Terra-side state (news plumbing + the dynamic watchlist roster).
let dynamicSymbols = {};        // SYM → { addedAt, source:'venus', catalyst } (roster Terra maintains)
let seenNewsIds    = new Set(); // dedupe articles across polls
let pendingArticles = [];       // articles fetched but not yet analyzed (budget/again next cycle)
let aiCallLog      = [];        // timestamps of Venus calls (rolling hour window)
// ── Rate-limit cooldown (v11.16) — shared across ALL LLM callers ─────────────
// Seen live: a 429 on one call, retried at full cadence, burns the hourly budget on
// guaranteed failures. On any 'rate-limited' result, every LLM path (news analysis,
// assess, deliberate) goes quiet for the cooldown window, then resumes normally.
let aiCooldownUntil = 0;
const AI_RATE_LIMIT_COOLDOWN_MS = 90 * 1000;
// Max news articles per single LLM call. The live death loop: ~20 articles in one
// prompt ≈ 5–8K tokens — OVER Groq's free-tier tokens-per-minute cap by itself, so the
// call 429'd, the whole batch requeued, and the identical oversized call failed again
// every cycle forever. 8 articles ≈ ~2K tokens — comfortably under; the rest wait.
const MAX_ARTICLES_PER_CALL = 8;
let intelStats     = { articlesSeen: 0, aiCalls: 0, signalsGenerated: 0, lastCycleAt: 0, lastError: null, tokensIn: 0, tokensOut: 0 };
let _intelInProgress = false;

function aiCallsThisHour() {
  const cutoff = Date.now() - 3600000;
  aiCallLog = aiCallLog.filter(t => t > cutoff);
  return aiCallLog.length;
}

// ── Shared LLM reasoning, budget-aware, used by BOTH engines for genuine reasoning
//    that goes beyond fixed rules. Returns parsed JSON, or null when there's no API
//    key / the hourly budget is spent / the response won't parse — in every such case
//    the caller falls back to its mechanical behaviour, so reasoning only ever ADDS.
async function llmReason(prompt) {
  if (!PROVIDER) return null;
  if (Date.now() < aiCooldownUntil) return null;   // provider rate-limited — stay quiet
  if (aiCallsThisHour() >= AI_MAX_CALLS_PER_HOUR) return null;
  aiCallLog.push(Date.now());
  try { intelStats.aiCalls++; } catch (_) {}
  let r;
  try { r = PROVIDER === 'groq' ? await callGroq(prompt) : await callAnthropic(prompt); }
  catch (_) { return null; }
  if (r && !r.ok && r.error === 'rate-limited') {
    aiCooldownUntil = Date.now() + AI_RATE_LIMIT_COOLDOWN_MS;
    console.warn(`[AI] ${PROVIDER} rate-limited — cooling down ALL LLM calls ${AI_RATE_LIMIT_COOLDOWN_MS/1000}s`);
    return null;
  }
  if (!r || !r.ok || !r.text) return null;
  try {
    const t = r.text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s === -1 || e === -1 || e < s) return null;
    return JSON.parse(t.slice(s, e + 1));
  } catch (_) { return null; }
}

function isNewsWindow() {
  const { hours, day } = getEasternTimeParts();
  if (day === 0 || day === 6) return false;
  return hours >= 8.0 && hours < 16.0;     // pre-market news matters for the open
}

// All symbols the engine should trade/track right now: core watchlist + live dynamics.
function allTradeSymbols(market) {
  const core = symbolsForMarket(market);
  const dyn  = Object.keys(dynamicSymbols);
  return dyn.length ? [...core, ...dyn.filter(s => !core.includes(s))] : core;
}

// ── 1. Fetch news from Alpaca (same keys, same REST helper) ─────────────────
async function fetchNews() {
  const j = await alpacaDataGet(`/v1beta1/news?limit=50&sort=desc&exclude_contentless=true`);
  const items = (j && j.news) || [];
  const fresh = [];
  const cutoff = Date.now() - 2 * 3600000;   // ignore stories older than 2h
  for (const n of items) {
    const id = String(n.id || n.url || n.headline || '');
    if (!id || seenNewsIds.has(id)) continue;
    const ts = n.created_at ? Date.parse(n.created_at) : 0;
    if (ts && ts < cutoff) continue;
    seenNewsIds.add(id);
    fresh.push({
      id,
      headline:   String(n.headline || '').slice(0, 300),
      summary:    String(n.summary || '').slice(0, 500),
      symbols:    Array.isArray(n.symbols) ? n.symbols.slice(0, 8) : [],
      source:     n.source || 'benzinga',
      created_at: n.created_at || ''
    });
  }
  // Cap dedupe set growth
  if (seenNewsIds.size > 3000) seenNewsIds = new Set([...seenNewsIds].slice(-1500));
  intelStats.articlesSeen += fresh.length;
  return fresh;
}

// ── Terra runs the cycle: fetch news → Venus analyzes → Jupiter consumes ────
async function runIntelCycle() {
  if (!AI_ENABLED) return;
  if (_intelInProgress) return;
  if (!isNewsWindow()) { pruneIntel(); return; }
  _intelInProgress = true;
  try {
    const fresh = await fetchNews();
    pruneIntel();   // expire old signals/dynamics every cycle regardless

    // Combine retry queue + fresh; drop anything that's gone stale (>2h)
    const staleCut = Date.now() - 2 * 3600000;
    const batch = [...pendingArticles, ...fresh]
      .filter(a => !a.created_at || Date.parse(a.created_at) >= staleCut)
      .slice(-30);                                       // hard cap queue size
    pendingArticles = [];

    // ── STAGE 1 (optional): NEWS ANALYSIS ────────────────────────────────────
    // v11.16: this stage can fail, rate-limit, hit budget, or simply have nothing to
    // read — NONE of that is allowed to kill the rest of the cycle anymore. Seen
    // live: one rate-limited news call short-circuited research + assess + deliberate
    // for an entire session (zero 🧭 lines in the log; the whole intelligence layer
    // silently dead behind a single 429).
    let r = { ok: false, recommendations: [] };
    if (batch.length === 0) {
      r = { ok: true, recommendations: [] };               // no news is not a failure
    } else if (Date.now() < aiCooldownUntil) {
      pendingArticles = batch;                             // provider cooling down — retry next cycle
    } else if (aiCallsThisHour() >= AI_MAX_CALLS_PER_HOUR) {
      pendingArticles = batch;
      console.log(`[VENUS] Call budget reached (${AI_MAX_CALLS_PER_HOUR}/h) — ${batch.length} articles queued for next cycle`);
    } else {
      // TPM-safe slice: analyze only the newest MAX_ARTICLES_PER_CALL articles this
      // call; the remainder stays queued (still stale-filtered + capped next cycle).
      // A ~20-article batch was ~5–8K tokens in ONE request — over Groq's free-tier
      // tokens-per-minute cap by itself → guaranteed 429 → full requeue → forever.
      const toAnalyze = batch.slice(-MAX_ARTICLES_PER_CALL);
      pendingArticles = batch.slice(0, -MAX_ARTICLES_PER_CALL);
      aiCallLog.push(Date.now());
      intelStats.aiCalls++;
      r = await venus.analyze(toAnalyze);                  // VENUS analyzes (uses its own calibration)
      intelStats.lastCycleAt = Date.now();

      if (!r.ok) {
        intelStats.lastError = r.error;
        pendingArticles = [...pendingArticles, ...toAnalyze].slice(-30);   // retry next cycle
        if (r.error === 'rate-limited') {
          aiCooldownUntil = Date.now() + AI_RATE_LIMIT_COOLDOWN_MS;
          console.warn(`[VENUS] Analysis rate-limited — ${toAnalyze.length} article(s) requeued; ALL LLM calls cooling down ${AI_RATE_LIMIT_COOLDOWN_MS/1000}s`);
        } else {
          console.warn(`[VENUS] Analysis failed (${venus.PROVIDER}): ${r.error} — ${toAnalyze.length} article(s) requeued`);
        }
        r.recommendations = [];                            // …and the cycle CONTINUES below
      } else {
        intelStats.lastError = null;
        if (r.usage) { intelStats.tokensIn += r.usage.input || 0; intelStats.tokensOut += r.usage.output || 0; }
      }
    }

    if (r.recommendations.length) {
      console.log(`[VENUS] → ${r.recommendations.length} recommendation(s) handed to Jupiter`);
    }
    intelStats.signalsGenerated += r.recommendations.length;

    // VENUS RESEARCH: enrich the news with SEC 13F institutional holdings + real-time
    // relative volume → a ranked watchlist with directional ideas. This is the full
    // "scan the web + analyze what serious money holds + where the action is" pass.
    const universe = allTradeSymbols(getCurrentMarket() || 'nasdaq');
    await venus.research({
      recs: r.recommendations,
      universe,
      rvolOf: (s) => calculateRVOL(s),
      max: DYNAMIC_MAX_SYMBOLS
    });

    // VENUS reasons over the whole board — its own market posture + refined ideas,
    // not just the fixed formula (degrades to the formula if no LLM/budget).
    const _edge   = calculateTradeExpectancy();
    const _sample = portfolio.closedTrades.filter(t => !t.partial).length;   // full closes only
    const venusPosture = await venus.assess({
      stress:  calculateMarketStress(),
      regime:  detectMarketRegime(),
      winRate: _edge.winRate,
      sample:  _sample
    });
    if (venusPosture) console.log(`[VENUS] 🧭 Posture ${venusPosture.stance}${venusPosture.reasoning ? ' — ' + venusPosture.reasoning : ''}`);

    // JUPITER self-checks — reviews how we're actually doing + how exposed we are, and
    // sets its own bounded risk posture (size ×≤1) and optional hold. Discipline only.
    // A stale stored Venus posture (>90 min) is not forwarded — Jupiter reasons on
    // fresh context or none.
    const _tv = getTotalValue();
    const _storedPosture = venus.getResearch().posture;
    const _posFresh = _storedPosture && (Date.now() - (_storedPosture.at || 0)) < 90 * 60000;
    const jp = await jupiter.deliberate({
      winRate:           _edge.winRate,
      sample:            _sample,
      profitFactor:      _edge.profitFactor === 999 ? 99 : _edge.profitFactor,
      drawdown:          riskSystem.currentDrawdown,
      consecutiveLosses: riskSystem.consecutiveLosses,
      openPositions:     Object.keys(portfolio.longPositions).length + Object.keys(portfolio.shortPositions).length,
      maxPositions:      MAX_OPEN_POSITIONS,
      deployed:          _tv > 0 ? getNotionalExposure() / _tv : 0,
      venusPosture:      venusPosture ? venusPosture.stance : (_posFresh ? _storedPosture.stance : null)
    });
    if (jp) console.log(`[JUPITER] 🧭 Self-check size ×${jp.multiplier.toFixed(2)}${jp.hold ? ' · HOLD (new entries paused)' : ''}${jp.note ? ' — ' + jp.note : ''}`);

    const ideas = venus.researchRecommendations();   // institutional + news + vol, Jupiter-ready
    if (ideas.length) {
      console.log(`[VENUS] 🔬 Research → ${ideas.length} idea(s) (${venus.getResearch().institutions} names with institutional interest) handed to Jupiter`);
    }

    // JUPITER consumes Venus's research → sizes/decides; returns dynamic-watchlist candidates
    const candidates = jupiter.consumeRecommendations(ideas.length ? ideas : r.recommendations);
    for (const c of candidates) {
      const isCore = symbolsForMarket('nasdaq').includes(c.symbol) || c.symbol === 'SPY';
      if (!isCore && !dynamicSymbols[c.symbol]) {
        await addDynamicSymbol(c.symbol, c.rec);
      }
    }
    queueSaveState();
  } catch (e) {
    intelStats.lastError = e.message;
    console.error('[VENUS] Cycle error:', e.message);
  } finally {
    _intelInProgress = false;
  }
}

// ── Dynamic watchlist management ────────────────────────────────────────────
async function addDynamicSymbol(sym, sig) {
  if (!DYNAMIC_WATCHLIST_ON) return false;
  if (Object.keys(dynamicSymbols).length >= DYNAMIC_MAX_SYMBOLS) {
    console.log(`[JUPITER] Dynamic watchlist full (${DYNAMIC_MAX_SYMBOLS}) — skipping ${sym}`);
    return false;
  }

  // Liquidity/price screen via snapshot before we commit
  const snap = await alpacaDataGet(`/v2/stocks/${encodeURIComponent(sym)}/snapshot?feed=${ALPACA_DATA_FEED}`);
  const q = snapshotToQuote(snap);
  if (!q) { console.log(`[JUPITER] ${sym} rejected — no snapshot (bad/foreign/delisted symbol?)`); return false; }
  if (q.price < DYNAMIC_MIN_PRICE || q.price > DYNAMIC_MAX_PRICE) {
    console.log(`[JUPITER] ${sym} rejected — price $${q.price.toFixed(2)} outside [$${DYNAMIC_MIN_PRICE}, $${DYNAMIC_MAX_PRICE}]`);
    return false;
  }
  if ((q.volume || 0) < EFFECTIVE_MIN_DAY_VOL) {
    console.log(`[JUPITER] ${sym} rejected — day volume ${q.volume} < ${EFFECTIVE_MIN_DAY_VOL} (too thin on the ${ALPACA_DATA_FEED} feed)`);
    return false;
  }

  // Seed market data from the snapshot
  marketData[sym] = {
    price: q.price, prevClose: q.prevClose, high: q.high, low: q.low,
    dailyVolume: q.volume || 0,
    lastUpdate: Date.now(), lastTradeTime: 0, history: [q.price]
  };
  dynamicSymbols[sym] = { addedAt: Date.now(), source: 'venus', catalyst: sig?.catalyst || 'other' };

  // Warm up candles immediately so ATR/RVOL/strategy-gate have real data fast
  try {
    const start1m = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();    // see fetchCandles
    const start5m = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const [b1, b5] = await Promise.all([
      fetchBars([sym], '1Min', start1m, 100),
      fetchBars([sym], '5Min', start5m, 100)
    ]);
    if (b1[sym]?.length) { candleData[sym] = candleData[sym] || {}; candleData[sym].m1 = b1[sym].slice(-60); }
    if (b5[sym]?.length) { candleData[sym] = candleData[sym] || {}; candleData[sym].m5 = b5[sym].slice(-36); }
    // Seed tick history from candle closes so EMA/RSI are meaningful immediately
    if (b1[sym]?.length >= 15) marketData[sym].history = b1[sym].slice(-40).map(c => c.c);
  } catch (e) { /* candle warmup is best-effort */ }

  // Subscribe on the live stream
  if (dataWs && dataWs.readyState === WebSocket.OPEN) {
    try { dataWs.send(JSON.stringify({ action: 'subscribe', trades: [sym] })); } catch (e) {}
  }
  console.log(`[JUPITER] ➕ Dynamic add: ${sym} @ $${q.price.toFixed(2)} (vol ${(q.volume / 1e6).toFixed(1)}M) [${sig?.catalyst || '—'}]`);
  return true;
}

function removeDynamicSymbol(sym) {
  delete dynamicSymbols[sym];
  if (dataWs && dataWs.readyState === WebSocket.OPEN) {
    try { dataWs.send(JSON.stringify({ action: 'unsubscribe', trades: [sym] })); } catch (e) {}
  }
  console.log(`[JUPITER] ➖ Dynamic remove: ${sym}`);
}

// Expire stale signals (Jupiter owns them); drop dynamics whose signal expired and
// have no open position.
function pruneIntel() {
  jupiter.prune();   // Jupiter expires its own time-decayed signals
  const now = Date.now();
  for (const sym of Object.keys(dynamicSymbols)) {
    const hasPos = (portfolio.longPositions[sym]?.length > 0) || (portfolio.shortPositions[sym]?.length > 0);
    if (!jupiter.hasSignal(sym) && !hasPos) {
      // Grace period: keep a dynamic symbol 30 min past signal expiry in case price action develops
      if (now - dynamicSymbols[sym].addedAt > 30 * 60000) removeDynamicSymbol(sym);
    }
  }
}

// ── Score adjustment used inside evaluateAndTrade — delegates to JUPITER ───────
function aiScoreAdjustment(symbol) {
  return jupiter.scoreAdjustment(symbol);
}

// Stamp Venus/Jupiter metadata onto the trade record just opened, so the outcome
// can be attributed to the catalyst when the position closes (Jupiter → Venus loop).
function stampAiMetadata(symbol, direction) {
  const meta = jupiter.markTraded(symbol, direction);   // returns {catalyst, conviction} or null
  if (!meta) return;
  const t = [...portfolio.trades].reverse().find(
    x => x.ticker === symbol && x.direction === direction && x.status === 'open' && !x.aiCatalyst
  );
  if (!t) return;
  t.aiCatalyst      = meta.catalyst;
  t.aiMechanism     = meta.mechanism || 'none';
  t.aiConviction    = meta.conviction;
  t.aiConvictionRaw = meta.convictionRaw;
}

// ── Outcome learning — called from finalizeClose ────────────────────────────
// Jupiter records the trading-side outcome (edge), then hands it to Venus so the
// analysis engine recalibrates. This closes the Venus ⇄ Jupiter learning loop.
function recordAiOutcome(ticker, direction, totalPnL) {
  const t = [...portfolio.trades].reverse().find(
    x => x.ticker === ticker && x.direction === direction && x.status === 'closed' && !x._aiCounted
  );
  if (!t) return;
  t._aiCounted = true;
  // Jupiter records the outcome, trains its win-probability model, and reports the
  // result straight to Venus via a direct in-process call (zero latency).
  jupiter.recordOutcome({
    ticker, direction,
    aiCatalyst: t.aiCatalyst, aiMechanism: t.aiMechanism,
    aiConviction: t.aiConviction, aiConvictionRaw: t.aiConvictionRaw,
    realizedPnL: totalPnL
  });
}


// ─── OVERNIGHT GAP DETECTION ──────────────────────────────────────────────
// Compare prevClose (from REST quote) to the first 1m candle open of the day.
// Large gaps mean the symbol's risk profile is different today — stops need
// to be wider, or we should skip the symbol entirely until it stabilises.
// Median intraday move measured FROM THE DAY'S OPEN across the given symbols.
// Median: robust to the watchlist's designed-in high-vol names (one 6% runner must not
// halt the whole book). From-open: overnight gaps already have their own handling; a
// prevClose-based measure double-counts the gap as "volatility". Falls back to
// prevClose per-symbol only when the official open isn't known yet.
function marketIntradayVolMedian(symbols) {
  const vals = [];
  symbols.forEach(sym => {
    const d = marketData[sym];
    if (!d || !d.price) return;
    const base = (Number.isFinite(d.dayOpen) && d.dayOpen > 0) ? d.dayOpen : d.prevClose;
    if (!base || base <= 0) return;
    vals.push(Math.abs(d.price - base) / base);
  });
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function detectOvernightGaps() {
  const symbols  = [...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse];
  const now      = Date.now();
  const todayStr = getEasternTimeParts().dateStr;

  symbols.forEach(sym => {
    // An overnight gap is a FACT OF THE OPEN — measure it once per day, then freeze it.
    // v11.15 regression seen live: recomputing from m1[0] (the oldest bar in a SLIDING
    // buffer) made the "gap" drift all session (CIFR 6.17→6.47→6.32%), re-tripping the
    // 0.1%-change check and RE-ARMING blockUntil every cycle → the symbol stayed
    // blocked all day, defeating the v11.14 expiry fix through the back door.
    const existing = gapData[sym];
    if (existing && existing.dateStr === todayStr) return;   // already anchored today

    const md        = marketData[sym];
    const prevClose = md?.prevClose;
    if (!prevClose || prevClose <= 0) return;
    // Prefer the OFFICIAL daily open from the Alpaca snapshot — stable all day and
    // correct even after a mid-day restart. Fall back to the earliest cached candle.
    const m1      = candleData[sym]?.m1;
    const dayOpen = (md && Number.isFinite(md.dayOpen) && md.dayOpen > 0) ? md.dayOpen
                  : (m1 && m1.length ? m1[0].o : null);
    if (!dayOpen || dayOpen <= 0) return;

    const gapPct = (dayOpen - prevClose) / prevClose;  // positive = gap up
    gapData[sym] = {
      gapPct,
      direction: gapPct > 0 ? 'up' : gapPct < 0 ? 'down' : 'flat',
      absGap: Math.abs(gapPct),
      detectedAt: now,
      dateStr: todayStr,
      // Armed ONCE at detection; never re-armed intraday. Expiry math in
      // getGapSizeAdjust/isGapBlocked (v11.14) now actually gets to run.
      blockUntil: Math.abs(gapPct) >= GAP_BLOCK_PCT ? now + GAP_BLOCK_MS : 0
    };

    if (Math.abs(gapPct) >= GAP_WARN_PCT) {
      const dir = gapPct > 0 ? '↑' : '↓';
      console.log(`[GAP] ${sym} ${dir}${(gapPct * 100).toFixed(2)}% overnight gap${Math.abs(gapPct) >= GAP_BLOCK_PCT ? ' — BLOCKED 30min' : ' — size reduced'}`);
    }
  });
}

// Returns gap adjustment factor for position sizing: 1.0 = no gap, 0.5 = gap warning.
// TIME-TIED with isGapBlocked (v11.14): during the 30-min block window this returns 0.0
// (belt-and-suspenders with the scan-level gate); once the block EXPIRES, a big gap
// settles into the same half-size tier as a warning-level gap instead of staying at
// zero. Previously this keyed on absGap alone — a magnitude that never decays — so a
// symbol that gapped ≥3% at the open remained permanently unsizeable all session (0
// shares → Terra rejected every attempt) even after its block had lifted.
function getGapSizeAdjust(symbol) {
  const gap = gapData[symbol];
  if (!gap) return 1.0;
  if (gap.blockUntil > Date.now())  return 0.0;  // timed block active → no new size
  if (gap.absGap >= GAP_WARN_PCT)   return 0.5;  // block expired / warn-level → half size
  return 1.0;
}

// Returns true if symbol is blocked due to a large overnight gap
function isGapBlocked(symbol) {
  const gap = gapData[symbol];
  if (!gap) return false;
  return gap.blockUntil > Date.now();
}




//
//  Instead of random noise, sentiment is computed from:
//   1. Breadth: fraction of watchlist symbols above their prevClose
//   2. SPY momentum: daily % change in SPY as a market-wide trend signal
//   3. Intraday volatility: breadth contracts during high-vol regimes
//
//  This gives the bot real data to act on. It runs every 10s on the live
//  tick prices already in marketData — no extra API calls needed.
// ════════════════════════════════════════════════════════════════════════════

function computeMarketBreadth() {
  const market  = getCurrentMarket();
  const symbols = symbolsForMarket(market);
  if (symbols.length === 0) return;

  let advancing = 0, total = 0;
  symbols.forEach(sym => {
    const d = marketData[sym];
    if (!d || !d.price || !d.prevClose) return;
    total++;
    if (d.price > d.prevClose) advancing++;
  });
  if (total === 0) return;

  const breadth = advancing / total;   // 0 = all declining, 1 = all advancing
  sentimentData.breadthScore = breadth;

  // SPY momentum as a market-wide directional filter
  const spyMom = (spyData.price && spyData.prevClose && spyData.prevClose > 0)
    ? (spyData.price - spyData.prevClose) / spyData.prevClose
    : 0;
  sentimentData.spyMomentum = spyMom;

  // Combine: breadth drives 70% of sentiment, SPY momentum adds 30%.
  // Map SPY momentum to a 0-1 scale (±2% move maps to 0.2–0.8).
  const spySignal = Math.max(0.2, Math.min(0.8, 0.5 + spyMom * 10));
  const raw = breadth * 0.7 + spySignal * 0.3;
  const clamped = Math.max(0.2, Math.min(0.8, raw));

  // Smooth toward the new value — TIME-NORMALIZED (v11.19).
  // This was a flat `general*0.8 + clamped*0.2` per call, which silently couples the
  // filter's real-world responsiveness to the MAIN LOOP'S TICK RATE. When the loop went
  // 10s→2s this same line started running 5x more often, cutting the EMA's half-life
  // from ~31s to ~6s — sentiment began whipsawing on short-lived breadth flickers, and
  // sentimentFactor is 10% of every entry score, so that noise fed straight into entry
  // quality. (Same failure class as the v11.17 win-rate bug: an EMA step must correspond
  // to a fixed unit — here, of TIME, since each call carries genuinely new prices.)
  // Deriving alpha from elapsed ms against the 10s cadence the 0.2 was tuned for keeps
  // the intended ~31s half-life at ANY tick rate, and makes future cadence changes safe.
  // Irregular spacing is handled correctly too (fetchInitialPrices/diag also call this).
  const _sNow = Date.now();
  const _sDt  = computeMarketBreadth._lastAt ? Math.max(0, _sNow - computeMarketBreadth._lastAt)
                                             : SENTIMENT_EMA_REF_MS;
  computeMarketBreadth._lastAt = _sNow;
  const _sAlpha = sentimentAlpha(_sDt);
  sentimentData.general = sentimentData.general * (1 - _sAlpha) + clamped * _sAlpha;

  // Per-market sentiment: both NASDAQ and NYSE trade together in the US session
  if (market === 'nasdaq') {
    sentimentData.byMarket.nasdaq = sentimentData.general;
    sentimentData.byMarket.nyse   = sentimentData.general;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ════════════════════════════════════════════════════════════════════════════

function ema(history, period) {
  if (!history || history.length === 0) return null;
  if (history.length < 2) return history[history.length - 1];
  const k = 2 / (period + 1);
  let e = history[0];
  for (let i = 1; i < history.length; i++) e = history[i] * k + e * (1 - k);
  return e;
}

function rsi(history, period = 14) {
  if (!history || history.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = history.length - period;
  for (let i = start; i < history.length; i++) {
    const diff = history[i] - history[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calculateVolatility(symbol) {
  const d = marketData[symbol];
  if (!d || !d.high || !d.low || !d.price || d.price <= 0) return 0.02;
  const vol = Math.abs(d.high - d.low) / d.price;
  return Number.isFinite(vol) ? Math.max(0.005, Math.min(0.5, vol)) : 0.02;
}

// Renamed from vwapProxy — honest comment: this is a simple midpoint, not real VWAP.
// Real VWAP needs cumulative (price × volume) which the trade stream alone does not provide.
function priceMidpoint(symbol) {
  const d = marketData[symbol];
  if (!d || !d.high || !d.low) return d?.price ?? 0;
  return (d.high + d.low + d.price) / 3;
}

// ✅ TRUE ATR — uses actual per-bar H/L from candle data when available.
// Falls back to tick-delta approximation only before candles have loaded.
function calculateATR(symbol, period = 14) {
  const candles = candleData[symbol]?.m1;
  if (candles && candles.length >= 2) {
    // True Range = max(H-L, |H-prevClose|, |L-prevClose|)
    let trSum = 0;
    const lookback = Math.min(period, candles.length - 1);
    const start = candles.length - lookback;
    for (let i = start; i < candles.length; i++) {
      const h  = candles[i].h, l = candles[i].l;
      const pc = candles[i - 1].c;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      trSum += tr;
    }
    const atr = trSum / lookback;
    return Number.isFinite(atr) && atr > 0 ? atr : (marketData[symbol]?.price || 10) * 0.015;
  }

  // Fallback: tick-to-tick delta approximation (pre-candle data)
  const d = marketData[symbol];
  if (!d || !d.history || d.history.length < 2) return (d?.price || 10) * 0.015;
  let trSum = 0;
  const start = Math.max(1, d.history.length - period);
  for (let i = start; i < d.history.length; i++) {
    trSum += Math.abs(d.history[i] - d.history[i - 1]);
  }
  const lookbackPeriod = Math.min(period, d.history.length - 1);
  return lookbackPeriod > 0 ? trSum / lookbackPeriod : (d.price || 10) * 0.015;
}

// ── VOLATILITY DATA QUALITY (v11.19 — the primary live money-loser) ──────────
// A live session ran with `[CANDLES] Updated 3/21 symbols` (the IEX feed is only ~3%
// of the consolidated tape, so thin names get very few 1-minute bars). With no candles
// calculateATR falls back to TICK-TO-TICK deltas, which on IEX are pennies apart — so
// measured ATR collapsed to the 0.3% floor, producing a 0.66% stop against a 0.5–1.5%
// round-trip execution cost. That stop sits INSIDE the spread+noise: on a name that
// moves 5% a day it is a coin flip that pays the spread every flip. Five consecutive
// losses followed, and the R:R gate never caught it because the ratio (1.38/0.66) still
// read as a healthy 2.09 — the geometry was fine, the volatility input was fiction.
//
// Two defences, because either alone is insufficient:
//   1. atrQuality() — entries are gated on candle-grade data (see evaluateAndTrade),
//      so we simply do not trade a symbol whose volatility we cannot measure.
//   2. A quality-aware FLOOR here — if the fallback is ever used anyway (managing an
//      already-open position, a mid-session data gap), it must err WIDE, never tight.
//      Real candle-derived ATR keeps the original 0.3% floor so genuinely calm names
//      (KO, JNJ) are not forced into artificially wide stops.
const MIN_CANDLES_FOR_ATR = 15;   // enough 1m bars for a meaningful 14-period ATR

function atrQuality(symbol) {
  const m1 = candleData[symbol]?.m1;
  return (m1 && m1.length >= MIN_CANDLES_FOR_ATR) ? 'candle' : 'fallback';
}
// True only when the symbol's volatility is measured from real OHLC bars.
function hasReliableVolatility(symbol) { return atrQuality(symbol) === 'candle'; }

// ATR as a fraction of price (volatility %), clamped to a sane band.
function atrPct(symbol) {
  const price = marketData[symbol]?.price || 0;
  if (price <= 0) return 0.02;
  const a = calculateATR(symbol, STRATEGY.ATR_PERIOD) / price;
  // Fallback floor is deliberately ~2.7x the candle floor: 0.8% ATR → a 1.76% stop,
  // comfortably clear of round-trip costs, instead of 0.66% which is inside them.
  const floor = atrQuality(symbol) === 'candle' ? 0.003 : 0.008;
  return Number.isFinite(a) ? Math.max(floor, Math.min(0.15, a)) : 0.02;
}

// ✅ ADX (Average Directional Index) — Wilder. Measures TREND STRENGTH (not
// direction). This is the single most important regime filter in the quant
// mean-reversion/momentum literature: trend-follow only when ADX is high; fade
// extremes only when ADX is low. Computed from 1-minute candles.
// Returns { adx, plusDI, minusDI } or null if insufficient data.
function calculateADX(symbol, period = STRATEGY.ADX_PERIOD) {
  const candles = candleData[symbol]?.m1;
  if (!candles || candles.length < period * 2 + 1) return null;

  const n = candles.length;
  let trS = 0, plusDMS = 0, minusDMS = 0;
  // Seed with the first `period` window
  const seedStart = n - (period * 2);
  for (let i = seedStart; i < seedStart + period; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    const ph = candles[i - 1].h, pl = candles[i - 1].l;
    const up = h - ph, down = pl - l;
    const plusDM  = (up > down && up > 0)   ? up   : 0;
    const minusDM = (down > up && down > 0) ? down : 0;
    trS      += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    plusDMS  += plusDM;
    minusDMS += minusDM;
  }
  // Wilder smoothing + DX series over the second window
  const dxs = [];
  for (let i = seedStart + period; i < n; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    const ph = candles[i - 1].h, pl = candles[i - 1].l;
    const up = h - ph, down = pl - l;
    const plusDM  = (up > down && up > 0)   ? up   : 0;
    const minusDM = (down > up && down > 0) ? down : 0;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trS      = trS      - (trS / period)      + tr;
    plusDMS  = plusDMS  - (plusDMS / period)  + plusDM;
    minusDMS = minusDMS - (minusDMS / period) + minusDM;
    if (trS <= 0) continue;
    const plusDI  = 100 * (plusDMS / trS);
    const minusDI = 100 * (minusDMS / trS);
    const denom = plusDI + minusDI;
    if (denom > 0) dxs.push(100 * Math.abs(plusDI - minusDI) / denom);
  }
  if (dxs.length === 0) return null;
  // ADX = average of the DX series
  const adx = dxs.reduce((a, b) => a + b, 0) / dxs.length;
  // Latest directional read
  const lastPlusDI  = 100 * (plusDMS / trS);
  const lastMinusDI = 100 * (minusDMS / trS);
  return Number.isFinite(adx)
    ? { adx, plusDI: lastPlusDI, minusDI: lastMinusDI }
    : null;
}

// ✅ RVOL — Rolling 5-minute volume relative to the recent average.
// Returns a multiplier (1.0 = average, 2.0 = twice normal, etc.).
// Uses actual 1m candle volumes rather than the static dailyVolume snapshot.
function calculateRVOL(symbol) {
  const candles = candleData[symbol]?.m1;
  if (!candles || candles.length < 10) {
    // Fallback: compare dailyVolume to threshold
    // Feed-scaled for the same reason as EFFECTIVE_MIN_DAY_VOL: on the iex feed this
    // threshold was being compared against ~3%-of-tape volume, so almost every symbol
    // read as "thin" and got RVOL 0.5 — which then halves position size in computeSize.
    const vol = marketData[symbol]?.dailyVolume || 0;
    return vol > VOLATILITY_FILTERS.MIN_VOLUME_THRESHOLD * FEED_VOLUME_FACTOR ? 1.0 : 0.5;
  }

  // Sum of the most recent 5 bars = current 5-min volume
  const recent5 = candles.slice(-5);
  const currentVol = recent5.reduce((s, c) => s + (c.v || 0), 0);

  // Average 5-bar volume over the prior 10 windows (50 bars = ~50 min lookback)
  const prior50 = candles.slice(-55, -5);
  if (prior50.length < 5) return 1.0;
  // Chunk into 5-bar windows and average
  const windows = [];
  for (let i = 0; i + 5 <= prior50.length; i += 5) {
    windows.push(prior50.slice(i, i + 5).reduce((s, c) => s + (c.v || 0), 0));
  }
  if (windows.length === 0) return 1.0;
  const avgVol = windows.reduce((s, v) => s + v, 0) / windows.length;
  if (avgVol === 0) return 1.0;
  return Math.min(5.0, currentVol / avgVol);  // cap at 5× to prevent outlier spikes
}

// ✅ Candle-based multi-timeframe trend.
// Returns { tf5m: 'bullish'|'bearish'|'neutral', tf15m: 'bullish'|'bearish'|'neutral' }
// using real candle close prices instead of sliced tick history.
function getCandleTrend(symbol) {
  const m1 = candleData[symbol]?.m1;
  const m5 = candleData[symbol]?.m5;

  // tf5m: EMA(3) vs EMA(8) on last 12 1m-bar closes ≈ recent 12-min momentum
  let tf5m = 'neutral';
  if (m1 && m1.length >= 10) {
    const closes1m = m1.slice(-12).map(c => c.c);
    const fast = ema(closes1m, 3);
    const slow = ema(closes1m, 8);
    if (fast !== null && slow !== null) {
      tf5m = fast > slow ? 'bullish' : fast < slow ? 'bearish' : 'neutral';
    }
  }

  // tf15m: EMA(3) vs EMA(6) on last 9 5m-bar closes ≈ 45-min bias
  let tf15m = 'neutral';
  if (m5 && m5.length >= 8) {
    const closes5m = m5.slice(-9).map(c => c.c);
    const fast = ema(closes5m, 3);
    const slow = ema(closes5m, 6);
    if (fast !== null && slow !== null) {
      tf15m = fast > slow ? 'bullish' : fast < slow ? 'bearish' : 'neutral';
    }
  } else if (m1 && m1.length >= 16) {
    // Fallback: use last 16 1m bars (~16min) if 5m data not yet available
    const closes1m = m1.slice(-16).map(c => c.c);
    const fast = ema(closes1m, 5);
    const slow = ema(closes1m, 12);
    if (fast !== null && slow !== null) {
      tf15m = fast > slow ? 'bullish' : fast < slow ? 'bearish' : 'neutral';
    }
  }

  return { tf5m, tf15m };
}

// ─── FORMAL STRATEGY GATE ─────────────────────────────────────────────────
// Explicit EMA-crossover + RSI rules (see STRATEGY spec block above).
// Returns { longGate, shortGate, detail } — a hard yes/no the engine ANDs with
// its weighted score. Keeps the strategy auditable and separate from the score.
function evaluateStrategyGate(symbol, q) {
  if (!STRATEGY_GATE_ENABLED) return { longGate: true, shortGate: true, detail: 'gate-off', mode: 'off', rr: 99 };

  const emaFast = ema(q.history, STRATEGY.EMA_FAST);
  const emaSlow = ema(q.history, STRATEGY.EMA_SLOW);
  const r       = rsi(q.history, STRATEGY.RSI_PERIOD);
  const mid     = priceMidpoint(symbol);
  const { tf15m } = getCandleTrend(symbol);
  const momentum = (q.price - q.prevClose) / q.prevClose;
  const adxData  = calculateADX(symbol);
  const adx      = adxData ? adxData.adx : null;

  // Reward:risk preview from ATR geometry (same numbers the exit engine will use)
  const a = atrPct(symbol);
  const stopDist   = STRATEGY.ATR_STOP_MULT   * a;
  const targetDist = STRATEGY.ATR_TARGET_MULT * a;
  const rr = stopDist > 0 ? targetDist / stopDist : 0;
  const rrOK = rr >= STRATEGY.MIN_RR;

  // Cold start: indicators not ready → don't block (let weighted score decide)
  if (emaFast === null || emaSlow === null) {
    return { longGate: true, shortGate: true, detail: 'ema-warmup', mode: 'warmup', rr };
  }

  const trendUp   = emaFast > emaSlow;
  const trendDown = emaFast < emaSlow;

  // ── Regime classification via ADX ──
  // trending (ADX≥TREND): momentum entries. ranging (ADX≤RANGE): mean-reversion.
  // in-between: allow momentum but only with strong confirmation.
  const trending = adx !== null && adx >= STRATEGY.ADX_TREND;
  const ranging  = adx !== null && adx <= STRATEGY.ADX_RANGE;

  let longGate = false, shortGate = false, mode = 'momentum';

  if (ranging && MEAN_REVERSION_ENABLED) {
    // MEAN-REVERSION: fade oversold back up / overbought back down, but never
    // fight an established higher-timeframe trend.
    mode = 'mean-rev';
    longGate  = r <= STRATEGY.RSI_MR_OVERSOLD   && tf15m !== 'bearish' && q.price > 0;
    shortGate = r >= STRATEGY.RSI_MR_OVERBOUGHT && tf15m !== 'bullish' && q.price > 0;
  } else {
    // MOMENTUM / TREND-FOLLOW (default and when trending)
    mode = trending ? 'momentum-strong' : 'momentum';
    longGate =
      trendUp && momentum > 0 &&
      r >= STRATEGY.RSI_LONG_MIN && r <= STRATEGY.RSI_LONG_MAX &&
      tf15m !== 'bearish' &&
      (mid <= 0 || q.price >= mid);
    shortGate =
      trendDown && momentum < 0 &&
      r >= STRATEGY.RSI_SHORT_MIN && r <= STRATEGY.RSI_SHORT_MAX &&
      tf15m !== 'bullish' &&
      (mid <= 0 || q.price <= mid);
  }

  // R:R gate — never take a setup whose ATR target/stop ratio is too thin
  if (!rrOK) { longGate = false; shortGate = false; }

  const adxStr = adx === null ? 'ADX—' : `ADX${adx.toFixed(0)}`;
  return {
    longGate, shortGate, mode, rr,
    detail: `${mode} EMA${STRATEGY.EMA_FAST}${trendUp ? '>' : trendDown ? '<' : '='}EMA${STRATEGY.EMA_SLOW} RSI${r.toFixed(0)} ${adxStr} RR${rr.toFixed(1)}`
  };
}

// Check if symbol has upcoming earnings within 2 days (blackout window)
function isEarningsBlackout(symbol) {
  // ✅ FIX Bug #3: Use Eastern-time date and correct modular arithmetic so the
  // blackout window wraps properly at month boundaries.
  //   e.g. today=30, earnings=2: (2-30+31)%31 = 3  → inside window
  //        today=29, earnings=2: (2-29+31)%31 = 4  → outside (earnings not yet close)
  //   Window: 2 days before, day-of, and 1 day after earnings.
  if (!EARNINGS_BLACKOUT_ENABLED) return false;   // see EARNINGS_CALENDAR — placeholder data, off by default
  const earningsDays = EARNINGS_CALENDAR[symbol];
  if (!earningsDays) return false;
  const nowET      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const today      = nowET.getDate();
  const daysInMonth = new Date(nowET.getFullYear(), nowET.getMonth() + 1, 0).getDate();
  return earningsDays.some(day => {
    // Normalize to a forward-looking distance within the current month cycle
    const diff = ((day - today + daysInMonth) % daysInMonth);
    // diff=0 → today is earnings day
    // diff=1 → earnings tomorrow (1 day before)
    // diff=2 → earnings in 2 days
    // diff=daysInMonth-1 → earnings were yesterday (1 day after)
    return diff === 0 || diff === 1 || diff === 2 || diff === daysInMonth - 1;
  });
}

// Estimate bid-ask spread dynamically based on volatility, RVOL, and ATR spikes.
// Returns a fraction (e.g. 0.005 = 0.5%).
function estimateDynamicSpread(symbol) {
  const d = marketData[symbol];
  if (!d || !d.price || d.price <= 0) return 0.002;

  // v11.20 REWRITE. This previously started at a flat 25bp and then added
  // `sessionRange × 0.5`, which conflates VOLATILITY with SPREAD — economically the
  // wrong quantity. A stock that ranged 3% intraday was modelled as having a 1.5%
  // bid-ask; the real spread on PLTR/JPM/KO is 1–5bp. Backtesting measured a median
  // round-trip cost of 1.73%, roughly 5x reality, which (once costs entered the entry
  // gate) rejected essentially every trade. It also inflated simulated slippage, so
  // every historical sim result was pessimistic by the same factor.
  //
  // Correct anchor is MICROSTRUCTURE, not range:
  //   • US equities quote in $0.01, so one tick is the hard floor on spread.
  //   • Spread widens with per-minute volatility, but weakly (a small coefficient on
  //     1-minute ATR), not with the whole session's range.
  //   • Thin participation and hard-to-borrow names carry a modest premium.
  const tick = 0.01 / d.price;                    // one cent as a fraction of price
  let spread = Math.max(tick, 0.0002);            // floor: 1 tick, min 2bp
  spread += atrPct(symbol) * 0.08;                // per-minute vol premium (weak, correct sign)

  // BUG B FIX: Use RVOL instead of static dailyVolume for the liquidity penalty.
  // dailyVolume is a stale daily snapshot; RVOL reflects current 5-min participation.
  const rvol = calculateRVOL(symbol);
  if (rvol < 0.5) spread += 0.0015;      // very thin market
  else if (rvol < 0.8) spread += 0.0005; // below-average participation

  // Hard-to-borrow / small-cap names quote a little wider
  if (HIGH_VOLATILITY.has(symbol)) spread += 0.0005;

  // ATR spike detection: if the current 1m bar range > 2× ATR, spread widens.
  // This catches real-time volatility spikes that the session H-L misses.
  const candles = candleData[symbol]?.m1;
  if (candles && candles.length >= 2) {
    const lastBar = candles[candles.length - 1];
    const barRange = lastBar.h - lastBar.l;
    const atr = calculateATR(symbol);
    if (atr > 0 && barRange > atr * 2) {
      spread += 0.001;  // momentary spike — quotes do widen, but not by 30bp
    }
  }

  return Math.min(spread, 0.010);  // 1% cap — beyond this a name is untradeable anyway
}

// ✅ NEW: Calculate market-wide stress level (0.0 = calm, 1.0 = extreme)
function calculateMarketStress() {
  const symbols = symbolsForMarket(getCurrentMarket());
  if (symbols.length === 0) return 0.0;  // no stress when market is closed
  
  let totalAbsMove = 0;
  let count = 0;
  
  symbols.forEach(sym => {
    const d = marketData[sym];
    if (d && d.price && d.prevClose && d.prevClose > 0) {
      const move = Math.abs((d.price - d.prevClose) / d.prevClose);
      totalAbsMove += move;
      count++;
    }
  });
  
  if (count === 0) return 0.5;
  const avgMove = totalAbsMove / count;
  
  // Map: 0.008 (normal) → 0.0, 0.025 (chaos) → 1.0
  const stress = Math.max(0, Math.min(1, (avgMove - 0.008) / 0.017));
  return stress;
}

// ✅ NEW: Trade expectancy (actual profit edge metric)
// ✅ FIX Bug #3: Use actual closedTrades array instead of regimeMetrics
function calculateTradeExpectancy() {
  // Use full closes only (exclude partial take-profit slices) so win rate and
  // avg win/loss stay consistent with the displayed win-rate metric.
  const recent = portfolio.closedTrades.filter(t => !t.partial).slice(-50);
  if (recent.length === 0) {
    return { expectancy: 0, profitFactor: 1.0, avgWin: 0, avgLoss: 0, winRate: 0 };
  }
  
  const winningTrades = recent.filter(t => t.realizedPnL > 0);
  const losingTrades  = recent.filter(t => t.realizedPnL < 0);
  
  const avgWin  = winningTrades.length > 0 
    ? winningTrades.reduce((s, t) => s + t.realizedPnL, 0) / winningTrades.length 
    : 0;
  const avgLoss = losingTrades.length > 0 
    ? Math.abs(losingTrades.reduce((s, t) => s + t.realizedPnL, 0) / losingTrades.length)
    : 0;
  const winRate = recent.length > 0 ? winningTrades.length / recent.length : 0;
  
  // Expectancy = (avg win × win rate) - (avg loss × loss rate)
  const expectancy = (avgWin * winRate) - (avgLoss * (1 - winRate));
  
  // Profit Factor = gross wins / gross losses
  const totalWins = winningTrades.reduce((s, t) => s + t.realizedPnL, 0);
  const totalLosses = Math.abs(losingTrades.reduce((s, t) => s + t.realizedPnL, 0));
  const profitFactor = avgLoss > 0 ? totalWins / totalLosses : (totalWins > 0 ? 999 : 0);
  
  return { expectancy, profitFactor, avgWin, avgLoss, winRate };
}

// ════════════════════════════════════════════════════════════════════════════
//  RICHER REGIME DETECTION (multi-factor)
//
//  v8.0: relied only on sentiment level (which was random) + avg vol.
//  v8.1: uses real breadth + SPY momentum + intraday vol for 4-factor regime.
// ════════════════════════════════════════════════════════════════════════════

function detectMarketRegime() {
  const market  = getCurrentMarket();
  // No active market → neutral (not 'choppy' which implies a live but directionless session)
  if (!market) return 'neutral';
  const symbols = symbolsForMarket(market);
  const breadth = sentimentData.breadthScore;
  const spyMom  = sentimentData.spyMomentum;

  // Average absolute intraday move = realized volatility across the watchlist
  let totalVol = 0, counted = 0;
  symbols.forEach(sym => {
    const d = marketData[sym];
    if (d && d.price && d.prevClose) { totalVol += Math.abs(d.price - d.prevClose) / d.prevClose; counted++; }
  });
  const avgVol = counted > 0 ? totalVol / counted : 0;

  // Regime scoring — each factor casts a vote:
  //  • breadth > 0.65 AND SPY +0.3%+ AND avgVol moderate  → bull
  //  • breadth < 0.35 AND SPY -0.3%+ down                 → bear
  //  • avgVol > 4% (big moves everywhere)                 → high_volatility
  //  • avgVol < 0.8% (nothing moving)                     → choppy

  if (avgVol > 0.04) return 'high_volatility';

  let bullVotes = 0, bearVotes = 0;
  if (breadth > 0.65)  bullVotes++;
  if (breadth < 0.35)  bearVotes++;
  if (spyMom > 0.003)  bullVotes++;
  if (spyMom < -0.003) bearVotes++;
  // Uptick ratio is intraday candle microstructure — more informative than
  // sentimentData.general which is derived from the same breadth data.
  if (sentimentData.uptickRatio > 0.60) bullVotes++;
  if (sentimentData.uptickRatio < 0.40) bearVotes++;

  if (bullVotes >= 2) return 'bull';
  if (bearVotes >= 2) return 'bear';
  if (avgVol < 0.008) return 'choppy';
  return 'neutral';
}
// ════════════════════════════════════════════════════════════════════════════

function getTotalValue() {
  let value = portfolio.cash;
  Object.entries(portfolio.longPositions).forEach(([ticker, positions]) => {
    const price = marketData[ticker]?.price;
    positions.forEach(pos => {
      const p = Number(price || pos.entryPrice) || 0;
      value += p * (pos.qty || 0);
    });
  });
  Object.entries(portfolio.shortPositions).forEach(([ticker, positions]) => {
    const price = marketData[ticker]?.price;
    positions.forEach(pos => {
      const ep  = Number(pos.entryPrice) || 0;
      const p   = Number(price || ep) || ep;
      const qty = pos.qty || 0;
      // Equity for an open short = locked margin collateral + unrealized P&L.
      // The margin (ep × qty × MARGIN_RATE) was deducted from cash at entry and
      // is returned at close — it is still the trader's asset while locked, so
      // it MUST be counted here. Omitting it made equity falsely dip by the
      // margin amount while shorts were open (corrupting drawdown/peak/return/
      // heat) and then "jump back" at close.
      value += ep * qty * MARGIN_RATE + (ep - p) * qty;
    });
  });
  return Number.isFinite(value) ? value : portfolio.cash;
}

function getNotionalExposure() {
  let n = 0;
  Object.entries(portfolio.longPositions).forEach(([t, arr]) => {
    const price = marketData[t]?.price || 0;
    arr.forEach(p => { n += price * (p.qty || 0); });
  });
  Object.entries(portfolio.shortPositions).forEach(([t, arr]) => {
    const price = marketData[t]?.price || 0;
    arr.forEach(p => { n += price * (p.qty || 0) * 1.3; });  // shorts weighted 1.3×
  });
  return n;
}

// Sector exposure check — prevents correlated clusters
function sectorExposureFor(sector) {
  if (!sector) return 0;
  const sectorOf = t => SYMBOL_SECTOR[t] || (dynamicSymbols[t] ? 'dynamic' : undefined);
  let count = 0;
  Object.keys(portfolio.longPositions).forEach(t  => { if (sectorOf(t) === sector) count++; });
  Object.keys(portfolio.shortPositions).forEach(t => { if (sectorOf(t) === sector) count++; });
  return count;
}

// ════════════════════════════════════════════════════════════════════════════
//  CAPITAL MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

function rebalanceCapital() {
  const tv = getTotalValue();
  if (tv <= 0) return;

  // reserveCash is a SOFT target for display — it does not represent money locked
  // in a separate account. All cash is in portfolio.cash; reserve is a fraction of
  // total equity we track to show the user what "should" stay untouched.
  capitalSystem.reserveCash = tv * capitalSystem.reserveRatio;

  // tradingCapital = cash that is genuinely free to deploy.
  // We cap it at tv*(1-reserveRatio) to honour the reserve intent.
  // We do NOT subtract profitVault from the cap: vault funds were already
  // deducted from portfolio.cash when processProfitVault deposited them, so
  // subtracting them here would double-penalise — reducing tradingCapital by
  // $1 for every $1 vaulted even though that cash is already gone.
  const freeCapitalCap = Math.max(0, tv * (1 - capitalSystem.reserveRatio));
  capitalSystem.tradingCapital = Math.min(portfolio.cash, freeCapitalCap);
  capitalSystem.tradingCapital = Math.max(0, capitalSystem.tradingCapital);

  // Log only when something actually changed — this runs on a timer, and identical
  // lines every cycle bury the signal (seen live: 5 back-to-back duplicates).
  const snap = `${capitalSystem.reserveCash.toFixed(2)}|${capitalSystem.tradingCapital.toFixed(2)}|${capitalSystem.profitVault.toFixed(2)}`;
  if (rebalanceCapital._last !== snap) {
    rebalanceCapital._last = snap;
    console.log(`[CAPITAL] reserve $${capitalSystem.reserveCash.toFixed(2)} | trading $${capitalSystem.tradingCapital.toFixed(2)} | vault $${capitalSystem.profitVault.toFixed(2)}`);
  }
}

function processProfitVault() {
  const tv = getTotalValue();
  if (capitalSystem.lastVaultValue <= 0) { capitalSystem.lastVaultValue = tv; return; }
  const growth = (tv - capitalSystem.lastVaultValue) / capitalSystem.lastVaultValue;
  if (growth >= capitalSystem.vaultTrigger) {
    const profit = tv - capitalSystem.lastVaultValue;
    const amount = profit * (1 - capitalSystem.reinvestRatio);
    if (amount > 0 && amount <= portfolio.cash) {
      // Deposit succeeded — lock the profit and advance the milestone
      capitalSystem.profitVault   += amount;
      portfolio.cash              -= amount;
      capitalSystem.lastVaultValue = tv;  // advance ONLY on successful deposit
      console.log(`[VAULT] Locked $${amount.toFixed(2)} (total $${capitalSystem.profitVault.toFixed(2)})`);
      logTrade(`VAULT +$${amount.toFixed(2)}`);
      queueSaveState();
    } else if (amount > 0) {
      // Cash is tied up in open positions — do NOT advance the milestone.
      // This lets the vault retry on the next 5-min tick when positions close
      // and cash is freed. Advancing here would mean the vault never fills
      // while the bot is actively deployed.
      console.log(`[VAULT] Growth target hit but cash insufficient ($${portfolio.cash.toFixed(2)} available, need $${amount.toFixed(2)}) — will retry next cycle`);
    }
    // If amount <= 0 (shouldn't happen, but guard) don't advance either.
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  POSITION SIZING — owned by JUPITER (jupiter.js)
//
//  Jupiter implements CONSTANT DOLLAR-RISK + fractional-Kelly sizing:
//    shares = (equity × riskFraction) ÷ (ATR_STOP_MULT × ATR% × price), capped
//    to 60% notional. riskFraction starts at RISK_PER_TRADE_BASE, is nudged by a
//    ¼-Kelly term from the bot's MEASURED edge (≥20 trades), cut for drawdown /
//    loss streaks / safe mode / stress / thin RVOL / gaps, and hard-capped at
//    RISK_PER_TRADE_MAX. Terra just delegates and lets the rest of the entry
//    pipeline (heat, sector, daily caps) apply on top.
// ════════════════════════════════════════════════════════════════════════════
function computePositionSize(symbol, price, direction) {
  return jupiter.computeSize(symbol, price, direction);
}

// Drawdown + peak, with the divisor guarded. A peakValue of 0 (corrupt or hand-edited
// state — `?? START_CAPITAL` on load does NOT catch 0, only null/undefined) makes this
// 0/0 = NaN when equity is also 0. That matters because EVERY downstream risk check is
// a `<=`/`>=` comparison against this number, and every comparison with NaN is false —
// safe mode and the emergency stop would silently never arm on a corrupt state file.
// Pure + exported so the degenerate cases are regression-tested (see test.js).
function computeDrawdown(peakValue, totalValue) {
  const peak = (Number.isFinite(peakValue) && peakValue > 0) ? peakValue : START_CAPITAL;
  const tv   = Number.isFinite(totalValue) ? totalValue : 0;
  const dd   = Math.max(0, (peak - tv) / peak);
  return { peak: Math.max(peak, tv), drawdown: Number.isFinite(dd) ? dd : 0 };
}

function wouldExceedHeat(price, qty) {
  const tv = getTotalValue();
  if (tv <= 0) return true;
  return (getNotionalExposure() + price * qty) / tv > riskSystem.maxPortfolioHeat;
}

// ════════════════════════════════════════════════════════════════════════════
//  KILL SWITCHES — stale data, WS disconnect, consecutive losses
// ════════════════════════════════════════════════════════════════════════════

// How long the consecutive-loss halt pauses NEW entries. Long enough to break a losing
// streak's momentum (regimes shift, spreads settle), short enough that one bad stretch
// does not cost the rest of the session. Exits/stops are NEVER paused by this.
const LOSS_HALT_MS = 45 * 60 * 1000;

// The consecutive-loss halt, as a reason string (null = not halted).
// TIME-BOUNDED (v11.19 deadlock fix). This used to test `consecutiveLosses >= max`
// directly, and that counter resets in only two places: a WINNING trade, or a new
// Eastern-time calendar day. But the halt blocks new entries, so no new trade can
// happen, so no win can happen, so the counter could never clear — the bot bricked
// itself until midnight ET while logging "cooling off", implying a timer that did not
// exist. The live log is an unbroken wall of exactly that message.
// Split out of getKillSwitchReason so it is testable on its own: that function returns
// early on `!wsConnected`, which silently made an earlier version of this test pass
// without ever reaching the loss check.
function lossHaltReason() {
  if (riskSystem.lossHaltUntil > Date.now()) {
    const mins = Math.ceil((riskSystem.lossHaltUntil - Date.now()) / 60000);
    return `${riskSystem.consecutiveLosses} consecutive losses — cooling off ${mins}min`;
  }
  return null;
}

// Clear an expired loss halt and reset the streak so trading can genuinely resume.
// Without this the counter stays at/above the limit forever (see getKillSwitchReason).
function releaseExpiredLossHalt() {
  if (riskSystem.lossHaltUntil && Date.now() >= riskSystem.lossHaltUntil) {
    console.log(`[RISK] Loss-streak cool-off expired — entries re-armed (streak of ${riskSystem.consecutiveLosses} cleared)`);
    riskSystem.lossHaltUntil     = 0;
    riskSystem.consecutiveLosses = 0;
    return true;
  }
  return false;
}

// Returns a non-null reason string if trading should be halted, null if safe.
function getKillSwitchReason() {
  // 1. WS disconnected: refuse to trade on potentially stale data
  if (!wsConnected) return 'WS disconnected';

  // 2. Stale price data: a symbol's price hasn't updated in MAX_PRICE_AGE_MS
  //    This catches the "WS drops silently, prices freeze" failure mode.
  const market  = getCurrentMarket();
  const symbols = symbolsForMarket(market);
  const now     = Date.now();
  let staleCount = 0;
  symbols.forEach(sym => {
    const d = marketData[sym];
    if (d && (now - d.lastUpdate) > MAX_PRICE_AGE_MS) staleCount++;
  });
  // If more than half the watchlist is stale, halt new entries
  if (staleCount > symbols.length / 2) return `${staleCount}/${symbols.length} prices stale`;

  // 3. Consecutive loss halt (see lossHaltReason)
  const lh = lossHaltReason();
  if (lh) return lh;

  return null;   // all clear
}

// ════════════════════════════════════════════════════════════════════════════
//  TRADE EXECUTION
// ════════════════════════════════════════════════════════════════════════════

function onCooldown(symbol) {
  const until = symbolCooldowns[symbol];
  return until && Date.now() < until;
}

// ─── BROKER ROUTING ───────────────────────────────────────────────────────
// Called by execute/close functions AFTER ATLAS has approved the trade through
// its full risk pipeline (sizing, kill switches, gap blocks, sector caps, heat).
// Fire-and-forget with logging: ATLAS keeps its internal shadow book so the
// dashboard stays populated; the broker is the real execution venue in live mode.
// In sim mode (LIVE_TRADING=false) this is a no-op.
const liveOrderLog = [];   // last 200 broker responses, surfaced at /api/broker
function recordLiveOrder(entry) {
  liveOrderLog.push({ ts: new Date().toISOString(), ...entry });
  if (liveOrderLog.length > 200) liveOrderLog.shift();
}
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  v11.18 — BROKER-AUTHORITATIVE EXECUTION (Centauri Integrated)              ║
// ║  Pending-order lifecycle: Terra approves → order submits → broker fill      ║
// ║  books the position at the REAL price. Alpaca (paper) is the source of      ║
// ║  truth; the internal ledger mirrors it by construction.                     ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Realized-vs-modelled entry cost, so paper trading answers the adverse-selection
// question empirically instead of by assumption.
let costTracking = { samples: [] };
function costTrackingSummary() {
  const s = costTracking.samples;
  if (!s.length) return { samples: 0 };
  const med = a => { const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
  const realized = med(s.map(x => x.realized)), modelled = med(s.map(x => x.modelled));
  return {
    samples: s.length,
    medianRealizedEntryCostPct: +(realized * 100).toFixed(4),
    medianModelledEntryCostPct: +(modelled * 100).toFixed(4),
    ratio: modelled > 0 ? +(realized / modelled).toFixed(2) : null,
    note: modelled > 0 && realized > modelled * 1.43
      ? 'Real entry costs exceed the model by >43% — the measured backtest edge would be wiped out.'
      : 'Within the modelled range so far.'
  };
}

let pendingOrders = {};                    // id → {kind, ...meta, submittedAt} (persisted)
let brokerMirror  = { at: 0, ok: false };  // latest broker account+positions snapshot
const ORDER_TIMEOUT_MS = 45 * 1000;        // market orders should fill ~instantly on paper
// A pending order older than this is STUCK: poll keeps erroring with something other
// than 404 (sustained 5xx / network outage / missing keys, which returns no .status at
// all), so it never reaches a terminal state and never gets released. This matters most
// for EXIT orders — their lots stay marked `_exiting`, and closeLong/closeShort return
// early on that mark, so a stop-loss silently cannot fire while it persists.
// DELIBERATELY ALERT-ONLY, NOT AUTO-RELEASED: blind resubmission risks a DUPLICATE exit
// (the original order may still be live at the broker and fill later), which turns a
// flat position into an unintended opposite-side one — a worse failure than the stall.
// Recovery is operator-driven: POST /api/reconcile to see real broker state, then
// cancel/flatten at the broker. Surfaced in logs and /api/portfolio → execution.stuck.
const STALE_ORDER_ALERT_MS = 5 * 60 * 1000;

function pendingEntryFor(ticker) {
  return Object.values(pendingOrders).some(p => p.kind === 'entry' && p.plan && p.plan.ticker === ticker);
}

function unmarkLots(ticker, direction, kind, rung) {
  const book = direction === 'LONG' ? portfolio.longPositions : portfolio.shortPositions;
  (book[ticker] || []).forEach(p => {
    if (kind === 'partial') { if (p._pendingRung === rung) delete p._pendingRung; }
    else delete p._exiting;
  });
}

function submitBrokerOrder(meta) {
  const { ticker, side, qty, refPrice } = meta;
  // ENTRIES use a limit order at our reference price so we do not cross the spread
  // (v11.20 — the largest single cost saving available). A non-fill is harmless: the
  // order is cancelled after ORDER_TIMEOUT_MS and the scan re-evaluates.
  // EVERY OTHER kind — exits, stops, partials — stays a MARKET order. Getting out must
  // never depend on a resting limit being reached.
  const useLimit = LIMIT_ENTRIES && meta.kind === 'entry' && Number(refPrice) > 0;
  const orderType = useLimit ? 'limit' : 'market';
  const limitPrice = useLimit ? +Number(refPrice).toFixed(2) : null;
  broker.submitOrder({ symbol: ticker, side, qty, type: orderType, limitPrice, tif: 'day', refPrice })
    .then(r => {
      if (r.ok) {
        pendingOrders[r.id] = { ...meta, id: r.id, submittedAt: Date.now() };
        console.log(`[BROKER] ⏳ ${meta.kind} ${side} ${ticker} ×${qty} submitted (${r.id})`);
        recordLiveOrder({ symbol: ticker, side, qty, ok: true, status: r.status, id: r.id, error: null });
        queueSaveState();
      } else {
        console.error(`[BROKER] ✗ ${meta.kind} ${side} ${ticker} ×${qty} submit FAILED: ${r.error}`);
        recordLiveOrder({ symbol: ticker, side, qty, ok: false, status: null, id: null, error: r.error });
        if (meta.kind !== 'entry') unmarkLots(ticker, meta.direction, meta.kind, meta.rung);
      }
    })
    .catch(e => {
      console.error(`[BROKER] submit error: ${e.message}`);
      if (meta.kind !== 'entry') unmarkLots(ticker, meta.direction, meta.kind, meta.rung);
    });
  return true;   // "accepted for execution" — the fill (or failure) books asynchronously
}

function submitEntryOrder(plan) {
  const side = plan.direction === 'LONG' ? 'buy' : 'sell';
  console.log(`[TERRA] ✓ ${plan.direction} ${plan.ticker} approved — routing ×${plan.shares} to ${broker.name} (authoritative)`);
  return submitBrokerOrder({ kind: 'entry', ticker: plan.ticker, direction: plan.direction,
                             side, qty: plan.shares, refPrice: plan.entryPrice, plan });
}

let _pollingOrders = false;
async function pollPendingOrders() {
  if (_pollingOrders) return;
  const ids = Object.keys(pendingOrders);
  if (!ids.length) return;
  _pollingOrders = true;
  try {
    for (const id of ids) {
      const p = pendingOrders[id];
      if (!p) continue;

      // Stuck-order alarm (see STALE_ORDER_ALERT_MS). Checked BEFORE the poll so it
      // still fires when getOrder is the thing that's failing.
      const ageMs = Date.now() - (p.submittedAt || 0);
      if (ageMs > STALE_ORDER_ALERT_MS) {
        p.stuck = true;
        if (!p._lastStuckLog || Date.now() - p._lastStuckLog > 60000) {
          p._lastStuckLog = Date.now();
          const blocking = p.kind !== 'entry'
            ? ` — ⛔ ${p.direction} ${p.ticker} EXITS ARE BLOCKED (stop-loss cannot fire) while this persists`
            : ' — new entries on this symbol are paused';
          console.error(`[BROKER] ⚠️ STUCK ${p.kind} order ${id} (${p.ticker}) unresolved for ${Math.round(ageMs / 60000)}min${blocking}. Check the broker directly, then POST /api/reconcile.`);
        }
      }

      let o;
      try { o = await broker.getOrder(id); } catch (e) { o = { ok: false, error: e.message }; }
      if (!o.ok) {
        if (o.status === 404) {   // order vanished — treat as canceled, release marks
          console.warn(`[BROKER] order ${id} not found — releasing`);
          if (p.kind !== 'entry') unmarkLots(p.ticker, p.direction, p.kind, p.rung);
          delete pendingOrders[id]; queueSaveState();
        }
        continue;                 // transient error — retry next pass
      }
      if (o.status === 'filled') {
        dispatchFill(p, o);
        delete pendingOrders[id];
        queueSaveState();
        refreshBrokerMirror();
      } else if (['canceled', 'expired', 'rejected', 'replaced', 'done_for_day'].includes(o.status)) {
        console.warn(`[BROKER] ${p.kind} ${p.ticker} ${o.status} — no fill`);
        if (p.kind !== 'entry') unmarkLots(p.ticker, p.direction, p.kind, p.rung);
        delete pendingOrders[id]; queueSaveState();
      } else if (Date.now() - p.submittedAt > ORDER_TIMEOUT_MS && !p.cancelSent) {
        p.cancelSent = true;
        console.warn(`[BROKER] ${p.kind} ${p.ticker} unfilled ${Math.round(ORDER_TIMEOUT_MS/1000)}s — canceling ${id}`);
        try { await broker.cancelOrder(id); } catch (_) {}
        // terminal state (canceled OR filled-in-a-race) is read on the next pass
      }
    }
  } finally { _pollingOrders = false; }
}

function dispatchFill(p, o) {
  const fillPrice = Number(o.filled_avg_price);
  const fillQty   = Number(o.filled_qty);
  if (!(fillPrice > 0) || !(fillQty >= 1)) {
    console.error(`[BROKER] ${p.kind} ${p.ticker} filled with bad numbers (px=${o.filled_avg_price}, qty=${o.filled_qty}) — skipping book`);
    if (p.kind !== 'entry') unmarkLots(p.ticker, p.direction, p.kind, p.rung);
    return;
  }
  console.log(`[BROKER] ✓ FILLED ${p.kind} ${p.ticker} ×${fillQty} @ $${fillPrice.toFixed(2)} (real ${broker.name} fill)`);
  if (p.kind === 'entry')          applyEntryFill(p.plan, fillPrice, fillQty, true);
  else if (p.kind === 'exitLong')  closeLong(p.ticker,  p.stopLoss, { brokerFill: true, fillPrice });
  else if (p.kind === 'exitShort') closeShort(p.ticker, p.stopLoss, { brokerFill: true, fillPrice });
  else if (p.kind === 'partial')   partialClose(p.ticker, p.direction, p.fraction, p.rung, { brokerFill: true, fillPrice, sells: p.sells });
}

// Boot sync: adopt the broker's cash as the ledger's cash, and adopt any broker
// positions the internal book doesn't know (e.g., after a state wipe). The broker is
// authoritative — the ledger conforms to IT, never the other way around.
async function syncFromBroker() {
  try {
    const acct = await broker.getAccount();
    if (acct.ok && Number.isFinite(acct.cash)) {
      const prev = portfolio.cash;
      portfolio.cash = acct.cash;
      if (Number.isFinite(acct.equity)) riskSystem.peakValue = Math.max(riskSystem.peakValue || 0, acct.equity);
      console.log(`[SYNC] Ledger cash ${prev.toFixed(2)} → broker cash $${acct.cash.toFixed(2)} (authoritative)`);
    }
    const pos = await broker.getPositions();
    if (pos.ok) {
      for (const bp of pos.positions) {
        const dir  = bp.side === 'short' || bp.qty < 0 ? 'SHORT' : 'LONG';
        const book = dir === 'LONG' ? portfolio.longPositions : portfolio.shortPositions;
        const qty  = Math.abs(bp.qty);
        if ((book[bp.symbol] || []).length > 0 || qty < 1) continue;   // internal already tracks it
        const frac = Math.min(0.15, Math.max(0.02, 2.2 * (atrPct(bp.symbol) || 0.02)));
        const stopPrice = dir === 'LONG' ? bp.avg_entry_price * (1 - frac) : bp.avg_entry_price * (1 + frac);
        const tgtPrice  = dir === 'LONG' ? bp.avg_entry_price * (1 + frac * 2.1) : bp.avg_entry_price * (1 - frac * 2.1);
        book[bp.symbol] = [{ lotId: `adopt-${Date.now()}`, qty, entryPrice: bp.avg_entry_price, highestPnL: 0,
                             openedAt: Date.now(), atrFrac: frac / 2.2, stopPrice, stopFrac: frac, targetPrice: tgtPrice }];
        portfolio.trades.push({ timestamp: new Date().toISOString(), ticker: bp.symbol, direction: dir,
                                entryPrice: bp.avg_entry_price, qty, status: 'open',
                                reason: 'adopted from broker at boot', realizedPnL: 0,
                                market: getCurrentMarket(), signalScore: 0, stopPrice, targetPrice: tgtPrice });
        console.log(`[SYNC] Adopted broker position ${dir} ${bp.symbol} ×${qty} @ $${bp.avg_entry_price.toFixed(2)} (stops recomputed)`);
      }
      const brokerSyms = new Set(pos.positions.map(x => x.symbol));
      [...Object.keys(portfolio.longPositions), ...Object.keys(portfolio.shortPositions)]
        .filter(sym => !brokerSyms.has(sym))
        .forEach(sym => console.warn(`[SYNC] ⚠️ ledger holds ${sym} but broker does not — investigate (/api/reconcile)`));
    }
  } catch (e) { console.error('[SYNC] failed:', e.message); }
}

async function refreshBrokerMirror() {
  if (!EXEC_BROKER_AUTH) return;
  try {
    const [acct, pos] = [await broker.getAccount(), await broker.getPositions()];
    brokerMirror = {
      at: Date.now(),
      ok: !!(acct.ok),
      equity: acct.ok ? acct.equity : null,
      cash: acct.ok ? acct.cash : null,
      buying_power: acct.ok ? acct.buying_power : null,
      positions: pos.ok ? pos.positions : []
    };
  } catch (e) { brokerMirror = { at: Date.now(), ok: false, error: e.message }; }
}

function executionDriftPct() {
  if (!brokerMirror.ok || !Number.isFinite(brokerMirror.equity) || brokerMirror.equity <= 0) return null;
  return Math.abs(getTotalValue() - brokerMirror.equity) / brokerMirror.equity;
}

function routeToBroker(symbol, side, qty) {
  if (!LIVE_TRADING) return;
  if (EXEC_BROKER_AUTH) return;   // v11.18: fire-and-forget retired — the pending-order lifecycle owns all orders
  if (!qty || qty < 1) return;
  // side: 'buy' (open long / cover short) or 'sell' (open short / exit long)
  broker.submitOrder({ symbol, side, qty, type: 'market', tif: 'day' })
    .then(r => {
      if (r.ok) {
        console.log(`[BROKER] ${broker.name} ${side} ${symbol} ×${qty} → ${r.status} (${r.id})`);
        logTrade(`BROKER ${side} ${symbol} ×${qty} ${r.status}`);
      } else {
        console.error(`[BROKER] ${broker.name} ${side} ${symbol} ×${qty} FAILED: ${r.error}`);
        logTrade(`BROKER FAIL ${side} ${symbol} ×${qty}: ${r.error}`);
      }
      recordLiveOrder({ symbol, side, qty, ok: r.ok, status: r.status || null, id: r.id || null, error: r.error || null });
    })
    .catch(e => {
      console.error(`[BROKER] route error: ${e.message}`);
      recordLiveOrder({ symbol, side, qty, ok: false, error: e.message });
    });
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  THE PIPELINE:  feed → brain decides → 🌍 TERRA validates → execute / reject ║
// ║  The brain (Venus + Jupiter) has already analyzed the feed and shaped the    ║
// ║  signal and size. buildTradePlan packages that DECISION — direction, Jupiter's ║
// ║  size, and the rules the trade must achieve (stop loss + target). Then       ║
// ║  terraValidateTrade is Terra's GATE: it checks the plan against the rules    ║
// ║  (valid stop, stock within limits, full risk pipeline) and approves or       ║
// ║  rejects. terraExecutePlan carries out an APPROVED plan. Terra opens nothing  ║
// ║  that breaks a rule.                                                          ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const tradeRejections = [];   // rolling log of plans Terra rejected (surfaced at /api/portfolio)
const _rejectionLogGate = {};  // console dedupe only — the record above captures everything
function recordRejection(plan, reason) {
  tradeRejections.push({ at: new Date().toISOString(), ticker: plan.ticker, direction: plan.direction, reason });
  if (tradeRejections.length > 50) tradeRejections.shift();
  // The 10s scan re-attempts the same rejected candidates, which floods the console
  // with identical lines (seen live: dozens of "size below 1 share" repeats/minute).
  // Log each unique symbol+direction+reason at most once per 60s; the full stream is
  // still recorded above and visible on Luna's Terra-rejections row.
  const key = plan.ticker + '|' + plan.direction + '|' + reason;
  const now = Date.now();
  if (_rejectionLogGate[key] && now - _rejectionLogGate[key] < 60000) return;
  _rejectionLogGate[key] = now;
  for (const k of Object.keys(_rejectionLogGate)) { if (now - _rejectionLogGate[k] > 300000) delete _rejectionLogGate[k]; }
  console.log(`[TERRA] ✗ rejected ${plan.direction} ${plan.ticker} — ${reason}`);
}

// 1) THE DECISION — the brain's output: direction (already chosen by the scan + AI),
//    Jupiter's size, and the ATR-anchored stop loss + target the trade must achieve.
function buildTradePlan(symbol, direction, entryPrice, signalScore, reason) {
  const a        = atrPct(symbol);                                   // the symbol's volatility
  const shares   = jupiter.computeSize(symbol, entryPrice, direction); // 🔭 Jupiter sizes the trade
  const stopFrac = Math.max(0.004, STRATEGY.ATR_STOP_MULT   * a);    // hard stop distance (1R)
  const tgtFrac  =                  STRATEGY.ATR_TARGET_MULT * a;     // first target distance
  const stopPrice = direction === 'LONG' ? entryPrice * (1 - stopFrac) : entryPrice * (1 + stopFrac);
  const tgtPrice  = direction === 'LONG' ? entryPrice * (1 + tgtFrac)  : entryPrice * (1 - tgtFrac);
  const sig = jupiter.getSignal(symbol);                               // ♀ Venus's catalyst, if any
  const cost = estimateRoundTripCost(symbol);                          // what this trade must beat
  return {
    ticker: symbol, direction, entryPrice, shares, atrFrac: a,
    stop:   { price: stopPrice, frac: stopFrac },                    // ← the rule each trade MUST carry
    target: { price: tgtPrice,  frac: tgtFrac },
    rewardRisk: stopFrac > 0 ? tgtFrac / stopFrac : 0,
    // The economics, carried on the plan so the gate and the logs agree.
    cost,
    netRewardRisk:  netRewardRisk(tgtFrac, stopFrac, cost),
    targetCostRatio: cost > 0 ? tgtFrac / cost : 0,
    conviction: sig ? sig.conviction : null,
    catalyst:   sig ? sig.catalyst   : null,
    signalScore, reason
  };
}

// 2) THE GATE — Terra validates the plan against the rules. Returns {approved, reason}.
function terraValidateTrade(plan) {
  const reject = (r) => ({ approved: false, reason: r });
  const { ticker, direction, entryPrice, shares, stop } = plan;

  // RULE 1 — every trade MUST carry a valid, correctly-placed stop loss with acceptable R:R
  if (!Number.isFinite(entryPrice) || entryPrice <= 0)            return reject('invalid entry price');
  if (!stop || !Number.isFinite(stop.price) || stop.price <= 0)   return reject('missing/invalid stop loss');
  if (direction === 'LONG'  && stop.price >= entryPrice)          return reject('long stop not below entry');
  if (direction === 'SHORT' && stop.price <= entryPrice)          return reject('short stop not above entry');
  if (stop.frac < 0.002 || stop.frac > 0.15)                      return reject(`stop ${(stop.frac*100).toFixed(1)}% out of bounds`);
  if (plan.rewardRisk < STRATEGY.MIN_RR)                          return reject(`R:R ${plan.rewardRisk.toFixed(2)} < ${STRATEGY.MIN_RR}`);

  // RULE 2 — the stock must be within tradeable limits
  if (entryPrice < DYNAMIC_MIN_PRICE)                             return reject(`price $${entryPrice.toFixed(2)} below $${DYNAMIC_MIN_PRICE} min`);
  if (entryPrice > DYNAMIC_MAX_PRICE)                             return reject(`price $${entryPrice.toFixed(2)} above $${DYNAMIC_MAX_PRICE} max`);

  // RULE 3 — Jupiter must have produced a real size
  if (!Number.isFinite(shares) || shares < 1)                     return reject('size below 1 share');

  // RULE 3.5 — THE ECONOMIC GATE (v11.20). Rules 1-3 establish the plan is well-formed;
  // these establish it can actually PAY. Gross R:R is geometry; this is money. Without
  // them the engine took setups whose net reward:risk was below 1.0 — the average loss
  // exceeding the average win before win rate even entered the picture.
  if (plan.netRewardRisk < STRATEGY.MIN_RR_NET)
    return reject(`net R:R ${plan.netRewardRisk.toFixed(2)} < ${STRATEGY.MIN_RR_NET} after ${(plan.cost * 100).toFixed(2)}% costs`);
  if (plan.targetCostRatio < STRATEGY.MIN_TARGET_COST_RATIO)
    return reject(`target only ${plan.targetCostRatio.toFixed(1)}× round-trip cost (need ${STRATEGY.MIN_TARGET_COST_RATIO}×)`);
  if (!Number.isFinite(plan.atrFrac) || plan.atrFrac < STRATEGY.MIN_ATR_ENTRY)
    return reject(`ATR ${((plan.atrFrac || 0) * 100).toFixed(2)}% below the ${(STRATEGY.MIN_ATR_ENTRY * 100).toFixed(2)}% floor — move too small to beat costs`);
  if (plan.cost > STRATEGY.MAX_ROUND_TRIP_COST)
    return reject(`round-trip cost ${(plan.cost * 100).toFixed(2)}% above the ${(STRATEGY.MAX_ROUND_TRIP_COST * 100).toFixed(2)}% ceiling — too expensive to trade`);

  // RULE 3.6 — direction. See LONG_ONLY: the short book measured 8.5% wins against a
  // 32.4% break-even, i.e. anti-predictive, and shorting fights positive equity drift.
  if (LONG_ONLY && direction === 'SHORT')
    return reject('shorts disabled (LONG_ONLY) — the short signal measured anti-predictive');

  // RULE 4 — the full risk pipeline (Terra never opens a trade that breaks these)
  // Regular-trading-hours gate, belt-and-suspenders: evaluateAndTrade already refuses
  // to scan outside 9:30–16:00 ET, but Terra enforces the same invariant at the money
  // boundary so NO caller (webhook, future code paths) can open an entry pre/post
  // market. Exits never pass through this gate — closes are always allowed.
  if (!getCurrentMarket())                                        return reject('outside regular trading hours (9:30–16:00 ET)');
  if (EXEC_BROKER_AUTH && pendingEntryFor(ticker))                return reject('entry order already pending at broker');
  if (capitalSystem.emergencyStop)                                return reject('emergency stop active');
  if (jupiter.isOnHold && jupiter.isOnHold())                     return reject('Jupiter self-imposed hold (discipline)');
  if (onCooldown(ticker))                                         return reject('symbol on cooldown');
  if (isGapBlocked(ticker))                                       return reject('gap-blocked (large overnight gap)');
  if (direction === 'SHORT' && !isShortBorrowAvailable(ticker))   return reject('short borrow unavailable');
  if (wouldExceedHeat(entryPrice, shares))                        return reject('portfolio heat limit');
  const sector = SYMBOL_SECTOR[ticker] || (dynamicSymbols[ticker] ? 'dynamic' : undefined);
  if (sector && sectorExposureFor(sector) >= MAX_SECTOR_EXPOSURE) return reject(`sector ${sector} at max exposure`);
  const plannedCost = direction === 'LONG' ? entryPrice * shares : entryPrice * shares * MARGIN_RATE;
  if (portfolio.cash < plannedCost)                               return reject('insufficient cash');

  return { approved: true, reason: 'all rules passed' };
}

// 3) EXECUTE — Terra carries out an APPROVED plan: fill, open the position WITH its
//    stop stored on the record, route to the broker. Returns true on a real fill.
function terraExecutePlan(plan) {
  // v11.18 broker-authoritative: Terra has approved — submit the REAL order and let the
  // fill (polled) book the position at the broker's actual price. Nothing is booked here.
  if (EXEC_BROKER_AUTH) return submitEntryOrder(plan);

  // Simulation path (unchanged behavior): modeled partial fill + modeled fill price.
  const { ticker, direction, entryPrice } = plan;
  const side = direction === 'LONG' ? 'buy' : 'sell';
  const filledSize = simulatePartialFill(ticker, plan.shares, direction);
  if (filledSize < 1) { console.log(`[TERRA] ${direction} ${ticker} not filled (thin market)`); return false; }
  // Entries are limit orders (see LIMIT_ENTRIES) — model them as not crossing the spread.
  const fillPrice = simulateFillPrice(entryPrice, side, ticker, filledSize, { limit: LIMIT_ENTRIES });
  return applyEntryFill(plan, fillPrice, filledSize, false);
}

// Books an entry into the ledger at a KNOWN fill. Sim mode passes the simulator's
// numbers; broker mode passes the broker's REAL filled_avg_price / filled_qty — one
// bookkeeping path for both worlds, so stops, learning, and Luna behave identically.
function applyEntryFill(plan, fillPrice, filledSize, brokerFill = false) {
  const { ticker, direction } = plan;

  // Capital guard at the ACTUAL fill (post-slippage). In broker mode the money has
  // already moved at the broker — a shortfall here is ledger drift to surface loudly,
  // not a reason to un-book a real position.
  const cost = direction === 'LONG' ? fillPrice * filledSize : fillPrice * filledSize * MARGIN_RATE;
  if (!Number.isFinite(cost)) return false;
  if (portfolio.cash < cost) {
    if (!brokerFill) { console.log(`[TERRA] ${direction} ${ticker} rejected at fill (cash)`); return false; }
    console.warn(`[SYNC] ⚠️ broker filled ${direction} ${ticker} but ledger cash short ($${portfolio.cash.toFixed(2)} < $${cost.toFixed(2)}) — booking anyway; run /api/reconcile`);
  }

  // Anchor the stop/target to the ACTUAL fill so the stored rule matches reality
  const stopPrice = direction === 'LONG' ? fillPrice * (1 - plan.stop.frac)   : fillPrice * (1 + plan.stop.frac);
  const tgtPrice  = direction === 'LONG' ? fillPrice * (1 + plan.target.frac) : fillPrice * (1 - plan.target.frac);

  const book = direction === 'LONG' ? portfolio.longPositions : portfolio.shortPositions;
  book[ticker] = book[ticker] || [];
  book[ticker].push({
    lotId: `lot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    qty: filledSize, entryPrice: fillPrice, highestPnL: 0, openedAt: Date.now(),
    atrFrac: plan.atrFrac,
    stopPrice, stopFrac: plan.stop.frac, targetPrice: tgtPrice   // ← explicit stop the trade must honor
  });
  // REALIZED-COST INSTRUMENTATION (v11.21). The largest unknown in whether this bot
  // can profit is whether real fills cost what the model assumes — adverse selection on
  // limit orders is unmodellable in backtest but directly measurable here. Comparing the
  // actual fill against the reference price the plan was built on turns that guess into
  // a number. Surfaced at /api/portfolio -> execution.costTracking.
  try {
    const ref = plan.entryPrice;
    if (ref > 0 && fillPrice > 0) {
      const realized = direction === 'LONG' ? (fillPrice - ref) / ref : (ref - fillPrice) / ref;
      costTracking.samples.push({ sym: ticker, realized, modelled: (plan.cost || 0) / 2, at: Date.now() });
      if (costTracking.samples.length > 200) costTracking.samples.shift();
    }
  } catch (_) {}
  jupiter.observeEntry(ticker, direction, fillPrice);   // capture entry conditions for the learning model
  portfolio.cash -= cost;
  riskSystem.dailyTradeCount++;

  const gapNote = gapData[ticker]?.absGap >= GAP_WARN_PCT
    ? ` [gap${(gapData[ticker].gapPct*100).toFixed(1)}%]` : '';
  portfolio.trades.push({
    timestamp: new Date().toISOString(), ticker, direction,
    entryPrice: fillPrice, qty: filledSize, status: 'open',
    reason: plan.reason + gapNote + (brokerFill ? ' [real fill]' : ''), realizedPnL: 0, market: getCurrentMarket(),
    signalScore: plan.signalScore || 0,
    stopPrice, targetPrice: tgtPrice    // the trade's rules, recorded
  });
  stampAiMetadata(ticker, direction);   // v11.18: single stamp site — works for async broker fills too
  logTrade(`${direction} ${ticker} ×${filledSize} @ $${fillPrice.toFixed(2)} stop $${stopPrice.toFixed(2)} [score:${plan.signalScore}]${gapNote}${brokerFill ? ' [REAL]' : ''} ${plan.reason}`);
  console.log(`[TERRA] ✓ ${direction} ${ticker} ×${filledSize} @ $${fillPrice.toFixed(2)} (stop $${stopPrice.toFixed(2)}, R:R ${plan.rewardRisk.toFixed(1)})${gapNote}${brokerFill ? ' [REAL ' + broker.name + ' fill]' : ''}`);
  queueSaveState();
  return true;
}

// Entry points (called by the scan loop + the TradingView webhook). Same signatures
// as before — they now run the explicit decide → validate → execute pipeline.
function executeLong(ticker, rawPrice, reason, signalScore) {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return false;
  const plan = buildTradePlan(ticker, 'LONG', rawPrice, signalScore, reason);
  const verdict = terraValidateTrade(plan);
  if (!verdict.approved) { recordRejection(plan, verdict.reason); return false; }
  return terraExecutePlan(plan);
}

function executeShort(ticker, rawPrice, reason, signalScore) {
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return false;
  const plan = buildTradePlan(ticker, 'SHORT', rawPrice, signalScore, reason);
  const verdict = terraValidateTrade(plan);
  if (!verdict.approved) { recordRejection(plan, verdict.reason); return false; }
  return terraExecutePlan(plan);
}

// ════════════════════════════════════════════════════════════════════════════
//  TRADE CLOSING
// ════════════════════════════════════════════════════════════════════════════

function closeLong(ticker, stopLoss = false, opts = {}) {
  const positions = portfolio.longPositions[ticker];
  if (!positions || positions.length === 0) return;

  // v11.18 broker-authoritative: submit the REAL exit order; the polled fill re-enters
  // here with opts.brokerFill + the actual price. _exiting prevents duplicate orders
  // when the exit engine re-fires on the next tick while the order is in flight.
  if (EXEC_BROKER_AUTH && !opts.brokerFill) {
    if (positions.some(p => p._exiting)) return;                    // exit already in flight
    if (positions.some(p => p._pendingRung != null)) return;        // partial in flight — defer one tick
    positions.forEach(p => { p._exiting = true; });
    const qty = positions.reduce((s, p) => s + p.qty, 0);
    submitBrokerOrder({ kind: 'exitLong', ticker, direction: 'LONG', stopLoss,
                        side: 'sell', qty, refPrice: marketData[ticker]?.price });
    return;
  }

  const rawPrice = opts.brokerFill ? opts.fillPrice : marketData[ticker]?.price;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return;

  // Real broker fill = use as-is; simulation = modeled slippage as before
  const exitPrice = opts.brokerFill ? opts.fillPrice : simulateFillPrice(rawPrice, 'sell', ticker);

  // Read open-time market BEFORE the forEach mutates trade status
  const tradeOpenMarket = portfolio.trades.find(
    t => t.ticker === ticker && t.direction === 'LONG' && t.status === 'open'
  )?.market || null;

  let totalPnL = 0;
  let closedQty = 0;
  positions.forEach(pos => {
    totalPnL += (exitPrice - pos.entryPrice) * pos.qty;
    portfolio.cash += exitPrice * pos.qty;
    closedQty += pos.qty;
  });

  portfolio.trades
    .filter(t => t.ticker === ticker && t.direction === 'LONG' && t.status === 'open')
    .forEach(t => {
      t.status = 'closed';
      t.exitPrice = exitPrice;
      t.realizedPnL = (exitPrice - t.entryPrice) * t.qty;
      t.closedAt = new Date().toISOString();
    });

  routeToBroker(ticker, 'sell', closedQty);   // exit long at broker (no-op in sim)
  finalizeClose(ticker, 'LONG', totalPnL, exitPrice, tradeOpenMarket, stopLoss, detectMarketRegime());
}

function closeShort(ticker, stopLoss = false, opts = {}) {
  const positions = portfolio.shortPositions[ticker];
  if (!positions || positions.length === 0) return;

  if (EXEC_BROKER_AUTH && !opts.brokerFill) {
    if (positions.some(p => p._exiting)) return;
    if (positions.some(p => p._pendingRung != null)) return;
    positions.forEach(p => { p._exiting = true; });
    const qty = positions.reduce((s, p) => s + p.qty, 0);
    submitBrokerOrder({ kind: 'exitShort', ticker, direction: 'SHORT', stopLoss,
                        side: 'buy', qty, refPrice: marketData[ticker]?.price });
    return;
  }

  const rawPrice = opts.brokerFill ? opts.fillPrice : marketData[ticker]?.price;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return;

  const exitPrice = opts.brokerFill ? opts.fillPrice : simulateFillPrice(rawPrice, 'buy', ticker);

  const tradeOpenMarket = portfolio.trades.find(
    t => t.ticker === ticker && t.direction === 'SHORT' && t.status === 'open'
  )?.market || null;

  let totalPnL = 0;
  let closedQty = 0;
  const borrowRate = getShortBorrowRate(ticker);  // symbol-specific rate
  positions.forEach(pos => {
    const gross    = (pos.entryPrice - exitPrice) * pos.qty;
    const heldDays = Math.max(0, (Date.now() - (pos.openedAt || Date.now())) / 86400000);
    const borrow   = pos.entryPrice * pos.qty * borrowRate * heldDays;
    const net      = gross - borrow;
    totalPnL      += net;
    portfolio.cash += pos.entryPrice * pos.qty * MARGIN_RATE + net;
    closedQty += pos.qty;
  });

  portfolio.trades
    .filter(t => t.ticker === ticker && t.direction === 'SHORT' && t.status === 'open')
    .forEach(t => {
      t.status = 'closed';
      t.exitPrice = exitPrice;
      t.realizedPnL = (t.entryPrice - exitPrice) * t.qty;
      t.closedAt = new Date().toISOString();
    });

  routeToBroker(ticker, 'buy', closedQty);    // cover short at broker (no-op in sim)
  finalizeClose(ticker, 'SHORT', totalPnL, exitPrice, tradeOpenMarket, stopLoss, detectMarketRegime());
}

// ✅ IMPROVEMENT #5: Take-profit ladder — partial position close.
//    Sells a FRACTION of an open position at a profit target, letting the
//    remainder ride a trailing stop. This locks in gains so winners don't
//    round-trip back to break-even. Reuses the same fee/slippage/cash
//    accounting as a full close, but does NOT delete the position or run
//    loss-cooldown logic (a partial take-profit is always a win).
//
//    fraction: portion of CURRENT quantity to close (e.g. 0.40 = 40%)
//    rung:     label stored on the lot so each tier only fires once
function partialClose(ticker, direction, fraction, rung, opts = {}) {
  const book = direction === 'LONG' ? portfolio.longPositions : portfolio.shortPositions;
  const positions = book[ticker];
  if (!positions || positions.length === 0) return;

  // v11.18 broker-authoritative, PHASE 1: compute the exact per-lot quantities, mark
  // the lots, submit the REAL partial order — book NOTHING yet. The polled fill
  // re-enters as PHASE 2 (opts.brokerFill) and sells exactly the marked quantities at
  // the real price, so ledger and broker cannot diverge on a floor/rounding recompute.
  if (EXEC_BROKER_AUTH && !opts.brokerFill) {
    if (positions.some(p => p._exiting)) return;                      // full exit in flight
    if (positions.some(p => p._pendingRung === rung)) return;         // this rung already in flight
    const sells = [];
    positions.forEach(p => {
      p.partialsTaken = p.partialsTaken || {};
      if (p.partialsTaken[rung]) return;
      const q = Math.floor(p.qty * fraction);
      if (q < 1) { p.partialsTaken[rung] = true; return; }            // too small to ladder
      sells.push({ lotId: p.lotId, qty: q });
      p._pendingRung = rung;
    });
    const total = sells.reduce((sum, x) => sum + x.qty, 0);
    if (total < 1) return;
    submitBrokerOrder({ kind: 'partial', ticker, direction, fraction, rung, sells,
                        side: direction === 'LONG' ? 'sell' : 'buy', qty: total,
                        refPrice: marketData[ticker]?.price });
    return;
  }

  const rawPrice = opts.brokerFill ? opts.fillPrice : marketData[ticker]?.price;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return;

  const exitPrice = opts.brokerFill ? opts.fillPrice
    : (direction === 'LONG'
        ? simulateFillPrice(rawPrice, 'sell', ticker)
        : simulateFillPrice(rawPrice, 'buy', ticker));

  // PHASE 2 lot selection: sell EXACTLY the quantities marked at submit time.
  const sellFor = opts.brokerFill && Array.isArray(opts.sells)
    ? Object.fromEntries(opts.sells.map(x => [x.lotId, x.qty]))
    : null;

  let realizedPnL = 0;
  let anyClosed = false;
  // ✅ FIX Bug #1: accumulate the actual shares sold across all lots so the
  // trade-record deduction uses the same number, not a re-derived fraction of
  // the combined qty (which diverges under floor/round with multiple lots).
  let totalSoldQty = 0;

  positions.forEach(pos => {
    // Skip lots that already took this rung
    pos.partialsTaken = pos.partialsTaken || {};
    if (pos.partialsTaken[rung]) return;

    // Quantity: broker phase 2 sells EXACTLY what was marked; sim computes per-lot floor
    let sellQty;
    if (sellFor) {
      if (!(pos.lotId in sellFor)) return;      // this lot wasn't part of the submitted order
      sellQty = sellFor[pos.lotId];
      delete pos._pendingRung;                  // consumed
    } else {
      sellQty = Math.floor(pos.qty * fraction);
    }
    if (sellQty < 1) { pos.partialsTaken[rung] = true; return; }  // too small to ladder

    if (direction === 'LONG') {
      realizedPnL += (exitPrice - pos.entryPrice) * sellQty;
      portfolio.cash += exitPrice * sellQty;
    } else {
      const gross    = (pos.entryPrice - exitPrice) * sellQty;
      const heldDays = Math.max(0, (Date.now() - (pos.openedAt || Date.now())) / 86400000);
      const borrow   = pos.entryPrice * sellQty * getShortBorrowRate(ticker) * heldDays;
      const net      = gross - borrow;
      realizedPnL   += net;
      // Return proportional margin + net P&L for the closed share count
      portfolio.cash += pos.entryPrice * sellQty * MARGIN_RATE + net;
    }

    totalSoldQty += sellQty;
    pos.qty -= sellQty;
    pos.partialsTaken[rung] = true;
    anyClosed = true;
  });

  if (!anyClosed) return;

  // Drop any lots fully exhausted by the partial
  book[ticker] = positions.filter(p => p.qty > 0);

  // Reflect the partial in the open trade record(s) and record a closed slice
  const openTrade = portfolio.trades.find(
    t => t.ticker === ticker && t.direction === direction && t.status === 'open'
  );
  const market = openTrade?.market || getCurrentMarket();

  // ✅ FIX Bug #1: deduct the exact shares sold (totalSoldQty) — not a
  // re-derived fraction of the trade record's combined qty, which can diverge
  // from the per-lot floor calculations when multiple lots exist.
  if (openTrade) {
    openTrade.qty = Math.max(0, openTrade.qty - totalSoldQty);
  }

  // ✅ FIX Bug #4: do NOT reset consecutiveLosses on a partial win.
  // Only finalizeClose() (full closes) should touch the streak counter.
  // A partial TP fires mid-position; the trade isn't resolved yet.
  // Allowing it to reset the counter lets one partial bypass the consecutive-
  // loss kill switch even when 3 prior full trades all lost.
  if (realizedPnL < 0) riskSystem.dailyRealizedLoss += Math.abs(realizedPnL);

  // Log the partial as a closed slice so analytics/expectancy see it
  portfolio.closedTrades.push({
    ticker, direction, pnl: realizedPnL, realizedPnL,
    closedAt: new Date().toISOString(), market, partial: rung
  });
  if (portfolio.closedTrades.length > 500) portfolio.closedTrades = portfolio.closedTrades.slice(-500);

  logTrade(`PARTIAL ${rung} ${direction} ${ticker} ${(fraction*100).toFixed(0)}% @ $${exitPrice.toFixed(2)} PnL $${realizedPnL.toFixed(2)}`);
  console.log(`[PARTIAL] ${rung} ${direction} ${ticker} sold ${(fraction*100).toFixed(0)}% @ $${exitPrice.toFixed(2)} | PnL $${realizedPnL.toFixed(2)}`);

  // Route the partial to the broker: LONG partial = sell shares, SHORT partial = buy to cover
  routeToBroker(ticker, direction === 'LONG' ? 'sell' : 'buy', totalSoldQty);

  // If the position is now empty, clean it up fully
  if (!book[ticker] || book[ticker].length === 0) {
    delete book[ticker];
    portfolio.trades
      .filter(t => t.ticker === ticker && t.direction === direction && t.status === 'open')
      .forEach(t => { t.status = 'closed'; t.exitPrice = exitPrice; t.closedAt = new Date().toISOString(); });
  }

  trimTrades();
  queueSaveState();
}

function finalizeClose(ticker, direction, totalPnL, exitPrice, market, stopLoss, regime) {
  if (totalPnL < 0) {
    riskSystem.dailyRealizedLoss += Math.abs(totalPnL);
    riskSystem.consecutiveLosses++;
    // Arm (or extend) the time-bounded cool-off the moment the streak hits its limit.
    if (riskSystem.consecutiveLosses >= riskSystem.maxConsecutiveLosses) {
      riskSystem.lossHaltUntil = Date.now() + LOSS_HALT_MS;
      console.log(`[RISK] ${riskSystem.consecutiveLosses} consecutive losses — pausing NEW entries for ${LOSS_HALT_MS / 60000}min (exits still managed)`);
    }
  } else {
    riskSystem.consecutiveLosses = 0;  // reset on any win
    riskSystem.lossHaltUntil     = 0;  // a win clears the halt immediately
  }

  if (stopLoss || totalPnL < 0) {
    symbolLossCount[ticker] = (symbolLossCount[ticker] || 0) + 1;
    const mult = Math.min(REPEAT_LOSS_MULTIPLIER ** (symbolLossCount[ticker] - 1), 6);
    symbolCooldowns[ticker] = Date.now() + STOP_LOSS_COOLDOWN_MS * mult;
    console.log(`[COOLDOWN] ${ticker} blocked ${Math.round(STOP_LOSS_COOLDOWN_MS * mult / 60000)}min (loss #${symbolLossCount[ticker]})`);
  } else {
    symbolLossCount[ticker] = 0;
  }

  portfolio.closedTrades.push({
    ticker, direction, pnl: totalPnL, realizedPnL: totalPnL,
    closedAt: new Date().toISOString(), market
  });
  if (portfolio.closedTrades.length > 500) portfolio.closedTrades = portfolio.closedTrades.slice(-500);

  if (direction === 'LONG') delete portfolio.longPositions[ticker];
  else                       delete portfolio.shortPositions[ticker];

  // ✅ FIX Bug #1: regime is now passed as parameter
  const closedTrade = portfolio.closedTrades[portfolio.closedTrades.length - 1];
  if (closedTrade && regime) {
    const setupType = `${direction}-${market}-${regime}`;  // e.g., LONG-nasdaq-bull
    recordTradeAnalytics(closedTrade, setupType, regime, SYMBOL_SECTOR[ticker] || (dynamicSymbols[ticker] ? 'dynamic' : undefined));
  }

  // CENTAURI: attribute outcome to the AI catalyst that influenced the entry
  recordAiOutcome(ticker, direction, totalPnL);

  logTrade(`CLOSE ${direction} ${ticker} @ $${exitPrice.toFixed(2)} PnL $${totalPnL.toFixed(2)}`);
  console.log(`[CLOSE] ${direction} ${ticker} @ $${exitPrice.toFixed(2)} | PnL $${totalPnL.toFixed(2)}`);
  trimTrades();
  queueSaveState();
}

// ════════════════════════════════════════════════════════════════════════════
//  LEARNING SYSTEM
// ════════════════════════════════════════════════════════════════════════════

function updateLearning() {
  const closed = portfolio.closedTrades;
  aiSystem.currentReasoning.nextAction = getCurrentMarket()
    ? (closed.length < 3 ? 'collecting initial trades' : 'scanning for signals')
    : 'waiting for market open';

  if (closed.length < 3) return;

  // ✅ Learning operates on FULL closes only. Partial take-profit slices are
  // always positive by construction, so counting them would falsely reset
  // losing streaks and inflate aggression — defeating the consecutive-loss
  // protection. Their realized P&L is still reflected in cash + daily totals.
  const fullClosed = closed.filter(t => !t.partial);
  if (fullClosed.length < 3) return;

  const recent = fullClosed.slice(-20);
  const last   = recent[recent.length - 1];
  // v11.17 — EVERYTHING below updates ONCE PER NEW FULL CLOSE. Seen live: this
  // function runs on the 10-second main loop, so the win-rate EMA and the aggression
  // ratchet re-applied every tick against the SAME static trades. Within minutes of
  // three early losses, smoothedWinRate had been decayed hundreds of times to 0.0% and
  // aggression was pinned at the 0.15 floor ("ultra_conservative") — the numbers on
  // Luna were real, but they measured elapsed TIME, not trading evidence. An EMA's
  // step must correspond to one unit of new information.
  if (last.closedAt === aiSystem._lastStrategyUpdateTime) return;
  aiSystem._lastStrategyUpdateTime = last.closedAt;

  const wins       = recent.filter(t => t.realizedPnL > 0).length;
  const rawWinRate = recent.length > 0 ? wins / recent.length : 0.5;
  aiSystem.recentWinRate   = rawWinRate;
  aiSystem.smoothedWinRate = aiSystem.smoothedWinRate * 0.85 + rawWinRate * 0.15;
  aiSystem.strategySample  = fullClosed.length;   // exposed so Luna can show the n behind the stats
  const winRate = aiSystem.smoothedWinRate;
  if (last.closedAt !== aiSystem._lastCountedTradeTime) {
    aiSystem._lastCountedTradeTime = last.closedAt;
    if (last.realizedPnL > 0) { aiSystem.winningStreak++; aiSystem.losingStreak = 0; }
    else                      { aiSystem.losingStreak++;  aiSystem.winningStreak = 0; }
  }

  let targetAggression;
  if      (winRate > 0.65) { aiSystem.strategy = 'ultra_aggressive';  targetAggression = Math.min(1.0, 0.85 + (winRate - 0.65)); }
  else if (winRate > 0.55) { aiSystem.strategy = 'aggressive';        targetAggression = 0.70; }
  else if (winRate > 0.45) { aiSystem.strategy = 'balanced';          targetAggression = 0.50; }
  else if (winRate > 0.35) { aiSystem.strategy = 'defensive';         targetAggression = 0.30; }
  else                     { aiSystem.strategy = 'ultra_conservative'; targetAggression = 0.15; }

  // Weak-evidence floor (the cold-start principle, mechanical layer): with fewer than
  // 10 full closes, don't let the ratchet grind below 0.35 — three losses on three
  // trades is noise, not a regime, and pinning size to the floor guarantees fixed
  // execution costs dominate whatever edge exists. Real evidence can still take it
  // all the way down once the sample earns that conclusion.
  if (fullClosed.length < 10) targetAggression = Math.max(targetAggression, 0.35);

  aiSystem.aggressionLevel = aiSystem.aggressionLevel * 0.8 + targetAggression * 0.2;

  const avgPnL = recent.reduce((s, t) => s + t.realizedPnL, 0) / recent.length;

  // Sentiment shift gated on a new trade — uses P&L not random drift
  const sentimentShift = avgPnL > 5 ? 0.03 : (avgPnL < -5 ? -0.03 : 0);
  if (sentimentShift !== 0 && last.closedAt !== aiSystem._lastSentimentUpdateTime) {
    aiSystem._lastSentimentUpdateTime = last.closedAt;
    // Only shift by ±0.03 on top of breadth — trade P&L is a signal quality indicator
    sentimentData.general = Math.max(0.2, Math.min(0.8, sentimentData.general + sentimentShift * 0.3));
    const tm = last.market || getCurrentMarket();
    if (tm && sentimentData.byMarket[tm] !== undefined) {
      sentimentData.byMarket[tm] = Math.max(0.2, Math.min(0.8, sentimentData.byMarket[tm] + sentimentShift * 0.3));
    }
  }

  if (last.closedAt !== aiSystem._lastPerfHistoryTime) {
    aiSystem._lastPerfHistoryTime = last.closedAt;
    aiSystem.performanceHistory.push({ timestamp: Date.now(), winRate, avgPnL, strategy: aiSystem.strategy, aggression: aiSystem.aggressionLevel });
    if (aiSystem.performanceHistory.length > 50) aiSystem.performanceHistory.shift();
  }

  aiSystem.currentReasoning.winRate      = winRate;
  aiSystem.currentReasoning.confidence   = Math.round(Math.min(100, closed.length * 2));
  aiSystem.currentReasoning.trend        = avgPnL > 2 ? 'bullish' : avgPnL < -2 ? 'bearish' : 'neutral';
  aiSystem.currentReasoning.breadth      = sentimentData.breadthScore;
  aiSystem.currentReasoning.regime       = detectMarketRegime();
  aiSystem.currentReasoning.nextAction   =
    winRate > 0.55 ? 'increase position size' :
    winRate < 0.40 ? 'reduce exposure' :
    getCurrentMarket() ? 'scanning for signals' : 'waiting for market open';
}

function updateMarketTransition() {
  const current = getCurrentMarket();
  const prev    = marketTransitionData.lastMarket;
  if (current !== prev && prev) { console.log(`[TRANSITION] ${prev} -> ${current}`); queueSaveState(); }
  marketTransitionData.lastMarket = current;
}

// ════════════════════════════════════════════════════════════════════════════
//  PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════

function queueSaveState() {
  if (_saveTimeout) return;
  _saveTimeout = setTimeout(() => { _saveTimeout = null; saveState(); }, 5000);
}

// Cancel a debounced save that hasn't fired yet. Used by test.js: the suite books fake
// positions into the real module state, which arms queueSaveState()'s 5s timer — and
// relying on process.exit() to WIN that race is fragile (a slow run, or any future
// async teardown, would let it fire and overwrite the live atlas-solar-state.json with
// test fixtures). Cancelling deterministically removes the race instead of outrunning it.
function cancelPendingSave() {
  if (_saveTimeout) { clearTimeout(_saveTimeout); _saveTimeout = null; return true; }
  return false;
}

function buildStateObject() {
  return {
    cash: portfolio.cash,
    longPositions:  portfolio.longPositions,
    shortPositions: portfolio.shortPositions,
    trades:         portfolio.trades.slice(-500),
    closedTrades:   portfolio.closedTrades.slice(-500),
    marketTransition: marketTransitionData,
    capitalSystem,
    pendingOrders,
    symbolCooldowns,
    symbolLossCount,
    aiSystem: {
      aggressionLevel:   aiSystem.aggressionLevel,
      strategy:          aiSystem.strategy,
      recentWinRate:     aiSystem.recentWinRate,
      smoothedWinRate:   aiSystem.smoothedWinRate,
      winningStreak:     aiSystem.winningStreak,
      losingStreak:      aiSystem.losingStreak,
      a_plus_mode:       aiSystem.a_plus_mode,   // ✅ B11: was missing — lost on every restart
      _lastCountedTradeTime:    aiSystem._lastCountedTradeTime,
      _lastStrategyUpdateTime:  aiSystem._lastStrategyUpdateTime,
      strategySample:           aiSystem.strategySample,
      _lastSentimentUpdateTime: aiSystem._lastSentimentUpdateTime,
      _lastPerfHistoryTime:     aiSystem._lastPerfHistoryTime,
      performanceHistory: aiSystem.performanceHistory,
      currentReasoning:  { ...aiSystem.currentReasoning },
      // ✅ Persist trade analytics for Layer 4 learning
      tradeAnalytics: {
        setupMetrics: aiSystem.tradeAnalytics?.setupMetrics || {},
        regimeMetrics: aiSystem.tradeAnalytics?.regimeMetrics || {},
        sectorMetrics: aiSystem.tradeAnalytics?.sectorMetrics || {},
        timeMetrics: aiSystem.tradeAnalytics?.timeMetrics || {},
        bestSetups: aiSystem.tradeAnalytics?.bestSetups || []
      }
    },
    riskSystem: {
      dailyRealizedLoss: riskSystem.dailyRealizedLoss,
      dailyTradeCount:   riskSystem.dailyTradeCount,
      dailyResetDate:    riskSystem.dailyResetDate,
      peakValue:         riskSystem.peakValue,
      consecutiveLosses: riskSystem.consecutiveLosses,
      lossHaltUntil:     riskSystem.lossHaltUntil    // persisted so a restart can't skip the cool-off
    },
    sentimentData: {
      general:      sentimentData.general,
      byMarket:     { ...sentimentData.byMarket },
      breadthScore: sentimentData.breadthScore,
      spyMomentum:  sentimentData.spyMomentum,
      uptickRatio:  sentimentData.uptickRatio
    },
    spyData,
    // BUG 3 FIX: persist gapData so gap blocks survive a restart.
    // (candleData itself is too large to persist and is rebuilt by fetchCandles.)
    gapData,
    // CENTAURI: persist both engines' state. Venus owns its calibration
    // (long-term per-catalyst memory); Jupiter owns its live signals + edge log.
    // Terra persists the dynamic-watchlist roster.
    centauri: {
      venus: venus.serialize(),
      jupiter:   jupiter.serialize(),
      dynamicSymbols
    },
    savedAt: new Date().toISOString()
  };
}

function saveState() {
  if (_saveInProgress) { _savePending = true; return; }
  _saveInProgress = true;
  try {
    const json = JSON.stringify(buildStateObject());
    const tmp  = BACKUP_FILE + '.tmp';
    fs.writeFile(tmp, json, err => {
      if (err) { console.error('[SAVE]', err.message); _saveInProgress = false; return; }
      fs.rename(tmp, BACKUP_FILE, renameErr => {
        if (renameErr) console.error('[SAVE rename]', renameErr.message);
        _saveInProgress = false;
        if (_savePending) { _savePending = false; saveState(); }
      });
    });
  } catch (e) { console.error('[SAVE]', e.message); _saveInProgress = false; }
}

function saveStateSync() {
  try { fs.writeFileSync(BACKUP_FILE, JSON.stringify(buildStateObject())); }
  catch (e) { console.error('[SAVE_SYNC]', e.message); }
}

// ── ORPHANED IN-FLIGHT MARKS (v11.19 fix) ──────────────────────────────────────
// closeLong/closeShort set `_exiting` (and partialClose sets `_pendingRung`) on a lot
// SYNCHRONOUSLY, but the order id only lands in pendingOrders after an async round-trip
// to the broker. Any save inside that window — most realistically the SIGTERM
// saveStateSync that a Railway deploy or Ctrl-C triggers — persists lots marked
// in-flight with NO pending order that could ever release them. On restart the guards
// `if (positions.some(p => p._exiting)) return;` then short-circuit every exit attempt
// forever: the position becomes permanently unexitable and its STOP-LOSS SILENTLY
// CANNOT FIRE. Clearing marks with no matching live pending order self-heals this.
//
// Safe by construction: a mark WITH a live pending order is preserved (the poller still
// owns it), so this can't race the normal lifecycle. Only provably-orphaned marks are
// cleared, and clearing one merely re-arms the exit engine to re-evaluate normally. In
// broker-authoritative mode syncFromBroker() + reconcileWithBroker() run right after
// load and surface any real position drift for the operator.
function clearOrphanedInFlightMarks() {
  const liveMarks = new Set();      // "TICKER|DIRECTION|full" or "TICKER|DIRECTION|<rung>"
  Object.values(pendingOrders).forEach(p => {
    if (!p || !p.ticker) return;
    if (p.kind === 'exitLong' || p.kind === 'exitShort') liveMarks.add(`${p.ticker}|${p.direction}|full`);
    else if (p.kind === 'partial')                       liveMarks.add(`${p.ticker}|${p.direction}|${p.rung}`);
  });
  let cleared = 0;
  for (const [book, dir] of [[portfolio.longPositions, 'LONG'], [portfolio.shortPositions, 'SHORT']]) {
    Object.entries(book || {}).forEach(([ticker, lots]) => {
      (lots || []).forEach(p => {
        if (p._exiting && !liveMarks.has(`${ticker}|${dir}|full`)) { delete p._exiting; cleared++; }
        if (p._pendingRung != null && !liveMarks.has(`${ticker}|${dir}|${p._pendingRung}`)) {
          delete p._pendingRung; cleared++;
        }
      });
    });
  }
  if (cleared > 0) {
    console.warn(`[LOAD] ⚠️ Cleared ${cleared} orphaned in-flight mark(s) — an exit/partial was interrupted mid-submit (likely a restart). Exits are re-armed; verify real positions with POST /api/reconcile.`);
  }
  return cleared;
}

function loadState() {
  const candidates = [BACKUP_FILE, BACKUP_FILE + '.tmp'];
  let state = null;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') { state = parsed; if (file !== BACKUP_FILE) console.warn(`[LOAD] Recovered from ${file}`); break; }
    } catch (e) { console.error(`[LOAD] ${file}: ${e.message}`); }
  }
  if (!state) { console.log('[LOAD] No backup — starting fresh'); return; }

  try {
    const restoredCash = state.cash;
    portfolio.cash = (Number.isFinite(restoredCash) && restoredCash >= 0) ? restoredCash : START_CAPITAL;
    portfolio.longPositions   = state.longPositions  ?? {};
    portfolio.shortPositions  = state.shortPositions ?? {};
    portfolio.trades          = state.trades          ?? [];
    portfolio.closedTrades    = state.closedTrades    ?? [];
    marketTransitionData      = state.marketTransition ?? marketTransitionData;
    symbolCooldowns           = state.symbolCooldowns  ?? {};
    symbolLossCount           = state.symbolLossCount  ?? {};
    
    // ✅ FIX Bug #6: Prune expired cooldowns on load
    const now = Date.now();
    Object.keys(symbolCooldowns).forEach(k => {
      if (symbolCooldowns[k] < now) delete symbolCooldowns[k];
    });
    
    if (state.capitalSystem)  Object.assign(capitalSystem, state.capitalSystem);
    if (state.pendingOrders)  pendingOrders = state.pendingOrders;
    if (state.spyData)        Object.assign(spyData, state.spyData);

    clearOrphanedInFlightMarks();   // see the function — prevents permanently-dead stop-losses
    if (state.aiSystem) {
      const a = state.aiSystem;
      aiSystem.aggressionLevel          = a.aggressionLevel          ?? 0.5;
      aiSystem.strategy                 = a.strategy                  ?? 'balanced';
      aiSystem.recentWinRate            = a.recentWinRate             ?? 0.5;
      aiSystem.smoothedWinRate          = a.smoothedWinRate           ?? 0.5;
      aiSystem.winningStreak            = a.winningStreak             ?? 0;
      aiSystem.losingStreak             = a.losingStreak              ?? 0;
      aiSystem.a_plus_mode              = a.a_plus_mode               ?? false;  // ✅ B11
      aiSystem._lastCountedTradeTime    = a._lastCountedTradeTime     ?? null;
      aiSystem._lastStrategyUpdateTime  = a._lastStrategyUpdateTime   ?? null;
      aiSystem.strategySample           = a.strategySample            ?? 0;
      aiSystem._lastSentimentUpdateTime = a._lastSentimentUpdateTime  ?? null;
      aiSystem._lastPerfHistoryTime     = a._lastPerfHistoryTime      ?? null;
      aiSystem.performanceHistory       = a.performanceHistory        ?? [];
      if (a.currentReasoning) Object.assign(aiSystem.currentReasoning, a.currentReasoning);
      // ✅ NEW: Restore trade analytics
      if (a.tradeAnalytics) {
        aiSystem.tradeAnalytics.setupMetrics = a.tradeAnalytics.setupMetrics ?? {};
        aiSystem.tradeAnalytics.regimeMetrics = a.tradeAnalytics.regimeMetrics ?? {};
        aiSystem.tradeAnalytics.sectorMetrics = a.tradeAnalytics.sectorMetrics ?? {};
        aiSystem.tradeAnalytics.timeMetrics = a.tradeAnalytics.timeMetrics ?? {};
        aiSystem.tradeAnalytics.bestSetups = a.tradeAnalytics.bestSetups ?? [];
      }
    }
    if (state.riskSystem) {
      riskSystem.dailyRealizedLoss  = state.riskSystem.dailyRealizedLoss  ?? 0;
      riskSystem.dailyTradeCount    = state.riskSystem.dailyTradeCount    ?? 0;
      riskSystem.dailyResetDate     = state.riskSystem.dailyResetDate     ?? null;
      riskSystem.peakValue          = state.riskSystem.peakValue          ?? START_CAPITAL;
      riskSystem.consecutiveLosses  = state.riskSystem.consecutiveLosses  ?? 0;
      riskSystem.lossHaltUntil      = state.riskSystem.lossHaltUntil      ?? 0;
    }
    if (state.sentimentData) {
      sentimentData.general      = state.sentimentData.general      ?? 0.5;
      sentimentData.byMarket.nasdaq = state.sentimentData.byMarket?.nasdaq ?? 0.5;
      sentimentData.byMarket.nyse   = state.sentimentData.byMarket?.nyse   ?? 0.5;
      sentimentData.breadthScore = state.sentimentData.breadthScore ?? 0.5;
      sentimentData.spyMomentum  = state.sentimentData.spyMomentum  ?? 0;
      sentimentData.uptickRatio  = state.sentimentData.uptickRatio  ?? 0.5;
    }
    // BUG 3 FIX: restore gapData but only blocks that haven't expired yet,
    // so a symbol blocked for 25 more minutes stays blocked across a restart.
    if (state.gapData && typeof state.gapData === 'object') {
      const now = Date.now();
      Object.entries(state.gapData).forEach(([sym, g]) => {
        if (g && g.blockUntil > now) gapData[sym] = g;
      });
    }
    // CENTAURI restore: Venus's research calibration is permanent; Jupiter's
    // signals are restored only if still fresh (a restart hours later shouldn't
    // resurrect a dead news edge). Supports the new two-engine format, the legacy
    // single-layer format, AND state files written before Venus/Jupiter swapped
    // roles — we route each saved block by its CONTENT, not its key name, so the
    // research-calibration block always reaches Venus and the win-model block
    // always reaches Jupiter regardless of how it was labelled on disk.
    if (state.centauri && typeof state.centauri === 'object') {
      const c = state.centauri, now = Date.now();

      // New format — route by content (back-compatible across the role swap)
      const blocks = [c.venus, c.jupiter].filter(b => b && typeof b === 'object');
      const researchBlock = blocks.find(b => b.calibGlobal || b.calibByCat || b.calibLog || b.calibration);
      const decisionBlock = blocks.find(b => b.winModel || b.trainLog || b.signals);
      if (researchBlock) venus.loadState(researchBlock);     // Venus = research/calibration
      if (decisionBlock) jupiter.loadState(decisionBlock);   // Jupiter = win-model/sizing/decision

      // Legacy format migration (old aiSignals/catalystStats/aiOutcomes)
      if (!researchBlock && c.catalystStats) {
        venus.loadState({ calibration: c.catalystStats, learnLog: c.aiOutcomes || [] });
      }
      if (!decisionBlock && c.aiSignals) {
        jupiter.loadState({ signals: c.aiSignals, outcomeLog: c.aiOutcomes || [] });
      }

      // Dynamic-watchlist roster (Terra-owned): restore only if signal survived
      // or a position is open.
      if (c.dynamicSymbols && typeof c.dynamicSymbols === 'object') {
        Object.entries(c.dynamicSymbols).forEach(([sym, d]) => {
          const hasPos = (state.longPositions?.[sym]?.length > 0) || (state.shortPositions?.[sym]?.length > 0);
          if (jupiter.hasSignal(sym) || hasPos) dynamicSymbols[sym] = d;
        });
      }
      const js = venus.getState(), vs = jupiter.getState();
      const nDyn = Object.keys(dynamicSymbols).length;
      const nSig = vs.activeSignals.length;
      const nCal = Object.keys(js.calibration).length;
      if (nDyn || nSig || nCal) {
        console.log(`[CENTAURI] Restored — Jupiter: ${nSig} live signals, ${nDyn} dynamic symbols | Venus: ${nCal} catalyst calibrations`);
      }
    }
    // Date-anchor daily counters
    const todayET = getEasternTimeParts().dateStr;
    if (riskSystem.dailyResetDate !== todayET) {
      console.log(`[RISK] New ET day — daily counters reset`);
      riskSystem.dailyRealizedLoss = 0;
      riskSystem.dailyTradeCount   = 0;
      riskSystem.consecutiveLosses = 0;
      riskSystem.lossHaltUntil     = 0;   // a new session does not inherit yesterday's cool-off
      riskSystem.dailyResetDate    = todayET;
    }
    console.log(`[LOAD] Restored $${portfolio.cash.toFixed(2)} cash, vault $${capitalSystem.profitVault.toFixed(2)}`);
  } catch (e) { console.error('[LOAD_ERROR]', e.message); }
}

process.on('SIGTERM', () => { console.log('[SHUTDOWN]'); clearWsHeartbeat(); clearWsStabilityTimer(); saveStateSync(); if (dataWs) dataWs.close(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[SHUTDOWN]'); clearWsHeartbeat(); clearWsStabilityTimer(); saveStateSync(); if (dataWs) dataWs.close(); process.exit(0); });

// ── Crash safety nets ────────────────────────────────────────────────────────
// A long-running trading process must never die silently. Unhandled promise
// rejections (a stray network error in a fire-and-forget chain) are logged and
// survived — every subsystem here already degrades gracefully. A truly uncaught
// synchronous exception means unknown state: persist everything and exit(1) so
// the supervisor (Railway/systemd/pm2) restarts us clean from the saved state —
// far safer than trading on from a corrupted in-memory book.
process.on('unhandledRejection', (reason) => {
  console.error('[SAFETY] Unhandled promise rejection (survived):', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[SAFETY] Uncaught exception:', err && err.stack ? err.stack : err);
  // ONLY persist when this process is actually running the engine. server.js is also
  // imported as a library by train.js, backtest.js, edge-scan.js, train-model.js and
  // the test suite — and if one of THOSE crashed, this handler would write the module's
  // pristine default state (cash 1000, no positions, untrained models) straight over
  // the live state file, silently destroying accumulated learning. Observed for real:
  // a ReferenceError in a training script reset atlas-solar-state.json.
  if (require.main === module) {
    console.error('[SAFETY] Saving state and exiting for a clean restart.');
    try { saveStateSync(); } catch (_) {}
    process.exit(1);
  }
  console.error('[SAFETY] Imported as a library — NOT touching the state file. Re-throwing.');
  throw err;
});

// ════════════════════════════════════════════════════════════════════════════
//  DAILY RESET
// ════════════════════════════════════════════════════════════════════════════

function scheduleDailyReset() {
  const nowET       = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nextMidnight = new Date(nowET);
  nextMidnight.setHours(24, 0, 0, 0);
  let ms = nextMidnight - nowET;
  if (ms <= 0) ms += 86400000;
  console.log(`[RISK] Next daily reset in ${(ms / 3600000).toFixed(1)}h (Eastern midnight)`);
  setTimeout(() => {
    riskSystem.dailyRealizedLoss = 0;
    riskSystem.dailyTradeCount   = 0;
    riskSystem.consecutiveLosses = 0;
    riskSystem.lossHaltUntil     = 0;
    riskSystem.dailyResetDate    = getEasternTimeParts().dateStr;
    Object.keys(symbolLossCount).forEach(k => { symbolLossCount[k] = 0; });
    
    // ✅ FIX Bug #6: Also prune expired cooldowns at daily reset
    const now = Date.now();
    Object.keys(symbolCooldowns).forEach(k => {
      if (symbolCooldowns[k] < now) delete symbolCooldowns[k];
    });
    
    // BUG D FIX: watchlist symbols are always in portfolio.trades so they were
    // never pruned anyway — but the Set construction was misleading. Now we
    // explicitly keep all watchlist symbols and only prune unknown symbols.
    const watchlistSet = new Set([...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse, 'SPY']);
    const activeSymbols = new Set(watchlistSet);
    Object.keys(portfolio.longPositions).forEach(s => activeSymbols.add(s));
    Object.keys(portfolio.shortPositions).forEach(s => activeSymbols.add(s));
    Object.keys(dynamicSymbols).forEach(s => activeSymbols.add(s));   // live dynamics keep their data (they're still WS-subscribed)

    // Remove marketData and candleData for symbols not on the watchlist
    // and not currently held (e.g. old symbols from a changed watchlist)
    const marketDataKeys = Object.keys(marketData);
    for (const sym of marketDataKeys) {
      if (!activeSymbols.has(sym)) {
        delete marketData[sym];
        delete candleData[sym];
        delete gapData[sym];
      }
    }
    
    console.log('[RISK] Daily reset + memory cleanup');
    scheduleDailyReset();  // recurse — recalculates after DST changes
  }, ms);
}

// ════════════════════════════════════════════════════════════════════════════
//  RELATIVE STRENGTH RANKING — Layer 2 Enhancement
//  Rank symbols by momentum + trend strength + relative performance
// ════════════════════════════════════════════════════════════════════════════

function updateSymbolMetrics() {
  const market = getCurrentMarket();
  if (!market) return;
  
  const symbols = allTradeSymbols(market);   // core + AI dynamic additions
  const ranking = [];

  symbols.forEach(sym => {
    const q = marketData[sym];
    if (!q || !q.price || !q.prevClose) return;

    // Calculate strength metrics
    const momentum = (q.price - q.prevClose) / q.prevClose;
    const emaFast = ema(q.history, 5);
    const emaSlow = ema(q.history, 20);
    const trend = (emaFast && emaSlow) ? (emaFast > emaSlow ? 1 : -1) : 0;
    const r = rsi(q.history, 14);
    const rsiStrength = Math.abs(r - 50) / 50;  // 0-1: how overbought/oversold

    // Distance from midpoint indicates intraday strength
    const mid = priceMidpoint(sym);
    const fromMid = q.price > mid ? 1 : -1;

    // SPY relative strength
    const spyMom = sentimentData.spyMomentum || 0;
    const relativeStrength = momentum > spyMom ? 1 : -1;

    // Composite strength score (0-10)
    let strengthScore = 0;
    if (momentum > 0.001) strengthScore += 2;
    if (trend > 0) strengthScore += 2;
    if (rsiStrength > 0.3) strengthScore += 2;
    if (fromMid > 0) strengthScore += 2;
    if (relativeStrength > 0) strengthScore += 2;

    ranking.push({
      symbol: sym,
      momentum,
      trend,
      strengthScore,
      rsiStrength,
      fromMid,
      relativeStrength
    });
  });

  // Sort by strength score descending
  ranking.sort((a, b) => b.strengthScore - a.strengthScore);

  // Store top performers and update metrics
  aiSystem.tradeAnalytics.symbolMetrics = {};
  ranking.forEach((item, idx) => {
    aiSystem.tradeAnalytics.symbolMetrics[item.symbol] = {
      momentum: item.momentum,
      strength: item.strengthScore,
      rank: idx + 1,
      relativeToTop: idx === 0 ? 1.0 : item.strengthScore / (ranking[0]?.strengthScore || 1)
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  TRADE QUALITY ANALYTICS — Layer 4: Real Learning (tracks setup performance)
// ════════════════════════════════════════════════════════════════════════════

function recordTradeAnalytics(trade, setupType, regime, sector) {
  // ✅ B9: was `!trade.realizedPnL` — falsy, silently skipped break-even trades ($0 P&L).
  // A break-even is a valid outcome and should count as a loss for analytics.
  if (!trade || trade.realizedPnL === undefined || trade.realizedPnL === null) return;

  const pnl = trade.realizedPnL;
  const isWin = pnl > 0;

  // ✅ Setup type analytics
  if (!aiSystem.tradeAnalytics.setupMetrics[setupType]) {
    aiSystem.tradeAnalytics.setupMetrics[setupType] = {
      wins: 0, losses: 0, totalPnL: 0, times: []
    };
  }
  const setup = aiSystem.tradeAnalytics.setupMetrics[setupType];
  if (isWin) setup.wins++; else setup.losses++;
  setup.totalPnL += pnl;

  // ✅ Regime analytics
  if (!aiSystem.tradeAnalytics.regimeMetrics[regime]) {
    aiSystem.tradeAnalytics.regimeMetrics[regime] = {
      wins: 0, losses: 0, totalPnL: 0
    };
  }
  const reg = aiSystem.tradeAnalytics.regimeMetrics[regime];
  if (isWin) reg.wins++; else reg.losses++;
  reg.totalPnL += pnl;

  // ✅ Sector analytics
  if (sector) {
    if (!aiSystem.tradeAnalytics.sectorMetrics[sector]) {
      aiSystem.tradeAnalytics.sectorMetrics[sector] = {
        wins: 0, losses: 0, totalPnL: 0
      };
    }
    const sec = aiSystem.tradeAnalytics.sectorMetrics[sector];
    if (isWin) sec.wins++; else sec.losses++;
    sec.totalPnL += pnl;
  }

  // ✅ Time-of-day analytics
  const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  if (!aiSystem.tradeAnalytics.timeMetrics[hour]) {
    aiSystem.tradeAnalytics.timeMetrics[hour] = { wins: 0, losses: 0 };
  }
  if (isWin) aiSystem.tradeAnalytics.timeMetrics[hour].wins++;
  else aiSystem.tradeAnalytics.timeMetrics[hour].losses++;

  // ✅ Update best setups (top 3)
  const setupList = Object.entries(aiSystem.tradeAnalytics.setupMetrics)
    .map(([name, stats]) => ({
      name,
      winRate: stats.wins / (stats.wins + stats.losses || 1),
      totalPnL: stats.totalPnL
    }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 3);
  aiSystem.tradeAnalytics.bestSetups = setupList;
}

// ════════════════════════════════════════════════════════════════════════════
//  (Removed in v11.13: detectVolumeBreakout / estimateAbnormalVolume — dead code.
//   Despite the names, both compared PRICE RANGES, not volume, and neither was
//   called anywhere. The real volume-breakout signal lives in evaluateAndTrade
//   via calculateRVOL, which uses actual candle volume.)
// ════════════════════════════════════════════════════════════════════════════
//
//  NEW in v8.1:
//   • Real breadth-based sentiment (no random drift) via computeMarketBreadth()
//   • Probabilistic signal SCORING (0-4 points): requires 2/4 minimum
//   • Time-of-day filter: skip session open/close buffers
//   • Kill switches: stale data, WS disconnect, consecutive-loss halt
//   • Regime uses multi-factor real data (breadth + SPY + vol)
//   • Sector concentration cap in executeLong/Short
//   • priceMidpoint (honest name) replaces vwapProxy
// ════════════════════════════════════════════════════════════════════════════

function evaluateAndTrade() {
  const market = getCurrentMarket();
  if (!market) return;

  updateMarketTransition();

  // Date-anchor daily counters in case no midnight reset fired yet
  const todayET = getEasternTimeParts().dateStr;
  if (riskSystem.dailyResetDate !== todayET) {
    riskSystem.dailyRealizedLoss = 0;
    riskSystem.dailyTradeCount   = 0;
    riskSystem.consecutiveLosses = 0;
    riskSystem.lossHaltUntil     = 0;
    riskSystem.dailyResetDate    = todayET;
  }

  const symbols = allTradeSymbols(market);   // core + AI dynamic additions

  // ── 1. MANAGE OPEN POSITIONS — ATR-anchored stops, targets & trailing ────────
  //  v11.3: every exit threshold scales with the symbol's own volatility (ATR),
  //  not a fixed %. This keeps reward:risk positive and consistent across calm
  //  and wild names. Geometry (per position, from entry-time ATR):
  //    • Hard stop:   −ATR_STOP_MULT × ATR      (e.g. −2.2×ATR)
  //    • TP rung 1:   +1.0×(ATR_TARGET_MULT×ATR) → sell 40%   (~2.1R)
  //    • TP rung 2:   +1.5×(ATR_TARGET_MULT×ATR) → sell 30%   (~3.1R)
  //    • Trailing:    once peak ≥ 1.0R, exit if price gives back ATR_TRAIL_MULT×ATR
  //    • Runner:      final slice rides the trail (no fixed cap — let winners run)
  const TP_RUNG_1_FRACTION = 0.40;
  const TP_RUNG_2_FRACTION = 0.30;
  const longsToClose = [], longsStop = [], shortsToClose = [], shortsStop = [];
  const longPartials = [], shortPartials = [];   // { ticker, fraction, rung }

  // Effective ATR fraction for a ticker's open lots (avg of stored entry ATRs,
  // falling back to live ATR if older state lacks it).
  const lotAtr = (positions, ticker) => {
    const vals = positions.map(p => p.atrFrac).filter(v => Number.isFinite(v) && v > 0);
    if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
    return atrPct(ticker);
  };

  Object.keys(portfolio.longPositions).forEach(ticker => {
    const price = marketData[ticker]?.price;
    if (!price) return;
    const positions = portfolio.longPositions[ticker];
    if (!positions?.length) return;
    let totQty = 0, totCost = 0;
    positions.forEach(p => { totQty += p.qty; totCost += p.entryPrice * p.qty; });
    const avgEntry = totQty > 0 ? totCost / totQty : price;
    const pnlPct   = (price - avgEntry) / avgEntry;
    positions.forEach(p => { p.highestPnL = Math.max(p.highestPnL || 0, pnlPct); });
    const peak = Math.max(...positions.map(p => p.highestPnL || 0));

    const a       = lotAtr(positions, ticker);
    const stopPct = STRATEGY.ATR_STOP_MULT   * a;     // R, in % terms
    const tgtPct  = STRATEGY.ATR_TARGET_MULT * a;
    const trailPct= STRATEGY.ATR_TRAIL_MULT  * a;
    const oneR    = stopPct;

    if (pnlPct <= -stopPct)                              longsStop.push(ticker);     // ATR hard stop
    else if (peak >= oneR && pnlPct <= peak - trailPct)  longsToClose.push(ticker);  // ATR trailing stop
    else {
      if (pnlPct >= tgtPct * 1.5)      longPartials.push({ ticker, fraction: TP_RUNG_2_FRACTION, rung: 'tp2' });
      else if (pnlPct >= tgtPct)       longPartials.push({ ticker, fraction: TP_RUNG_1_FRACTION, rung: 'tp1' });
    }
  });

  Object.keys(portfolio.shortPositions).forEach(ticker => {
    const price = marketData[ticker]?.price;
    if (!price) return;
    const positions = portfolio.shortPositions[ticker];
    if (!positions?.length) return;
    let totQty = 0, totCost = 0;
    positions.forEach(p => { totQty += p.qty; totCost += p.entryPrice * p.qty; });
    const avgEntry = totQty > 0 ? totCost / totQty : price;
    const pnlPct   = (avgEntry - price) / avgEntry;
    positions.forEach(p => { p.highestPnL = Math.max(p.highestPnL || 0, pnlPct); });
    const peak = Math.max(...positions.map(p => p.highestPnL || 0));

    const a       = lotAtr(positions, ticker);
    const stopPct = STRATEGY.ATR_STOP_MULT   * a;
    const tgtPct  = STRATEGY.ATR_TARGET_MULT * a;
    const trailPct= STRATEGY.ATR_TRAIL_MULT  * a;
    const oneR    = stopPct;

    if (pnlPct <= -stopPct)                              shortsStop.push(ticker);
    else if (peak >= oneR && pnlPct <= peak - trailPct)  shortsToClose.push(ticker);
    else {
      if (pnlPct >= tgtPct * 1.5)      shortPartials.push({ ticker, fraction: TP_RUNG_2_FRACTION, rung: 'tp2' });
      else if (pnlPct >= tgtPct)       shortPartials.push({ ticker, fraction: TP_RUNG_1_FRACTION, rung: 'tp1' });
    }
  });

  // Take partial profits first (locks gains before any full-close logic)
  longPartials.forEach(p  => partialClose(p.ticker, 'LONG',  p.fraction, p.rung));
  shortPartials.forEach(p => partialClose(p.ticker, 'SHORT', p.fraction, p.rung));

  longsStop.forEach(t    => closeLong(t, true));
  longsToClose.forEach(t => closeLong(t, false));
  shortsStop.forEach(t    => closeShort(t, true));
  shortsToClose.forEach(t => closeShort(t, false));

  // ── 2. RISK GATES ─────────────────────────────────────────────────────────
  const totalValue = getTotalValue();
  const _dd = computeDrawdown(riskSystem.peakValue, totalValue);
  riskSystem.peakValue       = _dd.peak;
  riskSystem.currentDrawdown = _dd.drawdown;
  riskSystem.peakValue       = Math.max(riskSystem.peakValue, totalValue);
  riskSystem.portfolioHeat   = totalValue > 0 ? Math.max(0, getNotionalExposure() / totalValue) : 0;

  if (riskSystem.currentDrawdown >= capitalSystem.safeModeDrawdown)       capitalSystem.safeMode = true;
  // Auto-release only applies to the AUTOMATIC trigger. A manually-activated Safe Mode
  // (Luna button / API) stays on until the operator releases it — drawdown recovering
  // must not silently override a human's explicit "be careful" instruction.
  if (riskSystem.currentDrawdown < capitalSystem.safeModeDrawdown * 0.5 && !capitalSystem.safeModeManual) capitalSystem.safeMode = false;
  if (riskSystem.currentDrawdown >= capitalSystem.emergencyDrawdown) {
    if (!capitalSystem.emergencyStop) console.log('[EMERGENCY] Severe drawdown — halting entries');
    capitalSystem.emergencyStop = true;
  } else if (riskSystem.currentDrawdown < capitalSystem.emergencyDrawdown * 0.6) {
    capitalSystem.emergencyStop = false;
  }

  // Daily loss limit measured against CURRENT equity, not the fixed starting capital.
  // Frozen at START_CAPITAL it grows under-protective as the account compounds (a $100
  // loss on a $2,000 account is 5%, not 10%). Using live equity also makes the limit
  // MORE protective in a drawdown — the denominator shrinks, so the same dollar loss
  // reads as a bigger % and trips the brake sooner. (Deliberately NOT
  // max(START_CAPITAL, equity): that variant would loosen the brake exactly when the
  // account is losing, which is backwards for a survival-first bot.)
  const dailyLossPct = riskSystem.dailyRealizedLoss / Math.max(1, getTotalValue());
  riskSystem.checksPassing = [];
  if (riskSystem.currentDrawdown <= riskSystem.maxDrawdown)      riskSystem.checksPassing.push('drawdown');
  if (riskSystem.portfolioHeat   <= riskSystem.maxPortfolioHeat) riskSystem.checksPassing.push('heat');
  if (dailyLossPct               <= riskSystem.dailyLossLimit)   riskSystem.checksPassing.push('dailyLoss');
  riskSystem.riskLevel = riskSystem.checksPassing.length === 3 ? 'normal' : 'elevated';

  if (capitalSystem.emergencyStop) return;
  if (riskSystem.riskLevel === 'elevated') {
    if (Date.now() - evaluateAndTrade._lastRiskLog > 60000) {
      evaluateAndTrade._lastRiskLog = Date.now();
      console.log(`[RISK] Elevated [${riskSystem.checksPassing.join(', ')}]`);
    }
    return;
  }
  if (riskSystem.dailyTradeCount >= riskSystem.maxTradesPerDay) {
    if (Date.now() - evaluateAndTrade._lastRiskLog > 60000) {
      evaluateAndTrade._lastRiskLog = Date.now();
      console.log(`[RISK] Daily cap ${riskSystem.maxTradesPerDay} reached`);
    }
    return;
  }

  // ── 3. KILL SWITCHES ──────────────────────────────────────────────────────
  releaseExpiredLossHalt();   // let a finished cool-off actually end before we test it
  const killReason = getKillSwitchReason();
  if (killReason) {
    if (Date.now() - evaluateAndTrade._lastKillLog > 60000) {
      evaluateAndTrade._lastKillLog = Date.now();
      console.log(`[KILL] New entries paused: ${killReason}`);
    }
    return;
  }

  // ── 3.5. MARKET-WIDE VOLATILITY FILTER ─────────────────────────────────────
  // Extreme volatility protection — stops trading during genuine market chaos.
  // v11.16 recalibration, from a live session that took ZERO trades:
  //   • MEDIAN, not mean — 7 of the 21 watchlist names are deliberately high-vol
  //     movers, so a mean let one 6% runner (CIFR, live) halt the entire book while
  //     the typical name moved ~1%.
  //   • Measured FROM THE DAY'S OPEN, not prevClose — the overnight gap is already
  //     handled (and blocked/sized) by the gap system; |price − prevClose| counted
  //     the same gap a second time and halted entries for the whole session.
  const medianVol = marketIntradayVolMedian(symbols);
  if (medianVol > VOLATILITY_FILTERS.EXTREME_VOL_THRESHOLD) {
    if (Date.now() - evaluateAndTrade._lastVolLog > 60000) {
      evaluateAndTrade._lastVolLog = Date.now();
      console.log(`[VOL] Market intraday vol (median) ${(medianVol*100).toFixed(1)}% — halting entries`);
    }
    return;
  }

  // ── 4. POSITION COUNT + CAPITAL CHECK ─────────────────────────────────────
  const openCount = Object.keys(portfolio.longPositions).length
                  + Object.keys(portfolio.shortPositions).length;
  if (openCount >= MAX_OPEN_POSITIONS) return;
  if (capitalSystem.tradingCapital < 50) return;

  // ── 5. TIME-OF-DAY FILTER ─────────────────────────────────────────────────
  if (isInsideSessionBuffer()) {
    if (Date.now() - evaluateAndTrade._lastSessionLog > 60000) {
      evaluateAndTrade._lastSessionLog = Date.now();
      console.log('[FILTER] Inside session buffer — skipping entry');
    }
    return;
  }

  // ── 6. AUTONOMOUS-ENTRY GATE ──────────────────────────────────────────────
  // Exits, risk gates, and kill switches above always run. But if autonomous
  // trading is disabled, ATLAS does NOT open its own positions — entries come
  // only from the TradingView webhook. (Pure-executor mode.)
  if (!AUTONOMOUS_TRADING) {
    if (Date.now() - evaluateAndTrade._lastSessionLog > 300000) {
      evaluateAndTrade._lastSessionLog = Date.now();
      console.log('[MODE] Autonomous entries OFF — waiting for TradingView signals (exits still managed)');
    }
    return;
  }

  // ── 7. REGIME + REAL BREADTH SENTIMENT ───────────────────────────────────
  const regime    = detectMarketRegime();
  const sentiment = sentimentData.byMarket[market] || 0.5;

  // ✅ FIX Bug #2: Regime suggests aggression, but don't mutate every cycle.
  // Use temp adjustment instead. Actual aggression glides via updateLearning().
  let regimeAggressionTarget = aiSystem.aggressionLevel;
  if      (regime === 'bull')             regimeAggressionTarget = Math.min(1.0, regimeAggressionTarget * 1.05);
  else if (regime === 'bear')             regimeAggressionTarget = Math.max(0.15, regimeAggressionTarget * 0.7);
  else if (regime === 'high_volatility')  regimeAggressionTarget = Math.max(0.2,  regimeAggressionTarget * 0.75);
  else if (regime === 'choppy')           regimeAggressionTarget = Math.max(0.25, regimeAggressionTarget * 0.85);
  // BUG F FIX: regimeAggressionTarget now adjusts the entry threshold.
  // High aggression (bull regime) → slightly easier to enter (+0 to -0.03).
  // Low aggression (bear/choppy) → slightly harder to enter (+0 to +0.04).
  // Scale: aggression 0.5 = 0 adjustment, 1.0 = -0.03, 0.15 = +0.04
  const regimeThreshAdj = (0.5 - regimeAggressionTarget) * 0.08;  // range: -0.04 to +0.03

  // ── 7. ENTRY SCAN — strongest symbols first, per-symbol MTF + 7-factor weighted scoring ──
  // Sort by strength rank from updateSymbolMetrics() so the highest-momentum
  // names get evaluated first. When only one slot is open, we trade the best
  // opportunity rather than whichever symbol happens to be first in the array.
  // Unranked symbols (rank === undefined) go to the back.
  const rankedSymbols = [...symbols].sort((a, b) => {
    const rankA = aiSystem.tradeAnalytics.symbolMetrics[a]?.rank ?? 999;
    const rankB = aiSystem.tradeAnalytics.symbolMetrics[b]?.rank ?? 999;
    return rankA - rankB;
  });

  for (const symbol of rankedSymbols) {
    const q = marketData[symbol];
    if (!q || !q.price || !q.prevClose) continue;
    // Per-symbol staleness guard: the kill switch above only halts NEW entries
    // market-wide once a MAJORITY of the watchlist goes stale (getKillSwitchReason).
    // A single frozen feed — most likely a just-added dynamic/Venus symbol whose WS
    // subscribe silently failed — never trips that aggregate check and was otherwise
    // tradeable on a frozen price with no freshness check at all. Trading a stale
    // number is exactly the failure mode "make sure all numbers are true" rules out.
    if (q.lastUpdate && (Date.now() - q.lastUpdate) > MAX_PRICE_AGE_MS) continue;
    // ✅ FIX Bug #2: Empty arrays are truthy, check length explicitly
    const hasLong = portfolio.longPositions[symbol]?.length > 0;
    const hasShort = portfolio.shortPositions[symbol]?.length > 0;
    if (hasLong || hasShort) continue;
    if (onCooldown(symbol)) continue;

    // Earnings calendar blackout
    if (isEarningsBlackout(symbol)) continue;
    // Overnight gap block (>3% gap = skip for 30 min to let price stabilise)
    if (isGapBlocked(symbol)) continue;

    // CENTAURI: dynamic symbols must build real data before any entry. The
    // strategy gate's cold-start fallback is permissive by design for the core
    // list (those symbols accumulate history within minutes of boot), but a
    // just-added news symbol could otherwise trade on a 1-tick history.
    // VOLATILITY-DATA GATE (v11.19) — applies to EVERY symbol, core included.
    // Previously only dynamic symbols were checked, so core names (PLTR, MARA, SOUN…)
    // could trade with ZERO candles: tick-fallback ATR → stops tighter than the spread
    // → the five straight losses seen live. If we cannot measure a symbol's volatility
    // from real bars we do not size a trade on it, full stop. Exits are unaffected —
    // this is the entry scan only, so open positions are still managed normally.
    if (!hasReliableVolatility(symbol)) {
      if (Date.now() - (evaluateAndTrade._lastAtrLog || 0) > 300000) {
        evaluateAndTrade._lastAtrLog = Date.now();
        const n = rankedSymbols.filter(s => !hasReliableVolatility(s)).length;
        console.log(`[DATA] ${n}/${rankedSymbols.length} symbols lack candle-grade ATR (<${MIN_CANDLES_FOR_ATR} 1m bars) — entries on those are paused. Thin IEX tape? Consider ALPACA_DATA_FEED=sip.`);
      }
      continue;
    }
    if (dynamicSymbols[symbol]) {
      const hist = q.history?.length || 0;
      const m1   = candleData[symbol]?.m1?.length || 0;
      if (hist < 15 || m1 < 10) continue;   // wait for EMA/RSI/ATR-grade data
    }

    const momentum  = (q.price - q.prevClose) / q.prevClose;
    const emaFast   = ema(q.history, 5);
    const emaSlow   = ema(q.history, 20);
    const r         = rsi(q.history, 14);
    const midpoint  = priceMidpoint(symbol);
    
    // ✅ Real candle-based multi-timeframe analysis.
    // getCandleTrend() uses actual 1m/5m OHLCV candle closes for trend direction.
    // Falls back gracefully to tick-slice EMAs when candle data hasn't loaded yet.
    const { tf5m: tf5mTrend, tf15m: tf15mBias } = getCandleTrend(symbol);

    const spyMom = sentimentData.spyMomentum || 0;
    const breadthBullish = sentimentData.breadthScore > 0.55;
    
    // ✅ RVOL-based volume confirmation — real rolling relative volume.
    // rvol > 1.5 = above-average participation; more reliable than tick comparison.
    const rvol = calculateRVOL(symbol);
    const volumeBreakout = rvol >= 1.5;
    const abnormalVolume = rvol >= 2.0;

    // Weighted scoring (0.0–1.0). Weights rebalanced: sentiment raised to 0.10 so
    // it acts as a real filter (was 0.05 — barely affected scores). trendFactor
    // reduced from 0.25 to 0.20 to compensate. Weights sum to exactly 1.00.
    let longScore = 0;
    const momentumFactor = momentum > 0 ? Math.min(1, momentum / 0.01) : 0;  // 0.0-1.0
    const trendFactor = tf5mTrend === 'bullish' ? 1.0 : (tf5mTrend === 'neutral' ? 0.5 : 0);
    const emaFactor = emaFast !== null && emaSlow !== null && emaFast > emaSlow ? 1.0 : 0;
    const priceFactor = (q.price >= midpoint && midpoint > 0) ? Math.min(1, (q.price - midpoint) / (midpoint * 0.05 + 0.0001)) : 0;
    const rsiFactor = r >= 30 && r < 70 ? 1.0 - Math.abs(r - 50) / 50 : 0;  // Peak at r=50
    const volumeFactor = (volumeBreakout || abnormalVolume) ? 1.0 : 0.3;
    const sentimentFactor = (sentiment > 0.45 && breadthBullish && spyMom > -0.001) ? 1.0 : (sentiment > 0.5 ? 0.6 : 0.2);
    
    longScore = (momentumFactor * 0.25 + trendFactor * 0.20 + emaFactor * 0.15 + 
                 priceFactor * 0.10 + rsiFactor * 0.10 + volumeFactor * 0.10 + sentimentFactor * 0.10);

    // CENTAURI: bounded AI adjustment (± AI_SIGNAL_WEIGHT max, conviction- and
    // time-decay-scaled). The AI nudges the score; it cannot manufacture an
    // entry by itself or bypass the strategy gate below.
    const aiAdj = aiScoreAdjustment(symbol);
    longScore = Math.max(0, Math.min(1, longScore + aiAdj.long));
    
    // Threshold: 0.72 A+ (top signals), 0.50 normal.
    // v11.19: REVERTED from the 0.70/0.46 aggression tune. Lowering the bar admitted
    // more marginal setups at exactly the time the ATR feeding their stops was broken
    // (see atrQuality) — more trades, each with a stop inside the spread. Restore the
    // researched values; revisit only once the data-quality fixes have real trades
    // behind them.
    const A_PLUS_SETUP_THRESHOLD = 0.72;
    const NORMAL_SETUP_THRESHOLD = 0.50;
    // Apply regime micro-adjustment: bull regime makes threshold slightly easier,
    // bear/choppy makes it slightly harder. Clamped to a safe range.
    const baseThreshold = aiSystem.a_plus_mode ? A_PLUS_SETUP_THRESHOLD : NORMAL_SETUP_THRESHOLD;
    const minThreshold  = Math.max(0.40, Math.min(0.80, baseThreshold + regimeThreshAdj));

    // Formal EMA-crossover + RSI gate (hard filter on top of the weighted score)
    const gate = evaluateStrategyGate(symbol, q);

    const longReady = longScore >= minThreshold && regime !== 'bear' && tf15mBias !== 'bearish' && gate.longGate;

    // ── SHORT scoring (weighted, same structure) ──
    let shortScore = 0;
    const momentumFactorShort = momentum < 0 ? Math.min(1, -momentum / 0.01) : 0;
    const trendFactorShort = tf5mTrend === 'bearish' ? 1.0 : (tf5mTrend === 'neutral' ? 0.5 : 0);
    const emaFactorShort = emaFast !== null && emaSlow !== null && emaFast < emaSlow ? 1.0 : 0;
    const priceFactorShort = (q.price <= midpoint && midpoint > 0) ? Math.min(1, (midpoint - q.price) / (midpoint * 0.05 + 0.0001)) : 0;
    const rsiFactorShort = r > 30 && r <= 70 ? 1.0 - Math.abs(r - 50) / 50 : 0;
    const volumeFactorShort = (volumeBreakout || abnormalVolume) ? 1.0 : 0.3;
    const sentimentFactorShort = (sentiment < 0.55 && !breadthBullish && spyMom < 0.001) ? 1.0 : (sentiment < 0.5 ? 0.6 : 0.2);
    
    shortScore = (momentumFactorShort * 0.25 + trendFactorShort * 0.20 + emaFactorShort * 0.15 + 
                  priceFactorShort * 0.10 + rsiFactorShort * 0.10 + volumeFactorShort * 0.10 + sentimentFactorShort * 0.10);
    shortScore = Math.max(0, Math.min(1, shortScore + aiAdj.short));   // CENTAURI adjustment

    const shortReady = shortScore >= minThreshold && regime !== 'bull' && tf15mBias !== 'bullish' && gate.shortGate;

    if (longReady) {
      const reason = `weighted ${longScore.toFixed(2)}/1.0 ${gate.detail} tf5m ${tf5mTrend} tf15m ${tf15mBias} vol ${volumeBreakout ? 'YES' : 'no'} ${regime}${aiAdj.note}`;
      if (executeLong(symbol, q.price, reason, Math.round(longScore * 7))) {
        aiSystem.currentReasoning.signalScore = Math.round(longScore * 7); // store 0-7 int, consistent with trade records
        return;
      }
    } else if (shortReady) {
      const reason = `weighted ${shortScore.toFixed(2)}/1.0 ${gate.detail} tf5m ${tf5mTrend} tf15m ${tf15mBias} vol ${volumeBreakout ? 'YES' : 'no'} ${regime}${aiAdj.note}`;
      if (executeShort(symbol, q.price, reason, Math.round(shortScore * 7))) {
        aiSystem.currentReasoning.signalScore = Math.round(shortScore * 7);
        return;
      }
    }
  }

  // Throttled no-trade log
  if (Date.now() - evaluateAndTrade._lastScanLog > 60000) {
    evaluateAndTrade._lastScanLog = Date.now();
    const breadth = (sentimentData.breadthScore * 100).toFixed(0);
    const spy     = (sentimentData.spyMomentum  * 100).toFixed(2);
    const stress = (calculateMarketStress() * 100).toFixed(0);
    const expectancy = calculateTradeExpectancy();
    console.log(`[SCAN] ${market} ${regime} | breadth ${breadth}% | SPY ${spy}% | stress ${stress}% | expect ${expectancy.expectancy.toFixed(2)} | open ${openCount}/${MAX_OPEN_POSITIONS} | trades ${riskSystem.dailyTradeCount}/${riskSystem.maxTradesPerDay}`);
  }
}
evaluateAndTrade._lastScanLog     = 0;
evaluateAndTrade._lastRiskLog     = 0;
evaluateAndTrade._lastKillLog     = 0;
evaluateAndTrade._lastSessionLog  = 0;
evaluateAndTrade._lastVolLog      = 0;
evaluateAndTrade._lastAtrLog      = 0;

// ════════════════════════════════════════════════════════════════════════════
//  API — Luna reads these endpoints
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/portfolio', (req, res) => {
  const market     = getCurrentMarket();
  const totalValue = getTotalValue();
  const pnl        = totalValue - START_CAPITAL;
  const returnPct  = (pnl / START_CAPITAL) * 100;

  const positions = [];
  Object.entries(portfolio.longPositions).forEach(([ticker, posArr]) => {
    const price = Number(marketData[ticker]?.price) || 0;
    posArr.forEach(pos => {
      const ep = Number(pos.entryPrice) || 0;
      positions.push({ ticker, type: 'LONG', qty: pos.qty,
        entryPrice: ep.toFixed(2), currentPrice: price.toFixed(2),
        pnl: ((price - ep) * pos.qty).toFixed(2),
        peakPnL: ((pos.highestPnL || 0) * 100).toFixed(1) + '%',
        sector: SYMBOL_SECTOR[ticker] || (dynamicSymbols[ticker] ? 'dynamic' : '—')
      });
    });
  });
  Object.entries(portfolio.shortPositions).forEach(([ticker, posArr]) => {
    const price = Number(marketData[ticker]?.price) || 0;
    posArr.forEach(pos => {
      const ep = Number(pos.entryPrice) || 0;
      positions.push({ ticker, type: 'SHORT', qty: pos.qty,
        entryPrice: ep.toFixed(2), currentPrice: price.toFixed(2),
        pnl: ((ep - price) * pos.qty).toFixed(2),
        peakPnL: ((pos.highestPnL || 0) * 100).toFixed(1) + '%',
        sector: SYMBOL_SECTOR[ticker] || (dynamicSymbols[ticker] ? 'dynamic' : '—')
      });
    });
  });

  const recentTrades = portfolio.trades.slice(-12).reverse().map(t => {
    const entryP   = Number(t.entryPrice) || 0;
    const livePrice = marketData[t.ticker]?.price;
    const liveP    = (livePrice && livePrice > 0) ? livePrice : entryP;
    // For CLOSED trades the meaningful "current" price is the actual exit fill,
    // not today's live quote (which keeps moving after the trade is done).
    const shownP   = t.status === 'open' ? liveP : (Number(t.exitPrice) || liveP);
    const unrealized = t.status === 'open'
      ? (t.direction === 'LONG' ? (liveP - entryP) * t.qty : (entryP - liveP) * t.qty)
      : 0;
    return {
      ticker: t.ticker, direction: t.direction, size: t.qty,
      entryPrice: entryP.toFixed(2), currentPrice: shownP.toFixed(2),
      reason: t.reason, status: t.status, signalScore: t.signalScore || 0,
      realizedPnL: t.realizedPnL || 0, unrealizedPnL: unrealized,
      timestamp: t.timestamp
    };
  });

  const closed        = portfolio.closedTrades;
  // Partial take-profit slices are tagged with `.partial`; exclude them from
  // the win-rate denominator so a single laddered position isn't counted as
  // several separate "wins". Their realized P&L still flows into cash + daily
  // accounting; this only affects the displayed win-rate metric.
  const fullCloses    = closed.filter(t => !t.partial);
  const wins          = fullCloses.filter(t => t.realizedPnL > 0).length;
  const totalClosed   = fullCloses.length;
  const winRate       = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : '0.0';
  const openTradeCount = portfolio.trades.filter(t => t.status === 'open').length;

  res.json({
    cash:       portfolio.cash.toFixed(2),
    totalValue: totalValue.toFixed(2),
    totalPnL:   pnl.toFixed(2),
    return:     returnPct.toFixed(2),
    positions,
    recentTrades,
    stats: {
      totalTrades: openTradeCount + totalClosed,
      openTrades:  openTradeCount,
      closedTrades: totalClosed,
      wins, losses: totalClosed - wins,
      winRatePercent:  winRate + '%',
      recentWinRate:   (aiSystem.recentWinRate   * 100).toFixed(1) + '%',
      smoothedWinRate: (aiSystem.smoothedWinRate * 100).toFixed(1) + '%'
    },
    currentMarket: market || 'CLOSED',
    marketClosedReason: market ? null : marketClosedReason(),
    marketStatus:  getMarketStatus(),
    regime:        detectMarketRegime(),
    wsConnected,
    pricesLoaded:  Object.keys(marketData).length,
    capital: {
      reserveCash:    capitalSystem.reserveCash.toFixed(2),
      tradingCapital: capitalSystem.tradingCapital.toFixed(2),
      profitVault:    capitalSystem.profitVault.toFixed(2),
      safeMode:       capitalSystem.safeMode,
      safeModeManual: capitalSystem.safeModeManual,
      emergencyStop:  capitalSystem.emergencyStop,
      aPlusMode:      aiSystem.a_plus_mode
    },
    execution: {
      mode:          EXEC_BROKER_AUTH ? 'broker-authoritative' : 'simulation',
      broker:        broker.name,
      authoritative: EXEC_BROKER_AUTH ? broker.name : 'internal-simulator',
      pendingOrders: Object.keys(pendingOrders).length,
      mirror:        EXEC_BROKER_AUTH ? brokerMirror : null,
      driftPct:      EXEC_BROKER_AUTH ? executionDriftPct() : null,
      costTracking:  costTrackingSummary(),
      // Stuck orders (see STALE_ORDER_ALERT_MS). `exitsBlocked` is the one that needs
      // immediate operator attention — it means a stop-loss cannot fire on that symbol.
      stuck: Object.entries(pendingOrders)
        .filter(([, p]) => p && p.stuck)
        .map(([id, p]) => ({
          id, kind: p.kind, ticker: p.ticker, direction: p.direction || null,
          ageMin: Math.round((Date.now() - (p.submittedAt || 0)) / 60000),
          exitsBlocked: p.kind !== 'entry'
        }))
    },
    aiMetrics: {
      strategy:         aiSystem.strategy,
      strategySample:   aiSystem.strategySample || 0,
      aggressionLevel:  (aiSystem.aggressionLevel * 100).toFixed(0) + '%',
      winningStreak:    aiSystem.winningStreak,
      losingStreak:     aiSystem.losingStreak,
      consecutiveLosses: riskSystem.consecutiveLosses,
      performanceHistory: aiSystem.performanceHistory.slice(-20)
    },
    aiReasoning: {
      winRate:     (aiSystem.currentReasoning.winRate * 100).toFixed(1) + '%',
      trend:       aiSystem.currentReasoning.trend,
      confidence:  aiSystem.currentReasoning.confidence + '%',
      nextAction:  aiSystem.currentReasoning.nextAction,
      signalScore: aiSystem.currentReasoning.signalScore,
      regime:      aiSystem.currentReasoning.regime,
      breadth:     (sentimentData.breadthScore * 100).toFixed(0) + '%',
      spyMomentum: (sentimentData.spyMomentum * 100).toFixed(2) + '%',
      uptickRatio: (sentimentData.uptickRatio * 100).toFixed(0) + '%'
    },
    riskMetrics: {
      currentDrawdown:  (riskSystem.currentDrawdown  * 100).toFixed(2) + '%',
      portfolioHeat:    (riskSystem.portfolioHeat     * 100).toFixed(2) + '%',
      riskLevel:        riskSystem.riskLevel,
      checksPassing:    riskSystem.checksPassing,
      dailyLoss:        riskSystem.dailyRealizedLoss.toFixed(2),
      dailyLossLimit:   (riskSystem.dailyLossLimit   * 100).toFixed(0) + '%',
      dailyTradeCount:  riskSystem.dailyTradeCount,
      maxTradesPerDay:  riskSystem.maxTradesPerDay,
      consecutiveLosses: riskSystem.consecutiveLosses,
      maxConsecutiveLosses: riskSystem.maxConsecutiveLosses
    },
    // ✅ NEW: Trade Quality Analytics (Layer 4 Learning)
    tradeAnalytics: {
      bestSetups: aiSystem.tradeAnalytics.bestSetups,
      setupMetrics: aiSystem.tradeAnalytics.setupMetrics,
      regimeMetrics: aiSystem.tradeAnalytics.regimeMetrics,
      sectorMetrics: aiSystem.tradeAnalytics.sectorMetrics,
      topSymbolsByRank: Object.entries(aiSystem.tradeAnalytics.symbolMetrics)
        .sort((a, b) => a[1].rank - b[1].rank)
        .slice(0, 5)
        .map(([sym, metrics]) => ({ symbol: sym, ...metrics }))
    },
    // Gap data: shows overnight gaps detected at session open
    gapAlerts: Object.entries(gapData)
      .filter(([, g]) => g.absGap >= GAP_WARN_PCT)
      .map(([sym, g]) => ({
        symbol: sym,
        gapPct: (g.gapPct * 100).toFixed(2) + '%',
        direction: g.direction,
        blocked: g.blockUntil > Date.now(),
        blockedUntil: g.blockUntil > Date.now()
          ? new Date(g.blockUntil).toISOString() : null
      })),
    // CENTAURI: both engines broadcast to Luna.
    //   intel  = backward-compatible combined view (existing dashboard cards)
    //   venus / jupiter = the two-engine breakdown
    //   terra  = the execution gate (recent rejections + what it enforces)
    intel:   buildIntelSummary(),
    venus: { ...venus.getState(), research: venus.getResearch(), watchlist: venus.getResearch().watchlist, callsThisHour: aiCallsThisHour(), callBudgetPerHour: AI_MAX_CALLS_PER_HOUR, stats: intelStats },
    jupiter:   { ...jupiter.getState(), dynamicWatchlist: Object.keys(dynamicSymbols) },
    terra:   { recentRejections: tradeRejections.slice(-10).reverse(), rejectionCount: tradeRejections.length, enforces: ['stop loss', 'price limits', 'R:R ≥ ' + STRATEGY.MIN_RR, 'risk pipeline'] }
  });
});

// CENTAURI: combined summary (Venus calibration + Jupiter signals) for Luna's
// existing Intel card. Kept backward-compatible so the dashboard needs no change.
function buildIntelSummary() {
  const v = jupiter.getState();
  const j = venus.getState();
  return {
    aiEnabled: AI_ENABLED,
    provider: AI_ENABLED ? venus.PROVIDER : null,
    model: AI_ENABLED ? venus.AI_MODEL : null,
    // Jupiter owns the live signals
    signals: v.activeSignals,
    dynamicWatchlist: Object.keys(dynamicSymbols),
    // Accuracy: Jupiter's resolved trades drive the headline accuracy number
    accuracy: v.tradingAccuracy,
    resolvedSignals: v.resolvedTrades,
    // Venus owns the per-catalyst calibration
    catalystStats: j.calibration,
    callsThisHour: aiCallsThisHour(), callBudgetPerHour: AI_MAX_CALLS_PER_HOUR,
    stats: intelStats
  };
}

// CENTAURI: combined view + per-engine endpoints
app.get('/api/intel', (req, res) => res.json({ ...buildIntelSummary(), recentOutcomes: jupiter.getState().recentOutcomes }));
app.get('/api/venus', (req, res) => res.json({ ...venus.getState(), research: venus.getResearch(), watchlist: venus.getResearch().watchlist }));   // research engine
app.get('/api/jupiter',   (req, res) => res.json({ ...jupiter.getState(), dynamicWatchlist: Object.keys(dynamicSymbols) }));  // trading engine
app.post('/api/intel/analyze', async (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized (ADMIN_TOKEN)' });
  if (!AI_ENABLED) return res.status(503).json({ error: 'Venus disabled — set GROQ_API_KEY (free, console.groq.com) or ANTHROPIC_API_KEY' });
  await runIntelCycle();
  res.json({ ok: true, ...buildIntelSummary() });
});

// POST /api/retrain — specialize the AIs NOW from accumulated experience (no restart).
// Replays Jupiter's win-model + Venus's calibration over many epochs and adopts the
// sharpened weights live, then persists them. e.g.:
//   curl -X POST "http://localhost:3000/api/retrain?epochs=20"
app.post('/api/retrain', async (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized (ADMIN_TOKEN)' });
  const epochs = Math.max(1, Math.min(200, parseInt(req.query.epochs, 10) || 15));
  const jupiterResult = jupiter.trainOffline({ epochs });   // win-probability model
  const venusResult   = venus.trainOffline({ epochs });     // research calibration
  saveState();   // persist the sharpened weights (async, fire-and-forget)
  res.json({ ok: true, epochs, jupiter: jupiterResult, venus: venusResult });
});

app.get('/api/logs',   (req, res) => res.json(tradeLogger));
app.get('/api/health', (req, res) => res.json({
  ok: true, wsConnected, market: getCurrentMarket() || 'CLOSED',
  market_closed_reason: getCurrentMarket() ? null : marketClosedReason(),
  calendar_loaded: marketCalendar.ok, uptime: process.uptime(),
  a_plus_mode: aiSystem.a_plus_mode,
  live_trading: LIVE_TRADING,
  autonomous_trading: AUTONOMOUS_TRADING,
  broker: broker.name,
  broker_is_live: !!broker.isLive,
  strategy_gate: STRATEGY_GATE_ENABLED,
  // AI_ENABLED reflects whether VENUS has a working LLM key — that's the only engine
  // that calls an LLM provider. Jupiter's win-model runs regardless (it's pure ML, no
  // LLM); its own reasoning (deliberate/self-check) rides on the same provider check.
  ai_enabled: AI_ENABLED,
  venus_llm_enabled: AI_ENABLED,
  venus_llm_provider: AI_ENABLED ? venus.PROVIDER : null,
  jupiter_enabled: true,                 // the win-model + sizing engine always runs
  jupiter_reasoning_enabled: AI_ENABLED, // deliberate()/self-check needs the same LLM key
  venus_active: true,
  dynamic_watchlist: DYNAMIC_WATCHLIST_ON,
  dynamic_symbols: Object.keys(dynamicSymbols).length,
  live_ai_signals: jupiter.activeSymbols().length,
  version: 'v11.20-centauri'
}));

// Toggle A+ mode via POST /api/aplus?enable=true|false
// e.g.: curl -X POST "http://localhost:3000/api/aplus?enable=true"
app.post('/api/aplus', (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized (ADMIN_TOKEN)' });
  const enable = req.query.enable === 'true';
  aiSystem.a_plus_mode = enable;
  queueSaveState();
  console.log(`[A+] Mode ${enable ? 'ENABLED' : 'DISABLED'} via API`);
  res.json({ ok: true, a_plus_mode: aiSystem.a_plus_mode });
});

// Manual Safe Mode toggle via POST /api/safemode?on=true|false (half-size all entries).
// Manual activation STICKS — the automatic drawdown-recovery release will not clear it;
// only an explicit ?on=false (or the Luna button) releases a manual Safe Mode.
app.post('/api/safemode', (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized (ADMIN_TOKEN)' });
  const on = req.query.on !== 'false';
  capitalSystem.safeMode       = on;
  capitalSystem.safeModeManual = on;
  queueSaveState();
  console.log(`[SAFEMODE] ${on ? 'ACTIVATED' : 'RELEASED'} via API (manual)`);
  res.json({ ok: true, safeMode: capitalSystem.safeMode, manual: capitalSystem.safeModeManual });
});

// Emergency stop toggle via POST /api/emergency?stop=true|false
app.post('/api/emergency', (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized (ADMIN_TOKEN)' });
  const stop = req.query.stop !== 'false';
  capitalSystem.emergencyStop = stop;
  queueSaveState();
  console.log(`[EMERGENCY] ${stop ? 'HALTED' : 'RESUMED'} via API`);
  res.json({ ok: true, emergencyStop: capitalSystem.emergencyStop });
});

// ─── BROKER STATUS ─────────────────────────────────────────────────────────
// GET /api/broker — broker name, live flag, account, positions, last orders.
app.get('/api/broker', async (req, res) => {
  const out = {
    broker: broker.name, isLive: !!broker.isLive, liveTradingFlag: LIVE_TRADING,
    recentOrders: liveOrderLog.slice(-25)
  };
  try {
    const acct = await broker.getAccount();
    const pos  = await broker.getPositions();
    out.account = acct;
    out.brokerPositions = pos.positions || [];
  } catch (e) { out.error = e.message; }
  res.json(out);
});

// ─── RECONCILIATION ──────────────────────────────────────────────────────
// POST /api/reconcile — compare ATLAS's shadow book to the broker's real
// positions and report differences. Does NOT auto-modify state (too risky to
// silently overwrite); it surfaces drift so you can act. Read this every
// morning before the open when live.
async function reconcileWithBroker() {
  if (!LIVE_TRADING) return { ok: false, reason: 'not-live' };
  const pos = await broker.getPositions();
  if (!pos.ok) return { ok: false, error: pos.error };

  const brokerMap = {};
  (pos.positions || []).forEach(p => { brokerMap[p.symbol] = p; });

  const atlasMap = {};
  Object.entries(portfolio.longPositions).forEach(([s, lots]) => {
    atlasMap[s] = (atlasMap[s] || 0) + lots.reduce((a, l) => a + l.qty, 0);
  });
  Object.entries(portfolio.shortPositions).forEach(([s, lots]) => {
    atlasMap[s] = (atlasMap[s] || 0) - lots.reduce((a, l) => a + l.qty, 0);
  });

  const allSymbols = new Set([...Object.keys(brokerMap), ...Object.keys(atlasMap)]);
  const drift = [];
  allSymbols.forEach(sym => {
    const atlasQty  = atlasMap[sym] || 0;
    const brokerQty = brokerMap[sym] ? (brokerMap[sym].side === 'short' ? -brokerMap[sym].qty : brokerMap[sym].qty) : 0;
    if (atlasQty !== brokerQty) drift.push({ symbol: sym, atlasQty, brokerQty, diff: atlasQty - brokerQty });
  });

  if (drift.length) console.warn(`[RECONCILE] ${drift.length} position(s) differ from broker`, drift);
  else console.log('[RECONCILE] ATLAS and broker positions match');
  return { ok: true, inSync: drift.length === 0, drift, brokerPositions: pos.positions };
}
app.post('/api/reconcile', async (req, res) => {
  if (!adminAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized (ADMIN_TOKEN)' });
  res.json(await reconcileWithBroker());
});

// ─── TRADINGVIEW WEBHOOK ───────────────────────────────────────────────────
// POST /api/tradingview-webhook
// Receives alerts from a TradingView Pine strategy/indicator. The alert message
// MUST be JSON with a matching passphrase. Schema (strict):
//   { "passphrase": "<TRADINGVIEW_WEBHOOK_SECRET>",
//     "action": "buy" | "sell" | "close",
//     "symbol": "PLTR",
//     "qty": 10  (optional; if omitted ATLAS sizes it via computePositionSize) }
//
// SECURITY: the payload is untrusted. We (1) require the shared secret, (2) only
// accept a strict schema, (3) constrain symbol to the known watchlist, (4) bound
// qty, and (5) run ATLAS's full risk pipeline before any order is routed.
app.post('/api/tradingview-webhook', (req, res) => {
  if (!TRADINGVIEW_WEBHOOK_SECRET) {
    return res.status(503).json({ ok: false, error: 'webhook-not-configured (set TRADINGVIEW_WEBHOOK_SECRET)' });
  }
  const body = req.body || {};
  if (body.passphrase !== TRADINGVIEW_WEBHOOK_SECRET) {
    console.warn('[TV] rejected webhook — bad passphrase');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const action = String(body.action || '').toLowerCase();
  const symbol = String(body.symbol || '').toUpperCase();
  // Tradeable universe = core watchlists + live dynamic symbols (Venus-discovered names
  // are real positions too) + anything we currently HOLD. The last part matters most:
  // a close signal for an open position must never be rejected just because the symbol
  // expired off the dynamic list while the position was still open.
  const universe = new Set([
    ...WATCHLISTS.nasdaq, ...WATCHLISTS.nyse,
    ...Object.keys(dynamicSymbols),
    ...Object.keys(portfolio.longPositions), ...Object.keys(portfolio.shortPositions)
  ]);

  if (!['buy', 'sell', 'close'].includes(action)) return res.status(400).json({ ok: false, error: 'bad-action' });
  if (!universe.has(symbol)) return res.status(400).json({ ok: false, error: 'symbol-not-in-watchlist' });

  const price = marketData[symbol]?.price;
  if (!Number.isFinite(price) || price <= 0) return res.status(409).json({ ok: false, error: 'no-price-for-symbol' });

  // Global guards still apply even to external signals
  if (capitalSystem.emergencyStop) return res.status(423).json({ ok: false, error: 'emergency-stop-active' });

  let result;
  if (action === 'close') {
    closeLong(symbol);
    closeShort(symbol);
    result = { action: 'close', symbol };
  } else if (action === 'buy') {
    // 'buy' opens/extends a long via the normal risk-checked path
    const ok = executeLong(symbol, price, `TradingView webhook buy`, 5);
    result = { action: 'buy', symbol, accepted: ok };
  } else if (action === 'sell') {
    // 'sell' opens/extends a short via the normal risk-checked path
    const ok = executeShort(symbol, price, `TradingView webhook sell`, 5);
    result = { action: 'sell', symbol, accepted: ok };
  }

  console.log(`[TV] webhook ${action} ${symbol} → ${JSON.stringify(result)}`);
  logTrade(`TV-WEBHOOK ${action} ${symbol}`);
  res.json({ ok: true, ...result, routedToBroker: LIVE_TRADING });
});

// ════════════════════════════════════════════════════════════════════════════
//  MAIN STARTUP
// ════════════════════════════════════════════════════════════════════════════

// Boot the execution engine only when run directly (`node server.js`). When
// imported as a module, the engine stays dormant and only its brain is exposed.
if (require.main === module) app.listen(PORT, async () => {
  console.log(`\n🌌  ATLAS CENTAURI — Unified Engine v11.20 on port ${PORT}`);
  console.log(`   ♀ Venus (research AI: web + 13F + news) + 🔭 Jupiter (trading AI: sizes/decides/learns) + 🌍 Terra (execution gate)`);
  console.log(`[STARTUP] Alpaca data feed (${ALPACA_DATA_FEED}) — US markets (NASDAQ/NYSE) only`);

  // ── Wire JUPITER to Terra's live state + indicator helpers ──
  // (Objects are shared by reference, so Jupiter always reads current values.)
  jupiter.init({
    strategy: STRATEGY,
    venus,                          // DIRECT reference → zero-latency Jupiter↔Venus loop
    capitalSystem, riskSystem, aiSystem,
    helpers: {
      atrPct, calculateATR, calculateRVOL, calculateMarketStress,
      getGapSizeAdjust, calculateTradeExpectancy,
      isHighVolatility: (sym) => HIGH_VOLATILITY.has(sym),
      closedTradeCount: () => portfolio.closedTrades.filter(t => !t.partial).length,
      // ── Feature inputs for Jupiter's win-probability model ──
      adx: (sym) => calculateADX(sym),
      rsi: (sym) => rsi(marketData[sym]?.history || [], STRATEGY.RSI_PERIOD),
      regimeNumeric: () => ({ bull: 1, bullish: 1, choppy: 0, neutral: 0, bear: -1, bearish: -1 }[detectMarketRegime()] ?? 0),
      sessionFraction: () => { const { hours } = getEasternTimeParts(); return Math.max(0, Math.min(1, (hours - 9.5) / 6.5)); },
      spread: (sym) => estimateDynamicSpread(sym),
      quote: (sym) => { const m = marketData[sym]; return m ? { price: m.price, prevClose: m.prevClose } : null; }
    }
  });

  if (AI_ENABLED) {
    console.log(`[VENUS] ♀ Research AI ON — ${venus.PROVIDER} / ${venus.AI_MODEL} | scans web + 13F institutional holdings + news → watchlist & ideas | calibrated | poll ${NEWS_POLL_MS / 60000}min | budget ${AI_MAX_CALLS_PER_HOUR}/h`);
    console.log(`[JUPITER]   🔭 Trading AI ON — consumes Venus's research, sizes & decides (win-probability model + Kelly), learns from every trade | signal weight ±${AI_SIGNAL_WEIGHT} | dynamic watchlist ${DYNAMIC_WATCHLIST_ON ? `ON (max ${DYNAMIC_MAX_SYMBOLS})` : 'OFF'}`);
  } else {
    console.log('[VENUS] Research AI news layer OFF — set GROQ_API_KEY (free, console.groq.com) or ANTHROPIC_API_KEY. 13F + volume research still runs.');
    console.log('[JUPITER]   🔭 Trading AI ON (technical mode) — sizes & learns from every trade; Venus research disabled (no API key), so no external ideas to act on.');
  }

  // Announce execution mode loudly so live trading is never a surprise.
  if (LIVE_TRADING) {
    console.log(`\n🔴 LIVE TRADING ENABLED — broker: ${broker.name}${broker.isLive ? ' (REAL MONEY)' : ' (broker paper)'}`);
    console.log('🔴 ATLAS will route real orders through the broker after its risk checks.');
    if (broker.name.startsWith('alpaca') && broker.configured === false) {
      console.warn('⚠️  Alpaca keys missing — orders will fail until APCA_API_KEY_ID / APCA_API_SECRET_KEY are set.');
    }
  } else {
    console.log('🟢 SIM MODE — no real orders (LIVE_TRADING != true). Broker routing is a no-op.');
  }
  console.log(`[STRATEGY] EMA(${STRATEGY.EMA_FAST}/${STRATEGY.EMA_SLOW}) + RSI(${STRATEGY.RSI_PERIOD}) gate ${STRATEGY_GATE_ENABLED ? 'ON' : 'OFF'}`);
  console.log(`[MODE] Autonomous entries ${AUTONOMOUS_TRADING ? 'ON (ATLAS is the brain)' : 'OFF (pure executor — TradingView drives entries)'}`);

  loadState();
  if (!riskSystem.dailyResetDate) riskSystem.dailyResetDate = getEasternTimeParts().dateStr;

  // 1. Load all prevClose + dailyVolume (quotes)
  await fetchInitialPrices();

  // 2. Fetch real OHLCV candle data — true ATR, real multi-timeframe, RVOL
  await fetchCandles();

  // 3. Real-time WS feed
  connectWebSocket();

  // 3a. Confirm the LLM model actually exists on this key before Venus needs it.
  //     A retired model id silently killed every news cycle for a full session.
  if (AI_ENABLED) { try { await resolveAiModel(); } catch (e) { console.warn('[VENUS] model check failed:', e.message); } }

  // 3b. Official trading calendar (holidays + early closes). Best-effort: on failure
  //     the engine falls back to standard weekday hours, exactly as before.
  await refreshMarketCalendar();
  setInterval(refreshMarketCalendar, 12 * 3600 * 1000);

  // 4. Capital split
  rebalanceCapital();

  // 4b. Broker-authoritative startup (v11.18): adopt the broker's cash/positions as
  //     the ledger's truth, take the first mirror snapshot, start the order poller and
  //     the mirror refresher, and log the quantity reconcile for visibility.
  if (EXEC_BROKER_AUTH) {
    console.log(`[EXEC] 🔗 BROKER-AUTHORITATIVE mode — ${broker.name} fills are the source of truth (PAPER ONLY — no real money)`);
    try { await syncFromBroker(); } catch (e) { console.error('[SYNC] startup failed:', e.message); }
    try { await refreshBrokerMirror(); } catch (_) {}
    try { await reconcileWithBroker(); } catch (e) { console.error('[RECONCILE] startup failed:', e.message); }
    setInterval(pollPendingOrders, 3000);
    setInterval(() => { if (getCurrentMarket()) refreshBrokerMirror(); }, 60000);
    const pend = Object.keys(pendingOrders).length;
    if (pend) console.log(`[EXEC] Resuming ${pend} pending order(s) from saved state`);
  }

  // 5. Main loop — v11.19: sped up from 10s to 2s (matches Luna's own 2s poll cadence).
  // This is a pure reaction-speed change, not a risk change: it doesn't touch position
  // size, stop distance, or any cap — it just checks live WS prices against the SAME
  // stop/target/entry rules more often. That cuts both ways correctly: entries can catch
  // a setup sooner, AND open-position stops/trailing-stops/targets (evaluateAndTrade's
  // step 1, which always runs first, every tick, unconditionally) get checked 5x more
  // often too — the safeguards get MORE responsive, not less. Safe to run this often:
  // everything in the loop reads already-cached data (WS ticks / candle cache), no new
  // network calls are made here, and updateLearning() (v11.17) only advances state once
  // per NEW closed trade regardless of tick rate, so faster ticking can't corrupt it.
  setInterval(() => {
    computeMarketBreadth();
    updateSymbolMetrics();
    updateLearning();
    evaluateAndTrade();
  }, 2000);

  // 6. Profit vault — every 5 min
  setInterval(processProfitVault, 300000);

  // 7. Candle refresh — every 5 min during market hours (fresh ATR/RVOL/MTF)
  setInterval(() => { if (getCurrentMarket()) fetchCandles(); }, 300000);

  // 8. Capital rebalance — hourly
  setInterval(rebalanceCapital, 3600000);

  // 9. Periodic save — every 5 min
  setInterval(saveState, 300000);

  // 10. Daily reset at Eastern midnight
  scheduleDailyReset();

  // 11. prevClose + candle full refresh every 6h, US hours only
  setInterval(() => {
    const { hours, day } = getEasternTimeParts();
    const isWeekend   = day === 0 || day === 6;
    const isUSSession = hours >= 8 && hours < 17;
    if (!isWeekend && isUSSession) { fetchInitialPrices(); fetchCandles(); }
    else console.log('[PRICES] Skipping refresh — market closed');
  }, 21600000);

  // 12. CENTAURI cycle — Terra fetches news → Venus analyzes → Jupiter consumes
  //     (no-op without API key; skips outside 8:00–16:00 ET; no LLM call when no
  //      fresh news). This is the heartbeat of the Venus→Jupiter pipeline.
  if (AI_ENABLED) {
    setInterval(runIntelCycle, NEWS_POLL_MS);
    setTimeout(runIntelCycle, 15000);   // first cycle shortly after boot
  }

  // 13. Startup diagnostic — fires after prices + candles load
  setTimeout(() => {
    const m = getCurrentMarket();
    computeMarketBreadth();
    console.log(`[DIAG] Market: ${m || ('CLOSED — ' + (marketClosedReason() || 'unknown'))} | Regime: ${detectMarketRegime()} | Breadth: ${(sentimentData.breadthScore*100).toFixed(0)}% | SPY: ${(sentimentData.spyMomentum*100).toFixed(2)}% | Prices: ${Object.keys(marketData).length} | Candles: ${Object.keys(candleData).length} | Jupiter signals: ${jupiter.activeSymbols().length}`);
  }, 40000);

  console.log("[STARTUP] Centauri online — unified engine v11.20 (Venus + Jupiter + Terra) ready\n");
});

// ════════════════════════════════════════════════════════════════════════════
//  MODULE EXPORTS — expose the Centauri brain when this engine is imported
//  (e.g. by train.js or tests) so the AIs can be trained/inspected WITHOUT
//  booting the execution engine. Running `node server.js` directly boots normally.
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  venus, createJupiter, jupiter,
  createVenus: createJupiter,   // deprecated alias (pre-v11.7 name) — the factory builds the TRADING engine
  OnlineLogistic, PlattCalibrator, sigmoid, logit, clip, blendWithPrior,
  trainLogisticBatch, meanLogLoss, accuracyOf,
  // Test-only handles for the execution pipeline (unused by the running engine).
  _internals: { buildTradePlan, terraValidateTrade, terraExecutePlan, portfolio, capitalSystem, riskSystem, marketData, dynamicSymbols, STRATEGY, gapData, getGapSizeAdjust, isGapBlocked, detectOvernightGaps, marketIntradayVolMedian, candleData, rebalanceCapital, updateLearning, aiSystem, pendingOrders, pollPendingOrders, refreshBrokerMirror, brokerMirror: () => brokerMirror, executionDriftPct, applyEntryFill, closeLong, closeShort, partialClose,
    // v11.19: additional read-only/pure handles so test.js can regression-test the
    // invariants that were previously only ever checked by hand.
    clearOrphanedInFlightMarks, computeMarketBreadth, sentimentData, spyData,
    getTotalValue, getNotionalExposure, calculateTradeExpectancy,
    ema, rsi, calculateATR, atrPct, SENTIMENT_EMA_REF_MS, sentimentAlpha,
    computeDrawdown, isEarningsBlackout, EARNINGS_BLACKOUT_ENABLED, START_CAPITAL,
    trimTrades, cancelPendingSave, refreshMarketCalendar, marketClosedReason, costTrackingSummary,
    resolveAiModel, GROQ_CHAT_PREFERENCE, aiModel: () => AI_MODEL,
    LONG_ONLY,
    marketCalendar: () => marketCalendar, getCurrentMarket, getEasternTimeParts, resolveSession,
    atrQuality, hasReliableVolatility, MIN_CANDLES_FOR_ATR,
    releaseExpiredLossHalt, LOSS_HALT_MS, getKillSwitchReason, lossHaltReason,
    institutionalScore, ideaDirection, EFFECTIVE_MIN_DAY_VOL, FEED_VOLUME_FACTOR, DYNAMIC_MIN_DAY_VOL,
    estimateRoundTripCost, netRewardRisk, sideCost, LIMIT_ENTRIES, estimateDynamicSpread,
    evaluateStrategyGate, calculateADX, calculateRVOL, getCandleTrend, priceMidpoint, detectMarketRegime,
    setPendingOrders: (o) => { pendingOrders = o; } }
};
