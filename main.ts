// riidzhsn-bot-sprint: a deterministic paper-trading bot for the
// agent-fun/replay/v2 pump.fun replay (program/v2 style harness).
//
// Wire protocol (newline-delimited JSON):
//   harness -> bot : a hello line, then one batch line per slot, then done
//   bot -> harness : exactly one reply per batch, echoing that batch seq,
//                    carrying the orders decided on that batch
// stdout carries replies only; diagnostics go to stderr.
// Determinism is mandatory (the entry is executed twice and the action
// logs must match byte for byte), so this bot never reads the clock,
// the environment, the network, or Math.random. Every decision is a
// pure function of the hello seed context and the batches seen so far.
//
// Strategy in one paragraph: follow confirmed momentum, never chase a
// vertical spike, and protect capital first. A mint becomes a candidate
// only after several real trades show more buy than sell pressure and a
// moderate price rise from its own recent low. Positions are small and
// diversified so the bot can complete round trips of at least 0.01 SOL
// on at least 20 distinct coins, and every position carries a hard stop
// loss, a take profit, a trailing stop, and a time stop, which together
// keep the maximum drawdown far inside the 50 percent guardrail.

import { createInterface } from "node:readline";

// ---------------------------------------------------------------- types

type U64 = string;

interface HelloMsg {
  type: "hello";
  protocol: string;
  seed: U64;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface AnyEvent {
  event: string;
  mint: string;
  is_buy?: boolean;
  sol_amount?: U64;
  virtual_sol_reserves?: U64;
  virtual_token_reserves?: U64;
  virtual_quote_reserves?: U64;
  real_sol_reserves?: U64;
  real_token_reserves?: U64;
  real_quote_reserves?: U64;
  slot: number;
}

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Position {
  mint: string;
  token_amount: U64;
  cost_lamports: U64;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: AnyEvent[];
  marks: Mark[];
  fills: unknown[];
  account: { cash_lamports: U64; positions: Position[] };
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: U64;
  token_amount?: U64;
  max_slippage_bps: number;
}

// ---------------------------------------------------------------- state

interface MintStats {
  mint: string;
  trades: number;
  buyCount: number;
  sellCount: number;
  buySol: number;
  sellSol: number;
  firstPrice: number;
  lowPrice: number;
  lastPrice: number;
  peakPrice: number;
  realQuote: bigint;
  lastSlot: number;
  createdSlot: number;
  complete: boolean;
  entries: number;
  lastExitSlot: number;
}

interface HeldInfo {
  entrySlot: number;
  peakPrice: number;
}

const stats = new Map<string, MintStats>();
const held = new Map<string, HeldInfo>();
const tradedMints = new Set<string>();
let hello: HelloMsg | null = null;
let orderCounter = 0;
let currentSlot = 0;

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  // SOL per token, scaled only by double precision; ratios are what matter.
  return Number(vQuote) / Number(vToken);
}

function getStats(mint: string, slot: number): MintStats {
  let s = stats.get(mint);
  if (!s) {
    s = {
      mint, trades: 0, buyCount: 0, sellCount: 0, buySol: 0, sellSol: 0,
      firstPrice: 0, lowPrice: 0, lastPrice: 0, peakPrice: 0,
      realQuote: 0n, lastSlot: slot, createdSlot: slot, complete: false,
      entries: 0, lastExitSlot: -1000000,
    };
    stats.set(mint, s);
  }
  return s;
}

function noteReserves(s: MintStats, vQuote: U64 | undefined, vToken: U64 | undefined, slot: number): void {
  if (vQuote === undefined || vToken === undefined) return;
  const p = priceOf(BigInt(vQuote), BigInt(vToken));
  if (p <= 0) return;
  if (s.firstPrice === 0) s.firstPrice = p;
  if (s.lowPrice === 0 || p < s.lowPrice) s.lowPrice = p;
  s.lastPrice = p;
  if (p > s.peakPrice) s.peakPrice = p;
  s.lastSlot = slot;
}

