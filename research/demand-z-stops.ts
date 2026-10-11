/**
 * Z (research/demand-z.ts, the forward-test candidate: rally ≥ 8% within 4 bars, zone 2–10% under
 * the close, add-on with risk split 0.75% + 0.25%) — owner's follow-ups:
 *
 *   stops   where the zone counts as invalidated: its low − 0.5% (the candidate) · its low −
 *           0.5 × ATR(14) · its low − 1 × ATR · its middle (tighter) · the swing low of the 20 bars
 *           before the rally started − 0.5% (deeper); skipped beyond 1–15%
 *   caps    new v1 risk per bar 5% (the bot) vs 7.5% / 10% (more entries on a broad flush), Z's
 *           cap scaled alike. (The bot's daily loss limit is not in the research portfolio.)
 *
 * Cost 0.2%. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/demand-z-stops.ts
 */
import { SETUP_A } from "../lib/setups/setupA";
import type { AT } from "./audit";
import { demandZones, loadSignals, trade } from "./demand-entry";
import { atr14 } from "./intraday-edge";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { botTrades } from "./usdt-dominance";

const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);

type StopKind = "low − 0.5%" | "low − 0.5 ATR" | "low − 1 ATR" | "zone middle" | "swing low − 0.5%";

async function main() {
  const { symbols, sigs } = await loadSignals();
  const today = sigs.map((t) => trade(t.symbol, t.c, t.s, t.c[t.s].close, t.x, t.exit, t.liq, false));
  const { ac } = await botTrades(symbols);
  const aS: Sleeve = { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 };
  const atrs = new Map<unknown, Float64Array>();

  const z = (kind: StopKind): Trade[] => {
    const out: Trade[] = [];
    for (const t of sigs) {
      const close = t.c[t.s].close;
      // zones with the bar the rally started on, for the swing-low stop
      const zones: { lo: number; top: number; k: number }[] = [];
      for (let k = Math.max(3, t.s - 120); k + 4 < t.s; k++) {
        if (t.c[k + 4].close / t.c[k].close - 1 < 0.08) continue;
        let lo = Infinity;
        for (let j = k - 3; j <= k; j++) lo = Math.min(lo, t.c[j].low);
        zones.push({ lo, top: Math.max(t.c[k].open, t.c[k].close), k });
      }
      const ok = zones.filter((q) => q.top < close * 0.98 && q.top > close * 0.9);
      if (!ok.length) continue;
      const zone = ok.reduce((a, q) => (q.top > a.top ? q : a));
      if (!atrs.has(t.c)) atrs.set(t.c, atr14(t.c));
      const a = atrs.get(t.c)![t.s];
      let swing = Infinity;
      for (let j = Math.max(0, zone.k - 20); j <= zone.k; j++) swing = Math.min(swing, t.c[j].low);
      const stop =
        kind === "low − 0.5%" ? zone.lo * 0.995
        : kind === "low − 0.5 ATR" ? zone.lo - 0.5 * a
        : kind === "low − 1 ATR" ? zone.lo - a
        : kind === "zone middle" ? (zone.lo + zone.top) / 2
        : swing * 0.995;
      for (let f = t.s + 1; f <= t.x; f++) {
        if (t.c[f].low > zone.top) continue;
        const fill = Math.min(t.c[f].open, zone.top);
        const d = 1 - stop / fill;
        if (d > 0.01 && d <= 0.15) out.push({ ...trade(t.symbol, t.c, f, fill, t.x, t.exit, t.liq, true, stop), symbol: `${t.symbol}#z` });
        break;
      }
    }
    return out;
  };
  const perR = (xs: Trade[], from: number, to: number) => {
    const ys = xs.filter((t) => t.at >= from && t.at < to);
    const rs = ys.map((t) => (t.exit / t.entry - 1 - 0.001) / t.stopDist);
    return `${(rs.reduce((p, r) => p + r, 0) / Math.max(1, rs.length)).toFixed(2)}R win ${((100 * rs.filter((r) => r > 0).length) / Math.max(1, rs.length)).toFixed(0)}% (${ys.length})`;
  };
  const row = (r: Result) => `${pct(r.cagr).padStart(7)} / ${pct(r.maxDD).padStart(6)} / Cal ${r.calmar.toFixed(2)}`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(36)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  const s = (ts: Trade[], r: number, cap: number): Sleeve => ({ trades: ts, risk: r, maxFrac: 0.1, maxOpen: 15, maxBarRisk: cap });

  console.log("1 · Z's STOP — per trade IS │ OOS · median stop · portfolio v1.2 0.75% + Z 0.25% + A (CAGR / DD / Calmar, IS │ OOS)");
  both("today: v1.2 1% + A", [s(today, 0.01, 0.05), aS]);
  for (const kind of ["low − 0.5%", "low − 0.5 ATR", "low − 1 ATR", "zone middle", "swing low − 0.5%"] as StopKind[]) {
    const zt = z(kind);
    const med = zt.map((t) => t.stopDist).sort((p, q) => p - q)[Math.floor(zt.length / 2)] ?? 0;
    console.log(`  Z stop at ${kind.padEnd(17)} ${perR(zt, START, SPLIT)} │ ${perR(zt, SPLIT, END)} · stop median ${pct(-med, 1)}`);
    both(`    with Z (${kind})`, [s(today, 0.0075, 0.0375), aS, s(zt, 0.0025, 0.0125)]);
  }

  console.log("\n2 · NEW RISK PER BAR (v1 cap; Z's scaled) — CAGR / DD / Calmar, IS │ OOS");
  const zt = z("low − 0.5%");
  for (const cap of [0.05, 0.075, 0.1]) {
    both(`today, v1 cap ${cap * 100}%`, [s(today, 0.01, cap), aS]);
    both(`with Z, v1 cap ${cap * 100}%`, [s(today, 0.0075, cap * 0.75), aS, s(zt, 0.0025, cap * 0.25)]);
  }

}

if (process.argv[1]?.endsWith("demand-z-stops.ts")) void main();
