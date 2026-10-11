/**
 * Buy v1.2's signal at the prior balance / demand area instead of at the green dot (owner's idea,
 * after SUI Oct 2026). Same signals as the bot (4h, first green dot, breadth ≥ 10, ≥ $1M/day), the
 * same exit (the first red dot) and stop (−15% under the fill). Rules fixed before looking at
 * results:
 *
 *   zones (from bars s−120 … s−1, wholly under the signal close)
 *     balance   ≥ 12 bars whose high–low span ≤ 6% of its mid, ended by a close above its high;
 *               the zone is the box (its low … its high)
 *     demand    where a rally started: bar k with close[k+6] ≥ 1.08 × close[k]; the zone runs from
 *               the lowest low of bars k−3…k to bar k's body top
 *   entries
 *     today     the signal close
 *     zone      a limit buy at the top of the nearest zone under the close (2–10% below), resting
 *               until the trade's exit; filled at the level, or the open on a gap; unfilled → no trade
 *     half      half the risk at the close, half on the zone limit
 *
 * Then the zone as a SEPARATE add-on strategy ("Z", owner's follow-up): the green-dot entry stays
 * as it is, and a second position (0.5% risk, alongside the first on the same pair) buys the zone
 * limit with a tighter stop — the first entry's stop (−15% from the signal close) or the zone's
 * invalidation (1% under its low; skipped beyond 1–15%). Balance boxes of ≥ 6, 8 and 12 bars
 * (12 was an arbitrary first choice), and demand zones.
 *
 * Per trade in R (cost 0.2%) and the portfolio with Setup A as the bot runs it. IS 2021 → 2024-06,
 * OOS after.
 *
 *   npx tsx research/demand-entry.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import type { AT } from "./audit";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";
import { botTrades } from "./usdt-dominance";

const H4 = 4 * 3_600_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);
const STOP = SETUP_V1.stopPct;

export type Zone = [number, number];

function balanceZones(c: ResearchBar[], s: number, minBars = 12): Zone[] {
  const out: Zone[] = [];
  for (let a = Math.max(0, s - 120); a + minBars < s; a++) {
    let hi = -Infinity;
    let lo = Infinity;
    let b = a;
    // grow the box while it stays within 6%
    for (; b < s; b++) {
      const h = Math.max(hi, c[b].high);
      const l = Math.min(lo, c[b].low);
      if ((h - l) / ((h + l) / 2) > 0.06) break;
      hi = h;
      lo = l;
    }
    if (b - a >= minBars && b < s && c[b].close > hi) {
      out.push([lo, hi]);
      a = b; // next box after this one
    }
  }
  return out;
}

/** Where rallies started in the `lookback` bars before s: close[k + bars] ≥ (1 + rally) × close[k]. */
export function demandZones(c: ResearchBar[], s: number, rally = 0.08, bars = 6, lookback = 120): Zone[] {
  const out: Zone[] = [];
  for (let k = Math.max(3, s - lookback); k + bars < s; k++) {
    if (c[k + bars].close / c[k].close - 1 < rally) continue;
    let lo = Infinity;
    for (let j = k - 3; j <= k; j++) lo = Math.min(lo, c[j].low);
    out.push([lo, Math.max(c[k].open, c[k].close)]);
  }
  return out;
}

/** A long from bar f at `fill` to the v1 exit (bar x, price exit), or the −15% stop first. */
export function trade(symbol: string, c: ResearchBar[], f: number, fill: number, x: number, exit: number, liquidity: number, intrabar: boolean, stopLevel = fill * (1 - STOP)): Trade {
  const stop = stopLevel;
  let end = x;
  let px = exit;
  for (let k = f + 1; k <= x; k++) {
    if (c[k].low <= stop) {
      end = k;
      px = Math.min(c[k].open, stop);
      break;
    }
  }
  // a limit filled inside bar f: the stop may be hit in the same bar (counted as the stop)
  if (intrabar && c[f].low <= stop) {
    end = f;
    px = stop;
  }
  const closes = c.slice(f, end + 1).map((b) => b.close);
  closes[0] = fill;
  closes[closes.length - 1] = px * 0.999; // the extra 0.1% (the research charges 0.1%)
  return { symbol, at: c[f].time * 1000 + H4, barMs: H4, entry: fill, stopDist: 1 - stop / fill, closes, exitBars: end - f, exit: px * 0.999, open: false, liquidity, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null };
}

