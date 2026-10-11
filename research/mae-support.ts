/**
 * How far v1.2 entries fall first, and whether the low stops at a support (owner's question,
 * after SUI Oct 2026). The bot's v1.2 trades on 4h (first green dot, breadth ≥ 10, ≥ $1M/day),
 * 2021 → now, closed trades. Rules fixed before looking at results:
 *
 *   MAE        the lowest low from the bar after the entry to the exit, vs the entry
 *   support    pivot lows of the 600 bars (100 days) before the entry: a low under the 12 bars on
 *              each side, confirmed before the entry (pivot ≤ entry − 12). The first support is
 *              the highest pivot low under the entry.
 *   categories the trade's low never reached the first support (> 1% above it) · touched and
 *              held (within ±1%) · broke it (> 1% under)
 *   control    the same with another trade's depth: each trade gets three MAEs drawn from the
 *              other trades (the same depth distribution, the link to this chart's supports
 *              broken). If supports matter, real lows sit near them more often than these do.
 *
 * Then the same over the last 100 bars (≈ 17 days, the owner's window), with three kinds of
 * support: pivot lows of 6 or 12 bars a side, and demand zones — where a rally started: if the
 * close 6 bars after bar k is ≥ 8% above bar k's, the zone runs from the lowest low of bars
 * k−3…k to bar k's body top. A low "held" when it stopped inside the nearest zone under the
 * entry (±1%), "broke" when it went > 1% under it.
 *
 * Results in R (R = 15%, the stop), net of 0.2%. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/mae-support.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { pct } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const SPLIT = Date.UTC(2024, 6, 1);
const LOOKBACK = 600;
const SIDE = 12;

interface T {
  at: number;
  mae: number; // ≤ 0
  ret: number; // net
  win: boolean;
  support: number | null; // first support under the entry, as a share of the entry − 1 (≤ 0)
  lowVsSupport: number | null; // the trade's low ÷ the first support − 1
  randVsSupport: number[]; // control levels ÷ the first support − 1
  nearAny: boolean; // the low within ±1% of any pivot low under the entry
  randNearAny: number; // share of control levels within ±1% of any pivot low
  entry: number;
  pivots: number[];
  c: ResearchBar[];
  s: number;
  low: number;
}

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

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const signals = new Map<number, number>();
  const raw: { at: number; c: ResearchBar[]; s: number; x: number; exit: number }[] = [];
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
        if (t.exitIndex === null || t.exitPrice === null || liquidity30d(candles, t.entryIndex, H4) < 1e6) continue;
        raw.push({ at: t.entryTime, c, s: t.entryIndex, x: t.exitIndex, exit: t.exitPrice });
      }
    }
  }
  const r = rng(7);
  const trades: T[] = [];
  for (const { at, c, s, x, exit } of raw) {
    if ((signals.get(at) ?? 0) < SETUP_V1.minBreadth) continue;
    const entry = c[s].close;
    let low = Infinity;
    for (let k = s + 1; k <= x; k++) low = Math.min(low, c[k].low);
    // pivot lows confirmed before the entry, under it
    const pivots: number[] = [];
    for (let k = Math.max(SIDE, s - LOOKBACK); k <= s - SIDE; k++) {
      let isLow = true;
      for (let j = k - SIDE; j <= k + SIDE && isLow; j++) if (j !== k && c[j].low <= c[k].low) isLow = false;
      if (isLow && c[k].low < entry) pivots.push(c[k].low);
    }
    const first = pivots.length ? Math.max(...pivots) : null;
    const ret = exit / entry - 1 - 0.002;
    trades.push({
      at: at + H4,
      mae: low / entry - 1,
      ret,
      win: ret > 0,
      support: first === null ? null : first / entry - 1,
      lowVsSupport: first === null ? null : low / first - 1,
      randVsSupport: [],
      nearAny: pivots.some((v) => Math.abs(low / v - 1) <= 0.01),
      randNearAny: 0,
      entry,
      pivots,
      c,
      s,
      low,
    });
  }
  // the control: three other trades' depths on this trade's chart
  for (const t of trades) {
    const levels = [0, 1, 2].map(() => t.entry * (1 + trades[Math.floor(r() * trades.length)].mae));
    const first = t.pivots.length ? Math.max(...t.pivots) : null;
    t.randVsSupport = first === null ? [] : levels.map((v) => v / first - 1);
    t.randNearAny = levels.filter((v) => t.pivots.some((p) => Math.abs(v / p - 1) <= 0.01)).length / levels.length;
  }

  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const share = (xs: T[], f: (t: T) => boolean) => `${((100 * xs.filter(f).length) / Math.max(1, xs.length)).toFixed(0)}%`;
  const R = (xs: T[]) => (xs.length ? (xs.reduce((a, t) => a + t.ret, 0) / xs.length / SETUP_V1.stopPct).toFixed(2) : "–");

  console.log(`v1.2 closed trades (first dot, breadth ≥ 10): ${trades.length}\n`);
  console.log("1 · HOW FAR PRICE FALLS AFTER THE ENTRY (MAE, entry → exit)");
  for (const [label, xs] of [["all", trades], ["winners", trades.filter((t) => t.win)], ["losers", trades.filter((t) => !t.win)]] as const) {
    const m = xs.map((t) => t.mae);
    console.log(`  ${label.padEnd(8)} n ${String(xs.length).padStart(4)} · median ${pct(q(m, 0.5), 1)} · 25% of trades worse than ${pct(q(m, 0.25), 1)} · 10% worse than ${pct(q(m, 0.1), 1)} · fell ≥3% ${share(xs, (t) => t.mae <= -0.03)} ≥5% ${share(xs, (t) => t.mae <= -0.05)} ≥8% ${share(xs, (t) => t.mae <= -0.08)} ≥10% ${share(xs, (t) => t.mae <= -0.1)} ≥15% (stop) ${share(xs, (t) => t.mae <= -0.15)}`);
  }
  console.log("  result by depth (IS │ OOS, mean R · win):");
  for (const [a, b] of [[0, -0.03], [-0.03, -0.05], [-0.05, -0.08], [-0.08, -0.1], [-0.1, -0.15], [-0.15, -1]] as const) {
    const sel = trades.filter((t) => t.mae <= a && t.mae > b);
    const f = (xs: T[]) => `n ${String(xs.length).padStart(4)} ${R(xs).padStart(5)}R win ${share(xs, (t) => t.win)}`;
    console.log(`    ${`${pct(a, 0)} → ${pct(b, 0)}`.padEnd(14)} ${share(trades, (t) => t.mae <= a && t.mae > b).padStart(4)} of trades · ${f(sel.filter((t) => t.at < SPLIT))} │ ${f(sel.filter((t) => t.at >= SPLIT))}`);
  }

  const withS = trades.filter((t) => t.support !== null);
  console.log(`\n2 · DOES THE LOW STOP AT A SUPPORT? (pivot lows of the last 100 days; ${withS.length} trades with one under the entry)`);
  console.log(`  first support under the entry: median ${pct(q(withS.map((t) => t.support!), 0.5), 1)} away (25–75%: ${pct(q(withS.map((t) => t.support!), 0.75), 1)} … ${pct(q(withS.map((t) => t.support!), 0.25), 1)})`);
  const cat = (v: number) => (v > 0.01 ? "never reached" : v >= -0.01 ? "touched, held (±1%)" : "broke (> 1% under)");
  console.log("  the trade's low vs the first support (real │ control), then the real trades' result (IS │ OOS):");
  for (const name of ["never reached", "touched, held (±1%)", "broke (> 1% under)"]) {
    const real = withS.filter((t) => cat(t.lowVsSupport!) === name);
    const rand = withS.flatMap((t) => t.randVsSupport).filter((v) => cat(v) === name).length / withS.flatMap((t) => t.randVsSupport).length;
    const f = (xs: T[]) => `${R(xs).padStart(5)}R win ${share(xs, (t) => t.win)} (${xs.length})`;
    console.log(`    ${name.padEnd(20)} ${share(withS, (t) => cat(t.lowVsSupport!) === name).padStart(4)} │ ${`${(100 * rand).toFixed(0)}%`.padStart(4)} · ${f(real.filter((t) => t.at < SPLIT))} │ ${f(real.filter((t) => t.at >= SPLIT))}`);
  }
  const hist = (vals: number[]) => {
    const bins = new Array(16).fill(0);
    for (const v of vals) if (v >= -0.08 && v < 0.08) bins[Math.floor((v + 0.08) / 0.01)]++;
    return bins.map((b) => ((100 * b) / vals.length).toFixed(1).padStart(4)).join(" ");
  };
  console.log("  where the low lands vs the first support, in 1% bins from −8% to +8% (share of trades):");
  console.log(`    bins         ${Array.from({ length: 16 }, (_, k) => `${k - 8 >= 0 ? "+" : ""}${k - 8}`.padStart(4)).join(" ")}`);
  console.log(`    real low     ${hist(withS.map((t) => t.lowVsSupport!))}`);
  console.log(`    control      ${hist(withS.flatMap((t) => t.randVsSupport))}`);
  console.log(`  low within ±1% of ANY 100-day pivot low under the entry: real ${share(trades, (t) => t.nearAny)} │ control ${(100 * trades.reduce((a, t) => a + t.randNearAny, 0) / trades.length).toFixed(0)}%`);

  console.log("\n3 · THE LAST 100 BARS (≈ 17 days): does the low stop in the nearest support or demand zone under the entry?");
  console.log("  real │ control share of trades, then the real trades' mean R · win (IS │ OOS)");
  type Zone = [number, number];
  const pivotZones = (c: ResearchBar[], s: number, side: number): Zone[] => {
    const out: Zone[] = [];
    for (let k = Math.max(side, s - 100); k <= s - side; k++) {
      let isLow = true;
      for (let j = k - side; j <= k + side && isLow; j++) if (j !== k && c[j].low <= c[k].low) isLow = false;
      if (isLow) out.push([c[k].low, c[k].low]);
    }
    return out;
  };
  const demandZones = (c: ResearchBar[], s: number): Zone[] => {
    const out: Zone[] = [];
    for (let k = Math.max(3, s - 100); k + 6 <= s; k++) {
      if (c[k + 6].close / c[k].close - 1 < 0.08) continue;
      let lo = Infinity;
      for (let j = k - 3; j <= k; j++) lo = Math.min(lo, c[j].low);
      out.push([lo, Math.max(c[k].open, c[k].close)]);
    }
    return out;
  };
  const DEFS: [string, (c: ResearchBar[], s: number) => Zone[]][] = [
    ["pivot lows, 6 bars a side", (c, s) => pivotZones(c, s, 6)],
    ["pivot lows, 12 bars a side", (c, s) => pivotZones(c, s, 12)],
    ["demand zones (rally ≥ 8% in 6 bars)", demandZones],
  ];
  const kind = (low: number, z: Zone) => (low > z[1] * 1.01 ? 0 : low >= z[0] * 0.99 ? 1 : 2);
  const names = ["never reached", "stopped in it (±1%)", "broke it (> 1% under)"];
  for (const [label, zonesOf] of DEFS) {
    const rows: { t: T; real: number; ctrl: number[]; nearReal: boolean; nearCtrl: number }[] = [];
    for (const t of trades) {
      const zones = zonesOf(t.c, t.s).filter((z) => z[1] < t.entry);
      if (!zones.length) continue;
      const first = zones.reduce((a, z) => (z[1] > a[1] ? z : a));
      const ctrl = [0, 1, 2].map(() => t.entry * (1 + trades[Math.floor(r() * trades.length)].mae));
      const inAny = (v: number) => zones.some((z) => v >= z[0] * 0.99 && v <= z[1] * 1.01);
      rows.push({ t, real: kind(t.low, first), ctrl: ctrl.map((v) => kind(v, first)), nearReal: inAny(t.low), nearCtrl: ctrl.filter(inAny).length / 3 });
    }
    const dist = rows.map((x) => 1 - Math.max(...zonesOf(x.t.c, x.t.s).filter((z) => z[1] < x.t.entry).map((z) => z[1])) / x.t.entry);
    console.log(`  ${label}: ${rows.length} trades with one under the entry · nearest median ${pct(-q(dist, 0.5), 1)} away`);
    for (let k = 0; k < 3; k++) {
      const real = rows.filter((x) => x.real === k).map((x) => x.t);
      const ctrl = rows.reduce((a, x) => a + x.ctrl.filter((v) => v === k).length, 0) / (3 * rows.length);
      const f = (xs: T[]) => `${R(xs).padStart(5)}R win ${share(xs, (t) => t.win)} (${xs.length})`;
      console.log(`    ${names[k].padEnd(22)} ${share(rows.map((x) => x.t), (t) => rows.find((x) => x.t === t)!.real === k).padStart(4)} │ ${`${(100 * ctrl).toFixed(0)}%`.padStart(4)} · ${f(real.filter((t) => t.at < SPLIT))} │ ${f(real.filter((t) => t.at >= SPLIT))}`);
    }
    console.log(`    low inside ANY of them (±1%): real ${((100 * rows.filter((x) => x.nearReal).length) / rows.length).toFixed(0)}% │ control ${((100 * rows.reduce((a, x) => a + x.nearCtrl, 0)) / rows.length).toFixed(0)}%`);
  }
}

if (process.argv[1]?.endsWith("mae-support.ts")) void main();
