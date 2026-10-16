/**
 * Take profit at MaxFlow's first red dot (4h or 1D) instead of each setup's own exit (owner's
 * question). Red dot as v1's exit: wt1 crosses under wt2 above zero, known on the bar after the
 * cross; the daily one is computed on UTC days built from the 4h bars and acts at the close of the
 * 4h bar that ends the day it became known on. The initial stop stays. Rules fixed before looking:
 *
 *   Setup A   today (8×ATR chandelier, tightened after a spike) · first 4h red dot · first 1D red
 *             dot · whichever comes first of the chandelier and the 1D red dot
 *   Z         today (out with v1: its first 4h red dot) · first 1D red dot after the fill
 *
 * Per trade in R (cost 0.2%) and in the portfolio as the bot runs it (v1.2 1% + A, and v1.2 0.75% +
 * A + Z 0.25%). IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/red-exit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeMaxFlow } from "../lib/maxflow";
import { SETUP_A, atr, runSetupA } from "../lib/setups/setupA";
import { biasTimeframe, liquidity30d } from "../lib/setups/setupV1";
import { zoneOrder, limitFill, stopInRange } from "../lib/setups/setupZ";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { loadSignals, trade } from "./demand-entry";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

/** First-red-dot bars on `c` (index of the bar it becomes known on). */
function reds(c: Candle[], intervalMs: number): Uint8Array {
  const mf = computeMaxFlow(c, {
    scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: true, htfMs: biasTimeframe(intervalMs), intervalMs,
    dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
  });
  const out = new Uint8Array(c.length);
  for (let i = 1; i + 1 < c.length; i++) if (mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1] && mf.wt1[i] > 0) out[i + 1] = 1;
  return out;
}

/** For each 4h bar: whether a daily red dot became known by its close (the bar that ends that UTC day). */
function dailyRedAt4h(c: ResearchBar[]): Uint8Array {
  const days: ResearchBar[] = [];
  for (const b of c) {
    const t = Math.floor((b.time * 1000) / DAY) * DAY / 1000;
    const d = days[days.length - 1];
    if (d && d.time === t) {
      d.high = Math.max(d.high, b.high);
      d.low = Math.min(d.low, b.low);
      d.close = b.close;
      d.volume += b.volume;
    } else days.push({ ...b, time: t as ResearchBar["time"] });
  }
  const r = reds(days as unknown as Candle[], DAY);
  const knownAt = new Set<number>(); // ms: the daily close the dot is known at
  days.forEach((d, i) => {
    if (r[i]) knownAt.add(d.time * 1000 + DAY);
  });
  return Uint8Array.from(c.map((b) => (knownAt.has(b.time * 1000 + H4) ? 1 : 0)));
}

