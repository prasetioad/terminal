/**
 * Value-area confirmation trades (Fabio Valentini's auction approach, as proposed by the
 * owner): at VAH / VAL, wait for the market to show acceptance or rejection, long only.
 * Profiles come from lib/profile.ts (the chart's Volume Profile: 60 rows, value area 70%),
 * built from the bars before each UTC day and fixed for that day. Rules fixed before
 * looking at results:
 *
 *   VAH continuation   a close above VAH (the previous close at or below it) → within W bars
 *                      the first bar to come back within `tol` of VAH is the retest: it closes
 *                      above VAH → buy that close (it closes below → failed, no trade).
 *                      Stop: under the lower of the retest's low and VAH, by `buf`. Target 2R.
 *                      Variant: the breakout bar's volume ≥ 1.5× its 20-bar average.
 *   VAL failed breakdown  a close below VAL (the previous close at or above it) → within W bars
 *                      a close back above VAL (the reclaim; none → no trade) → within W bars
 *                      the retest: the first bar to come back within `tol` of VAL closes above
 *                      it → buy that close. Stop: under the lowest low since the breakdown, by
 *                      `buf`. Target: the POC (skipped when it is less than 1R away).
 *                      Variant: a MaxFlow green dot in the 12 bars before the entry.
 *   both               out after H bars at the latest; a stop and a target in the same bar
 *                      count as the stop; one position per pair and rule at a time.
 *
 *   swing     1h bars of the whole universe (≥ $5M/day), profile of the previous 30 days,
 *             W 24, tol 0.2%, buf 0.5%, stop ≤ 8%, H 72
 *   intraday  5m bars of 30 liquid pairs, profile of the previous day, W 24, tol 0.05%,
 *             buf 0.1%, stop 0.15–2%, H 48
 *
 * Gross per trade = the break-even cost; net at 0.2% (spot) and 0.04% (futures, maker). Per
 * event = all trades entered in the same hour count as one. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/value-area.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { buildProfile } from "../lib/profile";
import { biasTimeframe } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { cell, prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const SPLIT = Date.UTC(2024, 6, 1);
const DAY = 86_400;

export interface Scale {
  name: string;
  barMs: number;
  profileBars: number;
  window: number;
  tol: number;
  buf: number;
  minStop: number;
  maxStop: number;
  hold: number;
}

const SWING: Scale = { name: "swing 1h", barMs: 3_600_000, profileBars: 720, window: 24, tol: 0.002, buf: 0.005, minStop: 0, maxStop: 0.08, hold: 72 };
export const INTRADAY: Scale = { name: "intraday 5m", barMs: 300_000, profileBars: 288, window: 24, tol: 0.0005, buf: 0.001, minStop: 0.0015, maxStop: 0.02, hold: 48 };

export interface Levels {
  vah: number;
  val: number;
  poc: number;
}

/** Per bar, the value area of the bars before its UTC day (null when there is not enough history). */
export function dailyLevels(c: ResearchBar[], s: Scale): (Levels | null)[] {
  const out: (Levels | null)[] = new Array(c.length).fill(null);
  let current: Levels | null = null;
  for (let i = 0; i < c.length; i++) {
    if (i === 0 || Math.floor(c[i].time / DAY) !== Math.floor(c[i - 1].time / DAY)) {
      current = null;
      const from = i - s.profileBars;
      // the profile's bars must be contiguous
      if (from >= 0 && c[i].time - c[from].time === (s.profileBars * s.barMs) / 1000) {
        const p = buildProfile(c as unknown as Candle[], from, i - 1, { rows: 60, valueAreaPct: 70, lvnRatio: 0.35 });
        if (p) current = { val: p.rows[p.vaLow].low, vah: p.rows[p.vaHigh].low + p.rowSize, poc: p.rows[p.poc].low + p.rowSize / 2 };
      }
    }
    out[i] = current;
  }
  return out;
}

/** Green MaxFlow dots on the bar they become known, as in Setup v1. */
function greenDots(c: ResearchBar[], barMs: number): Uint8Array {
  const mf = computeMaxFlow(c as unknown as Candle[], {
    scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: true, htfMs: biasTimeframe(barMs), intervalMs: barMs,
    dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
  });
  const g = new Uint8Array(c.length);
  for (const d of mf.dots) if (d.kind === "green" && d.index + 1 < c.length) g[d.index + 1] = 1;
  return g;
}

