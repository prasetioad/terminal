/**
 * Bias audit of the bot's setups (v1.2 + Setup A, shared capital, the bot's rules): does the
 * edge survive what a real edge should survive, or is it a 4h artefact?
 *
 *   1  bar alignment   4h bars starting at 00/04/08… UTC (Binance's), and the same bars
 *                      shifted by 1, 2 and 3 hours — a real edge cannot depend on the clock
 *   2  timeframe       the same engines on 1h, 2h, 3h, 6h, 8h and 12h bars (indicator lengths in
 *                      bars, as a trader would apply them on another chart; Setup A's volume
 *                      surge is per day on every timeframe)
 *   3  costs           0.1% per round trip (what the research used for liquid pairs), 0.2% (spot
 *                      taker both ways, what the bot pays) and 0.3% (with slippage); pairs under
 *                      $5M/day pay 0.2% more as before
 *   4  parameters      on 4h: breadth 7 / 10 / 13, Setup A's RS −5 / −10 / −15%, volume 1.2 / 1.5 / 2×
 *
 * All bars are built from the 1h cache, so 4h+0h must match the native 4h results. Trades come
 * from the bot's own engines (lib/setups/setupV1.ts, setupA.ts) and run through the research
 * portfolio (research/momentum.ts simulate): v1 risk 1%, A 0.5%, ≤ 15 each, one position per
 * pair across both, ≤ 5% / 2.5% new risk per bar. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/audit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, runSetupA } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H = 3_600_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

interface Config {
  name: string;
  hours: number;
  offset: number; // hours
}
const CONFIGS: Config[] = [
  { name: "4h (Binance, 00 UTC)", hours: 4, offset: 0 },
  { name: "4h shifted +1h", hours: 4, offset: 1 },
  { name: "4h shifted +2h", hours: 4, offset: 2 },
  { name: "4h shifted +3h", hours: 4, offset: 3 },
  { name: "1h", hours: 1, offset: 0 },
  { name: "2h", hours: 2, offset: 0 },
  { name: "3h", hours: 3, offset: 0 },
  { name: "6h", hours: 6, offset: 0 },
  { name: "8h", hours: 8, offset: 0 },
  { name: "12h", hours: 12, offset: 0 },
];

export interface V1T extends Trade {
  breadth: number;
}
export interface AT extends Trade {
  rsA: number | null;
  surgeA: number;
}

/** 1h bars → `hours` bars starting at `offset` (UTC); only complete bars. */
export function aggregate(bars: ResearchBar[], hours: number, offset: number): ResearchBar[] {
  if (hours === 1) return bars;
  const sec = hours * 3600;
  const off = offset * 3600;
  const out: ResearchBar[] = [];
  let count = 0;
  for (const b of bars) {
    const t = Math.floor((b.time - off) / sec) * sec + off;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      last.quoteVolume += b.quoteVolume;
      last.buyVolume = (last.buyVolume ?? 0) + (b.buyVolume ?? 0);
      count++;
    } else {
      if (last && count !== hours) out.pop();
      out.push({ ...b, time: t as ResearchBar["time"] });
      count = 1;
    }
  }
  if (out.length && count !== hours) out.pop();
  return out;
}

export const load1h = (symbol: string): ResearchBar[] | null => {
  const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};

