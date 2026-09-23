# 🌌 ATLAS LUMEN

*(The running version comes from `package.json` and is printed in the boot banner —
this file deliberately does not restate it, because it was stuck at v11.18 for 46 releases.)*

A news-intelligent, two-engine adaptive day-trading bot for **US equities (NASDAQ + NYSE)**. Lumen = ATLAS Solar + a two-engine AI architecture (a researcher that scans the web/13F/news and a trader that sizes, acts, and learns) + a volatility-normalized strategy rewrite.

- 🌍 **Terra** — the **execution engine** (the part of the unified `server.js` dedicated to carrying out Venus & Jupiter's decisions: order routing, fills, position lifecycle, strategy gate, full risk pipeline). Its supporting infrastructure (market-data feed, indicators, persistence, dashboard server) lives alongside it

**How a trade flows (decide → validate → execute).** The feed reaches the brain first:
Venus analyzes the news and Jupiter scores and **sizes** the setup, producing a complete
**trade plan** — direction, size, and the **stop loss + target the trade must achieve**.
That plan goes to **Terra's gate**, which validates it against the rules — stop loss present
and sane, reward:risk ≥ minimum, stock within price limits, and the full risk pipeline
(cooldown, gap, heat, sector, capital). Terra **rejects** anything that breaks a rule
(visible at `/api/portfolio` → `terra.recentRejections`) and **executes** the rest, opening
each position with its validated stop. No trade opens without a stop loss.
- ♀ **Venus** (in `server.js`) — research **AI**: **scans the web** — SEC EDGAR **13F institutional holdings** (what large funds hold/accumulate), live **news** catalysts (via an LLM), and real-time **relative volume** — and analyzes it into a ranked **watchlist** with per-symbol ideas (what to watch, direction, why). A real online **calibration model** keeps its confidence empirically honest over time
- ☿ **Mercury** (in `server.js`) — the **forecaster**: continuous multi-horizon (30m/1d/1w/1mo) probability-and-magnitude forecasts for every watched symbol, scored against its own resolved predictions. Its confidence is `sample support x measured Brier skill x data freshness`, so it cannot influence an order until it has demonstrated skill out of sample — and if it never does, the engine keeps doing what measurably works
- 🔭 **Jupiter** (in `server.js`) — trading **AI**: a real online **win-probability model** (logistic regression) trained on every closed trade learns which conditions predict winners and uses it to size & steer trades; reports back to Venus via a direct zero-latency call
- 🌙 **Luna** (`dashboard.html`) — the live dashboard for both engines
- **broker.js** — execution adapter (Alpaca / paper) for real-money trading

**The loop:** Venus researches (SEC 13F institutional holdings + news + relative volume) → analyzes → tells Jupiter what to trade → Jupiter trades, its win-model learns, and it reports the outcome back (a direct in-process call, ~microseconds) → Venus recalibrates → all of it streams to Luna. Both engines also reason with an LLM each cycle — Venus forms a market posture and Jupiter runs a self-check that can scale risk down or pause entries — always bounded so they can only get *more* cautious, never exceed the hard risk caps or Terra's gate. v11.6 hardened the whole engine: process-level crash safety nets (a stray async error can no longer kill the bot — state is saved and the supervisor restarts it clean), an optional `ADMIN_TOKEN` protecting the state-mutating API endpoints on public deployments, staleness rules on *both* engines' reasoning, and a full-codebase bug audit (8 findings fixed). v11.7 fixes 7 external-audit findings plus a deeper conviction-scale bug that could nudge the entry scorer in the wrong direction. v11.8 fixed leftover swapped env var names for the learning models. v11.9 adds a built-in `.env` loader (no more manual `export` needed) and corrects `/api/health`'s field naming so you can actually verify each engine's AI status. v11.10 adds Mac-friendly fallback filenames (`env.local`/`env.txt`) for anyone whose Finder/TextEdit refuses to save a file named `.env`. v11.11–v11.12 tighten the WS keepalive and add one-click Emergency Stop / A+ Mode toggles (plus an admin-token field) to Luna. v11.13 fixes a third external audit's findings — most importantly the daily loss limit now scales with live equity instead of being frozen at starting capital. v11.14 fixes a gap-handling bug where a symbol that gapped ≥3% at the open stayed unsizeable all session even after its 30-minute block expired — it now settles to half size — and un-inverts the dashboard's Venus/Jupiter element IDs. v11.15 fixes the cold-start deadlock found on the first live paper day — Jupiter's self-check zeroed all sizing because "0% over 0 trades" read as failure instead of absence of data; sizing is now floored (×0.5 cold start, ×0.25 with a record) and hold requires real evidence — plus a regular-trading-hours gate at Terra itself and honest "10000+" capped 13F counts. v11.16 fixes the Groq rate-limit death loop (batch cap + shared cooldown + a decoupled intel cycle so one failed call can't kill research/assess/deliberate), recalibrates the volatility halt to a median-from-open measure, and stops overnight-gap blocks from re-arming off a sliding candle buffer. v11.17 fixes the strategy engine re-smoothing its win-rate EMA every 10-second tick instead of once per closed trade (three early losses had decayed the display to 0.0% and pinned aggression to the floor within minutes), adds a weak-evidence floor and sample-size display, and adds a manual Safe Mode button whose activation the automatic recovery cannot silently clear. v11.18 ships LUMEN INTEGRATED: broker-authoritative execution where Alpaca's paper engine is the source of truth — pending-order lifecycle, positions booked at real fills, Luna mirroring the broker with a drift indicator, and a hard paper-only boot refusal. Both engines are backed by real online-learning models (the ML toolkit lives in the same unified engine (`server.js`)) that sharpen the longer the bot runs and persist across restarts. Venus, Jupiter, and the ML toolkit are unified into a single cohesive engine (`server.js`) — one require, one module scope, zero indirection between the two AIs.

