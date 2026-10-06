/**
 * Liquid pairs for intraday research: spreads thin enough that a 5-minute strategy is not
 * eaten by slippage. Fixed list (the most liquid Binance USDT pairs with history since
 * 2022–2024); a survivorship caveat applies — these are today's survivors.
 *
 *   npx tsx research/intraday-pairs.ts      download 5m klines since 2022 (resumable)
 */
import { loadSeries } from "./data";

export const INTRADAY_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "DOTUSDT",
  "LTCUSDT", "BCHUSDT", "TRXUSDT", "NEARUSDT", "ATOMUSDT", "UNIUSDT", "AAVEUSDT", "ETCUSDT", "XLMUSDT", "FILUSDT",
  "INJUSDT", "ARBUSDT", "OPUSDT", "APTUSDT", "SUIUSDT", "PEPEUSDT", "SHIBUSDT", "WIFUSDT", "FETUSDT", "SEIUSDT",
];

async function main() {
  let done = 0;
  const failed: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < INTRADAY_PAIRS.length) {
        const s = INTRADAY_PAIRS[next++];
        try {
          const bars = await loadSeries(s, "5m", 2022);
          console.log(`${s}: ${bars.length} bars`);
        } catch (err) {
          failed.push(`${s}: ${(err as Error).message}`);
        }
        done++;
      }
    }),
  );
  console.log(`5m: done ${done - failed.length}/${INTRADAY_PAIRS.length}${failed.length ? `, failed (re-run):\n${failed.join("\n")}` : ""}`);
}

if (process.argv[1]?.endsWith("intraday-pairs.ts")) void main();
