/**
 * "Setup C": the market-wide capitulation of research/daily-movers.ts as a setup — a simpler
 * candidate for what v1.2 aims at (§4.38 found v1.2 fragile). Daily bars, long only. Rules fixed
 * before looking at results:
 *
 *   flush day    ≥ B of the liquid universe (≥ $2M/day) is down ≥ 15% over 3 days
 *   entry        at that close, every liquid coin itself down ≥ D over 3 days
 *   grid         D 15 / 20 / 25% × B 20 / 30 / 40%
 *   exits        out after 1 / 3 / 5 / 10 days at the close, or a close 2× / 3× ATR(14) under the
 *                best close (≤ 20 days); always a −20% stop (at the stop, or the open on a gap)
 *   portfolio    as the bot: 1% risk per trade (stop −20% → 5% of equity), ≤ 15 open, ≤ 5% new
 *                risk per day, the most liquid first; one position per pair across setups
 *
 * Chosen on in-sample (Calmar of C alone, day boundary 00 UTC), then: the whole grid (is it a
 * plateau or a spike?), day boundaries shifted by 4–20 hours (the test v1.2 failed), and the
 * combined portfolio with Setup A — A + v1.2 (today) vs A + C vs A + v1.2 + C. Daily bars are
 * built from the 1h cache. Cost 0.2%. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/setup-c.ts
 */
import { aggregate, load1h, toTrade } from "./audit";
import { archiveSymbols, segments, type ResearchBar } from "./data";
import { atr14, prefix } from "./intraday-edge";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";
import { botTrades } from "./usdt-dominance";
import { SETUP_A } from "../lib/setups/setupA";
import { SETUP_V1 } from "../lib/setups/setupV1";
import type { AT, V1T } from "./audit";

const H = 3_600_000;
const DAY_MS = 24 * H;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);
const OFFSETS = [0, 4, 8, 12, 16, 20];
const DROPS = [0.15, 0.2, 0.25];
const BREADTHS = [0.2, 0.3, 0.4];
const EXITS = ["1 day", "3 days", "5 days", "10 days", "trail 2×ATR", "trail 3×ATR"] as const;
type Exit = (typeof EXITS)[number];
const STOP = 0.2;

interface CT extends Trade {
  flush: number; // share of the liquid universe down ≥ 15% over 3 days on the entry day
}

