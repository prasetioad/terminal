import { fetchKlinesBulk } from "../binance";
import { SETUP_A, runSetupA } from "../setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1, scoreTrades, type StochPreset } from "../setups/setupV1";
import type { Candle } from "../types";
import { getPairs } from "./pairs";

/**
 * Setup scanner over every pair: runs a shared setup engine (Setup v1 or Setup A) on
 * each pair's closed 4h bars and reports new entries, open positions and fresh exits.
 * The klines are fetched once per closed 4h bar and shared by every setup and preset;
 * each scan is cached until the next bar closes.
 */

const INTERVAL_MS = 4 * 3_600_000;
/** Enough bars for the warm-up plus ~47 days in which a position can have opened. */
const BARS = 500;
const CONCURRENCY = 4;
/** Binance publishes a closed bar within seconds; wait a little before scanning it. */
const SETTLE_MS = 60_000;
/** 30 days of 4h bars, for the relative strength against BTC. */
const RS_BARS = 180;

export type ScanSetup = "v1" | "a";
export type ScanStatus = "entry" | "open" | "exit";

export interface ScanRow {
  symbol: string;
  base: string;
  rank: number | null;
  /** Price decimals of the pair (its tick size). */
  precision: number;
  status: ScanStatus;
  entryTime: number;
  entryPrice: number;
  /** v1: the −15% stop. A: the exit level now (chandelier trail, never below the initial stop). */
  stopPrice: number;
  /** Close of the last closed bar. */
  lastPrice: number;
  /** Unrealized (entry/open) or realized net of costs (exit). */
  ret: number;
  barsHeld: number;
  exitReason: "signal" | "stop" | "trail" | null;
  /** Whether the trade passes the setup's validated filter (A: volume ≥ 1.5×; v1: always). */
  passes: boolean;
  /** A: last-day volume ÷ 30-day daily average at the entry. */
  surge: number | null;
  /** 30-day return minus BTC's: at the entry for Setup A (its filter), at the last bar for v1. */
  rs30d: number | null;
  /** Quote volume of the last 24 h (six 4h bars), USDT. */
  volume24h: number;
  /** Trailing 30-day average daily quote volume, USDT (the liquidity filter). */
  liquidity30d: number;
  /** The setup's record on this pair over the scanned bars (validated trades only). */
  record: { count: number; winRate: number; avgRet: number };
}

export interface ScanResult {
  setup: ScanSetup;
  stoch: StochPreset;
  /** Open time of the last closed bar scanned (ms). */
  barTime: number;
  scannedAt: number;
  pairs: number;
  failed: number;
  /** Pairs with a fresh (validated) entry on this bar — Setup v1.1 trades only when ≥ SETUP_V1.minBreadth. */
  breadth: number;
  /** Crypto Fear & Greed index (alternative.me), null when unavailable. */
  fearGreed: number | null;
  /** BTC's last daily close relative to its 200-day average (0.05 = 5% above), null when unavailable. */
  btcVs200d: number | null;
  rows: ScanRow[];
}

interface PairInfo {
  symbol: string;
  base: string;
  rank: number | null;
  precision: number;
}

interface BarData {
  barTime: number;
  pairs: number;
  failed: number;
  series: { pair: PairInfo; candles: Candle[] }[];
  btc: Candle[] | null;
  fearGreed: number | null;
  btcVs200d: number | null;
}

let klines: { barTime: number; value: Promise<BarData> } | null = null;
const scans = new Map<string, { barTime: number; value: Promise<ScanResult> }>();

/** Open time of the last 4h bar that has closed (and settled) at `now`. */
export function lastClosedBar(now = Date.now()): number {
  return Math.floor((now - SETTLE_MS) / INTERVAL_MS) * INTERVAL_MS - INTERVAL_MS;
}

export function scanSetup(setup: ScanSetup, stoch: StochPreset): Promise<ScanResult> {
  const barTime = lastClosedBar();
  const key = setup === "v1" ? `v1:${stoch}` : "a";
  const hit = scans.get(key);
  if (hit && hit.barTime === barTime) return hit.value;
  const value = barData(barTime).then((data) => scan(data, setup, stoch));
  scans.set(key, { barTime, value });
  value.catch(() => scans.delete(key)); // a failed scan is retried on the next request
  return value;
}

function barData(barTime: number): Promise<BarData> {
  if (klines && klines.barTime === barTime) return klines.value;
  const value = loadBarData(barTime);
  klines = { barTime, value };
  value.catch(() => {
    if (klines?.value === value) klines = null;
  });
  return value;
}

