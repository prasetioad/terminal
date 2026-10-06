/**
 * MaxFlow+ and Stochastic only, on 1h candles: is there a tradable edge?
 *
 * No breadth, no RS, no other filter — only pairs trading ≥ $1M/day (tradability). Exit at
 * the first red dot, −15% stop (the shared engine, intervalMs = 1h, MaxFlow's bias on 4h).
 *
 *   variants  dot + stoch (5,3,3 or 14,3,3) · 5,3,3 only · 14,3,3 only · first dot only ·
 *             dot alone · no 4h bias
 *   costs     the gross edge per trade = the break-even cost; net at 0.04% (futures, limit
 *             orders), 0.1% (the research default) and 0.2% (spot, market orders)
 *
 *   npx tsx research/preload.ts 1h   (once)
 *   npx tsx research/h1.ts
 */
import fs from "node:fs";
import path from "node:path";
import { liquidity30d, runSetupV1, type SetupV1Config } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { compare, header, pct, simulate, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);

interface Variant {
  name: string;
  config: Omit<SetupV1Config, "intervalMs">;
}

const VARIANTS: Variant[] = [
  { name: "dot + stoch (5 or 14)", config: { stoch: "either" } },
  { name: "dot + stoch 5,3,3", config: { stoch: "5,3,3" } },
  { name: "dot + stoch 14,3,3", config: { stoch: "14,3,3" } },
  { name: "first dot + stoch", config: { stoch: "either", firstDotOnly: true } },
  { name: "dot alone", config: { stoch: "either", entry: "dot" } },
  { name: "dot + stoch, no 4h bias", config: { stoch: "either", htfBias: false } },
];

interface H1Trade extends Trade {
  gross: number;
}

async function main() {
  const trades: H1Trade[][] = VARIANTS.map(() => []);
  const symbols = (await archiveSymbols()).filter(inUniverse);
  let done = 0;
  for (const symbol of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of segments(all, 3 * DAY)) {
      if (c.length < 300) continue;
      VARIANTS.forEach((v, k) => {
        const r = runSetupV1(c, { ...v.config, intervalMs: H1 });
        for (const t of [...r.trades, ...(r.open ? [r.open] : [])]) {
          const liquidity = liquidity30d(c, t.entryIndex, H1);
          if (liquidity < 1e6) continue;
          const end = t.exitIndex ?? c.length - 1;
          const closes = c.slice(t.entryIndex, end + 1).map((b) => b.close);
          const exit = t.exitPrice ?? c[end].close;
          closes[closes.length - 1] = exit;
          trades[k].push({
            symbol, at: t.entryTime + H1, barMs: H1, entry: t.entryPrice, stopDist: 0.15, closes, exitBars: end - t.entryIndex, exit, open: t.exitIndex === null,
            liquidity, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null, gross: exit / t.entryPrice - 1,
          });
        }
      });
    }
    if (++done % 100 === 0) console.log(`  ${done}/${symbols.length} pairs`);
  }

  console.log("\nPER TRADE (pairs ≥ $1M/day, closed) — gross = break-even cost per round trip · net at 0.04% / 0.1% / 0.2%   IS 2021 → 2024-06 │ OOS 2024-07 → now");
  const stat = (xs: H1Trade[]) => {
    const r = xs.filter((t) => !t.open);
    if (!r.length) return "–";
    const g = r.reduce((s, t) => s + t.gross, 0) / r.length;
    const sd = Math.sqrt(r.reduce((s, t) => s + (t.gross - g) ** 2, 0) / Math.max(1, r.length - 1));
    const hold = r.reduce((s, t) => s + t.exitBars, 0) / r.length;
    return `n ${String(r.length).padStart(6)} · win ${((100 * r.filter((t) => t.gross > 0.001).length) / r.length).toFixed(0)}% · gross ${pct(g, 3)} (t=${((g / sd) * Math.sqrt(r.length)).toFixed(1)}) · net ${pct(g - 0.0004, 2)} / ${pct(g - 0.001, 2)} / ${pct(g - 0.002, 2)} · ${hold.toFixed(0)}h`;
  };
  VARIANTS.forEach((v, k) => {
    console.log(`  ${v.name.padEnd(26)} ${stat(trades[k].filter((t) => t.at < SPLIT))}`);
    console.log(`  ${"".padEnd(26)} ${stat(trades[k].filter((t) => t.at >= SPLIT))}`);
  });

  // Portfolio (1% risk at the −15% stop, ≤ 15 open, most liquid first). The simulator charges 0.1%
  // (+0.2% under $5M/day); a cost level is applied by moving the exit price.
  const sleeve = (xs: H1Trade[], cost: number): Sleeve => ({
    trades: xs.map((t) => ({ ...t, exit: t.exit * (1 + 0.001 - cost) })),
    risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 1,
  });
  for (const cost of [0.002, 0.001, 0.0004]) {
    header(`PORTFOLIO at ${(cost * 100).toFixed(2)}% per round trip (1% risk, ≤ 15 open)`);
    VARIANTS.forEach((v, k) => compare(v.name, [sleeve(trades[k], cost)]));
  }
  console.log("\nPER YEAR at 0.04% (the cheapest realistic cost): " + VARIANTS.slice(0, 4).map((v) => v.name).join(" │ "));
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    console.log(`  ${y}  ` + VARIANTS.slice(0, 4).map((_, k) => { const r = simulate([sleeve(trades[k], 0.0004)], from, to); return `${pct(r.cagr).padStart(7)} ${pct(r.maxDD).padStart(6)}`; }).join(" │ "));
  }
}

void main();
