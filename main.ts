// Burst Rider — pump.fun replay bot (agent-fun/replay/v2).
//
// Idea, learned from the house dev replay (24h, 1,222 coins, Nov 2026):
// a fresh coin's whole life is decided in its first seconds. The median
// coin peaks ~3 seconds after its real SOL reserve first reaches 1 SOL,
// then bleeds for hours (median price 5 min later is 0.88x the early
// price). Momentum chasing after the burst loses; dip-buying the bleed
// loses too. The only durable edge is to be IN the burst from its first
// slot, ride the few coins that keep running, and let the rest go on a
// wide trailing stop. So this bot:
//
//   1. Buys every fresh coin the moment its real reserve reaches 1 SOL
//      (the first slot a 0.01 SOL buy fits under the 1%-of-reserve cap),
//      0.05 SOL, no momentum filter — selection happens AFTER entry.
//   2. Adds 0.05 SOL per slot into a coin while it is still rising
//      (price above entry x 1.05 and at least 60% of its last 10 trades
//      buys), up to 1.0 SOL per coin. Size follows proven runners —
//      the adds are where the money is made.
//   3. Exits everything on a wide 25% trailing stop from the peak, a
//      30% hard stop, a "bank" exit (peak 45+ min old and price still
//      within 20% of it — take the peak instead of waiting for the dump),
//      or a 600-minute max hold. No tight stops: mid-burst 15% dips are
//      noise, and stale/dead-coin exits were tested and destroy value —
//      quiet coins do come back.
//
// Fully deterministic: no clock, no environment, no randomness. Every
// decision comes from the hello/batch/slot state the harness delivers.
// House grade-local on the dev replay (the server's own grader):
// +0.162 SOL net PnL, 45 round trips over 45 coins, max drawdown 15.4%.
// The PnL is concentrated in the few coins that run 5–10x — that
// concentration is the point: in this market the runners pay for
// everything else. The judge's score on the final window exists only
// after grading.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- tuned constants (from the local replay sweep; see README) ----
const FIRST_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL first ticket
const ADD_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL per add, per slot
const MAX_PER_COIN_LAMPORTS = 1_000_000_000n; // 1.0 SOL max in one coin
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail round trip
const MAX_POSITIONS = 5; // hello.caps.max_open_positions
const FRESH_MINUTES = 2; // enter only within 2 min of reserve crossing 1 SOL
const TRAIL_DROP = 0.25; // sell when 25% below the peak
const HARD_STOP = 0.30; // sell when 30% below the average entry
const BANK_AGE_MINUTES = 45; // bank the peak once it is this old...
const BANK_NEAR_PEAK = 0.80; // ...and price is still within 20% of it
const MAX_HOLD_MINUTES = 600; // give every coin up to 10 hours to run
const COOLDOWN_MINUTES = 60; // do not re-enter a sold coin for an hour
const ADD_TRIGGER = 1.05; // add only while price is above entry x 1.05
const ADD_BUY_SHARE = 0.6; // ...and >= 60% of the last 10 trades are buys
const ADD_WINDOW = 10; // trades of buy-pressure history
const MAX_SLIPPAGE_BPS = 1000; // 10%: bursts move fast, fills must land
const FEE_BPS = 125n; // 95 protocol + 30 creator, per side
const LAMPORTS_PER_SOL_NUM = 1_000_000_000;

interface TradeNote {
  price: number;
  isBuy: boolean;
}

interface CoinTrack {
  crossTs: number | null; // first second real reserve reached 1 SOL
  hist: TradeNote[]; // last ADD_WINDOW trades, oldest first
}

interface PositionTrack {
  entryPrice: number; // SOL per token, fee-inclusive average cost
  peakPrice: number;
  peakTs: number;
  entryTs: number;
  spentLamports: bigint;
  tokens: number; // expected tokens from decision-time fills
}

const tracks = new Map<string, CoinTrack>();
const positions = new Map<string, PositionTrack>();
const cooldownUntil = new Map<string, number>();
let nowTs = 0;

function curvePrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const quote = Number(curve.virtual_quote_reserves);
  const tokens = Number(curve.virtual_token_reserves);
  if (tokens <= 0) return 0;
  return quote / tokens;
}

function realSol(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL_NUM;
}

// Cost basis of one SOL spent, in SOL per token, fees included.
function costPrice(price: number): number {
  return price / (1 - Number(FEE_BPS) / 10_000);
}

