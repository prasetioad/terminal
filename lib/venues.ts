export type VenueId = "binance" | "bybit" | "okx" | "coinbase" | "kucoin";
export type MarketType = "spot" | "perp";

export interface VenueInfo {
  id: VenueId;
  name: string;
  logo: string; // path under /public
}

export const VENUES: Record<VenueId, VenueInfo> = {
  binance: { id: "binance", name: "Binance", logo: "/venues/binance.svg" },
  bybit: { id: "bybit", name: "Bybit", logo: "/venues/bybit.svg" },
  okx: { id: "okx", name: "OKX", logo: "/venues/okx.svg" },
  coinbase: { id: "coinbase", name: "Coinbase", logo: "/venues/coinbase.svg" },
  kucoin: { id: "kucoin", name: "KuCoin", logo: "/venues/kucoin.svg" },
};

export const MARKETS: Record<MarketType, { short: "S" | "P"; label: string }> = {
  spot: { short: "S", label: "Spot" },
  perp: { short: "P", label: "Perpetual" },
};

/** Every venue + market the terminal supports, in display order. */
export const ALL_SOURCES = [
  "binance:spot",
  "binance:perp",
  "bybit:spot",
  "bybit:perp",
  "okx:spot",
  "okx:perp",
  "coinbase:spot",
  "kucoin:spot",
  "kucoin:perp",
] as const satisfies readonly `${VenueId}:${MarketType}`[];

/** One tradable venue + market combination, e.g. "bybit:perp". */
export type SourceId = (typeof ALL_SOURCES)[number];

/** Candles, the header price and the 24h ticker all come from this source. */
export const CHART_SOURCE: SourceId = "binance:spot";

export function splitSource(source: SourceId): { venue: VenueId; market: MarketType } {
  const [venue, market] = source.split(":") as [VenueId, MarketType];
  return { venue, market };
}

/**
 * Where a pair trades on one source. Venues quote some contracts in bundles
 * (Binance "1000PEPEUSDT", OKX contracts of 10M PEPE), so every listing carries
 * factors that convert its raw price/size into per-base-unit values, keeping all
 * bubbles on the same price axis as the Binance spot candles.
 */
export interface Listing {
  source: SourceId;
  symbol: string; // venue-native instrument id, e.g. "1000PEPEUSDT", "PEPE-USDT-SWAP"
  priceScale: number; // raw price × priceScale = price per 1 base unit
  qtyScale: number; // raw size × qtyScale = size in base units
}
