# Burst Rider — Pump.fun Bot Sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sandytaztaz-hue/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sandytaztaz-hue/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun style Solana markets, built for make.fun's
"Pump.fun Bot Sprint: Make Bot And Win" bounty. It trades on the house
replay of pump.fun bonding-curve events and is ranked on net PnL.

## Strategy

What the dev replay taught us (24h, 1,222 coins): a fresh coin's whole
life is decided in its first seconds — the median coin peaks ~3 seconds
after its real SOL reserve first reaches 1 SOL, then bleeds for hours.
Momentum chasing after the burst loses, and dip-buying the bleed loses
too. So this bot buys the burst itself:

1. **Buy every fresh coin** the moment its real reserve reaches 1 SOL
   (the first slot a 0.01 SOL buy fits under the 1%-of-reserve cap),
   0.05 SOL, with no momentum filter. Selection happens after entry.
2. **Add into proven runners**: 0.05 SOL per slot while the price stays
   above entry x 1.05 and at least 60% of the last 10 trades are buys,
   up to 1.0 SOL per coin. Size follows the coins that keep running —
   the adds are where the money is made.
3. **Exit on a wide trailing stop** (25% below the peak), a 30% hard
   stop, a "bank" exit (peak 45+ minutes old and price still within 20%
   of it — take the peak instead of waiting for the dump), or a
   600-minute max hold. No tight stops: mid-burst 15% dips are noise,
   and stale-coin exits were tested and destroy value.

Fully deterministic: no clock, no environment, no randomness. Every
decision comes from the harness state delivered per batch.

## Local grading (house grader, dev replay)

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Result on the kit's dev dataset: **+0.162 SOL net PnL, 45 round trips
over 45 coins, max drawdown 15.4%, guardrails met** (12 real-harness
variants were graded; this one won — every tighter exit, wider trail,
shorter hold, or different fresh window scored negative). The PnL is
concentrated in the few coins that run 5–10x — that concentration is
the point: in this market the runners pay for everything else. These
are dev-replay numbers, not judge scores; the judge's score on the
final window exists only after grading.

## Run it

```sh
node main.ts
```

`main.ts` runs on Node 22.18+ (the grader runs Node 22.23.4) with no
dependencies and no build step. It speaks `agent-fun/replay/v2` on
stdin/stdout through the shim in `vendor/makefun-bot.ts` (the kit's own
SDK file, kept out of the authorship counts).

## Grade it locally

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sand72&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>

SPDX-License-Identifier: MIT
