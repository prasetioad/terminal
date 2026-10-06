/**
 * Intraday strategies on 5m and 15m candles of liquid pairs (research/intraday-pairs.ts),
 * long only (a spot account). Rules fixed before looking at results:
 *
 *   SWEEP & RECLAIM  the low of the last 4h (5m) / 8h (15m) is taken out, and within 2 bars a
 *                    close is back above it → buy that close. Stop 0.1% under the sweep's low
 *                    (0.3–3% away). Delta filter: none · taker buys > 50% of the reclaim bar ·
 *                    > 55% and volume ≥ 1.5× its average. Target 1R or 2R, else out after
 *                    4h (5m) / 12h (15m).
 *   SESSION ORB      sessions open 00:00, 07:00, 13:30 UTC; range = the first 30 minutes. The
 *                    first close above the range high within 4h → buy. Stop under the range low
 *                    (0.2–3%). Delta filter as above. Target 1R or 2R, else out 8h after the open.
 *
 * A stop and a target touched in the same bar count as the stop. Costs per round trip:
 * 0.2% (spot, market orders), 0.15% (spot with BNB fees), 0.04% (futures, limit orders).
 * In-sample 2022 → 2024-06, out-of-sample after.
 *
 *   npx tsx research/intraday-pairs.ts   (data, once)
 *   npx tsx research/intraday.ts
 */
import fs from "node:fs";
import path from "node:path";
import { liquidity30d } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, segments, type ResearchBar } from "./data";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { compare, header, pct, simulate, type Sleeve, type Trade } from "./momentum";

const M5 = 5 * 60_000;
const M15 = 15 * 60_000;
const SPLIT = Date.UTC(2024, 6, 1);

type Filter = "none" | "delta" | "delta+volume";
interface Rule {
  name: string;
  kind: "sweep" | "orb";
  tf: 5 | 15;
  filter: Filter;
  r: 1 | 2;
}

const RULES: Rule[] = [];
for (const kind of ["sweep", "orb"] as const)
  for (const tf of [5, 15] as const)
    for (const filter of ["none", "delta", "delta+volume"] as const) for (const r of [1, 2] as const) RULES.push({ name: `${kind === "sweep" ? "sweep&reclaim" : "session ORB"} ${tf}m · ${filter} · ${r}R`, kind, tf, filter, r });

interface X extends Trade {
  gross: number;
  reason: "stop" | "target" | "time" | "end";
}

function aggregate(bars: ResearchBar[], ms: number): ResearchBar[] {
  const out: ResearchBar[] = [];
  for (const b of bars) {
    const t = (Math.floor((b.time * 1000) / ms) * ms) / 1000;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      last.quoteVolume += b.quoteVolume;
      last.buyVolume = (last.buyVolume ?? 0) + (b.buyVolume ?? 0);
    } else out.push({ ...b, time: t as Candle["time"] });
  }
  return out;
}

const passes = (c: ResearchBar[], i: number, f: Filter, avgVol: number) => {
  if (f === "none") return true;
  const ratio = c[i].volume > 0 ? (c[i].buyVolume ?? 0) / c[i].volume : 0.5;
  if (f === "delta") return ratio > 0.5;
  return ratio > 0.55 && c[i].volume >= 1.5 * avgVol;
};

/** Hold from bar e: the stop first, then the target; out at the close after `maxBars`. */
function hold(c: ResearchBar[], e: number, stop: number, target: number, maxBars: number) {
  const entry = c[e].close;
  const closes = [entry];
  for (let x = e + 1; x < c.length; x++) {
    const b = c[x];
    if (b.low <= stop) {
      const px = Math.min(b.open, stop);
      closes.push(px);
      return { closes, exitBars: x - e, exit: px, reason: "stop" as const };
    }
    if (b.high >= target) {
      const px = Math.max(b.open, target);
      closes.push(px);
      return { closes, exitBars: x - e, exit: px, reason: "target" as const };
    }
    closes.push(b.close);
    if (x - e >= maxBars) return { closes, exitBars: x - e, exit: b.close, reason: "time" as const };
  }
  return { closes, exitBars: closes.length - 1, exit: c[c.length - 1].close, reason: "end" as const };
}

