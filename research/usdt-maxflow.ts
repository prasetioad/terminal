/**
 * MaxFlow+ on USDT dominance (owner's reading): a green dot on USDT.D (dominance oversold and
 * turning up) warns that BTC's rise is about to turn down; a red dot (dominance overbought and
 * turning down) that the market is about to rise.
 *
 * USDT.D proxy candles = USDT supply ÷ (BTC + ETH market cap), per 4h and per day (see
 * research/usdt-dominance.ts): close/open from the coins' closes/opens, high from their lows and
 * low from their highs (an approximation — the two coins' extremes need not coincide). MaxFlow
 * as on the chart (OB/OS filter), with its usual bias (4h → 1D, 1D → 1W) and without.
 *
 *   1  event study: after each dot, BTC's and the liquid universe's return over the next 1, 3, 7
 *      and 14 days, against the average over all days
 *   2  the bot (4h, its rules, cost 0.2%): no new entries while the last USDT.D dot is green
 *      (until the next red one), or for 7 days after a green dot
 *
 * Dots count from the bar they become known (the cross bar + 1). IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/usdt-maxflow.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { SETUP_A } from "../lib/setups/setupA";
import { SETUP_V1, biasTimeframe } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import type { AT, V1T } from "./audit";
import { CACHE_DIR, archiveSymbols, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";
import { botTrades, supply, usdtSupply } from "./usdt-dominance";

const DAY = 86_400;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

const bars = (tf: string, symbol: string): ResearchBar[] => JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", tf, `${symbol}.json`), "utf8"));

/** USDT.D proxy candles on `tf` (time in seconds, as the coins' bars). */
function proxy(tf: string, usdt: Map<number, number>): Candle[] {
  const eth = new Map(bars(tf, "ETHUSDT").map((b) => [b.time, b]));
  const out: Candle[] = [];
  for (const b of bars(tf, "BTCUSDT")) {
    const e = eth.get(b.time);
    const u = usdt.get(Math.floor(b.time / DAY) * DAY);
    if (!e || u === undefined) continue;
    const sb = supply("BTC", b.time);
    const se = supply("ETH", b.time);
    const cap = (pb: number, pe: number) => pb * sb + pe * se;
    out.push({ time: b.time, open: u / cap(b.open, e.open), high: u / cap(b.low, e.low), low: u / cap(b.high, e.high), close: u / cap(b.close, e.close), volume: 1, buyVolume: 0.5 } as Candle);
  }
  return out;
}

interface Dot {
  known: number; // ms: the close of the bar on which the dot is known
  kind: "green" | "red";
}

function dots(c: Candle[], barMs: number, bias: boolean): Dot[] {
  const mf = computeMaxFlow(c, {
    scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: bias, htfMs: biasTimeframe(barMs), intervalMs: barMs,
    dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
  });
  return mf.dots
    .filter((d) => (d.kind === "green" || d.kind === "red") && d.index + 1 < c.length)
    .map((d) => ({ known: c[d.index + 1].time * 1000 + barMs, kind: d.kind as "green" | "red" }));
}

