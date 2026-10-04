/**
 * The owner's method on daily candles, nothing else: no breadth, no liquidity filter.
 *
 *   A  MaxFlow+ green dot, then a Stochastic cross up from below 20 (5,3,3 or 14,3,3)
 *   B  MaxFlow+ green dot alone (entry on the bar the dot is known)
 *
 * Both: −15% stop, exit at the first red dot. Daily bars are built from the cached 4h
 * bars (UTC days, as Binance's 1d klines). MaxFlow's bias is then the weekly WaveTrend.
 * Same 4h rules shown for reference.
 *
 *   npx tsx research/daily.ts
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, type ResearchBar } from "./data";
import { collect, compare, dotStoch, header, loadContext, pct, simulate, type Sleeve, type Trade } from "./momentum";

const DAY = 86_400_000;
const H4 = 4 * 3_600_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);

/** research/.cache/klines/1d from the 4h cache (once). */
async function buildDaily(): Promise<void> {
  const dir = path.join(CACHE_DIR, "klines", "1d");
  fs.mkdirSync(dir, { recursive: true });
  for (const symbol of await archiveSymbols()) {
    const src = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    const dst = path.join(dir, `${symbol}.json`);
    if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
    const bars: ResearchBar[] = JSON.parse(fs.readFileSync(src, "utf8"));
    const days: ResearchBar[] = [];
    for (const b of bars) {
      const t = (Math.floor((b.time * 1000) / DAY) * DAY) / 1000;
      const d = days.at(-1);
      if (d && d.time === t) {
        d.high = Math.max(d.high, b.high);
        d.low = Math.min(d.low, b.low);
        d.close = b.close;
        d.volume += b.volume;
        d.quoteVolume += b.quoteVolume;
        d.buyVolume = (d.buyVolume ?? 0) + (b.buyVolume ?? 0);
      } else days.push({ ...b, time: t as Candle["time"] });
    }
    // The current UTC day is still forming: drop it unless all six 4h bars are in.
    const last = days.at(-1);
    if (last && bars.filter((b) => b.time >= last.time).length < 6) days.pop();
    fs.writeFileSync(dst, JSON.stringify(days));
  }
}

const net = (t: Trade) => t.exit / t.entry - 1 - 0.001 - (t.liquidity < 5e6 ? 0.002 : 0);

function perTrade(label: string, trades: Trade[]) {
  const stat = (xs: Trade[]) => {
    const r = xs.filter((t) => !t.open).map(net);
    if (!r.length) return "–".padEnd(52);
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, r.length - 1));
    const hold = xs.filter((t) => !t.open).reduce((a, t) => a + (t.exitBars * t.barMs) / DAY, 0) / r.length;
    return `n ${String(r.length).padStart(5)} win ${((100 * r.filter((x) => x > 0).length) / r.length).toFixed(0)}% avg ${pct(mean, 2).padStart(7)} t=${((mean / sd) * Math.sqrt(r.length)).toFixed(1).padStart(4)} hold ${hold.toFixed(0).padStart(2)}d`;
  };
  console.log(`  ${label.padEnd(40)} ${stat(trades.filter((t) => t.at >= START && t.at < SPLIT))} │ ${stat(trades.filter((t) => t.at >= SPLIT))}`);
}

async function main() {
  await buildDaily();
  const ctx = await loadContext();
  const [dStoch, dDot] = await collect(
    [dotStoch({ trend: false, barMs: DAY, label: "1D dot + stoch" }), dotStoch({ trend: false, barMs: DAY, label: "1D dot only", entry: "dot" })],
    "1d",
    ctx,
  );
  const [hStoch, hDot] = await collect(
    [dotStoch({ trend: false, barMs: H4, label: "4h dot + stoch" }), dotStoch({ trend: false, barMs: H4, label: "4h dot only", entry: "dot" })],
    "4h",
    ctx,
  );
  const all: [string, Trade[]][] = [
    ["1D · MaxFlow + Stochastic", dStoch],
    ["1D · MaxFlow only", dDot],
    ["4h · MaxFlow + Stochastic (reference)", hStoch],
    ["4h · MaxFlow only (reference)", hDot],
  ];

  console.log("PER TRADE, every signal (no breadth, no filter; costs included) — IS 2021 → 2024-06 │ OOS 2024-07 → now");
  for (const [label, trades] of all) perTrade(label, trades);
  console.log("\nPER TRADE, pairs trading ≥ $1M/day");
  for (const [label, trades] of all) perTrade(label, trades.filter((t) => t.liquidity >= 1e6));

  // The simulator skips pairs under $1M/day: lift the floor so "no filter" means no filter
  // (the extra slippage below $5M/day still applies).
  const unfiltered = (xs: Trade[]) => xs.map((t) => ({ ...t, liquidity: Math.max(t.liquidity, 1e6) }));
  const sleeve = (trades: Trade[]): Sleeve => ({ trades: unfiltered(trades), risk: 0.01, maxFrac: 0.2, maxOpen: 15, maxBarRisk: 1 });
  header("PORTFOLIO (1% risk at the −15% stop, ≤ 15 open, most liquid first)");
  for (const [label, trades] of all) compare(label, [sleeve(trades)]);

  console.log("\nPER YEAR (portfolio): 1D MaxFlow + Stochastic │ 1D MaxFlow only");
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (xs: Trade[]) => {
      const r = simulate([sleeve(xs)], from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} (${r.trades} tr, win ${(100 * r.win).toFixed(0)}%)`;
    };
    console.log(`  ${y}  ${f(dStoch).padEnd(42)} │ ${f(dDot)}`);
  }
}

void main();
