/**
 * Stochastic level test: Setup v1 takes the %K/%D cross up only from below 20. Does a
 * cross anywhere below the midline (or 30 / 40) also deserve an entry?
 *
 *   npx tsx research/stoch-level.ts
 *
 * Same universe, portfolio and split as research/momentum.ts. Since a looser level lets
 * more pairs signal on the same bar, the breadth threshold is re-chosen per level, on the
 * in-sample period only.
 */
import { breakout, collect, compare, dotStoch, header, loadContext, pct, simulate, zec, type Sleeve, type Trade } from "./momentum";

const H1 = 3_600_000;
const H4 = 4 * H1;
const SPLIT = Date.UTC(2024, 6, 1);
const START = Date.UTC(2021, 0, 1);
const END = Date.now();
const LEVELS = [20, 30, 40, 50];
const BREADTH = [10, 15, 20, 30];

const net = (t: Trade) => t.exit / t.entry - 1 - 0.001 - (t.liquidity < 5e6 ? 0.002 : 0);

function perTrade(label: string, trades: Trade[]) {
  const stat = (from: number, to: number) => {
    const xs = trades.filter((t) => t.at >= from && t.at < to && t.liquidity >= 1e6 && !t.open).map(net);
    if (!xs.length) return "–".padEnd(34);
    const win = xs.filter((x) => x > 0).length / xs.length;
    return `n ${String(xs.length).padStart(5)} win ${(100 * win).toFixed(0)}% avg ${pct(xs.reduce((a, x) => a + x, 0) / xs.length, 2).padStart(7)}`;
  };
  console.log(`  ${label.padEnd(42)} ${stat(START, SPLIT)}   │ ${stat(SPLIT, END)}`);
}

function breadthOf(trades: Trade[]) {
  const m = new Map<number, number>();
  for (const t of trades) m.set(t.at, (m.get(t.at) ?? 0) + 1);
  return m;
}

async function main() {
  const ctx = await loadContext();
  const fams = [...LEVELS.map((level) => dotStoch({ trend: false, barMs: H4, label: `stoch < ${level}`, stochLevel: level })), breakout(120, 8)];
  const t4 = await collect(fams, "4h", ctx);
  const byLevel = new Map(LEVELS.map((l, i) => [l, t4[i]]));
  const base = { risk: 0.01, maxFrac: 0.2, maxOpen: 15, maxBarRisk: 0.05 };
  const key = (t: Trade) => `${t.symbol}@${t.at}`;
  const strict = new Set(byLevel.get(20)!.map(key));

  console.log("\nPER TRADE, liquid pairs (≥ $1M/day), all signals, no breadth — IS │ OOS");
  for (const l of LEVELS) perTrade(`stoch < ${l} (all)`, byLevel.get(l)!);
  for (const l of LEVELS.slice(1)) perTrade(`stoch < ${l}: only the NEW signals`, byLevel.get(l)!.filter((t) => !strict.has(key(t))));

  console.log("\nPER TRADE by breadth (pairs signalling on the same bar) — IS │ OOS");
  for (const l of LEVELS) {
    const trades = byLevel.get(l)!;
    const b = breadthOf(trades);
    for (const [lo, hi] of [[1, 5], [5, 10], [10, 20], [20, 40], [40, 1e9]] as const) perTrade(`stoch < ${l} · breadth ${lo}–${hi === 1e9 ? "∞" : hi - 1}`, trades.filter((t) => b.get(t.at)! >= lo && b.get(t.at)! < hi));
  }

  header("PORTFOLIO v1.2 rules (1% risk, ≤15 open, ≤5% per bar) per stoch level × breadth");
  const grid: { name: string; sleeve: Sleeve; cal: number }[] = [];
  for (const l of LEVELS)
    for (const minB of BREADTH) {
      const sleeve: Sleeve = { ...base, trades: byLevel.get(l)!, accept: (_t, b) => b >= minB };
      const name = `stoch < ${l} · breadth ≥ ${minB}`;
      grid.push({ name, sleeve, cal: compare(name, [sleeve], l === 20 && minB === 10 ? "= " : "  ").calmar });
    }
  const pick = grid.sort((a, b) => b.cal - a.cal)[0];
  console.log(`  ★ in-sample pick: ${pick.name}   ("= " marks v1.2 today)`);

  header("COMBINED with A refined (breakout, RS<0 + surge≥1.5 + F&G≥25, 0.5% risk)");
  const a: Sleeve = { ...base, risk: 0.005, maxBarRisk: 0.025, trades: t4[LEVELS.length], accept: (t) => t.rs < 0 && t.surge >= 1.5 && (t.fng ?? 50) >= 25 };
  compare("v1.2 today (stoch < 20 · breadth ≥ 10) + A", [{ ...base, trades: byLevel.get(20)!, accept: (_t, b) => b >= 10 }, a]);
  compare(`${pick.name} + A`, [pick.sleeve, a]);

  console.log("\nPER YEAR: v1.2 today │ in-sample pick");
  const today: Sleeve = { ...base, trades: byLevel.get(20)!, accept: (_t, b) => b >= 10 };
  for (let y = 2021; y <= new Date(END).getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), END);
    const f = (s: Sleeve) => {
      const r = simulate([s], from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} (${r.trades} tr, win ${(100 * r.win).toFixed(0)}%)`;
    };
    console.log(`  ${y}  ${f(today).padEnd(40)} │ ${f(pick.sleeve)}`);
  }

  console.log("\nZEC Aug → Oct 2026");
  for (const l of LEVELS) zec(`stoch < ${l} (no breadth)`, byLevel.get(l)!);

  // The owner's method on 1h with the fear filter (research/momentum.ts §D), strict vs loose level.
  const t1 = await collect([dotStoch({ trend: false, barMs: H1, label: "1h < 20", stochLevel: 20 }), dotStoch({ trend: false, barMs: H1, label: "1h < 50", stochLevel: 50 })], "1h", ctx);
  header("1h method while the market is fearful (BTC < 200D and F&G < 50)");
  const fear = (t: Trade) => t.btcUp === false && (t.fng ?? 50) < 50;
  compare("1h · stoch < 20", [{ ...base, trades: t1[0], accept: fear }]);
  compare("1h · stoch < 50", [{ ...base, trades: t1[1], accept: fear }]);
}

void main();
