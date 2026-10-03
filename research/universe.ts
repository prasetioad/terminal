/**
 * The survivorship-free universe: every Binance spot USDT pair that ever traded,
 * delisted ones included, minus assets with no price action of their own.
 * Liquidity is judged point in time by the backtest, never by today's ranking.
 */

/** Stablecoins, fiat and pegged/wrapped assets (as bases). */
const EXCLUDED_BASES = new Set([
  "USDC", "BUSD", "TUSD", "USDP", "PAX", "FDUSD", "DAI", "UST", "USTC", "SUSD", "GUSD", "USDS", "USDSB", "USDE", "USD1", "RLUSD",
  "XUSD", "BFUSD", "FRAX", "U", "KGST", "EUR", "EURI", "AEUR", "GBP", "AUD", "TRY", "BRL", "RUB", "NGN", "UAH", "BIDR", "IDRT",
  "BKRW", "ZAR", "PLN", "RON", "ARS", "JPY", "MXN", "COP", "CZK", "WBTC", "WBETH", "BNSOL", "BETH", "PAXG", "XAUT",
]);

/** Leveraged tokens (BTCUP, ETHDOWN, BULL, BEAR…) were products with decay, not coins. */
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;

export function inUniverse(symbol: string): boolean {
  if (!symbol.endsWith("USDT")) return false;
  const base = symbol.slice(0, -4);
  if (!base || EXCLUDED_BASES.has(base)) return false;
  if (LEVERAGED.test(base) && base.length > 4) return false;
  return /^[A-Z0-9]+$/.test(base);
}
