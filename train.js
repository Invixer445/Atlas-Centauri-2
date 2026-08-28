#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  ATLAS LUMEN — train.js · Offline specialization trainer  v11.4
//
//  Makes Jupiter and Venus HIGHLY SPECIALIZED by re-training their learning models
//  over the experience they've accumulated. The live bot learns online (one trade at
//  a time); this script replays the whole accumulated dataset over many epochs with
//  a validation hold-out, keeping the best-validation weights — squeezing far more
//  signal out of limited data and producing a sharper, more specialized model.
//
//  WHAT IT TRAINS
//    • Jupiter — the win-probability model (which setups actually win → sizing).
//    • Venus   — the research confidence calibration (per-catalyst + global).
//
//  USAGE
//    node train.js                       train from the live state file, save results
//    node train.js --epochs 30           more passes for BOTH engines
//    node train.js --epochs-jupiter 30    win-model passes only   (default 15)
//    node train.js --epochs-venus 20      calibration passes only (default 12)
//    node train.js --val 0.25            validation hold-out fraction (default 0.2)
//    node train.js --dry                 report only; do NOT write weights back
//    node train.js --seed data.json      bootstrap from an external dataset first
//    node train.js --state path.json     use a specific state file
//    node train.js --help
//
//  SEED DATASET FORMAT (--seed), JSON:
//    {
//      "venus":   [ { "features":[10 numbers ~[-1,1]], "win":1 }, ... ]
//                 // or per-name: { "rvol":0.8, "adx":0.3, ..., "pnl": 12.4 }
//      "jupiter": [ { "conviction":0.82, "catalyst":"earnings", "win":0 }, ... ]
//    }
//    Feature names (order for the array form): jupiterConv, catalystEdge, adx, atr,
//    rvol, rsiAlign, momAlign, session, regimeAlign, spread.
//
//  IMPORTANT: run this while the bot is STOPPED (it rewrites the shared state file).
//  After training, start the bot and it boots with the specialized models.
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const { venus: researchEngine, createJupiter, OnlineLogistic } = require('./server.js');  // the unified engine exposes its brain when imported
// After the Venus/Jupiter role swap: Venus = research/calibration engine (the imported
// singleton), Jupiter = sizing/decision/win-model engine (built fresh via createJupiter —
// no Terra needed here, since trainOffline only consumes the training buffer).
const tradingEngine = createJupiter({ strategy: {} });

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
function flag(name) { return argv.includes(name); }
if (flag('--help') || flag('-h')) {
  // Print the header comment block (everything from line 2 up to the first non-// line)
  // — robust to edits that change the block's length.
  const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
  const header = [];
  for (const l of lines) { if (!l.startsWith('//')) break; header.push(l.replace(/^\/\/ ?/, '')); }
  console.log(header.join('\n'));
  process.exit(0);
}

const STATE_PATH = path.resolve(arg('--state', process.env.STATE_FILE || './atlas-solar-state.json'));
const EPOCHS_JUP = parseInt(arg('--epochs-jupiter', arg('--epochs', '15')), 10);   // Jupiter win-model passes
const EPOCHS_VEN = parseInt(arg('--epochs-venus',   arg('--epochs', '12')), 10);   // Venus calibration passes
const VAL        = parseFloat(arg('--val', '0.2'));
const DRY        = flag('--dry');
const SEED       = arg('--seed', null);

const line = (s = '') => console.log(s);
const hr = () => line('─'.repeat(70));

line('');
line('🎓  ATLAS LUMEN — Offline Specialization Trainer');
hr();

// ── load state ───────────────────────────────────────────────────────────────
let state = {};
if (fs.existsSync(STATE_PATH)) {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { console.error('✖ Could not parse state file:', e.message); process.exit(1); }
  line(`Loaded state: ${STATE_PATH}`);
} else {
  line(`No state file at ${STATE_PATH} — starting from empty models (use --seed to bootstrap).`);
}

// Route each saved block by CONTENT, not key name, so the win-model always reaches the
// trading engine and the calibration always reaches the research engine — robust across
// the Venus/Jupiter role swap and a couple of legacy shapes.
const lumen = state.lumen || {};
const _blocks = [lumen.jupiter, lumen.venus].filter(b => b && typeof b === 'object');
const winModelState = _blocks.find(b => b.winModel || b.trainLog || b.signals)
                    || (state.aiSignals ? { signals: state.aiSignals } : null);
const calibState    = _blocks.find(b => b.calibGlobal || b.calibByCat || b.calibLog || b.calibration)
                    || (state.catalystStats ? { calibration: state.catalystStats } : null);

