# Deploying ATLAS Lumen to Railway

The README has pointed at this file for a while and it did not exist. This is it.

Everything below is taken from the code, not from memory — where a default is quoted it
is the default `server.js` actually applies.

---

## 0. What this build is

**Paper only, by design.** If broker-authoritative execution is on and the broker
resolves to a LIVE Alpaca endpoint, the process refuses to boot and exits 1:

```
[FATAL] LIVE broker endpoint detected with broker-authoritative execution.
        This build is PAPER-ONLY by design.
```

That check is in `server.js` and is not an env flag away. Use paper keys.

---

## 1. Create the service

1. Push this repo to GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo**.
3. Nothing to configure for the build: `package.json` declares `node >= 18` and
   `npm start` → `node server.js`. Railway injects `PORT`; the server binds it.

---

## 2. Attach a volume — this is not optional

Without one, state is written to the container's working directory, which is **deleted on
every deploy**. The bot then forgets its positions each time you push, re-adopts every
broker position from scratch at boot, and buys a second copy of each.

Railway → service → **Variables/Settings → Volumes → Add volume**. Mount path can be
anything; `/data` is fine.

You do **not** set a variable for this. Railway sets `RAILWAY_VOLUME_MOUNT_PATH`
automatically for any service with a volume attached, and that is what the engine reads.
Setting a path by hand is how you get a path that does not match the mount.

Confirm it worked — the boot log tells you which of these three you got:

```
[STATE] ✅ Durable storage at "/data" (via RAILWAY_VOLUME_MOUNT_PATH) — ...
[STATE] ⚠️  State is being written to the WORKING DIRECTORY, which ... is deleted on every deploy
[STATE] ❌ CANNOT WRITE to "..." — nothing will be remembered across restarts
```

A volume can only be mounted to **one service at a time**. Two ATLAS services cannot
share one.

---

## 3. Variables

### Required

| Variable | Why |
|---|---|
| `APCA_API_KEY_ID` | Alpaca key. Also used for market data — without it the process exits at boot with `[FATAL] Alpaca data keys not set`. |
| `APCA_API_SECRET_KEY` | Alpaca secret. |
| `BROKER=alpaca` | Default is `paper`, an internal acknowledger with no real account. You want `alpaca`. |
| `ALPACA_PAPER=true` | Default is already `true`. Keep it. |
| `ADMIN_TOKEN` | **Set this on any public deployment.** Unset means the state-mutating endpoints (`/api/emergency`, `/api/safemode`, `/api/core/pause`, `/api/aplus`, `/api/retrain`, `/api/reconcile`, `/api/intel/analyze`) are open to anyone who finds the URL. |

### Strongly recommended

| Variable | Why |
|---|---|
| `LIVE_TRADING=true` | Routes orders to the **paper** broker. With `false` the engine runs its full pipeline against an internal ledger and places nothing. |
| `CORE_HOLD_FRACTION` | **Default is `0`, which switches the entire holding side OFF.** The holding side is where this build's measured return comes from. `0.5` is the usual setting; it is a floor, not a target — phase 1 runs at `CORE_PHASE1_FRACTION` (0.97). |
| `GROQ_API_KEY` | Free at console.groq.com. Without it Venus's news/LLM layer is off; 13F and volume research still run. |

### Optional, and what they cost you

