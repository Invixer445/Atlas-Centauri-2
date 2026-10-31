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
| `CORE_HOLD_FRACTION` | **Default is `0`, which switches the entire holding side OFF.** The holding side is where this build's measured return comes from. `0.5` is the usual setting; it is a floor, not a target — phase 1 runs at `CORE_PHASE1_FRACTION` (0.98). |
| `GROQ_API_KEY` | Free at console.groq.com. Without it Venus's news/LLM layer is off; 13F and volume research still run. |

### Optional, and what they cost you

| Variable | Default | Notes |
|---|---|---|
| `CORE_BASKET_TARGET_NAMES` | `16` | Measured: median return is flat from k=3 to k=20, median drawdown falls monotonically. Narrowing costs risk and buys nothing. |
| `CORE_BASKET_SOURCE` | `fixed` | `venus` lets the research AI pick the basket. Default is `fixed` on purpose — a proposal is a hypothesis until it beats the control basket on data that arrived after it. |
| `CORE_PHASE1_FRACTION` | `0.98` | Ceiling 0.98 (the engine needs working cash). Each percentage point of idle cash costs **$2.40–$3.20/month on $10,000**. |
| `PROFIT_FLOOR_PCT` | `0` (off) | ☢️ Holds part of your gain out of the market once you are up this much. **Measured to lose $9–$42/month and to reduce red days by nothing.** See §9. |
| `PROFIT_FLOOR_KEEP` | `0.5` | Share of the gain above the line to hold back. |
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


---

## 9. Banking profit — why the floor is off

`PROFIT_FLOOR_PCT` exists because protecting a gain is a reasonable *preference*. It is
off by default because it is a measured *cost*.

Banking profit into cash was tested fifteen ways, on two datasets, across four independent
half-windows. **It lost money in every half.** On $10,000:

| scheme | cost per month | per year |
|---|---|---|
| bank 25% of each new high | −$9 to −$11 | ~$120 |
| bank 50% of each new high | −$17 to −$22 | ~$235 |
| bank 100% of each new high | −$32 to −$42 | ~$450 |
| bank $50 every +$50 | −$22 to −$26 | ~$290 |

And it buys no safety. The share of **red days was identical — 44.9% — at every setting**,
the same as never banking. It does not reduce how often you are down; it reduces how much
you own when you are up.

The loss is arithmetic, not timing. Average cash parked, times the basket's 21.6% drift,
predicts 83% of the shortfall on its own:

| scheme | avg cash idle | predicted cost | actual cost |
|---|---|---|---|
| bank 25% | $409 | −$7.38/mo | −$8.88/mo |
| bank 50% | $796 | −$14.36/mo | −$17.18/mo |
| bank 100% | $1,537 | −$27.74/mo | −$32.37/mo |

Re-investing rather than holding cash was also tested — into the three calmest names, back
across the basket. All of it flipped sign between halves (−$2.01, then +$6.29). **There is
no free way to protect a gain.** "Banking profit" and "staying invested" are the same dial.

What *does* work is already running: the **12% trim band** sells anything that runs past
its target weight and redeploys into the laggards. That scored the best risk-adjusted
number of anything tested (1.59 vs 1.44 for no trimming), and forcing a quarterly or
monthly rebalance on top of it changed nothing.

If you turn the floor on anyway, the boot log prints the cost every time:

```bash
railway logs | grep "\[FLOOR\]"
```

And `[PROFIT]` reports your gain, your peak and how much is being held back, on every
digest, whether the floor is on or off.

---

## 10. Mark 15 — the configuration for a new account

Every value below is read by the code, checked name-by-name against `server.js`. That
check matters: a misspelled variable is silently ignored. The test suite itself was
caught setting `PHASE_GATE` — a name nothing reads — instead of `PHASE_GATE_ENABLED`,
and passed only because the gate defaults to on.

### The variables