interface Trade extends Sample {
  reason: "stop" | "target" | "time";
  /** Best high before the exit, in R (risk = entry − stop). */
  mfeR: number;
  bars: number;
  stopPct: number;
}

function exit(c: ResearchBar[], e: number, stop: number, target: number, hold: number): Omit<Trade, "at"> & { bar: number } {
  const entry = c[e].close;
  const risk = entry - stop;
  const last = Math.min(c.length - 1, e + hold);
  let best = entry;
  const done = (gross: number, x: number, reason: Trade["reason"]) => ({ gross, bar: x, reason, mfeR: (best - entry) / risk, bars: x - e, stopPct: risk / entry });
  for (let x = e + 1; x <= last; x++) {
    if (c[x].low <= stop) return done(Math.min(c[x].open, stop) / entry - 1, x, "stop");
    best = Math.max(best, c[x].high);
    if (c[x].high >= target) return done(Math.max(c[x].open, target) / entry - 1, x, "target");
  }
  return done(c[last].close / entry - 1, last, "time");
}

/** How many setups reach each step, per scale and pattern. */
const funnel = new Map<string, Record<string, number>>();
const step = (key: string, name: string) => {
  const f = funnel.get(key) ?? {};
  f[name] = (f[name] ?? 0) + 1;
  funnel.set(key, f);
};

function scan(c: ResearchBar[], s: Scale, book: Map<string, Trade[]>, minLiquidity: number) {
  const n = c.length;
  const lv = dailyLevels(c, s);
  const green = greenDots(c, s.barMs);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const vol = prefix(c.map((b) => b.volume));
  const perDay = DAY / (s.barMs / 1000);
  const liquid = (i: number) => i >= 30 * perDay && ((qv[i] - qv[i - 30 * perDay]) / 30) >= minLiquidity;
  const busy = new Map<string, number>();
  const take = (rule: string, e: number, stop: number, target: number) => {
    const key = `${s.name} · ${rule}`;
    if ((busy.get(key) ?? -1) >= e) return;
    const { bar, ...r } = exit(c, e, stop, target, s.hold);
    busy.set(key, bar);
    const list = book.get(key) ?? [];
    list.push({ at: c[e].time * 1000 + s.barMs, ...r });
    book.set(key, list);
  };
  const stopOk = (entry: number, stop: number) => {
    const d = 1 - stop / entry;
    return d >= s.minStop && d <= s.maxStop && d > 0;
  };

  for (let i = 21; i < n - 2; i++) {
    const L = lv[i];
    if (!L || !liquid(i)) continue;

    // VAH continuation
    if (c[i].close > L.vah && c[i - 1].close <= L.vah) {
      const fk = `${s.name} · VAH`;
      step(fk, "1 breakout");
      for (let j = i + 1; j <= Math.min(n - 2, i + s.window); j++) {
        if (c[j].low > L.vah * (1 + s.tol)) continue;
        step(fk, "2 retest");
        if (c[j].close > L.vah) {
          step(fk, "3 retest holds");
          const entry = c[j].close;
          const stop = Math.min(c[j].low, L.vah) * (1 - s.buf);
          if (stopOk(entry, stop)) {
            step(fk, "4 stop within limits");
            const target = entry + 2 * (entry - stop);
            take("VAH breakout-retest-hold", j, stop, target);
            if (c[i].volume >= (1.5 * (vol[i] - vol[i - 20])) / 20) take("VAH breakout-retest-hold + volume 1.5×", j, stop, target);
          }
        }
        break;
      }
    }

    // VAL failed breakdown
    if (c[i].close < L.val && c[i - 1].close >= L.val) {
      const fk = `${s.name} · VAL`;
      step(fk, "1 breakdown");
      let reclaim = -1;
      for (let j = i + 1; j <= Math.min(n - 2, i + s.window); j++) {
        if (c[j].close > L.val) {
          reclaim = j;
          break;
        }
      }
      if (reclaim < 0) continue;
      step(fk, "2 reclaim");
      for (let j = reclaim + 1; j <= Math.min(n - 2, reclaim + s.window); j++) {
        if (c[j].low > L.val * (1 + s.tol)) continue;
        step(fk, "3 retest");
        if (c[j].close > L.val) {
          step(fk, "4 retest holds");
          let low = Number.POSITIVE_INFINITY;
          for (let k = i; k <= j; k++) low = Math.min(low, c[k].low);
          const entry = c[j].close;
          const stop = low * (1 - s.buf);
          if (stopOk(entry, stop)) step(fk, "5 stop within limits");
          if (stopOk(entry, stop) && L.poc - entry >= entry - stop) {
            step(fk, "6 POC ≥ 1R away");
            take("VAL failed breakdown → POC", j, stop, L.poc);
            let dot = false;
            for (let k = Math.max(0, j - 12); k <= j; k++) if (green[k]) dot = true;
            if (dot) take("VAL failed breakdown → POC + MaxFlow dot", j, stop, L.poc);
          }
        }
        break;
      }
    }
  }
}

