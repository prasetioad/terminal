import type { Listing } from "../venues";
import type { Ticker24h } from "../types";
import { makeTrade, safeJson, timeSideKey, type StreamSpec } from "./types";

/** aggTrade: fills of one taker order at one price, already merged by Binance. */
interface AggTrade {
  e: "aggTrade";
  a: number; // aggregate trade id
  p: string;
  q: string;
  T: number;
  m: boolean; // is the buyer the maker?
}

interface Ticker {
  e: "24hrTicker";
  o: string;
  h: string;
  l: string;
  c: string;
  P: string;
  q: string;
}

type Frame = { data?: AggTrade | Ticker | { e: string } };

function parseTicker(raw: Ticker): Ticker24h {
  return {
    lastPrice: parseFloat(raw.c),
    open: parseFloat(raw.o),
    high: parseFloat(raw.h),
    low: parseFloat(raw.l),
    changePct: parseFloat(raw.P),
    quoteVolume: parseFloat(raw.q),
  };
}

function binanceSpec(listing: Listing, urls: readonly string[]): StreamSpec {
  return {
    key: `${listing.source}:${listing.symbol}`,
    source: listing.source,
    urls,
    parse(raw, emit) {
      const data = safeJson<Frame>(raw)?.data;
      if (!data) return;
      if (data.e === "aggTrade") {
        const t = data as AggTrade;
        // m = true → the buyer rested on the book → the aggressor sold into the bid.
        const side = t.m ? "SELL" : "BUY";
        const trade = makeTrade(listing, { id: t.a, price: +t.p, qty: +t.q, time: t.T, side });
        emit({ type: "trade", trade, orderKey: timeSideKey(t.T, side) });
      } else if (data.e === "24hrTicker") {
        emit({ type: "ticker", ticker: parseTicker(data as Ticker) });
      }
    },
  };
}

const stream = (symbol: string) => encodeURIComponent(symbol.toLowerCase());

/** Spot: aggTrades + the 24h ticker (drives the header, and keeps the socket busy). */
export function binanceSpotStream(listing: Listing): StreamSpec {
  const s = stream(listing.symbol);
  const query = `?streams=${s}@aggTrade/${s}@ticker`;
  return binanceSpec(listing, [
    `wss://stream.binance.com:9443/stream${query}`,
    `wss://data-stream.binance.vision/stream${query}`,
  ]);
}

/**
 * USDⓈ-M perpetuals. Market streams live under /market; the legacy /stream path
 * still accepts connections but delivers nothing. The 1s mark price keeps quiet
 * contracts from tripping the stale-stream watchdog.
 */
export function binancePerpStream(listing: Listing): StreamSpec {
  const s = stream(listing.symbol);
  return binanceSpec(listing, [`wss://fstream.binance.com/market/stream?streams=${s}@aggTrade/${s}@markPrice@1s`]);
}
