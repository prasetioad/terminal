import { decimalsFromTick, fetchBinanceJson } from "../binance";
import type { Pair, PairsResponse } from "../types";
import { CHART_SOURCE, type Listing } from "../venues";
import { CMC_SNAPSHOT } from "./cmcSnapshot";
import { INSTRUMENT_LOADERS, type ExternalSource, type ListingResolver } from "./instruments";

export const PAIR_COUNT = 100;
const CACHE_TTL_MS = 60 * 60 * 1000;
const DEGRADED_CACHE_TTL_MS = 5 * 60 * 1000; // retry soon if a source was missing
// Top 100 CMC coins only yield ~65 Binance USDT pairs (stablecoins and non-Binance
// coins drop out), so read further down the ranking to fill PAIR_COUNT.
const CMC_SCAN_DEPTH = 250;
const CMC_LISTING_URL =
  "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing" +
  `?start=1&limit=${CMC_SCAN_DEPTH}&sortBy=market_cap&sortType=desc&convert=USD`;

/** CMC ticker → Binance base asset, where they differ. */
const BINANCE_ALIASES: Record<string, string> = { BTT: "BTTC" };

interface CmcCoin {
  symbol: string;
  name: string;
  cmcRank: number;
  tags: string[];
}

interface ExchangeInfo {
  symbols: {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    filters: { filterType: string; tickSize?: string }[];
  }[];
}

type RankedCoin = Pick<CmcCoin, "symbol" | "name" | "cmcRank">;
type ExternalCatalogs = Partial<Record<ExternalSource, ListingResolver>>;

let cache: { value: PairsResponse; expires: number } | null = null;
let inflight: Promise<PairsResponse> | null = null;

async function fetchCmcRanking(): Promise<RankedCoin[]> {
  const res = await fetch(CMC_LISTING_URL, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { cryptoCurrencyList?: CmcCoin[] } };
  const list = json.data?.cryptoCurrencyList;
  if (!list?.length) throw new Error("CMC returned no listings");
  return list
    .filter((c) => !c.tags?.includes("stablecoin"))
    .sort((a, b) => a.cmcRank - b.cmcRank);
}

/** Tick sizes of every TRADING USDT spot pair on the chart source, keyed by base asset. */
async function fetchBinanceUsdtTicks(): Promise<Map<string, string>> {
  const info = await fetchBinanceJson<ExchangeInfo>(
    "/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING",
    undefined,
    15_000,
  );
  const ticks = new Map<string, string>();
  for (const s of info.symbols) {
    if (s.quoteAsset !== "USDT" || s.status !== "TRADING") continue;
    const tick = s.filters.find((f) => f.filterType === "PRICE_FILTER")?.tickSize;
    if (tick) ticks.set(s.baseAsset, tick);
  }
  return ticks;
}

/** Load every external instrument list in parallel; a failing venue is reported, not fatal. */
async function loadExternalCatalogs(): Promise<{ catalogs: ExternalCatalogs; unavailable: ExternalSource[] }> {
  const sources = Object.keys(INSTRUMENT_LOADERS) as ExternalSource[];
  const results = await Promise.allSettled(sources.map((source) => INSTRUMENT_LOADERS[source]()));
  const catalogs: ExternalCatalogs = {};
  const unavailable: ExternalSource[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") catalogs[sources[i]] = result.value;
    else unavailable.push(sources[i]);
  });
  return { catalogs, unavailable };
}

function buildPairs(ranking: readonly RankedCoin[], ticks: Map<string, string>, catalogs: ExternalCatalogs): Pair[] {
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const coin of ranking) {
    const base = BINANCE_ALIASES[coin.symbol] ?? coin.symbol;
    // Non-ASCII tickers exist on Binance but their WebSocket streams don't deliver.
    if (!/^[A-Z0-9]+$/.test(base) || seen.has(base)) continue;
    const tick = ticks.get(base);
    if (!tick) continue;
    seen.add(base);

    const symbol = `${base}USDT`;
    const listings: Listing[] = [{ source: CHART_SOURCE, symbol, priceScale: 1, qtyScale: 1 }];
    for (const resolve of Object.values(catalogs)) {
      const listing = resolve(base);
      if (listing) listings.push(listing);
    }

    pairs.push({
      symbol,
      base,
      name: coin.name,
      rank: coin.cmcRank,
      precision: decimalsFromTick(tick),
      minMove: parseFloat(tick),
      listings,
    });
    if (pairs.length === PAIR_COUNT) break;
  }
  return pairs;
}

async function load(): Promise<PairsResponse> {
  const [ranking, ticks, external] = await Promise.allSettled([
    fetchCmcRanking(),
    fetchBinanceUsdtTicks(),
    loadExternalCatalogs(),
  ]);
  if (ticks.status === "rejected") throw ticks.reason; // the chart source defines the pair universe
  const { catalogs, unavailable } =
    external.status === "fulfilled" ? external.value : { catalogs: {}, unavailable: Object.keys(INSTRUMENT_LOADERS) as ExternalSource[] };

  const live = ranking.status === "fulfilled" ? ranking.value : null;
  const coins = live ?? CMC_SNAPSHOT.map(([cmcRank, symbol, name]) => ({ cmcRank, symbol, name }));
  const pairs = buildPairs(coins, ticks.value, catalogs);
  if (pairs.length === 0) throw new Error("No tradable pairs");

  return {
    pairs,
    ranking: live ? "cmc-live" : "cmc-snapshot",
    unavailableSources: unavailable,
    updatedAt: Date.now(),
  };
}

/** Top PAIR_COUNT Binance USDT pairs by CMC rank with their venue listings, cached in memory. */
export async function getTopPairs(): Promise<PairsResponse> {
  if (cache && cache.expires > Date.now()) return cache.value;
  inflight ??= load()
    .then((value) => {
      const complete = value.ranking === "cmc-live" && value.unavailableSources.length === 0;
      cache = { value, expires: Date.now() + (complete ? CACHE_TTL_MS : DEGRADED_CACHE_TTL_MS) };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (err) {
    if (cache) return cache.value; // serve stale rather than nothing
    throw err;
  }
}