function applyBatch(batch: BatchMsg): void {
  currentSlot = batch.slot;
  for (const m of batch.marks) {
    const s = getStats(m.mint, m.slot);
    s.realQuote = BigInt(m.real_quote_reserves);
    noteReserves(s, m.virtual_quote_reserves, m.virtual_token_reserves, m.slot);
  }
  for (const e of batch.events) {
    const s = getStats(e.mint, e.slot);
    if (e.event === "CreateEvent") {
      s.createdSlot = e.slot;
      noteReserves(s, e.virtual_quote_reserves ?? e.virtual_sol_reserves, e.virtual_token_reserves, e.slot);
    } else if (e.event === "TradeEvent") {
      s.trades += 1;
      const sol = Number(BigInt(e.sol_amount ?? "0")) / 1e9;
      if (e.is_buy) { s.buyCount += 1; s.buySol += sol; } else { s.sellCount += 1; s.sellSol += sol; }
      if (e.real_quote_reserves !== undefined) s.realQuote = BigInt(e.real_quote_reserves);
      else if (e.real_sol_reserves !== undefined) s.realQuote = BigInt(e.real_sol_reserves);
      noteReserves(s, e.virtual_quote_reserves ?? e.virtual_sol_reserves, e.virtual_token_reserves, e.slot);
    } else if (e.event === "CompleteEvent") {
      s.complete = true;
    }
  }
  // Track holding age and peak for positions the account actually holds.
  const live = new Set<string>();
  for (const p of batch.account.positions) {
    if (BigInt(p.token_amount) <= 0n) continue;
    live.add(p.mint);
    const s = getStats(p.mint, batch.slot);
    if (!held.has(p.mint)) held.set(p.mint, { entrySlot: batch.slot, peakPrice: s.lastPrice });
    const h = held.get(p.mint)!;
    if (s.lastPrice > h.peakPrice) h.peakPrice = s.lastPrice;
  }
  for (const mint of [...held.keys()]) {
    if (!live.has(mint)) {
      held.delete(mint);
      const s = stats.get(mint);
      if (s) s.lastExitSlot = batch.slot;
    }
  }
}

// ---------------------------------------------------------------- logic

const MIN_ROUND_TRIP = 12_000_000n; // above the 0.01 SOL round-trip floor
const BASE_SIZE = 35_000_000n; // 0.035 SOL starter size
const MAX_SIZE = 60_000_000n; // 0.06 SOL, still small against 10 SOL capital

function maxBuyFor(s: MintStats): bigint {
  if (!hello || s.complete) return 0n;
  const bps = BigInt(hello.caps.max_order_bps_of_real_reserve);
  return (s.realQuote * bps) / 10000n;
}

