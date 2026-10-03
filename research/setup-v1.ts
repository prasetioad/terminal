/**
 * Setup v1 on a survivorship-free universe (docs/ROADMAP.md, stage 2).
 *
 *   npx tsx research/setup-v1.ts [--stoch either|5,3,3|14,3,3] [--from 2021]
 *
 * Every Binance spot USDT pair that traded since --from (delisted ones included),
 * through the same engine the app and the bot use (lib/setups/setupV1.ts). A trade
 * counts only if the pair was liquid when the signal fired: trailing 30-day average
 * daily quote volume ≥ the threshold, measured on data available at that moment.
 * Breadth = how many pairs signalled on the same bar (the v1.1 filter). Portfolios
 * take entries the way the bot does: most liquid first, ≤ 15 open, 1% risk each.
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_V1, liquidity30d, runSetupV1, type SetupTrade, type StochPreset } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, loadSeries, segments, type ResearchBar } from "./data";
import { inUniverse } from "./universe";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const STOCH = arg("stoch", "either") as StochPreset;
const FROM_YEAR = Number(arg("from", "2021"));
const INTERVAL = "4h";
const BAR_MS = SETUP_V1.validatedInterval;
const SPLIT = Date.UTC(2024, 6, 1); // in-sample before, out-of-sample after (as in the roadmap)
const LIQUIDITY = [0, 1e6, 5e6]; // trailing 30-day average daily quote volume, USDT
const BREADTH = [1, 5, SETUP_V1.minBreadth, 15, 25];
const DAY = 86_400_000;
const CONCURRENCY = 6; // symbols at a time (downloads are capped globally in data.ts)

interface Trade extends SetupTrade {
  symbol: string;
  liquidity: number; // trailing 30-day average daily quote volume at entry
  alive: boolean; // the pair still trades today
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  console.log(`universe: ${symbols.length} USDT spot pairs in the archive (listed and delisted)`);

  const trades: Trade[] = [];
  let loaded = 0;
  let next = 0;
  const lastBarCutoff = Date.now() - 7 * DAY;
  const worker = async () => {
    while (next < symbols.length) {
      const symbol = symbols[next++];
      let bars: ResearchBar[];
      try {
        bars = await loadSeries(symbol, INTERVAL, FROM_YEAR);
      } catch (err) {
        console.warn(`skip ${symbol}: ${(err as Error).message}`);
        continue;
      }
      loaded++;
      if (loaded % 50 === 0) console.log(`  loaded ${loaded}/${symbols.length}`);
      if (bars.length === 0) continue;
      const alive = bars.at(-1)!.time * 1000 > lastBarCutoff;
      for (const seg of segments(bars, 3 * DAY)) {
        if (seg.length < SETUP_V1.warmup + 30) continue;
        const result = runSetupV1(seg, { stoch: STOCH, intervalMs: BAR_MS });
        for (const t of result.trades) trades.push({ ...t, symbol, liquidity: liquidity30d(seg, t.entryIndex, BAR_MS), alive });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(path.join(CACHE_DIR, `setup-v1-trades-${STOCH}.json`), JSON.stringify(trades));
  report(trades);
}

/* ───────────────────────────── statistics ───────────────────────────── */

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(2)}%`;

function stats(rets: number[]) {
  const n = rets.length;
  if (n < 2) return { n, mean: 0, t: 0, win: 0, text: `n=${n}` };
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const win = rets.filter((r) => r > 0).length / n;
  const t = (mean / sd) * Math.sqrt(n);
  return { n, mean, t, win, text: `n=${String(n).padStart(4)} win ${(win * 100).toFixed(0)}% avg ${pct(mean).padStart(7)} t=${t.toFixed(1).padStart(4)}` };
}

/** 95% bootstrap interval of the mean (seeded, reproducible). */
function bootstrap(rets: number[], draws = 4000): [number, number] {
  if (rets.length < 5) return [Number.NaN, Number.NaN];
  // mulberry32: integer-exact (a plain LCG overflows double precision and skews the draws)
  let seed = 42;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let k = 0; k < rets.length; k++) s += rets[Math.floor(rand() * rets.length)];
    means.push(s / rets.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(draws * 0.025)], means[Math.floor(draws * 0.975)]];
}

/** 1% equity risk per trade with the −15% stop (≈ 6.7% position), at most 15 open. */
function portfolio(ts: Trade[], from: number, to: number) {
  const events = ts.filter((t) => t.entryTime >= from && t.entryTime < to).sort((a, b) => a.entryTime - b.entryTime || b.liquidity - a.liquidity);
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  const open: { exit: number; size: number; ret: number }[] = [];
  const settle = (until: number) => {
    open.sort((a, b) => a.exit - b.exit);
    while (open.length && open[0].exit <= until) {
      const o = open.shift()!;
      equity += o.size * o.ret;
      peak = Math.max(peak, equity);
      maxDD = Math.min(maxDD, equity / peak - 1);
    }
  };
  for (const t of events) {
    settle(t.entryTime);
    if (open.length >= 15) continue;
    open.push({ exit: t.exitTime!, size: (0.01 / SETUP_V1.stopPct) * equity, ret: t.ret! });
  }
  settle(Number.POSITIVE_INFINITY);
  const years = (to - from) / (365.25 * DAY);
  return `CAGR ${pct(Math.pow(equity, 1 / years) - 1).padStart(8)} · maxDD ${pct(maxDD)}`;
}

function report(all: Trade[]) {
  const start = Date.UTC(FROM_YEAR, 0, 1);
  const breadthOf = new Map<number, number>();
  for (const t of all) breadthOf.set(t.entryTime, (breadthOf.get(t.entryTime) ?? 0) + 1);
  console.log(`\nSetup v1 · stoch ${STOCH} · ${INTERVAL} · ${new Set(all.map((t) => t.symbol)).size} pairs with trades · ${all.length} trades · cost ${SETUP_V1.cost * 100}% · stop −${SETUP_V1.stopPct * 100}%`);
  for (const min of LIQUIDITY) {
    console.log(`\n── liquidity ≥ $${(min / 1e6).toFixed(0)}M/day at entry ──`);
    for (const b of BREADTH) {
      const ts = all.filter((t) => t.liquidity >= min && breadthOf.get(t.entryTime)! >= b);
      const IS = ts.filter((t) => t.entryTime < SPLIT).map((t) => t.ret!);
      const OOS = ts.filter((t) => t.entryTime >= SPLIT).map((t) => t.ret!);
      const [lo, hi] = bootstrap(OOS);
      console.log(`  breadth ≥ ${String(b).padStart(2)} · in-sample ${stats(IS).text} · ${portfolio(ts, start, SPLIT)}`);
      console.log(`               out-of-sample ${stats(OOS).text} · ${portfolio(ts, SPLIT, Date.now())} · 95% CI [${pct(lo)}, ${pct(hi)}]`);
      if (b === SETUP_V1.minBreadth) {
        const years = [...new Set(ts.map((t) => new Date(t.entryTime).getUTCFullYear()))].sort();
        console.log(`               by year ${years.map((y) => `${y} ${pct(stats(ts.filter((t) => new Date(t.entryTime).getUTCFullYear() === y).map((t) => t.ret!)).mean)}`).join(" · ")}`);
        console.log(`               still listed ${stats(ts.filter((t) => t.alive).map((t) => t.ret!)).text} · delisted ${stats(ts.filter((t) => !t.alive).map((t) => t.ret!)).text}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