type ExitA = "today" | "4h red" | "1D red" | "chandelier or 1D red";

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const btc = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "4h", "BTCUSDT.json"), "utf8")) as Candle[];
  const aTrades = new Map<ExitA, Trade[]>((["today", "4h red", "1D red", "chandelier or 1D red"] as ExitA[]).map((k) => [k, []]));
  const red1d = new Map<ResearchBar[], Uint8Array>();
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!all.length) continue;
    for (const c of segments(all, 3 * DAY)) {
      if (c.length < SETUP_A.warmup + 30) continue;
      const candles = c as unknown as Candle[];
      const r4 = reds(candles, H4);
      const r1 = dailyRedAt4h(c);
      red1d.set(c, r1);
      const a = atr(candles, SETUP_A.atrLength);
      const res = runSetupA(candles, H4, { btc, maxRs: SETUP_A.maxRs, spikeTighten: SETUP_A.spikeTighten });
      for (const t of res.trades) {
        if (!t.passes || t.exitIndex === null || liquidity30d(candles, t.entryIndex, H4) < 1e6) continue;
        const s0 = t.entryIndex;
        const stopDist = 1 - t.stopPrice / t.entryPrice;
        const mk = (x: number, px: number): Trade => {
          const closes = c.slice(s0, x + 1).map((b) => b.close);
          closes[closes.length - 1] = px * 0.999;
          return { symbol: s, at: c[s0].time * 1000 + H4, barMs: H4, entry: c[s0].close, stopDist, closes, exitBars: x - s0, exit: px * 0.999, open: false, liquidity: liquidity30d(candles, s0, H4), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null };
        };
        aTrades.get("today")!.push(mk(t.exitIndex, t.exitPrice!));
        for (const kind of ["4h red", "1D red", "chandelier or 1D red"] as ExitA[]) {
          let best = c[s0].close;
          let k: number = SETUP_A.atrMult;
          let done: Trade | null = null;
          for (let x = s0 + 1; x < c.length && !done; x++) {
            const b = c[x];
            if (b.low <= t.stopPrice) done = mk(x, Math.min(b.open, t.stopPrice));
            else if (kind === "4h red" && r4[x]) done = mk(x, b.close);
            else if (kind !== "4h red" && r1[x]) done = mk(x, b.close);
            else if (kind === "chandelier or 1D red" && b.close < best - k * a[x - 1]) done = mk(x, b.close);
            best = Math.max(best, b.close);
            if (b.close > c[s0].close * (1 + 2 * SETUP_A.cost) && b.close > b.open && b.high - b.low >= SETUP_A.spikeTighten.range * a[x - 1]) k = Math.min(k, SETUP_A.spikeTighten.k);
          }
          if (done) aTrades.get(kind)!.push(done);
        }
      }
    }
  }

  // Z: exits with v1 (today) or at the first 1D red dot after the fill
  const { sigs } = await loadSignals();
  const v1 = sigs.map((t) => trade(t.symbol, t.c, t.s, t.c[t.s].close, t.x, t.exit, t.liq, false));
  const zToday: Trade[] = [];
  const z1d: Trade[] = [];
  for (const t of sigs) {
    const order = zoneOrder(t.c as unknown as Candle[], t.s);
    if (!order) continue;
    let r1 = red1d.get(t.c);
    if (!r1) {
      r1 = dailyRedAt4h(t.c);
      red1d.set(t.c, r1);
    }
    for (let f = t.s + 1; f <= t.x; f++) {
      const fill = limitFill(t.c[f] as unknown as Candle, order.level);
      if (fill === null) continue;
      if (!stopInRange(fill, order.stop)) break;
      zToday.push({ ...trade(t.symbol, t.c, f, fill, t.x, t.exit, t.liq, true, order.stop), symbol: `${t.symbol}#z` });
      let x = f + 1;
      while (x < t.c.length - 1 && !r1[x]) x++;
      z1d.push({ ...trade(t.symbol, t.c, f, fill, x, t.c[x].close, t.liq, true, order.stop), symbol: `${t.symbol}#z` });
      break;
    }
  }

  const perR = (xs: Trade[], from: number, to: number) => {
    const ys = xs.filter((t) => t.at >= from && t.at < to && t.liquidity >= 1e6);
    const rs = ys.map((t) => (t.exit / t.entry - 1 - 0.001) / t.stopDist);
    const hold = ys.reduce((p, t) => p + t.exitBars, 0) / Math.max(1, ys.length) / 6;
    return `${(rs.reduce((p, r) => p + r, 0) / Math.max(1, rs.length)).toFixed(2)}R win ${((100 * rs.filter((r) => r > 0).length) / Math.max(1, rs.length)).toFixed(0)}% hold ${hold.toFixed(1)}d (${ys.length})`;
  };
  const row = (r: Result) => `${pct(r.cagr).padStart(7)} / ${pct(r.maxDD).padStart(6)} / Cal ${r.calmar.toFixed(2)}`;
  const both = (label: string, s: Sleeve[]) => console.log(`    portfolio ${label.padEnd(30)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  const sl = (ts: Trade[], risk: number, cap: number): Sleeve => ({ trades: ts, risk, maxFrac: 0.1, maxOpen: 15, maxBarRisk: cap });

  console.log("SETUP A — per trade IS │ OOS, then v1.2 1% + A 0.5% (CAGR / DD / Calmar, IS │ OOS)");
  for (const [kind, ts] of aTrades) {
    console.log(`  ${kind.padEnd(22)} ${perR(ts, START, SPLIT)} │ ${perR(ts, SPLIT, END)}`);
    both(`with A: ${kind}`, [sl(v1, 0.01, 0.05), sl(ts, 0.005, 0.025)]);
  }
  console.log("\nZ — per trade IS │ OOS, then v1.2 0.75% + A (today) + Z 0.25%");
  const aToday = aTrades.get("today")!;
  for (const [kind, ts] of [["out with v1 (4h red, today)", zToday], ["first 1D red after the fill", z1d]] as const) {
    console.log(`  ${kind.padEnd(28)} ${perR(ts, START, SPLIT)} │ ${perR(ts, SPLIT, END)}`);
    both(`with Z: ${kind.slice(0, 18)}`, [sl(v1, 0.0075, 0.0375), sl(aToday, 0.005, 0.025), sl(ts, 0.0025, 0.0125)]);
  }
}

if (process.argv[1]?.endsWith("red-exit.ts")) void main();