*This narrative stops at v11.18 and the repo is well past it — `git log` is the authoritative history. Every release since carries its reasoning in the commit message and in the comment block beside the code it changed.*

> **Default mode is a paper-trading simulator.** It models slippage, spread, market
> impact, partial fills, margin and borrow fees against live market prices but does
> **not** place real orders unless you explicitly enable live trading.
> This build is paper-only by design: broker-authoritative execution against a LIVE
> Alpaca endpoint is refused at boot and the process exits. See
> **`RAILWAY_DEPLOY_GUIDE.md`** to deploy it.

## Core capabilities

| Layer | What it does |
|-------|--------------|
| **Capital management** | Splits equity into a protected reserve (30%), an active trading pool (70%), and a locked profit vault |
| **Constant dollar-risk sizing** | Each trade risks **1.5% of the trading pool (3% hard cap)** as true dollar-risk — shares = (equity × risk%) ÷ (ATR stop distance) — with a ¼-Kelly overlay from measured edge |
| **EMA + RSI strategy gate** | Explicit EMA(9/21) crossover + RSI(14) entry rules, layered as a hard filter on a 7-factor weighted score |
| **Projected-heat gate** | Rejects a trade if it would push total exposure past 50% |
| **Regime detection** | Adapts aggression to bull / bear / choppy / high-volatility markets (breadth + SPY momentum + candle uptick ratio) |
| **Real candle data** | True ATR, RVOL, and multi-timeframe trend from 1m/5m OHLCV bars |
| **ADX regime filter** | Trend-follows when ADX shows a real trend, switches to mean-reversion (fades extremes) when the tape is ranging |
| **Overnight gap handling** | Halves size on 1.5%+ gaps, blocks entries for 30 min on 3%+ gaps |
| **ATR-anchored exits** | Stop at −2.2×ATR, targets at ~4.6×ATR (≥1.8:1 reward:risk enforced), trailing at peak −2×ATR; winners ride the trail with no fixed cap |
| **Realistic execution** | Slippage, dynamic spread (widens on ATR spikes), square-root market impact, probabilistic partial fills |
| **Stop-loss cooldowns** | Blocks revenge-trading with escalating per-symbol cooldowns |
| **Adaptive learning** | EWMA win rate + per-regime / per-setup / per-symbol analytics resist overfitting |
| **Profit vaulting** | Locks away 30% of profit on every +10% growth milestone |
| **Safe mode / emergency stop** | Auto-defends at 10% drawdown, halts entries at 20%; kill switches for disconnects, stale data, loss streaks, extreme volatility |
| **Live execution (optional)** | Routes risk-approved orders to Alpaca (paper or live); accepts TradingView webhook alerts |

## Quick start (local — simulator)

```bash
npm install
APCA_API_KEY_ID=... APCA_API_SECRET_KEY=... npm start
```

Open `http://localhost:3000` for the Luna dashboard. You should see `🟢 SIM MODE` in
the logs — no real orders are possible in this mode.

## Endpoints

