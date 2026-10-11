/**
 * "Z", the demand-zone entry of research/demand-entry.ts, tested for robustness and in two forms
 * (owner's follow-up). On every v1.2 signal (first green dot, breadth ≥ 10), a limit buy at the
 * top of the nearest demand zone under the close (a rally of ≥ `rally` within `bars` bars started
 * there, in the 120 bars before), `lo`–`hi` under the close, resting until v1.2's exit (the first
 * red dot); stop under the zone's low by `buf` (skipped beyond 1–15%), or at the green-dot
 * entry's stop. Rules fixed before looking at results:
 *
 *   add-on       Z next to the green-dot position on the same coin; the coin's risk split
 *                0.75% (green dot) + 0.25% (Z)
 *   other coins  Z only on coins the green-dot entry did not take (one position per coin, as the
 *                bot): on a broad flush, v1.2 takes the ≤ 5 most liquid signals per bar and Z can
 *                catch others at their zones; v1.2 1% + Z 0.5%
 *   grid         rally 6 / 8 / 10% · bars 4 / 6 / 8 · distance 1–8% / 2–10% / 3–12% · buffer
 *                0.5% (the owner's "0.5% under the liquidity") / 1%
 *
 * A plateau — most of the grid better than today in- and out-of-sample — would be an edge; a few
 * good cells would not. Cost 0.2%. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/demand-z.ts
 */
import { SETUP_A } from "../lib/setups/setupA";
import { SETUP_V1 } from "../lib/setups/setupV1";
import type { AT } from "./audit";
import { demandZones, loadSignals, trade } from "./demand-entry";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { botTrades } from "./usdt-dominance";

const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

interface P {
  rally: number;
  bars: number;
  lo: number;
  hi: number;
  buf: number | null; // null: the green-dot entry's stop
}

async function main() {
  const { symbols, sigs } = await loadSignals();
  const today = sigs.map((t) => trade(t.symbol, t.c, t.s, t.c[t.s].close, t.x, t.exit, t.liq, false));
  const { ac } = await botTrades(symbols);
  const aS: Sleeve = { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 };
  const v1S = (trades: Trade[], risk: number): Sleeve => ({ trades, risk, maxFrac: 0.1, maxOpen: 15, maxBarRisk: Math.max(risk * 5, 0.0125) });

  const zTrades = (p: P, addOn: boolean): Trade[] => {
    const out: Trade[] = [];
    for (const t of sigs) {
      const close = t.c[t.s].close;
      const zones = demandZones(t.c, t.s, p.rally, p.bars).filter((z) => z[1] < close * (1 - p.lo) && z[1] > close * (1 - p.hi));
      if (!zones.length) continue;
      const zone = zones.reduce((a, z) => (z[1] > a[1] ? z : a));
      for (let f = t.s + 1; f <= t.x; f++) {
        if (t.c[f].low > zone[1]) continue;
        const fill = Math.min(t.c[f].open, zone[1]);
        const stop = p.buf === null ? close * (1 - SETUP_V1.stopPct) : zone[0] * (1 - p.buf);
        const dist = 1 - stop / fill;
        if (dist > 0.01 && dist <= SETUP_V1.stopPct) {
          const z = trade(t.symbol, t.c, f, fill, t.x, t.exit, t.liq, true, stop);
          out.push(addOn ? { ...z, symbol: `${t.symbol}#z` } : z);
        }
        break;
      }
    }
    return out;
  };
  const perR = (xs: Trade[], from: number, to: number) => {
    const ys = xs.filter((t) => t.at >= from && t.at < to && t.liquidity >= 1e6);
    return { n: ys.length, r: ys.reduce((a, t) => a + (t.exit / t.entry - 1 - 0.001) / t.stopDist, 0) / Math.max(1, ys.length) };
  };
  const cal = (s: Sleeve[]) => [simulate(s, START, SPLIT), simulate(s, SPLIT, END)] as [Result, Result];
  const fmt = ([a, b]: [Result, Result]) => `${a.calmar.toFixed(2)} │ ${b.calmar.toFixed(2)} (${pct(a.cagr, 0)} / ${pct(a.maxDD, 0)} │ ${pct(b.cagr, 0)} / ${pct(b.maxDD, 0)})`;

  const base = cal([v1S(today, 0.01), aS]);
  console.log(`today, v1.2 1% + A: Calmar ${fmt(base)}\n`);

  // the owner's two forms at the first-found setting, with each stop
  console.log("TWO FORMS, rally 8% in 6 bars, 2–10% under the close — per trade R IS │ OOS (n) · Calmar IS │ OOS");
  for (const buf of [null, 0.01, 0.005]) {
    const p: P = { rally: 0.08, bars: 6, lo: 0.02, hi: 0.1, buf };
    const label = buf === null ? "stop: green-dot entry's" : `stop: ${buf * 100}% under the zone`;
    for (const addOn of [true, false]) {
      const z = zTrades(p, addOn);
      const a = perR(z, START, SPLIT);
      const b = perR(z, SPLIT, END);
      const book = addOn ? [v1S(today, 0.0075), aS, v1S(z, 0.0025)] : [v1S(today, 0.01), aS, v1S(z, 0.005)];
      console.log(`  ${label.padEnd(26)} ${(addOn ? "add-on (0.75 + 0.25%)" : "other coins (1% + 0.5%)").padEnd(24)} ${a.r.toFixed(2)}R (${a.n}) │ ${b.r.toFixed(2)}R (${b.n}) · ${fmt(cal(book))}`);
    }
  }

  // the robustness grid
  console.log("\nGRID (stop under the zone) — per trade R IS │ OOS · Calmar add-on IS │ OOS · Calmar other coins IS │ OOS");
  let cells = 0;
  let rBoth = 0;
  let addBoth = 0;
  let otherBoth = 0;
  for (const buf of [0.005, 0.01]) {
    for (const rally of [0.06, 0.08, 0.1]) {
      for (const bars of [4, 6, 8]) {
        for (const [lo, hi] of [[0.01, 0.08], [0.02, 0.1], [0.03, 0.12]] as const) {
          const p: P = { rally, bars, lo, hi, buf };
          const zAdd = zTrades(p, true);
          const zOther = zTrades(p, false);
          const a = perR(zAdd, START, SPLIT);
          const b = perR(zAdd, SPLIT, END);
          const ca = cal([v1S(today, 0.0075), aS, v1S(zAdd, 0.0025)]);
          const co = cal([v1S(today, 0.01), aS, v1S(zOther, 0.005)]);
          cells++;
          if (a.r > 0 && b.r > 0) rBoth++;
          if (ca[0].calmar > base[0].calmar && ca[1].calmar > base[1].calmar) addBoth++;
          if (co[0].calmar > base[0].calmar && co[1].calmar > base[1].calmar) otherBoth++;
          console.log(`  buf ${(buf * 100).toFixed(1)}% · rally ${rally * 100}% in ${bars} · ${lo * 100}–${hi * 100}%  ${a.r.toFixed(2).padStart(5)}R │ ${b.r.toFixed(2).padStart(5)}R (${String(a.n).padStart(3)}│${String(b.n).padStart(3)}) · add ${ca[0].calmar.toFixed(2)} │ ${ca[1].calmar.toFixed(2)} · other ${co[0].calmar.toFixed(2)} │ ${co[1].calmar.toFixed(2)}`);
        }
      }
    }
  }
  console.log(`\n  ${cells} cells: per-trade R > 0 in both periods ${rBoth} · add-on beats today's Calmar in both ${addBoth} · other coins beats it in both ${otherBoth}`);
}

if (process.argv[1]?.endsWith("demand-z.ts")) void main();
