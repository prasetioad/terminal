import type { Listing, SourceId } from "../venues";
import { BinanceBook } from "./binance";
import { BybitBook } from "./bybit";
import { CoinbaseBook } from "./coinbase";
import { KucoinBook } from "./kucoin";
import { OkxBook } from "./okx";
import type { LiveBook } from "./SocketBook";

export type { LiveBook } from "./SocketBook";

/** Order-book adapter per source. Every source with an entry here feeds the global heatmap. */
export const BOOK_FACTORIES: Record<SourceId, (listing: Listing) => LiveBook> = {
  "binance:spot": (l) => new BinanceBook(l, "spot"),
  "binance:perp": (l) => new BinanceBook(l, "perp"),
  "bybit:spot": (l) => new BybitBook(l, "spot"),
  "bybit:perp": (l) => new BybitBook(l, "perp"),
  "okx:spot": (l) => new OkxBook(l),
  "okx:perp": (l) => new OkxBook(l),
  "coinbase:spot": (l) => new CoinbaseBook(l),
  "kucoin:spot": (l) => new KucoinBook(l, "spot"),
  "kucoin:perp": (l) => new KucoinBook(l, "perp"),
};
