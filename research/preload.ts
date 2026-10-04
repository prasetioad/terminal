/**
 * Fill the kline cache for one interval over the whole universe (resumable).
 *
 *   npx tsx research/preload.ts 1h
 */
import { archiveSymbols, loadSeries } from "./data";
import { inUniverse } from "./universe";

async function main() {
  const interval = process.argv[2] ?? "4h";
  const symbols = (await archiveSymbols()).filter(inUniverse);
  let done = 0;
  let next = 0;
  const failed: string[] = [];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < symbols.length) {
        const symbol = symbols[next++];
        try {
          await loadSeries(symbol, interval, 2021);
        } catch (err) {
          failed.push(`${symbol}: ${(err as Error).message}`);
        }
        if (++done % 25 === 0) console.log(`${interval}: ${done}/${symbols.length}`);
      }
    }),
  );
  console.log(`${interval}: done ${done - failed.length}/${symbols.length}${failed.length ? `, failed (re-run to retry):\n${failed.join("\n")}` : ""}`);
}

void main();
