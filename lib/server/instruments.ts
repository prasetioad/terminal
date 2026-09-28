import type { Listing, SourceId } from "../venues";

/** Finds where one base asset (e.g. "PEPE") trades on a source, or null if it doesn't. */
export type ListingResolver = (base: string) => Listing | null;

/** Every source except the chart source, which defines the pair universe itself. */
export type ExternalSource = Exclude<SourceId, "binance:spot">;

const TIMEOUT_MS = 10_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": "orderflow-terminal" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

/**
 * Low-priced coins trade as bundles on some perp venues: Binance/Bybit list
 * "1000PEPEUSDT" (price and size per 1000 PEPE), and Bybit spells SHIB as a
 * suffix ("SHIB1000"). Candidates are matched exactly, so coins whose names
 * merely contain digits ("1INCH", "BROCCOLI714") are never mistaken for bundles.
 */
const BUNDLES: readonly { spell: (base: string) => string; size: number }[] = [
  { spell: (b) => b, size: 1 },
  { spell: (b) => `1000${b}`, size: 1e3 },
  { spell: (b) => `10000${b}`, size: 1e4 },
  { spell: (b) => `1000000${b}`, size: 1e6 },
  { spell: (b) => `1M${b}`, size: 1e6 },
  { spell: (b) => `${b}1000`, size: 1e3 },
];

function bundledResolver(source: SourceId, symbolsByBase: Map<string, string>): ListingResolver {
  return (base) => {
    for (const { spell, size } of BUNDLES) {
      const symbol = symbolsByBase.get(spell(base));
      if (symbol) return { source, symbol, priceScale: 1 / size, qtyScale: size };
    }
    return null;
  };
}

function plainResolver(source: SourceId, symbolsByBase: Map<string, string>): ListingResolver {
  return (base) => {
    const symbol = symbolsByBase.get(base);
    return symbol ? { source, symbol, priceScale: 1, qtyScale: 1 } : null;
  };
}

async function binancePerp(): Promise<ListingResolver> {
  type Info = { symbols: { symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }[] };
  const info = await getJson<Info>("https://fapi.binance.com/fapi/v1/exchangeInfo");
  const bySymbol = new Map<string, string>();
  for (const s of info.symbols) {
    if (s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING") {
      bySymbol.set(s.baseAsset, s.symbol);
    }
  }
  return bundledResolver("binance:perp", bySymbol);
}

async function bybitInstruments(category: "spot" | "linear") {
  type Item = { symbol: string; baseCoin: string; quoteCoin: string; status: string; contractType?: string };
  type Page = { retCode: number; result: { list: Item[]; nextPageCursor?: string } };
  const items: Item[] = [];
  let cursor = "";
  do {
    const url = `https://api.bybit.com/v5/market/instruments-info?category=${category}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await getJson<Page>(url);
    if (page.retCode !== 0) throw new Error(`Bybit retCode ${page.retCode}`);
    items.push(...page.result.list);
    cursor = page.result.nextPageCursor ?? "";
  } while (cursor);
  return items.filter((i) => i.quoteCoin === "USDT" && i.status === "Trading");
}

async function bybitSpot(): Promise<ListingResolver> {
  const items = await bybitInstruments("spot");
  return plainResolver("bybit:spot", new Map(items.map((i) => [i.baseCoin, i.symbol])));
}

async function bybitPerp(): Promise<ListingResolver> {
  const items = await bybitInstruments("linear");
  const perps = items.filter((i) => i.contractType === "LinearPerpetual");
  return bundledResolver("bybit:perp", new Map(perps.map((i) => [i.baseCoin, i.symbol])));
}

type OkxInstrument = {
  instId: string;
  state: string;
  baseCcy?: string;
  quoteCcy?: string;
  ctType?: string;
  settleCcy?: string;
  ctVal?: string;
  ctMult?: string;
  ctValCcy?: string;
};

async function okxInstruments(instType: "SPOT" | "SWAP"): Promise<OkxInstrument[]> {
  const res = await getJson<{ code: string; data: OkxInstrument[] }>(
    `https://www.okx.com/api/v5/public/instruments?instType=${instType}`,
  );
  if (res.code !== "0") throw new Error(`OKX code ${res.code}`);
  return res.data.filter((i) => i.state === "live");
}