async function loadBarData(barTime: number): Promise<BarData> {
  const [{ pairs }, fearGreed, btcVs200d] = await Promise.all([getPairs(), fetchFearGreed(), fetchBtcVs200d(barTime)]);
  const series: BarData["series"] = [];
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      const pair = pairs[next++];
      try {
        const all = await fetchKlinesBulk(pair.symbol, "4h", BARS, AbortSignal.timeout(180_000));
        // Closed bars only, up to the bar being scanned: the forming bar would flicker.
        const candles = all.filter((c: Candle) => c.time * 1000 <= barTime);
        if (candles.length < SETUP_V1.warmup + 2 || candles[candles.length - 1].time * 1000 !== barTime) continue;
        series.push({ pair: { symbol: pair.symbol, base: pair.base, rank: pair.rank, precision: pair.precision }, candles });
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const btc = series.find((s) => s.pair.symbol === "BTCUSDT")?.candles ?? null;
  return { barTime, pairs: pairs.length, failed, series, btc, fearGreed, btcVs200d };
}

/** BTC's last closed daily close ÷ its 200-day simple average − 1. */
async function fetchBtcVs200d(barTime: number): Promise<number | null> {
  try {
    const days = await fetchKlinesBulk("BTCUSDT", "1d", 202, AbortSignal.timeout(30_000));
    const closed = days.filter((c) => c.time * 1000 + 86_400_000 <= barTime + INTERVAL_MS).slice(-200);
    if (closed.length < 200) return null;
    const sma = closed.reduce((sum, c) => sum + c.close, 0) / closed.length;
    return closed[closed.length - 1].close / sma - 1;
  } catch {
    return null;
  }
}

async function fetchFearGreed(): Promise<number | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!res.ok) return null;
    const value = Number(((await res.json()) as { data?: { value?: string }[] }).data?.[0]?.value);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const ret30 = (candles: Candle[]) => (candles.length > RS_BARS ? candles[candles.length - 1].close / candles[candles.length - 1 - RS_BARS].close - 1 : null);

function scan(data: BarData, setup: ScanSetup, stoch: StochPreset): ScanResult {
  const btcRet = data.btc ? ret30(data.btc) : null;
  const rows: ScanRow[] = [];
  for (const { pair, candles } of data.series) {
    const own = ret30(candles);
    const rs30d = own === null || btcRet === null ? null : own - btcRet;
    const row = setup === "v1" ? rowV1(pair, candles, stoch, rs30d) : rowA(pair, candles, data.btc);
    if (row) rows.push(row);
  }
  const order: Record<ScanStatus, number> = { entry: 0, exit: 1, open: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || Number(b.passes) - Number(a.passes) || b.volume24h - a.volume24h);
  const breadth = rows.filter((r) => r.status === "entry" && r.passes).length;
  return { setup, stoch, barTime: data.barTime, scannedAt: Date.now(), pairs: data.pairs, failed: data.failed, breadth, fearGreed: data.fearGreed, btcVs200d: data.btcVs200d, rows };
}

interface Position {
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number | null;
  ret: number | null;
}

/** Status of the pair's last trade on the scanned bar: open, opened now, or closed now. */
function status<T extends Position>(open: T | null, last: T | undefined, lastIndex: number): { trade: T; status: ScanStatus } | null {
  if (open) return { trade: open, status: open.entryIndex === lastIndex ? "entry" : "open" };
  if (last && last.exitIndex === lastIndex) return { trade: last, status: "exit" };
  return null;
}

function common(pair: PairInfo, candles: Candle[], rs30d: number | null) {
  const last = candles.length - 1;
  return {
    symbol: pair.symbol,
    base: pair.base,
    rank: pair.rank,
    precision: pair.precision,
    lastPrice: candles[last].close,
    volume24h: candles.slice(-6).reduce((sum, c) => sum + c.volume * c.close, 0),
    liquidity30d: liquidity30d(candles, last, INTERVAL_MS),
    rs30d,
  };
}

function rowV1(pair: PairInfo, candles: Candle[], stoch: StochPreset, rs30d: number | null): ScanRow | null {
  const result = runSetupV1(candles, { stoch, intervalMs: INTERVAL_MS });
  const last = candles.length - 1;
  const hit = status(result.open, result.trades.at(-1), last);
  if (!hit) return null;
  const { trade: t } = hit;
  const base = common(pair, candles, rs30d);
  const score = scoreTrades(result.trades);
  return {
    ...base,
    status: hit.status,
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    stopPrice: t.stopPrice,
    ret: hit.status === "exit" ? (t.ret ?? 0) : base.lastPrice / t.entryPrice - 1,
    barsHeld: last - t.entryIndex,
    exitReason: hit.status === "exit" ? t.exitReason : null,
    passes: true,
    surge: null,
    record: { count: score.count, winRate: score.winRate, avgRet: score.avgRet },
  };
}

function rowA(pair: PairInfo, candles: Candle[], btc: Candle[] | null): ScanRow | null {
  const result = runSetupA(candles, SETUP_A.validatedInterval, { btc: btc ?? undefined });
  const last = candles.length - 1;
  const hit = status(result.open, result.trades.at(-1), last);
  if (!hit) return null;
  const { trade: t } = hit;
  const base = common(pair, candles, t.rs);
  const score = scoreTrades(result.trades.filter((x) => x.passes));
  return {
    ...base,
    status: hit.status,
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    stopPrice: Math.max(t.trail[t.trail.length - 1], t.stopPrice),
    ret: hit.status === "exit" ? (t.ret ?? 0) : base.lastPrice / t.entryPrice - 1,
    barsHeld: last - t.entryIndex,
    exitReason: hit.status === "exit" ? t.exitReason : null,
    passes: t.passes,
    surge: t.surge,
    record: { count: score.count, winRate: score.winRate, avgRet: score.avgRet },
  };
}