```bash
# ── broker: a NEW paper account ─────────────────────────────────────────────
APCA_API_KEY_ID=<new paper key>
APCA_API_SECRET_KEY=<new paper secret>
BROKER=alpaca
ALPACA_PAPER=true
LIVE_TRADING=true           # routes orders to the PAPER broker; live endpoints are refused at boot
ALPACA_DATA_FEED=iex
ATLAS_DATA_DIR=/data/acct3  # ONLY when starting a new account; see below
ADMIN_TOKEN=<any long random string>

# ── the core: two indexes and T-bills (15.82; was QLD/BIL, see "Why this shape") ─
CORE_HOLD_FRACTION=0.9
CORE_BASKET_SOURCE=fixed
CORE_HOLD_SYMBOLS=QQQ,SPY,BIL
CORE_WEIGHTS=QQQ:0.40,SPY:0.40,BIL:0.20

# ── crash protection ────────────────────────────────────────────────────────
REGIME_SHIELD=on            # slow bear markets: the 200-day trend
REGIME_SHIELD_DAYS=200
REGIME_SHIELD_FLOOR=0.30
CORE_VOL_SCALING=on         # fast crashes: cut the sleeve when it runs hotter than normal (15.81)

# ── AI pointed at prices: off (zero measured skill, see Mark 14) ────────────
MERCURY_ENABLED=false

# ── gates: unchanged ────────────────────────────────────────────────────────
PHASE_GATE_ENABLED=true
TRADING_UNLOCK_PCT=0.10
TRADING_RECORD_GATE=on
BASKET_CHALLENGER=on
BASKET_CHALLENGER_AUTO=off

# ── measurement: on ─────────────────────────────────────────────────────────
ATLAS_AUDITOR=on
RISK_PROFILE=on
RISK_FREE_PROXY=BIL
```

`REGIME_SHIELD_SKIP_DEFENSIVE` (Mark 14) is retired — delete it if you set it. Nothing
reads it any more.

**`ATLAS_DATA_DIR`: change it once, when the ACCOUNT changes — never mid-account.** Any
path works as long as it is fresh for the new account (a wiped volume does the same job).
Changing it on a running account starts state from scratch, and the engine re-detects
starting capital from whatever the balance is that minute — which moves the phase-gate
bar and every "since inception" figure. To switch an EXISTING account to this config,
change only the core and Mercury variables and leave `ATLAS_DATA_DIR` alone: the old
holdings are off-basket, get a target of zero, and are trimmed out on the next
market-hours cycle while the top-up buys the new basket with the proceeds.

### Why this shape

An investor holds **one** risky portfolio and sets their risk level by mixing it with
the risk-free asset: the Capital Allocation Line. Here the risky portfolio is half
Nasdaq-100 (`QQQ`), half S&P 500 (`SPY`); `BIL` (1–3 month T-bills) is the risk-free
asset. When the shield goes risk-off, the core moves along that line: the two indexes
keep 30% of their weight and the rest shifts **into BIL**. The core stays fully invested.

**The mix is also dynamic, in one direction only (15.81).** Each day the index sleeve
keeps `min(1, its normal volatility ÷ its 20-day volatility now)` of its weight, and the
rest goes to BIL. At or below normal it does nothing. It can never raise the weight: the
version that could earned more in-sample and lost out of sample.

**Why not QLD/BIL any more (15.82).** Mark 15.80 held `QLD` (2× the Nasdaq-100) at 35%
beside 65% `BIL`. That was a mistake, for two reasons:

- **It borrowed and lent the same money.** A 2× fund gets its second 1× by borrowing
  inside the fund, at about the T-bill rate plus 1.6%/yr (measured 2006–2026). Holding
  T-bills beside it lends that money straight back at the T-bill rate. `QQQ` at 70% is
  the same exposure with no loan. The auditor now flags this as `LEVERAGE_BESIDE_CASH`.
- **The Nasdaq-100 on its own is one bet,** and Mark 15 was chosen on 2007–2026. That was
  the Nasdaq's best era, and it began *after* its worst crash: −83% in 2000–02.