function trades(symbol: string, c: ResearchBar[], rule: Rule): X[] {
  const ms = rule.tf * 60_000;
  const out: X[] = [];
  const n = c.length;
  const volSum = [0];
  for (const b of c) volSum.push(volSum[volSum.length - 1] + b.volume);
  const avgVol = (i: number, len: number) => (i >= len ? (volSum[i] - volSum[i - len]) / len : Number.POSITIVE_INFINITY);
  const push = (e: number, stop: number, target: number, maxBars: number) => {
    const h = hold(c, e, stop, target, maxBars);
    out.push({
      symbol, at: c[e].time * 1000 + ms, barMs: ms, entry: c[e].close, stopDist: 1 - stop / c[e].close, closes: h.closes, exitBars: h.exitBars, exit: h.exit,
      open: h.reason === "end", liquidity: liquidity30d(c, e, ms), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null, gross: h.exit / c[e].close - 1, reason: h.reason,
    });
    return e + h.exitBars;
  };

  if (rule.kind === "sweep") {
    const L = rule.tf === 5 ? 48 : 32;
    const maxBars = rule.tf === 5 ? 48 : 48;
    // the lowest low of the L bars before i (monotonic deque)
    const prior = new Float64Array(n).fill(Number.NaN);
    const dq: number[] = [];
    let head = 0;
    for (let i = 0; i < n; i++) {
      while (head < dq.length && dq[head] < i - L) head++;
      if (i >= L) prior[i] = c[dq[head]].low;
      while (dq.length > head && c[dq[dq.length - 1]].low >= c[i].low) dq.pop();
      dq.push(i);
    }
    for (let i = L + 48; i < n - 1; i++) {
      const level = prior[i];
      if (!(c[i].low < level)) continue;
      // the reclaim: a close back above the swept level within 2 bars (the sweep bar included)
      let j = -1;
      for (let k = i; k <= Math.min(n - 1, i + 2); k++) {
        if (c[k].close > level) {
          j = k;
          break;
        }
      }
      if (j < 0) continue;
      let low = Number.POSITIVE_INFINITY;
      for (let k = i; k <= j; k++) low = Math.min(low, c[k].low);
      const entry = c[j].close;
      const stop = low * 0.999;
      const sd = 1 - stop / entry;
      if (sd < 0.003 || sd > 0.03 || !passes(c, j, rule.filter, avgVol(j, 48))) continue;
      i = push(j, stop, entry * (1 + rule.r * sd), maxBars);
    }
    return out;
  }

  // Session ORB
  const orBars = rule.tf === 5 ? 6 : 2;
  const window = (4 * 60) / rule.tf;
  const life = (8 * 60) / rule.tf;
  const opens = new Set([0, 7 * 60, 13 * 60 + 30]);
  for (let s = 48; s < n - orBars - 1; s++) {
    const t = c[s].time * 1000;
    const minute = Math.floor((t % 86_400_000) / 60_000);
    if (!opens.has(minute)) continue;
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let k = s; k < s + orBars; k++) {
      hi = Math.max(hi, c[k].high);
      lo = Math.min(lo, c[k].low);
    }
    for (let e = s + orBars; e < Math.min(n - 1, s + orBars + window); e++) {
      if (!(c[e].close > hi && c[e - 1].close <= hi)) continue;
      const stop = lo * 0.9995;
      const sd = 1 - stop / c[e].close;
      if (sd < 0.002 || sd > 0.03 || !passes(c, e, rule.filter, avgVol(e, 48))) break;
      push(e, stop, c[e].close * (1 + rule.r * sd), Math.max(1, s + life - e));
      break;
    }
  }
  return out;
}

async function main() {
  const all: X[][] = RULES.map(() => []);
  let pairs = 0;
  for (const symbol of INTRADAY_PAIRS) {
    const file = path.join(CACHE_DIR, "klines", "5m", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    pairs++;
    const raw: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const seg of segments(raw, 60 * 60_000)) {
      if (seg.length < 2000) continue;
      const m15 = aggregate(seg, M15);
      RULES.forEach((rule, k) => all[k].push(...trades(symbol, rule.tf === 5 ? seg : m15, rule)));
    }
  }
  console.log(`${pairs} pairs · 5m and 15m · IS 2022 → 2024-06 │ OOS 2024-07 → now\n`);
  console.log("PER TRADE: n · target hit · stop hit · gross (= break-even cost) · net at 0.2% / 0.15% / 0.04%");
  const cell = (xs: X[]) => {
    const c = xs.filter((t) => !t.open);
    if (!c.length) return "–";
    const g = c.reduce((s, t) => s + t.gross, 0) / c.length;
    const sd = Math.sqrt(c.reduce((s, t) => s + (t.gross - g) ** 2, 0) / Math.max(1, c.length - 1));
    const share = (r: X["reason"]) => `${((100 * c.filter((t) => t.reason === r).length) / c.length).toFixed(0)}%`;
    return `n ${String(c.length).padStart(6)} · tgt ${share("target").padStart(3)} · stop ${share("stop").padStart(3)} · gross ${pct(g, 3).padStart(7)} (t=${((g / sd) * Math.sqrt(c.length)).toFixed(1).padStart(5)}) · net ${pct(g - 0.002, 2)} / ${pct(g - 0.0015, 2)} / ${pct(g - 0.0004, 2)}`;
  };
  RULES.forEach((rule, k) => {
    console.log(`  ${rule.name.padEnd(38)} ${cell(all[k].filter((t) => t.at < SPLIT))}`);
    console.log(`  ${"".padEnd(38)} ${cell(all[k].filter((t) => t.at >= SPLIT))}`);
  });

  // Portfolios for the rules whose in-sample gross covers the spot cost with BNB fees.
  const isGross = (k: number) => {
    const c = all[k].filter((t) => t.at < SPLIT && !t.open);
    return c.reduce((s, t) => s + t.gross, 0) / Math.max(1, c.length);
  };
  const ranked = RULES.map((_, k) => k).sort((a, b) => isGross(b) - isGross(a));
  const sleeve = (k: number, cost: number): Sleeve => ({
    trades: all[k].map((t) => ({ ...t, liquidity: Math.max(t.liquidity, 5e6), exit: t.exit * (1 + 0.001 - cost) })),
    risk: 0.005, maxFrac: 0.25, maxOpen: 6, maxBarRisk: 0.02,
  });
  for (const cost of [0.0015, 0.0004]) {
    header(`PORTFOLIO (0.5% risk per trade, ≤ 25% a position, ≤ 6 open) at ${(cost * 100).toFixed(2)}% — the 6 best rules in-sample`);
    for (const k of ranked.slice(0, 6)) compare(RULES[k].name, [sleeve(k, cost)]);
  }
  const best = ranked[0];
  console.log(`\nPER YEAR, ${RULES[best].name} (CAGR / DD at 0.15% │ 0.04%)`);
  for (let y = 2022; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (cost: number) => {
      const r = simulate([sleeve(best, cost)], from, to);
      return `${pct(r.cagr).padStart(7)} ${pct(r.maxDD).padStart(6)}`;
    };
    console.log(`  ${y}  ${f(0.0015)} │ ${f(0.0004)}`);
  }
}

if (process.argv[1]?.endsWith("intraday.ts")) void main();
