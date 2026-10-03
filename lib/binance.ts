import type { UTCTimestamp } from "lightweight-charts";
import type { SeedBar } from "./flow";
import type { Candle, IntervalKey, Ticker24h } from "./types";
import type { Listing } from "./venues";

/** Binance spot REST. The *.binance.vision host serves market data only and is reachable in more regions. */
const REST_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const REST_TIMEOUT_MS = 5_000;

/**
 * GET a Binance REST path from all hosts in parallel; the first OK response wins and
 * the rest are aborted. A blocked host often hangs instead of refusing, so trying
 * hosts one after another would cost a full timeout on every load.
 */
export async function fetchBinanceJson<T>(path: string, signal?: AbortSignal, timeoutMs = REST_TIMEOUT_MS): Promise<T> {
  const controllers = REST_HOSTS.map(() => new AbortController());
  let winner = -1;

  const attempt = async (host: string, i: number): Promise<T> => {
    const signals = [controllers[i].signal, AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const res = await fetch(`${host}${path}`, { signal: AbortSignal.any(signals), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
    if (winner !== -1 && winner !== i) throw new Error("lost race");
    winner = i;
    controllers.forEach((c, j) => j !== i && c.abort());
    return (await res.json()) as T;
  };

  try {
    return await Promise.any(REST_HOSTS.map(attempt));
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw err instanceof AggregateError ? err.errors[0] : err;
  }
}

/** "0.00001000" → 5 */
export function decimalsFromTick(tickSize: string): number {
  const frac = tickSize.split(".")[1]?.replace(/0+$/, "") ?? "";
  return frac.length;
}

interface RawTicker24h {
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

/**
 * Current 24h ticker. The WebSocket ticker only pushes when something changes, so a
 * quiet pair would otherwise show an empty header until its next trade.
 */
export async function fetchTicker24h(symbol: string, signal: AbortSignal): Promise<Ticker24h> {
  const t = await fetchBinanceJson<RawTicker24h>(`/api/v3/ticker/24hr?symbol=${symbol}`, signal);
  return {
    lastPrice: parseFloat(t.lastPrice),
    open: parseFloat(t.openPrice),
    high: parseFloat(t.highPrice),
    low: parseFloat(t.lowPrice),
    changePct: parseFloat(t.priceChangePercent),
    quoteVolume: parseFloat(t.quoteVolume),
  };
}

/** [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBaseVolume, …] */
type RawKline = [number, string, string, string, string, string, number, string, number, string, ...unknown[]];

const toCandle = (k: RawKline): Candle => ({
  time: Math.floor(k[0] / 1000) as UTCTimestamp,
  open: parseFloat(k[1]),
  high: parseFloat(k[2]),
  low: parseFloat(k[3]),
  close: parseFloat(k[4]),
  volume: parseFloat(k[5]),
  buyVolume: parseFloat(k[9]),
});

/** Seed the chart with recent history so it isn't empty on load. */
export async function fetchKlines(
  symbol: string,
  interval: IntervalKey,
  signal: AbortSignal,
  limit = 1000,
): Promise<Candle[]> {
  const rows = await fetchBinanceJson<RawKline[]>(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    signal,
  );
  return rows.map(toCandle);
}

const MARKET_DATA_HOST = "https://data-api.binance.vision";
/** Binance allows 6,000 request weight per minute per IP; bulk jobs stay well below it. */
const BULK_WEIGHT_CEILING = 2_400;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(id), reject(signal.reason)), { once: true });
  });

/**
 * Klines for bulk jobs (the scanner): the market-data host only, slowing down as the
 * IP's used weight climbs and waiting out 429s — the chart and the bot share this IP's
 * rate limit, so a scan must never starve them.
 */
export async function fetchKlinesBulk(symbol: string, interval: IntervalKey, limit: number, signal: AbortSignal): Promise<Candle[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${MARKET_DATA_HOST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      cache: "no-store",
    });
    if (res.status === 429 || res.status === 418) {
      const retryAfter = Number(res.headers.get("retry-after")) || 10;
      await sleep(Math.min(120, retryAfter) * 1000, signal);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
    const used = Number(res.headers.get("x-mbx-used-weight-1m")) || 0;
    const rows = (await res.json()) as RawKline[];
    if (used > BULK_WEIGHT_CEILING) await sleep(Math.min(30_000, (used - BULK_WEIGHT_CEILING) * 10), signal);
    return rows.map(toCandle);
  }
  throw new Error(`Rate limited fetching ${symbol}`);
}

/** Every Binance kline interval, finest first. */
export const KLINE_INTERVALS = [
  ["1m", 60_000],
  ["3m", 180_000],
  ["5m", 300_000],
  ["15m", 900_000],
  ["30m", 1_800_000],
  ["1h", 3_600_000],
  ["2h", 7_200_000],
  ["4h", 14_400_000],
  ["6h", 21_600_000],
  ["12h", 43_200_000],
  ["1d", 86_400_000],
] as const;

export type KlineInterval = (typeof KLINE_INTERVALS)[number][0];

/** Spot klines opening in [startMs, endMs] (at most 1000). */
export async function fetchKlineRange(
  symbol: string,
  interval: KlineInterval,
  startMs: number,
  endMs: number,
  signal: AbortSignal,
): Promise<Candle[]> {
  const rows = await fetchBinanceJson<RawKline[]>(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=1000`,
    signal,
    10_000,
  );
  return rows.map(toCandle);
}

/**
 * Taker buy/sell volume history of a Binance USDⓈ-M perpetual, in base units of the
 * spot coin (the listing's qtyScale undoes bundles like 1000PEPE).
 */
export async function fetchPerpFlowHistory(
  listing: Listing,
  interval: IntervalKey,
  signal: AbortSignal,
  limit = 1000,
): Promise<SeedBar[]> {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${listing.symbol}&interval=${interval}&limit=${limit}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(REST_TIMEOUT_MS)]), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} from fapi.binance.com`);
  const rows = (await res.json()) as RawKline[];
  return rows.map((k) => {
    const volume = parseFloat(k[5]) * listing.qtyScale;
    const buy = parseFloat(k[9]) * listing.qtyScale;
    return { time: Math.floor(k[0] / 1000), buy, sell: volume - buy };
  });
}