- `/` — Luna dashboard
- `GET  /api/portfolio` — full state: cash, positions, P&L, regime, analytics, **gap alerts**, **uptick ratio**
- `GET  /api/logs` — recent trade log (last 200 lines)
- `GET  /api/health` — heartbeat: WS status, market, version, mode, broker, engines
- `GET  /api/venus` — analysis engine: provider, per-catalyst calibration, recent learnings
- `GET  /api/jupiter` — trading engine: live signals, measured edge, dynamic watchlist
- `GET  /api/oracle` — ☿ Mercury: multi-horizon forecasts, out-of-sample Brier skill score, allocation and preservation state
- `GET  /api/broker` — broker status, account, positions, recent live orders
- `POST /api/aplus?enable=true|false` — toggle A+ mode (top ~10% signals only)
- `POST /api/emergency?stop=true|false` — emergency halt / resume
- `GET  /api/intel` — the AIs' current reasoning, posture and self-check
- `POST /api/reconcile` — compare ATLAS's book to the broker's real positions (live mode)
- `POST /api/safemode?enable=true|false` — manual Safe Mode (auto-recovery cannot clear it)
- `POST /api/core/pause?pause=true|false` — halt the core holding without halting the engine
- `POST /api/retrain` — retrain Jupiter's win model from closed trades
- `POST /api/intel/analyze` — force an out-of-cycle research pass
- `POST /api/tradingview-webhook` — receive TradingView alerts (secret-gated)

All `POST` routes above are gated by `ADMIN_TOKEN` when it is set. Set it.

## Execution modes (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_TRADING` | `false` | `true` routes real orders through the broker (after risk checks) |
| `AUTONOMOUS_TRADING` | `true` | `false` = pure executor; entries come only from TradingView |
| `BROKER` | `paper` | `alpaca` for real execution (paper or live by `ALPACA_PAPER`) |
| `STRATEGY_GATE` | `on` | EMA(9/21)+RSI(14)+ADX hard entry filter |
| `MEAN_REVERSION` | `on` | Fade extremes when ADX says the market is ranging |
| `EARNINGS_BLACKOUT` | `off` | Blackout around earnings. Off by default — the built-in calendar holds placeholder dates; populate real ones first |

See `.env.example` for the full list.

## Deploy

See **`RAILWAY_DEPLOY_GUIDE.md`** for the full walkthrough (env vars, the `ADMIN_TOKEN`
security step, persistent volumes, troubleshooting). In short: push to GitHub, create a
Railway project, set Alpaca + Groq keys and `ADMIN_TOKEN` in Railway's Variables tab, and
it runs `npm start` automatically. For live trading, use a host near US-east for lower
latency.

## Files

```
server.js          THE UNIFIED ENGINE — three subsystems in one program:
                     ♀ Venus (research AI: web + SEC 13F + news → watchlist)
                     🔭 Jupiter  (trading AI: online win-probability model + sizing)
                     🌍 Terra  (execution engine: order routing, fills, position
                                lifecycle, strategy gate, full risk pipeline)
                   When imported (e.g. by train.js or test.js) it exposes the brain
                   WITHOUT booting the engine. Run directly to boot: `node server.js`.
broker.js          Alpaca + paper execution adapter (the pluggable broker "driver"
                   Terra routes orders through; kept separate as the money boundary)
dashboard.html     Luna — the live dashboard
test.js            Regression suite, zero dependencies: `npm test`

train.js           Offline specialization trainer (CLI) — `node train.js --help`
train-model.js     Batch trainer for Jupiter's win-probability model
backtest.js        Historical replay harness
edge-scan.js       Sweeps candidate rules and reports measured edge
edge-research.js   Deeper follow-up on whatever edge-scan surfaced
edge-register.json Every edge that has been tested, and how it did
hold-optimize.js   Basket-size / holding-period measurement
score-basket.js    Scores a proposed basket against the control
quality-scan.js    Source-quality and consistency scan
anomaly-test.js    Anomaly checks on the state file
trend-test.js      Trend-filter measurement
project.js         Block-bootstrap projections

package.json       dependencies (express, ws) + `npm start` / `npm test`
.env.example       every environment variable
RAILWAY_DEPLOY_GUIDE.md   cloud deploy (env vars, ADMIN_TOKEN, volumes, changing account)
```

Runtime state (`atlas-solar-state.json`) and secrets (`env.local`) are gitignored on
purpose — see `RAILWAY_DEPLOY_GUIDE.md` §2 for where state should actually live.
