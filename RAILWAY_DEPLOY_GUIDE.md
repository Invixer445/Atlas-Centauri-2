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
`/api/jupiter`, `/api/intel`, `/api/logs`.

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
