import { KLINE_INTERVALS, fetchKlineRange, type KlineInterval } from "../binance";
import type { Candle } from "../types";

/**
 * Candles for range profiles, independent of the chart's timeframe.
 *
 * A profile built from the chart's own bars changes with the timeframe: coarser bars
 * spread their volume over a wider high–low, and the chart only holds its latest
 * ~1,000 bars, so a range can be partly empty on 1m yet complete on 5m. Profiles
 * instead read Binance klines at a resolution picked from the range's length alone
 * (the finest giving ≤ MAX_BARS bars), so the same range gives the same profile on
 * every timeframe.
 *
 * Klines are fetched and cached in aligned chunks of CHUNK_BARS, so resizing or
 * moving a range only loads the chunks it newly touches. A chunk last fetched before
 * it had closed (it holds "now", or did then) is refreshed while it is in use.
 */

export interface Resolution {
  interval: KlineInterval;
  ms: number;
}

export type RangeCandles =
  | { status: "ready"; candles: Candle[]; resolution: Resolution }
  | { status: "loading" }
  | { status: "error" };

const MAX_BARS = 3_000;
const CHUNK_BARS = 1_000;
const LIVE_REFRESH_MS = 10_000;
const RETRY_MS = 15_000;
/** Binance may publish a closed bar a moment late. */
const SETTLE_MS = 5_000;

interface Chunk {
  status: "loading" | "ready" | "error";
  candles: Candle[];
  /** When the last request for it started. */
  requestedAt: number;
}

/** The finest interval that covers [fromMs, toMs] in at most MAX_BARS bars. */
export function resolutionFor(fromMs: number, toMs: number): Resolution {
  const span = Math.max(0, toMs - fromMs);
  const found = KLINE_INTERVALS.find(([, ms]) => span / ms <= MAX_BARS) ?? KLINE_INTERVALS[KLINE_INTERVALS.length - 1];
  return { interval: found[0], ms: found[1] };
}

export class RangeCandleStore {
  private symbol: string | null = null;
  private chunks = new Map<string, Chunk>();
  private abort = new AbortController();
  /** Bumped whenever any chunk's data changes, so callers can key caches on it. */
  version = 0;

  /** `onData`: some chunk finished loading or refreshed. */
  constructor(private readonly onData: () => void) {}

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return;
    this.abort.abort();
    this.abort = new AbortController();
    this.symbol = symbol;
    this.chunks = new Map();
    this.version++;
  }

  dispose(): void {
    this.abort.abort();
  }

  /** Bars opening within [fromMs, toMs), loading what's missing. */
  get(fromMs: number, toMs: number, now = Date.now()): RangeCandles {
    const to = Math.min(toMs, now);
    if (!this.symbol || !(to > fromMs)) return { status: "error" };
    const resolution = resolutionFor(fromMs, to);
    const span = resolution.ms * CHUNK_BARS;
    const candles: Candle[] = [];
    let loading = false;
    let failed = false;
    for (let index = Math.floor(fromMs / span); index <= Math.floor((to - 1) / span); index++) {
      const chunk = this.ensure(resolution, index, span, now);
      if (chunk.status === "ready") {
        for (const c of chunk.candles) {
          const t = c.time * 1000;
          if (t >= fromMs && t < to) candles.push(c);
        }
      } else if (chunk.status === "loading") loading = true;
      else failed = true;
    }
    if (loading) return { status: "loading" };
    if (failed) return { status: "error" };
    return { status: "ready", candles, resolution };
  }

  private ensure(resolution: Resolution, index: number, span: number, now: number): Chunk {
    const key = `${resolution.interval}|${index}`;
    const chunk = this.chunks.get(key);
    // Fetched before its last bar had closed: the data may still change.
    const unsettled = chunk !== undefined && chunk.requestedAt < (index + 1) * span + SETTLE_MS;
    const stale =
      chunk !== undefined &&
      ((chunk.status === "error" && now - chunk.requestedAt > RETRY_MS) ||
        (chunk.status === "ready" && unsettled && now - chunk.requestedAt > LIVE_REFRESH_MS));
    if (chunk && !stale) return chunk;

    // A refresh keeps serving the data it already has until the new data arrives.
    const next: Chunk = chunk?.status === "ready" ? { ...chunk, requestedAt: now } : { status: "loading", candles: [], requestedAt: now };
    this.chunks.set(key, next);
    this.load(key, next, resolution.interval, index * span, (index + 1) * span - 1);
    return next;
  }

  private load(key: string, chunk: Chunk, interval: KlineInterval, startMs: number, endMs: number): void {
    const symbol = this.symbol;
    const { signal } = this.abort;
    if (!symbol) return;
    fetchKlineRange(symbol, interval, startMs, endMs, signal).then(
      (candles) => {
        if (signal.aborted || this.chunks.get(key) !== chunk) return;
        this.chunks.set(key, { status: "ready", candles, requestedAt: chunk.requestedAt });
        this.version++;
        this.onData();
      },
      () => {
        if (signal.aborted || this.chunks.get(key) !== chunk) return;
        // Keep serving older data if there is some; otherwise report the failure.
        this.chunks.set(key, chunk.candles.length ? { ...chunk, status: "ready" } : { ...chunk, status: "error" });
        this.version++;
        this.onData();
      },
    );
  }
}