| Variable | Default | Notes |
|---|---|---|
| `CORE_BASKET_TARGET_NAMES` | `16` | Measured: median return is flat from k=3 to k=20, median drawdown falls monotonically. Narrowing costs risk and buys nothing. |
| `CORE_BASKET_SOURCE` | `fixed` | `venus` lets the research AI pick the basket. Default is `fixed` on purpose — a proposal is a hypothesis until it beats the control basket on data that arrived after it. |
| `CORE_PHASE1_FRACTION` | `0.97` | Ceiling 0.98. Idle cash costs ~0.48%/yr per percentage point. |
| `TRADING_UNLOCK_PCT` | `0.10` | The phase gate: trading stays locked until the holding side banks this fraction of starting capital. |
| `MERCURY_ENABLED` | `true` | ☿ the forecaster. `false` reverts exits to stop/target only. |
| `MERCURY_MIN_SAMPLES` | `40` | Resolved forecasts a horizon needs before its skill counts at all. |
| `MERCURY_SKILL_FLOOR` | `0.02` | Brier skill score a horizon must clear. Eight models are scored at once, so this is the multiple-testing bar. |
| `ALLOC_SHORT_TARGET` | `0.70` | The 70/30 objective. Ramps with measured skill; `ALLOC_RAMP=off` goes straight there. |
| `GROWTH_SLEEVE_FRACTION` | `0` (off) | ☢️ Puts this share of the core into high-volatility names. `0.70` is the aggressive setting. **Measured: 39% max drawdown, worst month −28%, and roughly a 1-in-15 chance of +20% in any month out of sample.** Read §8 before turning it on. |
| `GROWTH_SLEEVE_NAMES` | `8` | How many. Breadth was measured better on BOTH tails — do not narrow it. |
| `GROWTH_DISASTER_STOP` | `0.35` | Catastrophe exit only. Tighter was measured to cost five-sixths of the return AND deepen the drawdown. |
| `GROWTH_BUDGET_TOLERANCE` | `1.15` | How far the sleeve may drift above its share of invested cash before top-ups stop. Without this the core buys more of whatever is falling. |
| `ALPACA_DATA_FEED` | `iex` | `sip` needs a paid data plan. |
| `WS_MAX_SYMBOLS` | `30` | The free IEX tier's subscription cap. Exceeding it is **all-or-nothing** — the whole stream is rejected and the bot goes dark. |
| `ATLAS_DATA_DIR` | — | Manual override for the state directory. Only needed off Railway. |

---

## 4. Funding: any amount works

Starting capital is **detected from the broker** on the first boot of a fresh account and
then persisted, so it never re-derives against a grown account:

```
[CAPITAL] 📐 Starting capital detected as $10000.00 from the broker — ...
```

Everything scales off that number: the unlock bar is `TRADING_UNLOCK_PCT` of it, the
minimum trading book is 5% of it, the basket narrows to whatever the balance can fund at
$10 a slice and widens again on its own as the account grows. There is nothing to set.

The capital-dependent configuration is printed **after** the broker sync, so the
`[CONFIG] PHASE GATE ON — ... banks $X` line is about your account and not about a
default.

---

## 5. Moving to a different Alpaca account

Swap the keys and redeploy. That is the whole procedure — **do not delete the volume.**

At boot the engine compares the account id in saved state against the live one. If they
differ it discards everything denominated in the old account's money (starting capital,
the benchmark anchor, both drawdown peaks, the vault, the position book, in-flight
orders) and re-derives from the broker:

```
[CAPITAL] 🔁 DIFFERENT BROKER ACCOUNT — saved state belongs to …a1b2c3, this is …d4e5f6.
```

Closed-trade history is kept deliberately: those are market outcomes rather than
balances, and they are the only thing the AIs have ever learned from.

If you *want* a clean slate including the learning history, delete the volume instead.

---

## 6. Verifying a deploy

Boot log, in order:

1. `🌌 ATLAS LUMEN — Unified Engine vX.Y.Z on port ...` — version comes from
   `package.json`, so it cannot drift from what is deployed.
2. `[STATE] ✅ Durable storage ...` — section 2.
3. `🔴 LIVE TRADING ENABLED — broker: alpaca (broker paper)` or `🟢 SIM MODE`.
4. `[CAPITAL] 📐 Starting capital detected ...` — section 4.
5. `[CONFIG] PHASE GATE ON — ...` with your real unlock bar.
6. `[CONFIG] ... core holding 97% now across N names (...)` — if this says
   `core holding OFF`, `CORE_HOLD_FRACTION` is unset and nothing will be bought.

Endpoints: `/` (dashboard), `/api/health`, `/api/portfolio`, `/api/broker`, `/api/venus`,
`/api/jupiter`, `/api/oracle`, `/api/intel`, `/api/logs`.

### Is the forecaster working?

`/api/oracle` answers it in one line. Until a horizon has `MERCURY_MIN_SAMPLES` resolved
forecasts AND a Brier skill score above `MERCURY_SKILL_FLOOR`, it reports

```
no measured skill yet — forecasts are recorded and scored, but multiply out to zero
and cannot move money
```

and that is not a fault: confidence is `support x skill x freshness`, so an unproven
forecaster multiplies every decision to zero and the engine behaves exactly as it did
before. It has to earn the right to spend a dollar, out of sample, on your account's own
data. `node backtest.js --oracle` runs the same measurement over historical bars.

---

## 7. Troubleshooting

