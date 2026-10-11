import type { Candle } from "../lib/types";
import type { SetupId } from "./config";

/**
 * Entry traits: what the research found sets winners apart (docs/ROADMAP.md §4.47), recorded on
 * every entry so live trades can test it on data the research never saw. Informational only —
 * no trading decision reads them, and a failure to fetch one leaves it null.
 *
 * Tags locked on 2026-10-11 (thresholds = the research's in-sample tercile cut points):
 *   Setup A  tight base     the 120 bars before the breakout span < 16% of the price
 *            funding up     the last 3 funding rates average ≥ 0.01%
 *            basis up       the perpetual's 4h close ≥ 0.042% above spot's
 *   v1       mass drawdown  ≥ 69% of the evaluated pairs ≥ 30% under their 30-day high close
 *            OI flushed     open interest down ≥ 12.3% over 7 days
 *            mature coin    ≥ 526 days of history, counted from 2021-01-01 at the earliest
 *                           (the research data's start)
 *            BTC not hot    BTC < 16.5% above its 200-day average
 */
export interface Traits {
  range20: number | null;
  funding: number | null;
  basis: number | null;
  oi7: number | null;
  ageDays: number | null;
  breadthDD: number | null;
  btcTrend: number | null;
}

export interface TraitTag {
  setup: SetupId;
  key: keyof Traits;
  label: string;
  /** Whether the trait is present; null when unknown. */
  test: (v: number) => boolean;
}

export const TRAIT_TAGS: readonly TraitTag[] = [
  { setup: "a", key: "range20", label: "tight base", test: (v) => v < 0.16 },
  { setup: "a", key: "funding", label: "funding up", test: (v) => v >= 0.0001 },
  { setup: "a", key: "basis", label: "basis up", test: (v) => v >= 0.00042 },
  { setup: "v1", key: "breadthDD", label: "mass drawdown", test: (v) => v >= 0.689 },
  { setup: "v1", key: "oi7", label: "OI flushed", test: (v) => v <= -0.123 },
  { setup: "v1", key: "ageDays", label: "mature coin", test: (v) => v >= 526 },
  { setup: "v1", key: "btcTrend", label: "BTC not hot", test: (v) => v < 0.165 },
];

export function tagsOf(setup: SetupId, traits: Traits): { label: string; on: boolean | null }[] {
  return TRAIT_TAGS.filter((t) => t.setup === setup).map((t) => {
    const v = traits[t.key];
    return { label: t.label, on: v === null ? null : t.test(v) };
  });
}

/** "tight base ✓ · funding up ✗ · basis up ?" */
export const tagLine = (setup: SetupId, traits: Traits) => tagsOf(setup, traits).map((t) => `${t.label} ${t.on === null ? "?" : t.on ? "✓" : "✗"}`).join(" · ");

/** Span of the 120 bars before the last one, as a share of its close. */
export function range20(bars: readonly Candle[]): number | null {
  const n = bars.length;
  if (n < 121) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = n - 121; i < n - 1; i++) {
    hi = Math.max(hi, bars[i].high);
    lo = Math.min(lo, bars[i].low);
  }
  return (hi - lo) / bars[n - 1].close;
}

/** Share of the series whose last close is ≥ 30% under the highest close of the 180 bars before. */
export function breadthDD(series: Iterable<readonly Candle[]>): number | null {
  let total = 0;
  let down = 0;
  for (const bars of series) {
    const n = bars.length;
    if (n < 181) continue;
    let hi = 0;
    for (let i = n - 181; i < n - 1; i++) hi = Math.max(hi, bars[i].close);
    total++;
    if (bars[n - 1].close <= 0.7 * hi) down++;
  }
  return total ? down / total : null;
}

/** The traits that need data beyond the 4h bars: futures, listing age, BTC's daily trend. */
export interface TraitSource {
  btcTrend(): Promise<number | null>;
  forPair(symbol: string, base: string, barTime: number, spotClose: number): Promise<Pick<Traits, "funding" | "basis" | "oi7" | "ageDays">>;
}

const SPOT = "https://data-api.binance.vision";
const FUTURES = "https://fapi.binance.com";
const RESEARCH_START = Date.UTC(2021, 0, 1);
const DAY = 86_400_000;

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}
const settle = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Public Binance endpoints; every call may fail and then yields null. */
export class BinanceTraitSource implements TraitSource {
  private readonly perps = new Map<string, { symbol: string; mult: number } | null>();
  private readonly firstBar = new Map<string, number>();

  async btcTrend(): Promise<number | null> {
    return settle(
      (async () => {
        const rows = await json<[number, string, string, string, string, string, number][]>(`${SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=201`);
        const closes = rows.filter((r) => r[6] < Date.now()).map((r) => Number(r[4]));
        if (closes.length < 200) return null;
        const last = closes.slice(-200);
        return closes[closes.length - 1] / (last.reduce((a, b) => a + b, 0) / 200) - 1;
      })(),
    );
  }

  /** The coin's USDT-M perpetual (XUSDT, else 1000XUSDT / 1000000XUSDT priced ×1000…), if any. */
  private async perp(base: string): Promise<{ symbol: string; mult: number } | null> {
    if (this.perps.has(base)) return this.perps.get(base) ?? null;
    for (const [symbol, mult] of [[`${base}USDT`, 1], [`1000${base}USDT`, 1000], [`1000000${base}USDT`, 1_000_000]] as const) {
      if ((await settle(json(`${FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`))) !== null) {
        this.perps.set(base, { symbol, mult });
        return { symbol, mult };
      }
    }
    this.perps.set(base, null);
    return null;
  }

  async forPair(symbol: string, base: string, barTime: number, spotClose: number) {
    const perp = await settle(this.perp(base));
    const [funding, basis, oi7, ageDays] = await Promise.all([
      perp
        ? settle(json<{ fundingRate: string }[]>(`${FUTURES}/fapi/v1/fundingRate?symbol=${perp.symbol}&limit=3`).then((r) => (r.length ? r.reduce((a, x) => a + Number(x.fundingRate), 0) / r.length : null)))
        : null,
      perp
        ? settle(json<[number, string, string, string, string][]>(`${FUTURES}/fapi/v1/klines?symbol=${perp.symbol}&interval=4h&startTime=${barTime}&limit=1`).then((r) => (r[0]?.[0] === barTime ? Number(r[0][4]) / perp.mult / spotClose - 1 : null)))
        : null,
      perp
        ? settle(json<{ sumOpenInterest: string }[]>(`${FUTURES}/futures/data/openInterestHist?symbol=${perp.symbol}&period=4h&limit=43`).then((r) => (r.length >= 2 && Number(r[0].sumOpenInterest) > 0 ? Number(r[r.length - 1].sumOpenInterest) / Number(r[0].sumOpenInterest) - 1 : null)))
        : null,
      settle(
        (async () => {
          let first = this.firstBar.get(symbol);
          if (first === undefined) {
            const r = await json<[number][]>(`${SPOT}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=0&limit=1`);
            if (!r.length) return null;
            first = r[0][0];
            this.firstBar.set(symbol, first);
          }
          return (barTime - Math.max(first, RESEARCH_START)) / DAY;
        })(),
      ),
    ]);
    return { funding, basis, oi7, ageDays };
  }
}