async function okxSpot(): Promise<ListingResolver> {
  const bySymbol = new Map<string, string>();
  for (const i of await okxInstruments("SPOT")) {
    if (i.quoteCcy === "USDT" && i.baseCcy) bySymbol.set(i.baseCcy, i.instId);
  }
  return plainResolver("okx:spot", bySymbol);
}

/** Swap sizes are contracts: base units = sz × ctVal × ctMult. */
async function okxPerp(): Promise<ListingResolver> {
  const items = await okxInstruments("SWAP");
  const byBase = new Map<string, Listing>();
  for (const i of items) {
    if (i.ctType !== "linear" || i.settleCcy !== "USDT" || !i.instId.endsWith("-USDT-SWAP")) continue;
    const base = i.instId.split("-")[0];
    const qtyScale = Number(i.ctVal) * Number(i.ctMult ?? 1);
    if (i.ctValCcy !== base || !(qtyScale > 0)) continue;
    byBase.set(base, { source: "okx:perp", symbol: i.instId, priceScale: 1, qtyScale });
  }
  return (base) => byBase.get(base) ?? null;
}

/** Coinbase quotes in USD rather than USDT; close enough for sizing and bubble placement. */
async function coinbaseSpot(): Promise<ListingResolver> {
  type Product = { id: string; base_currency: string; quote_currency: string; status: string; trading_disabled: boolean };
  const products = await getJson<Product[]>("https://api.exchange.coinbase.com/products");
  const live = products.filter((p) => p.quote_currency === "USD" && p.status === "online" && !p.trading_disabled);
  return plainResolver("coinbase:spot", new Map(live.map((p) => [p.base_currency, p.id])));
}

async function kucoinSpot(): Promise<ListingResolver> {
  type Symbol = { symbol: string; baseCurrency: string; quoteCurrency: string; enableTrading: boolean };
  const res = await getJson<{ code: string; data: Symbol[] }>("https://api.kucoin.com/api/v2/symbols");
  if (res.code !== "200000") throw new Error(`KuCoin code ${res.code}`);
  const bySymbol = new Map<string, string>();
  for (const s of res.data) {
    if (s.quoteCurrency === "USDT" && s.enableTrading) bySymbol.set(s.baseCurrency, s.symbol);
  }
  return plainResolver("kucoin:spot", bySymbol);
}

/** KuCoin futures call BTC "XBT". */
const KUCOIN_FUTURES_ALIASES: Record<string, string> = { BTC: "XBT" };

/**
 * USDT-margined perpetuals. Sizes are lots of `multiplier` contract units, and a
 * bundled contract's unit is itself a bundle ("1000BONK"): verified against live
 * prices (1000BONK ≈ 1000 × BONK spot) and trade notionals.
 */
async function kucoinPerp(): Promise<ListingResolver> {
  type Contract = {
    symbol: string;
    baseCurrency: string;
    quoteCurrency: string;
    multiplier: number;
    isInverse: boolean;
    status: string;
    type: string;
  };
  const res = await getJson<{ code: string; data: Contract[] }>("https://api-futures.kucoin.com/api/v1/contracts/active");
  if (res.code !== "200000") throw new Error(`KuCoin code ${res.code}`);
  const byBase = new Map<string, Contract>();
  for (const c of res.data) {
    // FFWCSX = perpetual swap; FFICSX would be a dated future.
    if (c.type === "FFWCSX" && c.quoteCurrency === "USDT" && !c.isInverse && c.status === "Open" && c.multiplier > 0) {
      byBase.set(c.baseCurrency, c);
    }
  }
  return (base) => {
    const futuresBase = KUCOIN_FUTURES_ALIASES[base] ?? base;
    for (const { spell, size } of BUNDLES) {
      const contract = byBase.get(spell(futuresBase));
      if (contract) {
        return { source: "kucoin:perp", symbol: contract.symbol, priceScale: 1 / size, qtyScale: contract.multiplier * size };
      }
    }
    return null;
  };
}

export const INSTRUMENT_LOADERS: Record<ExternalSource, () => Promise<ListingResolver>> = {
  "binance:perp": binancePerp,
  "bybit:spot": bybitSpot,
  "bybit:perp": bybitPerp,
  "okx:spot": okxSpot,
  "okx:perp": okxPerp,
  "coinbase:spot": coinbaseSpot,
  "kucoin:spot": kucoinSpot,
  "kucoin:perp": kucoinPerp,
};