if (winModelState) tradingEngine.loadState(winModelState);   // Jupiter — win-model/sizing
if (calibState)    researchEngine.loadState(calibState);     // Venus — research calibration

// ── optional seed ingest ─────────────────────────────────────────────────────
if (SEED) {
  if (!fs.existsSync(SEED)) { console.error('✖ Seed file not found:', SEED); process.exit(1); }
  let seed;
  try { seed = JSON.parse(fs.readFileSync(SEED, 'utf8')); }
  catch (e) { console.error('✖ Could not parse seed file:', e.message); process.exit(1); }
  // Role-correct keys (match server.js state): seed.jupiter = trade samples for the
  // win-model; seed.venus = resolved recommendations for research calibration.
  const jAdded = tradingEngine.ingestTrainingData(seed.jupiter || []);
  const vAdded = researchEngine.ingestCalibrationData(seed.venus || []);
  line(`Seeded: ${jAdded} Jupiter (win-model) samples, ${vAdded} Venus (calibration) samples from ${SEED}`);
}

hr();

// ── train Jupiter (win-model / sizing & decision) ────────────────────────────
line('🔭  JUPITER — win-probability model (sizing & decision)');
const jupStats = tradingEngine.getTrainStats();
line(`   accumulated trades: ${jupStats.samples}`);
const jupRes = tradingEngine.trainOffline({ epochs: EPOCHS_JUP, valSplit: VAL });
if (!jupRes.ok) {
  line(`   ⚠ not trained: ${jupRes.reason}`);
} else {
  line(`   trained ${jupRes.samples} samples × ${EPOCHS_JUP} epochs (best epoch ${jupRes.bestEpoch})`);
  line(`   train log-loss: ${jupRes.trainLoss}` + (jupRes.valLoss != null ? `   validation log-loss: ${jupRes.valLoss}` : ''));
  if (jupRes.valAccuracy != null) line(`   validation accuracy: ${jupRes.valAccuracy}%`);
  if (jupRes.overfitWarning) line(`   ⚠ validation loss >> train loss — possible overfitting; consider fewer epochs or more data.`);
  line(`   most predictive factors:`);
  for (const f of jupRes.topFactors) line(`      ${f.weight >= 0 ? '+' : ''}${f.weight}  ${f.name}`);
}

hr();

// ── train Venus (research confidence calibration) ────────────────────────────
line('♀  VENUS — research confidence calibration');
const venStats = researchEngine.getTrainStats();
line(`   accumulated resolved recommendations: ${venStats.calibrationSamples}`);
const venRes = researchEngine.trainOffline({ epochs: EPOCHS_VEN });
if (!venRes.ok) {
  line(`   ⚠ not trained: ${venRes.reason}`);
} else {
  line(`   trained ${venRes.samples} samples × ${EPOCHS_VEN} epochs`);
  line(`   Brier score (calibration error, lower=better): ${venRes.brierBefore} → ${venRes.brierAfter}`);
  line(`   global confidence shift (how it bends a 0.70): ${venRes.globalShift >= 0 ? '+' : ''}${venRes.globalShift}`);
  const cats = Object.entries(venRes.perCatalyst || {});
  if (cats.length) {
    line(`   per-catalyst specialization:`);
    for (const [cat, c] of cats) line(`      ${cat.padEnd(12)} ${c.samples} samples, shift ${c.shift >= 0 ? '+' : ''}${c.shift}`);
  }
}

hr();

// ── persist ──────────────────────────────────────────────────────────────────
if (DRY) {
  line('Dry run (--dry): models NOT written back. Re-run without --dry to save.');
} else if (!jupRes.ok && !venRes.ok) {
  line('Nothing trained — state file left unchanged.');
} else {
  state.lumen = state.lumen || {};
  state.lumen.jupiter = tradingEngine.serialize();    // win-model / sizing / decision
  state.lumen.venus   = researchEngine.serialize();   // research confidence calibration
  try {
    // Atomic write (tmp + rename) — a crash mid-write can never corrupt the live state file.
    const tmp = STATE_PATH + '.train-tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
    line(`✔ Specialized models written back to ${STATE_PATH}`);
    line('  Start the bot and it will boot with the specialized Jupiter + Venus.');
  } catch (e) {
    console.error('✖ Could not write state file:', e.message);
    process.exit(1);
  }
}
line('');
line('Note: more data ⇒ better specialization, but this never guarantees profit.');
line('Validate in the simulator before risking real money. Not financial advice.');
line('');
