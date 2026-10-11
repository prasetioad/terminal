/**
 * Setup A's entry timing: buy the breakout close (the bot today) or wait for a pullback to the
 * broken level? 4h, the bot's filters (volume ≥ 1.5×, RS < −10%, ≥ $1M/day), its exit (8×ATR
 * stop and chandelier, spike tightening). Rules fixed before looking at results:
 *
 *   breakout   as the bot: enter at the breakout close
 *   pullback   after a breakout that passes the filters, within 12 bars (2 days): the first bar
 *              whose low comes within 0.5% of the broken level (the prior 120-bar high) and closes
 *              above it → enter at that close; stop 8×ATR under it; no pullback → no trade
 *   half-half  half the risk at the breakout, half on the pullback (two positions' worth of risk
 *              split, booked as two sleeves)
 *
 * Per trade in R (cost 0.2%), and the portfolio with v1.2 as the bot runs it. IS 2021 → 2024-06,
 * OOS after.
 *
 *   npx tsx research/a-entry.ts
 */
import { SETUP_A, atr } from "../lib/setups/setupA";
import { SETUP_V1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { type AT, type V1T, toTrade } from "./audit";
import { archiveSymbols, segments, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";
import { botTrades } from "./usdt-dominance";
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "./data";
import { relativeStrength, volumeSurge } from "../lib/setups/setupA";
import { liquidity30d } from "../lib/setups/setupV1";

const H4 = 4 * 3_600_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

/** Setup A's exit from entry bar s with the stop at `stop` (as lib/setups/setupA.ts). */
function exitA(c: ResearchBar[], a: number[], s: number, stop: number): { x: number | null; px: number | null } {
  const entry = c[s].close;
  let best = entry;
  let k: number = SETUP_A.atrMult;
  for (let x = s + 1; x < c.length; x++) {
    const b = c[x];
    if (b.low <= stop) return { x, px: Math.min(b.open, stop) };
    if (b.close < best - k * a[x - 1]) return { x, px: b.close };
    best = Math.max(best, b.close);
    if (b.close > entry * (1 + 2 * SETUP_A.cost) && b.close > b.open && b.high - b.low >= SETUP_A.spikeTighten.range * a[x - 1]) k = Math.min(k, SETUP_A.spikeTighten.k);
  }
  return { x: null, px: null };
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const btc = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "4h", "BTCUSDT.json"), "utf8")) as Candle[];
  const pull: AT[] = [];
  for (const s of symbols) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${s}.json`);
    if (!fs.existsSync(file)) continue;
    for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")) as ResearchBar[], 3 * 86_400_000)) {
      if (c.length < SETUP_A.warmup + 30) continue;
      const candles = c as unknown as Candle[];
      const a = atr(candles, SETUP_A.atrLength);
      let busy = -1;
      for (let s0 = SETUP_A.warmup; s0 < c.length - 1; s0++) {
        let hh = -Infinity;
        let hhPrev = -Infinity;
        for (let j = s0 - SETUP_A.lookback; j < s0; j++) hh = Math.max(hh, c[j].high);
        for (let j = s0 - 1 - SETUP_A.lookback; j < s0 - 1; j++) hhPrev = Math.max(hhPrev, c[j].high);
        if (!(c[s0].close > hh && c[s0 - 1].close <= hhPrev)) continue;
        if (s0 <= busy) continue;
        const surge = volumeSurge(candles, s0, H4);
        const rs = relativeStrength(candles, s0, btc);
        if (surge < SETUP_A.minSurge || rs === null || rs >= SETUP_A.maxRs || liquidity30d(candles, s0, H4) < 1e6) continue;
        for (let p = s0 + 1; p <= Math.min(c.length - 2, s0 + 12); p++) {
          if (c[p].low > hh * 1.005) continue;
          if (c[p].close > hh) {
            const stopDist = (SETUP_A.atrMult * a[p]) / c[p].close;
            if (stopDist <= SETUP_A.maxStopPct) {
              const { x, px } = exitA(c, a, p, c[p].close * (1 - stopDist));
              pull.push({ ...toTrade(s, c, H4, 0, p, x, px, stopDist), rsA: rs, surgeA: surge });
              busy = x ?? c.length;
            }
          }
          break;
        }
      }
    }
  }
  const { v1c, ac } = await botTrades(symbols);
  const cost = <T extends Trade>(ts: T[]): T[] => ts.map((t) => ({ ...t, exit: t.exit * 0.999, closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * 0.999] }));
  const pullC = cost(pull);
  const accA = (t: Trade) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs;
  const v1s: Sleeve = { trades: v1c, accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 };
  const aS = (trades: Trade[], risk: number): Sleeve => ({ trades, accept: accA, risk, maxFrac: 0.1, maxOpen: 15, maxBarRisk: risk * 5 });

  const perR = (ts: Trade[], from: number, to: number) => {
    const xs = ts.filter((t) => accA(t) && !t.open && t.liquidity >= 1e6 && t.at >= from && t.at < to);
    const rs = xs.map((t) => (t.exit / t.entry - 1 - 0.002) / t.stopDist);
    const win = xs.filter((t) => t.exit / t.entry - 1 - 0.002 > 0).length / Math.max(1, xs.length);
    return `n ${String(xs.length).padStart(4)} · ${(rs.reduce((p, r) => p + r, 0) / Math.max(1, rs.length)).toFixed(2)}R · win ${(100 * win).toFixed(0)}%`;
  };
  console.log("PER TRADE (accepted, closed, cost 0.2%) — IS │ OOS");
  console.log(`  breakout (today)   ${perR(ac, START, SPLIT)} │ ${perR(ac, SPLIT, END)}`);
  console.log(`  pullback           ${perR(pull, START, SPLIT)} │ ${perR(pull, SPLIT, END)}`);
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(34)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  console.log("\nPORTFOLIO — IS │ OOS");
  both("A breakout alone (today)", [aS(ac, 0.005)]);
  both("A pullback alone", [aS(pullC, 0.005)]);
  both("v1.2 + A breakout (today)", [v1s, aS(ac, 0.005)]);
  both("v1.2 + A pullback", [v1s, aS(pullC, 0.005)]);
  both("v1.2 + A half breakout, half pullback", [v1s, aS(ac, 0.0025), aS(pullC, 0.0025)]);
  const missed = ac.filter((t) => accA(t) && t.liquidity >= 1e6).length;
  console.log(`\n  breakouts accepted ${missed} · with a pullback within 2 days ${pull.length} (${((100 * pull.length) / missed).toFixed(0)}%)`);
}

if (process.argv[1]?.endsWith("a-entry.ts")) void main();
