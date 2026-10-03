import { fetchBinanceJson, fetchKlinesBulk } from "../lib/binance";
import { getPairs } from "../lib/server/pairs";
import { SETUP_V1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";

/**
 * Where the bot gets prices from. The live implementation reads Binance; the replay
 * implementation (bot/replay.ts) serves history, so the bot can be run over the past
 * through exactly the code that trades live.
 */
export interface PairInfo {
  symbol: string;
  base: string;
  precision: number;
}

export interface MarketData {
  /** Tradable USDT pairs. */
  universe(): Promise<PairInfo[]>;
  /**
   * Closed 4h bars of `symbol` up to and including the bar opening at `barTime`, at
   * least `minBars` of them when available; null if the pair has no bar at `barTime`.
   */
  closedBars(symbol: string, barTime: number, minBars: number): Promise<Candle[] | null>;
  /** Latest traded price. */
  price(symbol: string): Promise<number>;
}

export const BAR_MS = SETUP_V1.validatedInterval;
/** Binance publishes a closed bar within seconds; the bot acts a little after. */
export const SETTLE_MS = 90_000;
const MAX_BARS = 1000; // one klines request

/** Open time of the last 4h bar that has closed and settled at `now`. */
export const lastClosedBar = (now: number) => Math.floor((now - SETTLE_MS) / BAR_MS) * BAR_MS - BAR_MS;


export class BinanceMarketData implements MarketData {
  async universe(): Promise<PairInfo[]> {
    const { pairs } = await getPairs();
    return pairs.map((p) => ({ symbol: p.symbol, base: p.base, precision: p.precision }));
  }

  async closedBars(symbol: string, barTime: number, minBars: number): Promise<Candle[] | null> {
    // Bars after `barTime` exist when the bot catches up after downtime: fetch enough to cover them.
    const extra = Math.max(0, Math.ceil((Date.now() - barTime) / BAR_MS));
    const limit = Math.min(MAX_BARS, Math.max(500, minBars) + extra);
    const all = await fetchKlinesBulk(symbol, "4h", limit, AbortSignal.timeout(180_000));
    const bars = all.filter((c) => c.time * 1000 <= barTime);
    return bars.length && bars[bars.length - 1].time * 1000 === barTime ? bars : null;
  }

  async price(symbol: string): Promise<number> {
    const r = await fetchBinanceJson<{ price: string }>(`/api/v3/ticker/price?symbol=${symbol}`);
    return Number(r.price);
  }
}
