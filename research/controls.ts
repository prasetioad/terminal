/**
 * Is the research harness biased toward our two setups? Controls run through the same portfolio
 * (research/momentum.ts simulate) and the same cost (0.2%):
 *
 *   POSITIVE   a cheating rule that sees tomorrow (buy at the close when the next close is ≥ 2%
 *              higher, sell then): the harness must show a huge edge, or it cannot see edges
 *   NEGATIVE   random entries with Setup A's exit (8×ATR stop and chandelier, spike tightening)
 *              and with v1.2's (−15% stop, out at the first red dot), as many per year as the real
 *              setups take, five seeds: if random entries match the setups, their edge is the exit
 *              or the market, not the signal
 *   PUBLIC     well-known rules: BTC above its 50-day average (else cash); weekly cross-sectional
 *              momentum (the 10 liquid coins with the best 30-day return, rebalanced each Monday);
 *              BTC buy and hold
 *
 * IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/controls.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { SETUP_A, atr } from "../lib/setups/setupA";
import { SETUP_V1, biasTimeframe, liquidity30d } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { type AT, type V1T, toTrade } from "./audit";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";
import { botTrades } from "./usdt-dominance";

const H4 = 4 * 3_600_000;
const DAY_MS = 86_400_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cost = <T extends Trade>(ts: T[]): T[] => ts.map((t) => ({ ...t, exit: t.exit * 0.999, closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * 0.999] }));
const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(8)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(6)} · ${r.perYear.toFixed(0).padStart(4)}/y win ${(100 * r.win).toFixed(0)}%`;
const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(44)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const { v1c, ac } = await botTrades(symbols);
  const v1s: Sleeve = { trades: v1c, accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 };
  const as: Sleeve = { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 };
  // how often the real setups enter, per pair-bar (accepted, liquid)
  let bars4 = 0;
  const series4: { symbol: string; c: ResearchBar[] }[] = [];
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[], 3 * DAY_MS)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      series4.push({ symbol: s, c });
      bars4 += c.length - SETUP_V1.warmup;
    }
  }
  const nA = ac.filter((t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs && t.liquidity >= 1e6).length;
  const nV = v1c.filter((t) => (t as V1T).breadth >= SETUP_V1.minBreadth && t.liquidity >= 1e6).length;
  const pA = nA / bars4;
  const pV = nV / bars4;

  console.log("REFERENCE (the bot's setups, cost 0.2%) — IS │ OOS");
  both("Setup A", [as]);
  both("v1.2", [v1s]);
  both("A + v1.2", [v1s, as]);

  // POSITIVE control
  const cheat: Trade[] = [];
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1d", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[], 3 * DAY_MS)) {
      for (let i = 30; i < c.length - 1; i++) if (c[i + 1].close >= c[i].close * 1.02) cheat.push(toTrade(s, c, DAY_MS, 0, i, i + 1, c[i + 1].close, 1));
    }
  }
  console.log("\nPOSITIVE CONTROL (sees tomorrow) — must be huge");
  both("cheat: next close ≥ +2%", [{ trades: cost(cheat), risk: 0.1, maxFrac: 0.1, maxOpen: 10, maxBarRisk: 1 }]);

  // NEGATIVE controls: random entries with each setup's exit
  console.log("\nNEGATIVE CONTROL (random entries, the setups' exits, 5 seeds) — IS │ OOS");
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed);
    const ra: Trade[] = [];
    const rv: Trade[] = [];
    for (const { symbol, c } of series4) {
      const candles = c as unknown as Candle[];
      const a = atr(candles, SETUP_A.atrLength);
      const mf = computeMaxFlow(candles, {
        scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: true, htfMs: biasTimeframe(H4), intervalMs: H4,
        dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
      });
      const red = new Uint8Array(c.length);
      for (let i = 1; i + 1 < c.length; i++) if (mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1] && mf.wt1[i] > 0) red[i + 1] = 1;
      // Setup A's exit from a random bar
      for (let s: number = SETUP_V1.warmup; s < c.length - 1; s++) {
        if (r() >= pA || liquidity30d(candles, s, H4) < 1e6) continue;
        const entry = c[s].close;
        const stopDist = (SETUP_A.atrMult * a[s]) / entry;
        if (stopDist > SETUP_A.maxStopPct) continue;
        const stop = entry * (1 - stopDist);
        let best = entry;
        let k: number = SETUP_A.atrMult;
        let x = s + 1;
        let px: number | null = null;
        for (; x < c.length; x++) {
          const b = c[x];
          if (b.low <= stop) {
            px = Math.min(b.open, stop);
            break;
          }
          if (b.close < best - k * a[x - 1]) {
            px = b.close;
            break;
          }
          best = Math.max(best, b.close);
          if (b.close > entry * (1 + 2 * SETUP_A.cost) && b.close > b.open && b.high - b.low >= SETUP_A.spikeTighten.range * a[x - 1]) k = Math.min(k, SETUP_A.spikeTighten.k);
        }
        ra.push(toTrade(symbol, c, H4, 0, s, px === null ? null : x, px, stopDist));
        if (px === null) break;
        s = x;
      }
      // v1.2's exit from a random bar
      for (let s: number = SETUP_V1.warmup; s < c.length - 1; s++) {
        if (r() >= pV || liquidity30d(candles, s, H4) < 1e6) continue;
        const stop = c[s].close * (1 - SETUP_V1.stopPct);
        let x = s + 1;
        let px: number | null = null;
        for (; x < c.length; x++) {
          if (c[x].low <= stop) {
            px = stop;
            break;
          }
          if (red[x]) {
            px = c[x].close;
            break;
          }
        }
        rv.push(toTrade(symbol, c, H4, 0, s, px === null ? null : x, px, SETUP_V1.stopPct));
        if (px === null) break;
        s = x;
      }
    }
    both(`seed ${seed} · random + A's exit (0.5% risk)`, [{ trades: cost(ra), risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 }]);
    both(`seed ${seed} · random + v1.2's exit (1% risk)`, [{ trades: cost(rv), risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 }]);
  }

  // PUBLIC rules on daily bars
  console.log("\nPUBLIC RULES (daily, cost 0.2%) — IS │ OOS");
  const btc: ResearchBar[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "1d", "BTCUSDT.json"), "utf8"));
  const trend: Trade[] = [];
  for (let i = 50; i < btc.length - 1; i++) {
    let sma = 0;
    for (let j = i - 49; j <= i; j++) sma += btc[j].close;
    sma /= 50;
    if (btc[i].close <= sma) continue;
    let x = i + 1;
    for (; x < btc.length; x++) {
      let m = 0;
      for (let j = x - 49; j <= x; j++) m += btc[j].close;
      if (btc[x].close <= m / 50) break;
    }
    const e = Math.min(x, btc.length - 1);
    trend.push(toTrade("BTCUSDT", btc, DAY_MS, 0, i, x < btc.length ? e : null, x < btc.length ? btc[e].close : null, 1));
    i = e;
  }
  both("BTC above its 50-day average, else cash", [{ trades: cost(trend), risk: 0.98, maxFrac: 0.98, maxOpen: 1, maxBarRisk: 1 }]);
  const hold: Trade[] = [toTrade("BTCUSDT", btc, DAY_MS, 0, btc.findIndex((b) => b.time * 1000 >= START), null, null, 1)];
  const holdOos: Trade[] = [toTrade("BTCUSDT", btc, DAY_MS, 0, btc.findIndex((b) => b.time * 1000 >= SPLIT), null, null, 1)];
  console.log(`  ${"BTC buy and hold".padEnd(44)} ${row(simulate([{ trades: hold, risk: 0.98, maxFrac: 0.98, maxOpen: 1, maxBarRisk: 1 }], START, SPLIT))} │ ${row(simulate([{ trades: holdOos, risk: 0.98, maxFrac: 0.98, maxOpen: 1, maxBarRisk: 1 }], SPLIT, END))}`);

  // weekly cross-sectional momentum: each Monday the 10 best 30-day returns among liquid coins, held 7 days
  const daily = new Map<string, ResearchBar[]>();
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "1d", `${s}.json`);
    if (fs.existsSync(file)) daily.set(s, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  const mom: Trade[] = [];
  for (let t = Date.UTC(2021, 1, 1) / 1000; t * 1000 < END; t += 86_400) {
    if (new Date(t * 1000).getUTCDay() !== 1) continue;
    const cands: { s: string; c: ResearchBar[]; i: number; r: number }[] = [];
    for (const [s, c] of daily) {
      const i = c.findIndex((b) => b.time === t - 86_400); // the last complete day (Sunday)
      if (i < 30 || i + 7 >= c.length || c[i + 7].time - c[i].time !== 7 * 86_400) continue;
      if (liquidity30d(c as unknown as Candle[], i, DAY_MS) < 5e6) continue;
      cands.push({ s, c, i, r: c[i].close / c[i - 30].close - 1 });
    }
    for (const x of cands.sort((a, b) => b.r - a.r).slice(0, 10)) mom.push(toTrade(x.s, x.c, DAY_MS, 0, x.i, x.i + 7, x.c[x.i + 7].close, 1));
  }
  both("weekly momentum: top 10 by 30-day return", [{ trades: cost(mom), risk: 0.1, maxFrac: 0.1, maxOpen: 10, maxBarRisk: 1 }]);
}

if (process.argv[1]?.endsWith("controls.ts")) void main();
