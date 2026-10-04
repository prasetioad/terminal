/**
 * Two setups, one account: shared capital vs capital split.
 *
 *   1  shared: v1.2 (capitulation) and Setup A (breakout, volume-confirmed) draw on the
 *      same cash freely.
 *   2  split:  Setup A's positions are capped at a share of equity, so cash is always
 *      left for a capitulation (and v1.2 optionally capped too).
 *
 * Same universe, costs and portfolio as §4.6–4.7. Chosen on in-sample only.
 *
 *   npx tsx research/capital-split.ts
 */
import { breakout, collect, compare, dotStoch, header, loadContext, pct, simulate, type Result, type Sleeve } from "./momentum";

const H4 = 4 * 3_600_000;

async function main() {
  const ctx = await loadContext();
  const [v1All, aAll] = await collect([dotStoch({ trend: false, barMs: H4, label: "v1" }), breakout(120, 8)], "4h", ctx);
  const v12 = (cap?: number): Sleeve => ({ trades: v1All, accept: (_t, b) => b >= 10, risk: 0.01, maxFrac: 0.2, maxOpen: 15, maxBarRisk: 0.05, maxExposure: cap });
  const setupA = (risk: number, cap?: number): Sleeve => ({ trades: aAll, accept: (t) => t.surge >= 1.5, risk, maxFrac: 0.2, maxOpen: 15, maxBarRisk: 5 * risk, maxExposure: cap });

  header("REFERENCE: each setup alone");
  compare("v1.2 alone", [v12()]);
  for (const r of [0.005, 0.01]) compare(`Setup A alone · risk ${r * 100}%`, [setupA(r)]);

  const rows: { name: string; sleeves: Sleeve[]; is: Result; kind: 1 | 2 }[] = [];
  header("1 · SHARED CAPITAL");
  for (const r of [0.005, 0.01]) {
    const sleeves = [v12(), setupA(r)];
    const name = `shared · A risk ${r * 100}%`;
    rows.push({ name, sleeves, kind: 1, is: compare(name, sleeves) });
  }
  header("2 · CAPITAL SPLIT (cap on each setup's share of equity)");
  for (const r of [0.005, 0.01])
    for (const aCap of [0.3, 0.5, 0.7])
      for (const vCap of [undefined, 0.5]) {
        const sleeves = [v12(vCap), setupA(r, aCap)];
        const name = `A risk ${r * 100}% ≤ ${aCap * 100}% · v1.2 ${vCap ? `≤ ${vCap * 100}%` : "free"}`;
        rows.push({ name, sleeves, kind: 2, is: compare(name, sleeves) });
      }

  const best = (k: 1 | 2) => rows.filter((x) => x.kind === k).sort((a, b) => b.is.calmar - a.is.calmar)[0];
  const b1 = best(1);
  const b2 = best(2);
  console.log(`\n  ★ in-sample pick · 1: ${b1.name}   2: ${b2.name}`);

  console.log(`\nPER YEAR: 1 (${b1.name}) │ 2 (${b2.name})`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve[]) => {
      const r = simulate(s, from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} (${r.trades} tr) used ${(100 * r.exposure).toFixed(0)}%`;
    };
    console.log(`  ${y}  ${f(b1.sleeves).padEnd(44)} │ ${f(b2.sleeves)}`);
  }
}

void main();