async function main() {
  const book = new Map<string, Trade[]>();
  let swingPairs = 0;
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "1h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    swingPairs++;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of segments(all, 6 * SWING.barMs)) if (c.length >= 1500) scan(c, SWING, book, 5e6);
  }
  let intradayPairs = 0;
  for (const symbol of INTRADAY_PAIRS) {
    const file = path.join(CACHE_DIR, "klines", "5m", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    intradayPairs++;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of segments(all, 6 * INTRADAY.barMs)) if (c.length >= 5000) scan(c, INTRADAY, book, 0);
  }
  console.log(`swing: ${swingPairs} pairs (1h, profile 30d) · intraday: ${intradayPairs} pairs (5m, profile previous day) · IS → 2024-06 │ OOS after\n`);
  const keys = [...book.keys()].sort();
  for (const key of keys) {
    const xs = book.get(key) ?? [];
    const is = xs.filter((t) => t.at < SPLIT);
    const oos = xs.filter((t) => t.at >= SPLIT);
    const m = (v: Trade[]) => {
      const st = stats(v);
      return st ? pct(st.g - 0.0004, 3) : "–";
    };
    console.log(`  ${key}`);
    console.log(`    IS  ${cell(is)}`);
    console.log(`    OOS ${cell(oos)}`);
    console.log(`    net at 0.04% (futures maker): IS ${m(is)} │ OOS ${m(oos)}`);
  }
  console.log("\nFUNNEL (all periods): setups reaching each step");
  for (const [k, f] of [...funnel].sort()) {
    const steps = Object.entries(f).sort();
    console.log(`  ${k.padEnd(20)} ${steps.map(([name, v]) => `${name.slice(2)} ${v} (${((100 * v) / steps[0][1]).toFixed(0)}%)`).join(" → ")}`);
  }

  console.log("\nWHERE TRADES END (all periods)");
  const share = (xs: Trade[], f: (t: Trade) => boolean) => `${((100 * xs.filter(f).length) / Math.max(1, xs.length)).toFixed(0)}%`;
  const avg = (xs: Trade[], f: (t: Trade) => number) => xs.reduce((a, t) => a + f(t), 0) / Math.max(1, xs.length);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : Number.NaN);
  for (const key of keys) {
    const xs = book.get(key) ?? [];
    const stops = xs.filter((t) => t.reason === "stop");
    const times = xs.filter((t) => t.reason === "time");
    console.log(`  ${key}`);
    console.log(`    stop ${share(xs, (t) => t.reason === "stop")} · target ${share(xs, (t) => t.reason === "target")} · time ${share(xs, (t) => t.reason === "time")} · stop distance median ${pct(median(xs.map((t) => t.stopPct)), 2)}`);
    console.log(`    stopped trades: median ${median(stops.map((t) => t.bars))} bars to the stop · ${share(stops, (t) => t.bars <= 3)} within 3 bars · first rose ≥ 0.5R ${share(stops, (t) => t.mfeR >= 0.5)} · ≥ 1R ${share(stops, (t) => t.mfeR >= 1)}`);
    console.log(`    time exits: mean ${pct(avg(times, (t) => t.gross), 2)} · target-hit trades: mean ${pct(avg(xs.filter((t) => t.reason === "target"), (t) => t.gross), 2)}`);
  }

  console.log("\nPER YEAR, gross per trade (n)");
  for (const key of keys) {
    const xs = book.get(key) ?? [];
    const years: string[] = [];
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const st = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(st ? `${y} ${pct(st.g, 2)} (${st.n})` : `${y} –`);
    }
    console.log(`  ${key}\n    ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("value-area.ts")) void main();