function exitOf(c: ResearchBar[], a: Float64Array, s: number, x: Exit): { e: number | null; px: number | null } {
  const entry = c[s].close;
  const stop = entry * (1 - STOP);
  const hold = x === "1 day" ? 1 : x === "3 days" ? 3 : x === "5 days" ? 5 : x === "10 days" ? 10 : 20;
  const k = x === "trail 2×ATR" ? 2 : x === "trail 3×ATR" ? 3 : 0;
  let best = entry;
  for (let i = s + 1; i < c.length; i++) {
    if (c[i].low <= stop) return { e: i, px: Math.min(c[i].open, stop) };
    if (k && c[i].close < best - k * a[i - 1]) return { e: i, px: c[i].close };
    best = Math.max(best, c[i].close);
    if (i - s >= hold) return { e: i, px: c[i].close };
  }
  return { e: null, px: null };
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  // trades[offset][drop][exit]
  const trades = new Map<string, CT[]>();
  const key = (o: number, d: number, x: Exit) => `${o}|${d}|${x}`;
  // first pass per offset: daily bars and the 3-day returns, for the flush share per day
  for (const off of OFFSETS) {
    const series: { symbol: string; c: ResearchBar[]; ret3: Float64Array; liquid: Uint8Array }[] = [];
    const down = new Map<number, number>();
    const total = new Map<number, number>();
    for (const symbol of symbols) {
      const bars = load1h(symbol);
      if (!bars) continue;
      for (const c of segments(aggregate(bars, 24, off), 3 * DAY_MS)) {
        if (c.length < 60) continue;
        const ret3 = new Float64Array(c.length).fill(Number.NaN);
        const liquid = new Uint8Array(c.length);
        const qv = prefix(c.map((b) => b.quoteVolume));
        for (let i = 30; i < c.length; i++) {
          // daily volume over the 30 days before bar i
          if ((qv[i] - qv[i - 30]) / 30 < 2e6) continue;
          liquid[i] = 1;
          ret3[i] = c[i].close / c[i - 3].close - 1;
          total.set(c[i].time, (total.get(c[i].time) ?? 0) + 1);
          if (ret3[i] <= -0.15) down.set(c[i].time, (down.get(c[i].time) ?? 0) + 1);
        }
        series.push({ symbol, c, ret3, liquid });
      }
    }
    for (const { symbol, c, ret3, liquid } of series) {
      const a = atr14(c);
      for (const d of DROPS) {
        for (const x of EXITS) {
          const list = trades.get(key(off, d, x)) ?? [];
          for (let s = 30; s < c.length; s++) {
            if (!liquid[s] || !(ret3[s] <= -d)) continue;
            const flush = (down.get(c[s].time) ?? 0) / (total.get(c[s].time) ?? 1);
            if (flush < BREADTHS[0]) continue;
            const { e, px } = exitOf(c, a, s, x);
            // booked on the 4h grid: the shifted daily close is `off` hours later than 00 UTC
            list.push({ ...toTrade(symbol, c, DAY_MS, off, s, e, px, STOP), flush });
            if (e === null) break;
            s = e; // one position per pair at a time
          }
          trades.set(key(off, d, x), list);
        }
      }
    }
    console.log(`  day boundary ${off}h done`);
  }

  const cost = <T extends Trade>(ts: T[]): T[] => ts.map((t) => ({ ...t, exit: t.exit * 0.999, closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * 0.999] }));
  const sleeveC = (off: number, d: number, b: number, x: Exit): Sleeve => ({
    trades: cost(trades.get(key(off, d, x)) ?? []), accept: (t) => (t as CT).flush >= b, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05,
  });
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(3)}/y win ${(100 * r.win).toFixed(0)}% hold ${r.holdDays.toFixed(1)}d`;
  const both = (label: string, s: Sleeve[]) => {
    const is = simulate(s, START, SPLIT);
    console.log(`  ${label.padEnd(40)} ${row(is)} │ ${row(simulate(s, SPLIT, END))}`);
    return is;
  };

  console.log("\n1 · GRID, Setup C alone, day boundary 00 UTC (cost 0.2%) — IS │ OOS");
  let pick = { d: 0.2, b: 0.3, x: EXITS[0] as Exit, cal: -Infinity };
  for (const x of EXITS) {
    for (const d of DROPS) {
      for (const b of BREADTHS) {
        const is = both(`drop ${d * 100}% · breadth ${b * 100}% · ${x}`, [sleeveC(0, d, b, x)]);
        if (is.calmar > pick.cal) pick = { d, b, x, cal: is.calmar };
      }
    }
  }
  console.log(`  ★ in-sample pick: drop ${pick.d * 100}% · breadth ${pick.b * 100}% · ${pick.x}`);

  console.log("\n2 · THE PICK WITH THE DAY BOUNDARY SHIFTED — IS │ OOS");
  for (const off of OFFSETS) both(`day starts ${String(off).padStart(2, "0")}:00 UTC`, [sleeveC(off, pick.d, pick.b, pick.x)]);

  console.log("\n3 · COMBINED WITH SETUP A (4h, the bot's rules, cost 0.2%) — IS │ OOS");
  const { v1c, ac } = await botTrades(symbols);
  const v1s: Sleeve = { trades: v1c, accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 };
  const as: Sleeve = { trades: ac, accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025 };
  const cs = sleeveC(0, pick.d, pick.b, pick.x);
  both("A alone", [as]);
  both("A + v1.2 (today)", [v1s, as]);
  both("A + C", [cs, as]);
  both("A + v1.2 + C", [v1s, cs, as]);
  console.log("  per year: A + v1.2 │ A + C (CAGR / DD)");
  for (let y = 2021; y <= 2026; y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), END);
    const p = simulate([v1s, as], from, to);
    const q = simulate([cs, as], from, to);
    console.log(`    ${y}  ${pct(p.cagr).padStart(7)} / ${pct(p.maxDD).padStart(7)} │ ${pct(q.cagr).padStart(7)} / ${pct(q.maxDD).padStart(7)}`);
  }
}

if (process.argv[1]?.endsWith("setup-c.ts")) void main();
