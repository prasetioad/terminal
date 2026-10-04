/**
 * Can Setup v1 find more capitulation trades without losing quality?
 *
 *   E1  green dots without the higher-timeframe (1D) bias: in a crash the daily
 *       WaveTrend is negative, which today blocks every green dot.
 *   E2  breadth over a window: count the pairs that signalled within the last w bars
 *       (w = 1 is v1.1), so a capitulation spread over a few bars still counts.
 *
 * Bot-like portfolio as in §4.6 (1% risk, ≤ 15 open, ≤ 5% risk per bar = v1.2 rules).
 * Chosen on in-sample only; out-of-sample reported.
 *
 *   npx tsx research/v1-experiments.ts
 */
import { collect, compare, dotStoch, header, loadContext, pct, simulate, type Sleeve, type Trade } from "./momentum";

const H4 = 4 * 3_600_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);

/** Pairs (distinct) whose entry happened within the last `w` bars, at each entry time. */
function windowBreadth(trades: Trade[], w: number): Map<number, number> {
  const bySymbolTimes = new Map<number, Set<string>>();
  for (const t of trades) (bySymbolTimes.get(t.at) ?? bySymbolTimes.set(t.at, new Set()).get(t.at)!).add(t.symbol);
  const out = new Map<number, number>();
  for (const at of bySymbolTimes.keys()) {
    const seen = new Set<string>();
    for (let j = 0; j < w; j++) for (const s of bySymbolTimes.get(at - j * H4) ?? []) seen.add(s);
    out.set(at, seen.size);
  }
  return out;
}

async function main() {
  const ctx = await loadContext();
  const [withBias, noBias] = await collect(
    [dotStoch({ trend: false, barMs: H4, label: "bias" }), dotStoch({ trend: false, barMs: H4, label: "no bias", htfBias: false })],
    "4h",
    ctx,
  );
  const base = { risk: 0.01, maxFrac: 0.2, maxOpen: 15, maxBarRisk: 0.05 };

  const grid: { name: string; sleeve: Sleeve; is: ReturnType<typeof simulate> }[] = [];
  header("GRID: signal source × breadth window × threshold (v1.2 portfolio rules)");
  for (const [label, trades] of [["1D bias (today)", withBias], ["no 1D bias", noBias]] as const) {
    for (const w of [1, 2, 3]) {
      const breadth = windowBreadth(trades, w);
      for (const min of [10, 15, 20, 30]) {
        const sleeve: Sleeve = { ...base, trades, accept: (t) => breadth.get(t.at)! >= min };
        const name = `${label} · window ${w} · ≥ ${min}`;
        const mark = label.startsWith("1D") && w === 1 && min === 10 ? "= " : "  ";
        grid.push({ name, sleeve, is: compare(name, [sleeve], mark) });
      }
    }
  }
  const pick = [...grid].sort((a, b) => b.is.calmar - a.is.calmar)[0];
  console.log(`  ★ in-sample pick: ${pick.name}   ("= " marks v1.2 today)`);

  // How many signals does the bias block, and how good are they?
  const key = (t: Trade) => t.symbol + t.at;
  const kept = new Set(withBias.map(key));
  const extra = noBias.filter((t) => !kept.has(key(t)) && t.liquidity >= 1e6 && !t.open);
  const br = windowBreadth(noBias, 1);
  const net = (t: Trade) => t.exit / t.entry - 1 - 0.001 - (t.liquidity < 5e6 ? 0.002 : 0);
  const stat = (xs: Trade[]) => (xs.length ? `n ${String(xs.length).padStart(4)} win ${((100 * xs.filter((t) => net(t) > 0).length) / xs.length).toFixed(0)}% avg ${pct(xs.reduce((a, t) => a + net(t), 0) / xs.length, 2)}` : "–");
  console.log("\nSignals only the no-bias variant takes (liquid, closed): IS │ OOS");
  for (const [label, f] of [["all", () => true], ["breadth ≥ 10", (t: Trade) => br.get(t.at)! >= 10]] as const) {
    const xs = extra.filter(f);
    console.log(`  ${label.padEnd(14)} ${stat(xs.filter((t) => t.at >= START && t.at < SPLIT))} │ ${stat(xs.filter((t) => t.at >= SPLIT))}`);
  }

  const today = grid.find((g) => g.name === "1D bias (today) · window 1 · ≥ 10")!;
  console.log(`\nPER YEAR: v1.2 today │ ${pick.name}`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve) => {
      const r = simulate([s], from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} (${r.trades} tr, win ${(100 * r.win).toFixed(0)}%)`;
    };
    console.log(`  ${y}  ${f(today.sleeve).padEnd(40)} │ ${f(pick.sleeve)}`);
  }
}

void main();