| Symptom | Cause |
|---|---|
| `[FATAL] Alpaca data keys not set` | `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` missing. Paper keys work for data. |
| `[FATAL] LIVE broker endpoint detected` | `ALPACA_PAPER=false` with live keys. This build refuses it. |
| `[LOAD] No backup — starting fresh` on every deploy | No volume attached. Section 2. |
| Nothing is ever bought, no errors | `CORE_HOLD_FRACTION` unset (`core holding OFF` in the banner), or the phase gate is shut and trading has no funds yet. |
| Prices never update / no ticks | More than `WS_MAX_SYMBOLS` symbols requested — the IEX subscription is rejected whole. |
| Two services, one volume | Not possible. Railway mounts a volume to one service. |


---

## 8. The growth sleeve — read this before turning it on

`GROWTH_SLEEVE_FRACTION=0.70` puts 70% of the holding side into eight high-volatility
names and leaves 30% in the long-term basket. It exists because **+20% in a month is not
available from the mega-cap basket** — across 60,000 bootstrapped months on real bars it
hit that target zero times, and its 95th-percentile month is +7.4%.

It is available from volatility, and only from volatility. Measured on 480 sessions of
real daily bars, split in half to see what is stable:

| | first half | second half |
|---|---|---|
| chance of +20% in a month | 34% | **6.8%** |
| chance of −20% in a month | 5.0% | **1.8%** |
| annualised return | +217% | **+21%** |
| max drawdown | 39.1% | 37.0% |
| worst single month | −28.4% | −22.5% |

**Believe the second half.** The spectacular numbers are all in the first. A realistic
expectation is roughly a one-in-fifteen chance of hitting +20% in any given month, and a
30–40% drawdown somewhere along the way — about −$3,700 on a $10,000 account.

### What it does NOT do

It does not predict. Forty rules have now been tested in this project and all forty
failed, including — within this exact pool, weekly rebalanced — momentum (+39.7%),
mean-reversion (+40.8%) and most-volatile (+38.3%) against **no selection at all
(+40.4%)**. Picking is indistinguishable from not picking. The sleeve owns eight volatile
things because that is what puts the target within reach; it does not claim to know which
of them will rise.

### Why there is no stop loss

There is only a catastrophe stop, at −35%, and that is a measured decision:

| stop | return | max drawdown |
|---|---|---|
| none | +38.3% | 55.3% |
| −5% | **+7.2%** | **66.4%** |
| −8% | +8.2% | 63.3% |
| −12% | +24.2% | 58.9% |
| −20% | +39.9% | 55.4% |

A tight stop on a 60%-volatility name does not protect anything. It sells at the bottom
of an ordinary session and misses the bounce — costing five-sixths of the return *and*
deepening the drawdown. Only a level far outside normal movement was harmless, which is
what −35% is for: a fraud, a halt, a delisting. A name it retires is replaced from the
rest of the pool.

### Turning it off

`GROWTH_SLEEVE_FRACTION=0`. The next core cycle rebalances back toward the long-term
basket on its own; nothing is force-sold.

### Three things the sleeve does NOT do

**It does not keep buying as it falls.** Sizing against live equity makes it a
rebalancing rule, and a rebalancing rule funds the faller out of trims of the winners —
70% quietly becomes 85% exactly when that is most dangerous. Top-ups stop once the sleeve
holds more than `GROWTH_BUDGET_TOLERANCE` × its share of *invested cost*. Cost basis, not
market value, because market value falls precisely when the risk rises.

**It does not dilute the long-term half.** Venus proposes 16 names for the durable sleeve
and knows nothing about the growth half, so a naive union is 24 names and each long-term
position drops to $182 on a $10,000 account. The union is capped at
`CORE_BASKET_TARGET_NAMES`, and it is always the long-term half that gets trimmed, never
the sleeve.

**It does not trip any risk gate.** Safe mode (10%), the emergency halt (20%), the daily
loss limit, portfolio heat and the consecutive-loss switch are all computed on
`tradableValue()` — total equity *minus* the core. With a 97% core the trading book is a
rounding error, so **all five will report "normal" throughout a 39% drawdown.** That is
correct for a holding meant to be held, and it would be a terrible thing to discover
afterwards. `riskSystem.coreDrawdown` gauges it and the log warns past 5%:

```bash
railway logs | grep "\[RISK\] Holding side"
```

Nothing halts on it. Reacting to a core drawdown is the behaviour this project has
measured losing, repeatedly.