/** One engine trade → the portfolio's Trade (closes from entry to exit for marking). */
export function toTrade(symbol: string, c: ResearchBar[], barMs: number, offset: number, e: number, x: number | null, exitPrice: number | null, stopDist: number): Trade {
  const end = x ?? c.length - 1;
  const closes = c.slice(e, end + 1).map((b) => b.close);
  if (exitPrice !== null) closes[closes.length - 1] = exitPrice;
  return {
    // the portfolio steps on a grid from 00:00 UTC: shifted bars are booked `offset` earlier
    // (the same for every pair, so the order of events is unchanged)
    symbol, at: c[e].time * 1000 + barMs - offset * H, barMs, entry: c[e].close, stopDist, closes, exitBars: end - e, exit: exitPrice ?? c[end].close,
    open: x === null, liquidity: liquidity30d(c as unknown as Candle[], e, barMs), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null,
  };
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const btc1h = load1h("BTCUSDT");
  if (!btc1h) throw new Error("BTCUSDT 1h missing");
  const btc = new Map(CONFIGS.map((k) => [k.name, aggregate(btc1h, k.hours, k.offset)]));
  const v1 = new Map<string, V1T[]>(CONFIGS.map((k) => [k.name, []]));
  const a = new Map<string, AT[]>(CONFIGS.map((k) => [k.name, []]));
  const signals = new Map<string, Map<number, number>>(CONFIGS.map((k) => [k.name, new Map()]));

  let done = 0;
  for (const symbol of symbols) {
    const bars = load1h(symbol);
    if (!bars) continue;
    for (const k of CONFIGS) {
      const barMs = k.hours * H;
      const all = aggregate(bars, k.hours, k.offset);
      for (const c of segments(all, Math.max(3 * 86_400_000, 6 * barMs))) {
        if (c.length < SETUP_V1.warmup + 30) continue;
        const candles = c as unknown as Candle[];
        // breadth counts every v1 signal (not only first dots), as the bot does
        const base = runSetupV1(candles, { stoch: "either", intervalMs: barMs });
        const sig = signals.get(k.name) ?? new Map();
        for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) sig.set(t.entryTime + barMs - k.offset * H, (sig.get(t.entryTime + barMs - k.offset * H) ?? 0) + 1);
        const first = runSetupV1(candles, { stoch: "either", intervalMs: barMs, firstDotOnly: true });
        for (const t of [...first.trades, ...(first.open ? [first.open] : [])]) {
          v1.get(k.name)?.push({ ...toTrade(symbol, c, barMs, k.offset, t.entryIndex, t.exitIndex, t.exitPrice, SETUP_V1.stopPct), breadth: 0 });
        }
        const ra = runSetupA(candles, barMs, { btc: btc.get(k.name) as unknown as Candle[], spikeTighten: SETUP_A.spikeTighten });
        for (const t of [...ra.trades, ...(ra.open ? [ra.open] : [])]) {
          a.get(k.name)?.push({ ...toTrade(symbol, c, barMs, k.offset, t.entryIndex, t.exitIndex, t.exitPrice, 1 - t.stopPrice / t.entryPrice), rsA: t.rs, surgeA: t.surge });
        }
      }
    }
    if (++done % 100 === 0) console.log(`  ${done} pairs…`);
  }
  for (const k of CONFIGS) for (const t of v1.get(k.name) ?? []) t.breadth = signals.get(k.name)?.get(t.at) ?? 0;

  /** Extra round-trip cost on top of the research's 0.1%: lowers each exit (and its last mark). */
  const withCost = <T extends Trade>(ts: T[], extra: number): T[] =>
    extra === 0 ? ts : ts.map((t) => ({ ...t, exit: t.exit * (1 - extra), closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * (1 - extra)] }));
  const sleeves = (name: string, extra: number, o: { breadth?: number; rs?: number; surge?: number } = {}): Sleeve[] => [
    { trades: withCost(v1.get(name) ?? [], extra), accept: (t) => (t as V1T).breadth >= (o.breadth ?? SETUP_V1.minBreadth), risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 },
    {
      trades: withCost(a.get(name) ?? [], extra),
      accept: (t) => {
        const x = t as AT;
        return x.surgeA >= (o.surge ?? SETUP_A.minSurge) && x.rsA !== null && x.rsA < (o.rs ?? SETUP_A.maxRs);
      },
      risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025,
    },
  ];
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y win ${(100 * r.win).toFixed(0)}%`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(34)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);

  console.log("\n1 + 2 · BAR ALIGNMENT AND TIMEFRAME (bot rules, research cost 0.1%) — IS │ OOS");
  for (const k of CONFIGS) {
    const [sv1, sa] = sleeves(k.name, 0);
    both(k.name, [sv1, sa]);
    both("    v1.2 alone", [sv1]);
    both("    Setup A alone", [sa]);
  }

  console.log("\n3 · COSTS (4h, Binance alignment) — IS │ OOS");
  for (const [label, extra] of [["0.1% (research so far)", 0], ["0.2% (spot taker both ways)", 0.001], ["0.3% (with slippage)", 0.002]] as const) both(label, sleeves(CONFIGS[0].name, extra));
  console.log("  and at 0.2% on the shifted 4h bars:");
  for (const k of CONFIGS.slice(1, 4)) both(k.name, sleeves(k.name, 0.001));

  console.log("\n4 · PARAMETERS (4h, cost 0.2%) — IS │ OOS");
  for (const b of [7, 10, 13]) both(`v1 breadth ≥ ${b}`, sleeves(CONFIGS[0].name, 0.001, { breadth: b }));
  for (const rs of [-0.05, -0.1, -0.15]) both(`A RS < ${(rs * 100).toFixed(0)}%`, sleeves(CONFIGS[0].name, 0.001, { rs }));
  for (const surge of [1.2, 1.5, 2]) both(`A volume ≥ ${surge}×`, sleeves(CONFIGS[0].name, 0.001, { surge }));

  console.log("\nPER YEAR (4h, cost 0.2%): CAGR / DD");
  const s = sleeves(CONFIGS[0].name, 0.001);
  const years: string[] = [];
  for (let y = 2021; y <= 2026; y++) {
    const r = simulate(s, Date.UTC(y, 0, 1), Math.min(Date.UTC(y + 1, 0, 1), END));
    years.push(`${y} ${pct(r.cagr)} / ${pct(r.maxDD)}`);
  }
  console.log(`  ${years.join(" · ")}`);
}

if (process.argv[1]?.endsWith("audit.ts")) void main();