export interface Signal {
  symbol: string;
  at: number;
  c: ResearchBar[];
  s: number;
  x: number;
  exit: number;
  liq: number;
}

/** The bot's v1.2 signals (first green dot, breadth ≥ 10) with their exits. */
export async function loadSignals(): Promise<{ symbols: string[]; sigs: Signal[] }> {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const signals = new Map<number, number>();
  const raw: Signal[] = [];
  for (const sym of symbols) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${sym}.json`);
    if (!fs.existsSync(file)) continue;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!all.length) continue;
    for (const c of segments(all, 3 * 86_400_000)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      const candles = c as unknown as Candle[];
      const base = runSetupV1(candles, { stoch: "either", intervalMs: H4 });
      for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) signals.set(t.entryTime, (signals.get(t.entryTime) ?? 0) + 1);
      for (const t of runSetupV1(candles, { stoch: "either", intervalMs: H4, firstDotOnly: true }).trades) {
        if (t.exitIndex === null || t.exitPrice === null) continue;
        raw.push({ symbol: sym, at: t.entryTime, c, s: t.entryIndex, x: t.exitIndex, exit: t.exitPrice, liq: liquidity30d(candles, t.entryIndex, H4) });
      }
    }
  }
  const sigs = raw.filter((t) => (signals.get(t.at) ?? 0) >= SETUP_V1.minBreadth);
  return { symbols, sigs };
}

async function main() {
  const { symbols, sigs } = await loadSignals();
  const today: Trade[] = sigs.map((t) => trade(t.symbol, t.c, t.s, t.c[t.s].close, t.x, t.exit, t.liq, false));
  const zoneTrades = (zonesOf: (c: ResearchBar[], s: number) => Zone[]) => {
    const out: Trade[] = [];
    let withZone = 0;
    for (const t of sigs) {
      const close = t.c[t.s].close;
      const zones = zonesOf(t.c, t.s).filter((z) => z[1] < close * 0.98 && z[1] > close * 0.9);
      if (!zones.length) continue;
      withZone++;
      const level = Math.max(...zones.map((z) => z[1]));
      for (let f = t.s + 1; f <= t.x; f++) {
        if (t.c[f].low <= level) {
          out.push(trade(t.symbol, t.c, f, Math.min(t.c[f].open, level), t.x, t.exit, t.liq, true));
          break;
        }
      }
    }
    return { out, withZone };
  };
  const bal = zoneTrades(balanceZones);
  const dem = zoneTrades(demandZones);

  const perR = (xs: Trade[], from: number, to: number) => {
    const ys = xs.filter((t) => t.at >= from && t.at < to && t.liquidity >= 1e6);
    const rs = ys.map((t) => (t.exit / t.entry - 1 - 0.001) / t.stopDist);
    return `n ${String(ys.length).padStart(4)} · ${(rs.reduce((a, b) => a + b, 0) / Math.max(1, rs.length)).toFixed(2)}R · win ${((100 * rs.filter((r) => r > 0).length) / Math.max(1, rs.length)).toFixed(0)}%`;
  };
  console.log(`v1.2 signals ${sigs.length} · with a balance zone 2–10% under the close ${bal.withZone} (filled ${bal.out.length}) · with a demand zone ${dem.withZone} (filled ${dem.out.length})\n`);
  console.log("PER TRADE (cost 0.2%) — IS │ OOS");
  console.log(`  today (the close)          ${perR(today, START, SPLIT)} │ ${perR(today, SPLIT, END)}`);
  console.log(`  limit at the balance zone  ${perR(bal.out, START, SPLIT)} │ ${perR(bal.out, SPLIT, END)}`);
  console.log(`  limit at the demand zone   ${perR(dem.out, START, SPLIT)} │ ${perR(dem.out, SPLIT, END)}`);

  const { ac } = await botTrades(symbols);
  const aS: Sleeve = { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 };
  const v1S = (trades: Trade[], risk: number): Sleeve => ({ trades, risk, maxFrac: 0.1, maxOpen: 15, maxBarRisk: risk * 5 });
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(40)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  console.log("\nPORTFOLIO with Setup A (cost 0.2%) — IS │ OOS");
  both("v1.2 today + A", [v1S(today, 0.01), aS]);
  both("v1.2 limit at balance zone + A", [v1S(bal.out, 0.01), aS]);
  both("v1.2 limit at demand zone + A", [v1S(dem.out, 0.01), aS]);
  both("v1.2 half close, half balance zone + A", [v1S(today, 0.005), v1S(bal.out, 0.005), aS]);
  both("v1.2 half close, half demand zone + A", [v1S(today, 0.005), v1S(dem.out, 0.005), aS]);

  // Z: the zone as a separate add-on next to the green-dot entry
  console.log("\nZ · ZONE ADD-ON next to the green-dot entry (0.5% risk; same exit) — per trade IS │ OOS, then the portfolio v1.2 + A + Z");
  const defs: [string, (c: ResearchBar[], s: number) => Zone[]][] = [
    ["balance ≥ 6 bars", (c, s) => balanceZones(c, s, 6)],
    ["balance ≥ 8 bars", (c, s) => balanceZones(c, s, 8)],
    ["balance ≥ 12 bars", (c, s) => balanceZones(c, s, 12)],
    ["demand (rally ≥ 8%)", demandZones],
  ];
  both("v1.2 today + A (reference)", [v1S(today, 0.01), aS]);
  for (const [label, zonesOf] of defs) {
    for (const stopKind of ["first entry's stop", "zone invalidation"] as const) {
      const z: Trade[] = [];
      for (const t of sigs) {
        const close = t.c[t.s].close;
        const zones = zonesOf(t.c, t.s).filter((q) => q[1] < close * 0.98 && q[1] > close * 0.9);
        if (!zones.length) continue;
        const zone = zones.reduce((a, q) => (q[1] > a[1] ? q : a));
        for (let f = t.s + 1; f <= t.x; f++) {
          if (t.c[f].low > zone[1]) continue;
          const fill = Math.min(t.c[f].open, zone[1]);
          const stop = stopKind === "first entry's stop" ? close * (1 - STOP) : zone[0] * 0.99;
          const dist = 1 - stop / fill;
          if (dist > 0.01 && dist <= STOP) z.push({ ...trade(t.symbol, t.c, f, fill, t.x, t.exit, t.liq, true, stop), symbol: `${t.symbol}#z` });
          break;
        }
      }
      const name = `${label} · ${stopKind}`;
      const med = z.map((t) => t.stopDist).sort((a, b) => a - b)[Math.floor(z.length / 2)] ?? 0;
      console.log(`  ${name.padEnd(42)} ${perR(z, START, SPLIT)} │ ${perR(z, SPLIT, END)} · stop median ${pct(-med, 1)}`);
      both(`    v1.2 + A + Z (${label}, ${stopKind === "first entry's stop" ? "first stop" : "invalidation"})`, [v1S(today, 0.01), aS, v1S(z, 0.005)]);
      if (label.startsWith("demand")) {
        // the same total risk per coin as today: split v1's 1% between the green dot and the zone
        both("      split: v1.2 0.5% + Z 0.5% + A", [v1S(today, 0.005), aS, v1S(z, 0.005)]);
        both("      split: v1.2 0.75% + Z 0.25% + A", [v1S(today, 0.0075), aS, v1S(z, 0.0025)]);
      }
    }
  }
}

if (process.argv[1]?.endsWith("demand-entry.ts")) void main();