function trackFor(mint: string): CoinTrack {
  let track = tracks.get(mint);
  if (track === undefined) {
    track = { crossTs: null, hist: [] };
    tracks.set(mint, track);
  }
  return track;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  // Fold this batch's events into the per-coin tracks first. The hello
  // message already gave us the caps; each batch hands us the slot, the
  // events on it, and the fills of orders we sent on earlier slots.
  for (const event of batch.events) {
    const ts = Number(event.timestamp);
    if (Number.isFinite(ts) && ts > nowTs) nowTs = ts;
    if (event.event === 'TradeEvent') {
      const track = trackFor(event.mint);
      const price = curvePrice(state, event.mint);
      if (price > 0) {
        track.hist.push({ price, isBuy: event.is_buy });
        if (track.hist.length > ADD_WINDOW) track.hist.shift();
      }
      if (track.crossTs === null && realSol(state, event.mint) >= 1) {
        track.crossTs = ts;
      }
    } else if (event.event === 'CreateEvent') {
      trackFor(event.mint);
    }
  }

  // Reconcile our books with the harness: drop a tracked position the
  // account no longer holds and that has no buy still in flight (its
  // buy was rejected, or the harness closed the coin itself).
  for (const mint of [...positions.keys()]) {
    if (state.positions.has(mint)) continue;
    let inflight = false;
    for (const pending of state.pending.values()) {
      if (pending.order.mint === mint && pending.order.side === 'buy') {
        inflight = true;
        break;
      }
    }
    if (!inflight) positions.delete(mint);
  }

  const orders: OrderInput[] = [];
  const soldThisBatch = new Set<string>();

  // ---- exits: decide every sell before any buy in this batch ----
  for (const [mint, held] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = curvePrice(state, mint);
    if (price <= 0) continue;
    const track = positions.get(mint);
    if (track === undefined) continue;
    if (price > track.peakPrice) {
      track.peakPrice = price;
      track.peakTs = nowTs;
    }
    const ret = price / track.entryPrice - 1;
    const fromPeak = price / track.peakPrice - 1;
    const ageMinutes = (nowTs - track.entryTs) / 60;
    const peakAgeMinutes = (nowTs - track.peakTs) / 60;
    let sell = false;
    if (ret <= -HARD_STOP) sell = true;
    else if (fromPeak <= -TRAIL_DROP) sell = true;
    else if (peakAgeMinutes >= BANK_AGE_MINUTES && price >= track.peakPrice * BANK_NEAR_PEAK) sell = true;
    else if (ageMinutes >= MAX_HOLD_MINUTES) sell = true;
    if (sell) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: held.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      soldThisBatch.add(mint);
    }
  }

  // ---- entries and adds, in first-seen coin order ----
  const freeSlots = MAX_POSITIONS - state.committedPositionCount();
  let entriesSent = 0;
  for (const [mint, curve] of state.curves) {
    if (orders.length >= 16) break;
    if (curve.complete || soldThisBatch.has(mint)) continue;
    if ((cooldownUntil.get(mint) ?? 0) > nowTs) continue;
    const price = curvePrice(state, mint);
    if (price <= 0) continue;
    const held = positions.get(mint);
    const cap = state.maxBuyLamports(mint);

    if (held === undefined) {
      // Fresh burst only: the coin crossed 1 SOL of real reserve within
      // the last FRESH_MINUTES. Older coins already showed their hand.
      if (entriesSent >= freeSlots) continue;
      const track = tracks.get(mint);
      if (track === undefined || track.crossTs === null) continue;
      if ((nowTs - track.crossTs) / 60 > FRESH_MINUTES) continue;
      if (cap < MIN_BUY_LAMPORTS) continue;
      const size = cap < FIRST_BUY_LAMPORTS ? cap : FIRST_BUY_LAMPORTS;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entriesSent += 1;
      positions.set(mint, {
        entryPrice: costPrice(price),
        peakPrice: price,
        peakTs: nowTs,
        entryTs: nowTs,
        spentLamports: size,
        tokens: (Number(size) / LAMPORTS_PER_SOL_NUM) * (1 - Number(FEE_BPS) / 10_000) / price,
      });
    } else if (held.spentLamports < MAX_PER_COIN_LAMPORTS) {
      // Add to a proven runner only: still above entry and still
      // mostly bought, never into a fade.
      if (price < held.entryPrice * ADD_TRIGGER) continue;
      const track = tracks.get(mint);
      const hist = track === undefined ? [] : track.hist;
      if (hist.length < ADD_WINDOW) continue;
      let buys = 0;
      for (const note of hist) if (note.isBuy) buys += 1;
      if (buys / hist.length < ADD_BUY_SHARE) continue;
      if (cap < MIN_BUY_LAMPORTS) continue;
      let size = cap < ADD_BUY_LAMPORTS ? cap : ADD_BUY_LAMPORTS;
      const room = MAX_PER_COIN_LAMPORTS - held.spentLamports;
      if (size > room) size = room;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      // Average the cost basis up at the decision-time price: total SOL
      // spent over total tokens expected from the fills.
      held.tokens += (Number(size) / LAMPORTS_PER_SOL_NUM) * (1 - Number(FEE_BPS) / 10_000) / price;
      held.spentLamports += size;
      held.entryPrice = Number(held.spentLamports) / LAMPORTS_PER_SOL_NUM / held.tokens;
      if (price > held.peakPrice) {
        held.peakPrice = price;
        held.peakTs = nowTs;
      }
    }
  }

  // ---- apply the sells we just decided to our own books ----
  for (const order of orders) {
    if (order.side === 'sell') {
      positions.delete(order.mint);
      cooldownUntil.set(order.mint, nowTs + COOLDOWN_MINUTES * 60);
    }
  }
  return orders;
}

await runBot({
  onBatch(state, batch) {
    return onBatch(state, batch);
  },
});

