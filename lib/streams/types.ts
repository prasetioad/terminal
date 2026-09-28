import type { Listing, SourceId } from "../venues";
import type { Side, Ticker24h, Trade } from "../types";

export type MarketEvent =
  | {
      type: "trade";
      trade: Trade;
      /** Prints sharing this key (and source) come from one taker order and may be merged. */
      orderKey: string;
    }
  | { type: "ticker"; ticker: Ticker24h };

/** Where to connect: fixed URLs, or a URL that must be fetched before every connect (e.g. a session token). */
type Endpoint =
  | {
      /** Tried in rotation on reconnect. */
      urls: readonly string[];
      resolveUrl?: undefined;
    }
  | {
      urls?: undefined;
      /** Called before every (re)connect; rejecting counts as a failed attempt. */
      resolveUrl: (signal: AbortSignal) => Promise<string>;
    };

/**
 * Everything the generic socket needs to know about one venue feed. Adapters are
 * pure data + parsing; connection management lives in ManagedSocket. `E` is the
 * event type the parser emits (trades/tickers by default, depth updates for books).
 */
export type StreamSpec<E = MarketEvent> = Endpoint & {
  /** Stable identity: specs with the same key are the same feed. */
  key: string;
  source: SourceId;
  /** Sent right after the socket opens (subscriptions). */
  subscribe?: readonly string[];
  /** For venues that close idle sockets unless the client pings. */
  heartbeat?: { intervalMs: number; message: string };
  /** Parse one raw frame; call `emit` for each event it contains. */
  parse(raw: string, emit: (event: E) => void): void;
};

export type StreamSpecFactory = (listing: Listing) => StreamSpec;

/** Build a normalised trade from a venue print, applying the listing's scale factors. */
export function makeTrade(
  listing: Listing,
  print: { id: string | number; price: number; qty: number; time: number; side: Side },
): Trade {
  const price = print.price * listing.priceScale;
  const qty = print.qty * listing.qtyScale;
  return {
    id: `${listing.source}:${print.id}`,
    source: listing.source,
    price,
    qty,
    usd: price * qty,
    time: print.time,
    side: print.side,
    fills: 1,
  };
}

/** Default order key for venues that don't expose the taker order id. */
export const timeSideKey = (time: number, side: Side) => `${time}|${side}`;

export function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // e.g. plain-text "pong"
  }
}