function decide(batch: BatchMsg): Order[] {
  const orders: Order[] = [];
  if (!hello) return orders;
  const maxOrders = hello.caps.max_orders_per_batch;
  const cash = BigInt(batch.account.cash_lamports);
  const positions = batch.account.positions.filter((p) => BigInt(p.token_amount) > 0n);
  const heldMints = new Set(positions.map((p) => p.mint));

  // --- exits first: capital protection before any new risk -------------
  for (const p of positions) {
    if (orders.length >= maxOrders) break;
    const s = stats.get(p.mint);
    if (!s || s.lastPrice <= 0) continue;
    const tokens = BigInt(p.token_amount);
    const cost = BigInt(p.cost_lamports);
    if (tokens <= 0n || cost <= 0n) continue;
    // Current value estimate from the latest curve price.
    const valueNow = s.lastPrice * Number(tokens);
    const costPerToken = Number(cost) / Number(tokens);
    const pnl = costPerToken > 0 ? s.lastPrice / costPerToken - 1 : 0;
    const h = held.get(p.mint);
    const age = h ? batch.slot - h.entrySlot : 0;
    const peak = h && h.peakPrice > 0 ? h.peakPrice : s.peakPrice;
    const offPeak = peak > 0 ? s.lastPrice / peak - 1 : 0;

    let sell = false;
    if (s.complete) sell = true; // curve finished: leave with everyone else
    else if (pnl <= -0.18) sell = true; // hard stop loss
    else if (pnl >= 0.35) sell = true; // take profit
    else if (pnl >= 0.12 && offPeak <= -0.12) sell = true; // trailing stop
    else if (age > 2400 && pnl < 0.05) sell = true; // stale position time stop
    else if (age > 6000) sell = true; // absolute maximum hold
    else if (valueNow > 0 && pnl <= -0.10 && s.sellSol > s.buySol * 1.6 && s.trades >= 8) sell = true; // sellers took over

    if (sell) {
      orderCounter += 1;
      orders.push({
        side: "sell", client_id: `s${orderCounter}`, mint: p.mint,
        token_amount: tokens.toString(), max_slippage_bps: 900,
      });
    }
  }

  // --- entries: confirmed momentum, moderate rise, real liquidity -----
  const openSlots = hello.caps.max_open_positions - heldMints.size;
  if (openSlots <= 0) return orders;
  // Until 20 distinct coins have been traded, trade a little more freely
  // (smaller confirmation bar) so the breadth guardrail is met early;
  // afterwards stay selective, because fees punish churn.
  const breadthDone = tradedMints.size >= 24;
  const minTrades = breadthDone ? 8 : 5;
  const candidates: { s: MintStats; score: number }[] = [];
  for (const s of stats.values()) {
    if (s.complete || heldMints.has(s.mint)) continue;
    if (s.trades < minTrades || s.lastPrice <= 0 || s.lowPrice <= 0) continue;
    if (batch.slot - s.lastExitSlot < 900 && s.entries > 0) continue; // cooldown
    if (batch.slot - s.lastSlot > 300) continue; // gone quiet
    const rise = s.lastPrice / s.lowPrice - 1;
    if (rise < 0.04 || rise > 0.55) continue; // want momentum, not a spike top
    const flow = s.buySol + s.sellSol;
    if (flow <= 0) continue;
    const buyShare = s.buySol / flow;
    if (buyShare < 0.58) continue;
    if (s.realQuote < 1_500_000_000n) continue; // under ~1.5 SOL of real reserve: too thin
    if (maxBuyFor(s) < MIN_ROUND_TRIP) continue; // order would breach the size cap
    const score = rise * 2 + (buyShare - 0.5) * 1.5 + Math.min(s.trades, 40) / 100;
    candidates.push({ s, score });
  }
  // Deterministic order: score descending, mint ascending as the tiebreak.
  candidates.sort((a, b) => (b.score - a.score) || (a.s.mint < b.s.mint ? -1 : a.s.mint > b.s.mint ? 1 : 0));

  let spent = 0n;
  let newEntries = 0;
  for (const { s, score } of candidates) {
    if (orders.length >= maxOrders) break;
    if (newEntries >= openSlots) break;
    // Keep at least 25 percent of the starting capital in reserve.
    const budget = cash - spent - 2_500_000_000n;
    if (budget < MIN_ROUND_TRIP) break;
    let size = BASE_SIZE + BigInt(Math.floor(Math.max(0, Math.min(score, 1)) * 25_000_000));
    if (size > MAX_SIZE) size = MAX_SIZE;
    const cap = (maxBuyFor(s) * 9n) / 10n; // stay inside the per-mint size cap
    if (size > cap) size = cap;
    if (size > budget) size = budget;
    if (size < MIN_ROUND_TRIP) continue;
    orderCounter += 1;
    orders.push({
      side: "buy", client_id: `b${orderCounter}`, mint: s.mint,
      quote_lamports: size.toString(), max_slippage_bps: 700,
    });
    spent += size;
    s.entries += 1;
    tradedMints.add(s.mint);
    newEntries += 1;
  }
  return orders;
}

// ---------------------------------------------------------------- main

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (trimmed === "") continue;
  let msg: { type?: string };
  try { msg = JSON.parse(trimmed); } catch { continue; }
  if (msg.type === "hello") {
    hello = msg as unknown as HelloMsg;
  } else if (msg.type === "batch") {
    const batch = msg as unknown as BatchMsg;
    applyBatch(batch);
    const orders = decide(batch);
    process.stdout.write(JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n");
  } else if (msg.type === "done") {
    break;
  }
}