async function main() {
  const usdt = await usdtSupply();
  const symbols = (await archiveSymbols()).filter(inUniverse);

  // daily equal-weight index of the liquid universe, and BTC's daily closes
  const sum = new Map<number, number>();
  const cnt = new Map<number, number>();
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1d", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    const c: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (let i = 30; i < c.length; i++) {
      if (c[i].time - c[i - 1].time !== DAY) continue;
      let q = 0;
      for (let j = i - 30; j < i; j++) q += c[j].quoteVolume;
      const r = c[i].close / c[i - 1].close - 1;
      if (q / 30 < 5e6 || Math.abs(r) > 0.9) continue;
      sum.set(c[i].time, (sum.get(c[i].time) ?? 0) + r);
      cnt.set(c[i].time, (cnt.get(c[i].time) ?? 0) + 1);
    }
  }
  const uniDays = [...sum.keys()].sort((a, b) => a - b);
  const uniIdx = new Map<number, number>();
  let level = 1;
  for (const d of uniDays) {
    level *= 1 + (sum.get(d) ?? 0) / (cnt.get(d) ?? 1);
    uniIdx.set(d, level);
  }
  const btcDay = new Map(bars("1d", "BTCUSDT").map((b) => [b.time, b.close]));
  /** Return from the close of the day containing `ms` (the last complete day) to `h` days later. */
  const fwd = (series: Map<number, number>, ms: number, h: number) => {
    const d = Math.floor(ms / 1000 / DAY) * DAY - DAY;
    const a = series.get(d);
    const b = series.get(d + h * DAY);
    return a !== undefined && b !== undefined ? b / a - 1 : null;
  };

  const sets = [
    { name: "4h, bias 1D", tf: "4h", barMs: 4 * 3_600_000, bias: true },
    { name: "4h, no bias", tf: "4h", barMs: 4 * 3_600_000, bias: false },
    { name: "1D, bias 1W", tf: "1d", barMs: 86_400_000, bias: true },
    { name: "1D, no bias", tf: "1d", barMs: 86_400_000, bias: false },
  ];
  const allDots = new Map<string, Dot[]>();
  for (const s of sets) allDots.set(s.name, dots(proxy(s.tf, usdt), s.barMs, s.bias));

  console.log("1 · AFTER A DOT ON USDT.D: mean return over the next 1 / 3 / 7 / 14 days (share positive at 7 days)\n");
  const HS = [1, 3, 7, 14];
  const baseline = (series: Map<number, number>, from: number, to: number) =>
    HS.map((h) => {
      const xs: number[] = [];
      for (let d = from; d < to; d += 86_400_000) {
        const r = fwd(series, d, h);
        if (r !== null) xs.push(r);
      }
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    });
  for (const [label, from, to] of [["IS", START, SPLIT], ["OOS", SPLIT, END]] as const) {
    console.log(`${label}`);
    console.log(`  every day (baseline)        BTC ${baseline(btcDay, from, to).map((x) => pct(x, 1).padStart(6)).join(" ")} │ universe ${baseline(uniIdx, from, to).map((x) => pct(x, 1).padStart(6)).join(" ")}`);
    for (const s of sets) {
      for (const kind of ["green", "red"] as const) {
        const ds = (allDots.get(s.name) ?? []).filter((d) => d.kind === kind && d.known >= from && d.known < to);
        const col = (series: Map<number, number>) =>
          HS.map((h) => {
            const xs = ds.map((d) => fwd(series, d.known, h)).filter((x): x is number => x !== null);
            return xs.length ? pct(xs.reduce((a, b) => a + b, 0) / xs.length, 1).padStart(6) : "     –";
          }).join(" ");
        const pos7 = ds.map((d) => fwd(uniIdx, d.known, 7)).filter((x): x is number => x !== null);
        console.log(`  ${s.name.padEnd(12)} ${kind.padEnd(5)} n ${String(ds.length).padStart(3)}  BTC ${col(btcDay)} │ universe ${col(uniIdx)} (up at 7d: ${pos7.length ? ((100 * pos7.filter((x) => x > 0).length) / pos7.length).toFixed(0) : "–"}%)`);
      }
    }
  }

  console.log("\n2 · THE BOT WITH A USDT.D GATE (4h, cost 0.2%) — IS │ OOS");
  const { v1c, ac } = await botTrades(symbols);
  type Gate = (t: Trade) => boolean;
  /** No entry while the last dot known at the entry is green. */
  const lastNotGreen = (ds: Dot[]): Gate => (t) => {
    let last: Dot | null = null;
    for (const d of ds) {
      if (d.known > t.at) break;
      last = d;
    }
    return last?.kind !== "green";
  };
  /** No entry within 7 days after a green dot. */
  const coolGreen = (ds: Dot[]): Gate => (t) => !ds.some((d) => d.kind === "green" && d.known <= t.at && t.at - d.known < 7 * 86_400_000);
  const book = (g: Gate): Sleeve[] => [
    { trades: v1c, accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth && g(t), risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 },
    { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs && g(t), risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 },
  ];
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(42)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  both("today (no gate)", book(() => true));
  for (const s of sets) {
    const ds = (allDots.get(s.name) ?? []).sort((a, b) => a.known - b.known);
    both(`last dot not green (${s.name})`, book(lastNotGreen(ds)));
    both(`7 days after a green dot (${s.name})`, book(coolGreen(ds)));
  }
  console.log("\nDots on the USDT.D proxy (1D, bias 1W), last 12:");
  for (const d of (allDots.get("1D, bias 1W") ?? []).slice(-12)) console.log(`  ${new Date(d.known).toISOString().slice(0, 10)} ${d.kind}`);
}

if (process.argv[1]?.endsWith("usdt-maxflow.ts")) void main();
