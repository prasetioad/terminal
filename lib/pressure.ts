import { ALL_SOURCES, type SourceId } from "./venues";
import type { Trade } from "./types";

/** Aggressive buy vs sell notional over a time window. */
export interface Pressure {
  buyUsd: number;
  sellUsd: number;
}

export const EMPTY_PRESSURE: Pressure = { buyUsd: 0, sellUsd: 0 };

/** Rolling windows the pressure panel offers; null = the whole session (since the pair opened). */
export const PRESSURE_RANGES = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  Session: null,
} as const satisfies Record<string, number | null>;

export type PressureRange = keyof typeof PRESSURE_RANGES;

const LONGEST_RANGE_MS = Math.max(...Object.values(PRESSURE_RANGES).filter((ms) => ms !== null));

/* ───────────────────────────── dominance ───────────────────────────── */

export type Dominance = "buy" | "sell" | "balanced" | "idle";

/** Below this net share of total volume, neither side is called dominant. */
const BALANCED_SHARE = 0.05;

export function dominanceOf({ buyUsd, sellUsd }: Pressure): Dominance {
  const total = buyUsd + sellUsd;
  if (total <= 0) return "idle";
  const netShare = (buyUsd - sellUsd) / total;
  if (Math.abs(netShare) < BALANCED_SHARE) return "balanced";
  return netShare > 0 ? "buy" : "sell";
}

/**
 * Do the large trades push the same way as everyone else?
 *
 * Large trades are part of the market total, so comparing them with the total would
 * lean towards "with": they are compared with the rest of the tape instead
 * (all trades minus the large ones).
 */
export type Alignment = "with" | "against" | "unclear" | "idle";

export interface FlowComparison {
  rest: Pressure;
  large: Dominance;
  restDominance: Dominance;
  alignment: Alignment;
  /** Large trades' share of all traded notional (0…1). */
  largeShare: number;
}

export function compareFlow(large: Pressure, market: Pressure): FlowComparison {
  const rest: Pressure = {
    // Clamped: at a window edge a large order (timed at its first fill) can lead its fills by a moment.
    buyUsd: Math.max(0, market.buyUsd - large.buyUsd),
    sellUsd: Math.max(0, market.sellUsd - large.sellUsd),
  };
  const largeDominance = dominanceOf(large);
  const restDominance = dominanceOf(rest);
  const marketTotal = market.buyUsd + market.sellUsd;
  const largeShare = marketTotal > 0 ? Math.min(1, (large.buyUsd + large.sellUsd) / marketTotal) : 0;

  const directional = (d: Dominance): d is "buy" | "sell" => d === "buy" || d === "sell";
  const alignment: Alignment =
    largeDominance === "idle" || restDominance === "idle"
      ? "idle"
      : directional(largeDominance) && directional(restDominance)
        ? largeDominance === restDominance
          ? "with"
          : "against"
        : "unclear";

  return { rest, large: largeDominance, restDominance, alignment, largeShare };
}

/* ───────────────────────────── tape ───────────────────────────── */

const BUCKET_MS = 1_000;
const SOURCE_INDEX = new Map<SourceId, number>(ALL_SOURCES.map((source, i) => [source, i]));

interface Bucket {
  start: number;
  /** Notional per source, indexed like ALL_SOURCES. */
  buy: Float64Array;
  sell: Float64Array;
}

const newTotals = () => ({ buy: new Float64Array(ALL_SOURCES.length), sell: new Float64Array(ALL_SOURCES.length) });

/**
 * Every trade print of the pair, whatever its size, summed into one-second buckets
 * per source. Holds the longest rolling range plus session totals, so any range can
 * be measured cheaply (≤ 900 buckets) regardless of how busy the tape is.
 */
export class PressureTape {
  private buckets: Bucket[] = []; // chronological
  private session = newTotals();

  add(trade: Trade): void {
    const index = SOURCE_INDEX.get(trade.source);
    if (index === undefined) return;
    const side = trade.side === "BUY" ? "buy" : "sell";
    this.session[side][index] += trade.usd;

    const bucket = this.bucketFor(Math.floor(trade.time / BUCKET_MS) * BUCKET_MS);
    if (bucket) bucket[side][index] += trade.usd;
  }

  /** Visible notional since `sinceMs` (null = the whole session). */
  measure(sinceMs: number | null, hidden: ReadonlySet<SourceId>): Pressure {
    if (sinceMs === null) return sum(this.session, hidden);
    const from = Math.floor(sinceMs / BUCKET_MS) * BUCKET_MS;
    const total = { buyUsd: 0, sellUsd: 0 };
    for (let i = this.buckets.length - 1; i >= 0 && this.buckets[i].start >= from; i--) {
      const part = sum(this.buckets[i], hidden);
      total.buyUsd += part.buyUsd;
      total.sellUsd += part.sellUsd;
    }
    return total;
  }

  clear(): void {
    this.buckets = [];
    this.session = newTotals();
  }

  /** The bucket starting at `start`, created in order; null if it's older than any range needs. */
  private bucketFor(start: number): Bucket | null {
    const newest = this.buckets.at(-1);
    if (newest && start < newest.start - LONGEST_RANGE_MS) return null;
    // Venues deliver slightly out of order: search back from the newest bucket.
    let i = this.buckets.length;
    while (i > 0 && this.buckets[i - 1].start > start) i--;
    if (i > 0 && this.buckets[i - 1].start === start) return this.buckets[i - 1];
    const bucket = { start, ...newTotals() };
    this.buckets.splice(i, 0, bucket);
    this.trim();
    return bucket;
  }

  private trim(): void {
    const horizon = this.buckets[this.buckets.length - 1].start - LONGEST_RANGE_MS - BUCKET_MS;
    let drop = 0;
    while (drop < this.buckets.length && this.buckets[drop].start < horizon) drop++;
    if (drop > 0) this.buckets.splice(0, drop);
  }
}

function sum(totals: { buy: Float64Array; sell: Float64Array }, hidden: ReadonlySet<SourceId>): Pressure {
  let buyUsd = 0;
  let sellUsd = 0;
  ALL_SOURCES.forEach((source, i) => {
    if (hidden.has(source)) return;
    buyUsd += totals.buy[i];
    sellUsd += totals.sell[i];
  });
  return { buyUsd, sellUsd };
}
