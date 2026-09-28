import type { Listing, SourceId } from "../venues";
import { binancePerpStream, binanceSpotStream } from "./binance";
import { bybitStream } from "./bybit";
import { coinbaseStream } from "./coinbase";
import { kucoinStream } from "./kucoin";
import { okxStream } from "./okx";
import type { StreamSpec, StreamSpecFactory } from "./types";

export type { MarketEvent, StreamSpec } from "./types";
export { ManagedSocket } from "./ManagedSocket";

const FACTORIES: Record<SourceId, StreamSpecFactory> = {
  "binance:spot": binanceSpotStream,
  "binance:perp": binancePerpStream,
  "bybit:spot": (listing) => bybitStream(listing, "spot"),
  "bybit:perp": (listing) => bybitStream(listing, "perp"),
  "okx:spot": okxStream,
  "okx:perp": okxStream,
  "coinbase:spot": coinbaseStream,
  "kucoin:spot": (listing) => kucoinStream(listing, "spot"),
  "kucoin:perp": (listing) => kucoinStream(listing, "perp"),
};

export function streamSpecsFor(listings: readonly Listing[]): StreamSpec[] {
  return listings.map((listing) => FACTORIES[listing.source](listing));
}