Rebuilt back to 1986 with synthetic QLD and BIL calibrated against the real funds (daily
correlation 0.996). 1986–2006 is a true out-of-sample test: none of it was looked at when
Mark 15 was set. Shield and volatility scaling on, 2bp a side:

| 1986–2026 | QLD 35 / BIL 65 (15.80) | **QQQ 40 / SPY 40 / BIL 20** | QQQ 35 / SPY 35 / BIL 30 |
|---|---|---|---|
| return per year | 9.5% | **9.4%** | 8.7% |
| worst drawdown | 28.6% (Oct 2002) | **22.9%** | 19.0% |
| worst 12 months | −16.8% | **−13.7%** | −11.4% |
| longest below a high | 5.4 years | **3.9 years** | 3.5 years |
| Sharpe, 1986–2006 / 2006–2026 | 0.52 / 0.80 | **0.57 / 0.79** | 0.57 / 0.80 |
| dot-com, 2000–02 | −28.5% | **−22.7%** | −18.9% |
| 2008 / COVID / 2022 | −10.2 / −7.4 / −11.1% | −11.0 / −7.9 / −9.8% | −9.4 / −6.9 / −8.6% |

The middle column keeps 15.80's return with a smaller worst case. The right-hand column is
the lower-risk setting: every crash smaller than 15.80, for about 0.7%/yr less.

**Both protections held up on the 20 years they never saw.** On 1986–2006 the shield took
the recommended core's worst fall from 58.9% to 29.8%, and volatility scaling took it to
22.9%. But be clear about what volatility scaling is: **insurance**. It improved Sharpe only
in the era it was found in. Over 40 years, return per unit of risk is the same with or
without it (0.67). What it buys is a worst 12 months of −13.7% instead of −22.0%, for about
1.4%/yr.

These figures include the 2009–2021 zero-rate era, when T-bills paid ~0%. Pre-1993 S&P
and pre-1999 Nasdaq returns are the index plus an estimated dividend (3.3% and 0.7%/yr).

**Up days do not move.** They sit at ~56% for every mix: no blend of equities and T-bills
changes how often a day is green, only how large the red days are. Up *months* and up
*years* move. Check monthly.

**SHY is no longer treated as cash (15.82).** It holds 1–3 year notes, duration ~1.9. It
lost 3.9% in 2022 while BIL gained 1.4%: the one year bonds fell with stocks. If you set
`CASH_EQUIVALENTS` yourself, keep it to T-bill and floating-rate funds.

**The basket challenger's bar is t ≥ 3 (15.82).** It re-reads the same t-statistic every
day, and with no real edge t ≥ 2 shows up by luck 16% of the time within three years. At 3
that falls to about 2%.

### Verifying

```
[CORE] ⚖️  Explicit weights in force: QQQ 40% · SPY 40% · BIL 20%
[SHIELD] 🛡  Regime shield ON — ... the core keeps 30% of its risky weight and moves the rest INTO its T-bills
[VOL] 🌡  Volatility scaling ON (cut-only) — ... Active.
[VOL] 🌡  QQQ+SPY 20-day volatility N% against a normal M% — ...
[RISK] 📐 QQQ 40% · SPY 40% · BIL 20% over N sessions ... 1-day VaR95 is -$...
[RISK] 📐 Pain: worst fall N%, worst 12 months -N%, longest below a high N sessions. Sortino N, Calmar N. ...
[AUDIT] 🔍 Mark 14 auditor ON — ...
```

If the auditor prints `LEVERAGE_BESIDE_CASH`, the core still holds a leveraged fund beside
T-bills. It names the unlevered swap; change `CORE_HOLD_SYMBOLS` and `CORE_WEIGHTS` to it.

`/api/risk` answers "is a loss this size normal?" in dollars. `/api/audit` answers "is the
machine misbehaving?". Those two, not the balance, are what to check.

### One thing that will look wrong and isn't

BIL pays its yield as a **monthly cash distribution**. On each ex-date its price drops by
that amount, so Alpaca's per-position P/L for BIL will hover near $0 and dip monthly —
while the cash balance rises by the same amount. Judge the account total, not BIL's row.
