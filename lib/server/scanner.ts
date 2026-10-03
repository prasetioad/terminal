import { fetchKlinesBulk } from "../binance";
import { SETUP_V1, runSetupV1, scoreTrades, type StochPreset } from "../setups/setupV1";
import type { Candle } from "../types";
import { getPairs } from "./pairs";

/**
 * Setup v1 scanner over every pair: runs the shared setup engine on each pair's
 * closed 4h bars and reports new entries, open positions and fresh exits. A scan
 * runs once per closed 4h bar and is cached until the next one closes.
 */

const INTERVAL_MS = SETUP_V1.validatedInterval;
/** Enough bars for the warm-up plus ~47 days in which a position can have opened. */
const BARS = 500;
const CONCURRENCY = 4;
/** Binance publishes a closed bar within seconds; wait a little before scanning it. */
const SETTLE_MS = 60_000;

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
  stopPrice: number;
  /** Close of the last closed bar. */
  lastPrice: number;
  /** Unrealized (entry/open) or realized net of costs (exit). */
  ret: number;
  barsHeld: number;
  exitReason: "signal" | "stop" | null;
  /** Quote volume of the last 24 h (six 4h bars), USDT. */
  volume24h: number;
  /** The setup's record on this pair over the scanned bars. */
  record: { count: number; winRate: number; avgRet: number };
}

export interface ScanResult {
  stoch: StochPreset;
  /** Open time of the last closed bar scanned (ms). */
  barTime: number;
  scannedAt: number;
  pairs: number;
  failed: number;
  rows: ScanRow[];
}

const cache = new Map<StochPreset, { barTime: number; value: Promise<ScanResult> }>();

/** Open time of the last 4h bar that has closed (and settled) at `now`. */
export function lastClosedBar(now = Date.now()): number {
  return Math.floor((now - SETTLE_MS) / INTERVAL_MS) * INTERVAL_MS - INTERVAL_MS;
}

export function scanSetupV1(stoch: StochPreset): Promise<ScanResult> {
  const barTime = lastClosedBar();
  const hit = cache.get(stoch);
  if (hit && hit.barTime === barTime) return hit.value;
  const value = runScan(stoch, barTime);
  cache.set(stoch, { barTime, value });
  value.catch(() => cache.delete(stoch)); // a failed scan is retried on the next request
  return value;
}

async function runScan(stoch: StochPreset, barTime: number): Promise<ScanResult> {
  const { pairs } = await getPairs();
  const rows: ScanRow[] = [];
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
        const row = rowFor(pair, candles, stoch);
        if (row) rows.push(row);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const order: Record<ScanStatus, number> = { entry: 0, exit: 1, open: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.volume24h - a.volume24h);
  return { stoch, barTime, scannedAt: Date.now(), pairs: pairs.length, failed, rows };
}

function rowFor(pair: { symbol: string; base: string; rank: number | null; precision: number }, candles: Candle[], stoch: StochPreset): ScanRow | null {
  const result = runSetupV1(candles, { stoch, intervalMs: INTERVAL_MS });
  const last = candles.length - 1;
  const lastPrice = candles[last].close;
  const volume24h = candles.slice(-6).reduce((sum, c) => sum + c.volume * c.close, 0);
  const score = scoreTrades(result.trades);
  const record = { count: score.count, winRate: score.winRate, avgRet: score.avgRet };
  const base = { symbol: pair.symbol, base: pair.base, rank: pair.rank, precision: pair.precision, lastPrice, volume24h, record };

  if (result.open) {
    const t = result.open;
    return {
      ...base,
      status: t.entryIndex === last ? "entry" : "open",
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      stopPrice: t.stopPrice,
      ret: lastPrice / t.entryPrice - 1,
      barsHeld: last - t.entryIndex,
      exitReason: null,
    };
  }
  const closed = result.trades.at(-1);
  if (closed && closed.exitIndex === last) {
    return {
      ...base,
      status: "exit",
      entryTime: closed.entryTime,
      entryPrice: closed.entryPrice,
      stopPrice: closed.stopPrice,
      ret: closed.ret ?? 0,
      barsHeld: last - closed.entryIndex,
      exitReason: closed.exitReason,
    };
  }
  return null;
}
