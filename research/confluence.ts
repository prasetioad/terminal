/**
 * Tahap 7 (F2–F4): futures positioning as confluence for the setups — not as triggers.
 *
 *   F2  features at the entry (and while held), point in time: funding (last, 3-day mean),
 *       open interest change (1/3/7 days), global and top-trader long/short ratio, taker
 *       buy/sell ratio (last day vs last week), basis (perp vs spot).
 *   F3  terciles (cut on in-sample trades) → average net return and stop rate, IS │ OOS. A
 *       feature counts only if the in-sample confirms the direction fixed in advance (below).
 *   F4  exposure: a confluence score from the confirmed features scales the risk (or vetoes
 *       a trade); exit warnings tested on the same entries. Chosen on in-sample only.
 *
 * Trades come from the shared engines with the bot's current rules: v1.2 (first dot only,
 * breadth counted on all v1 signals) and Setup A (volume; with and without RS < −10%).
 * Coins without a perpetual, or before its data starts, are neutral (1×).
 *
 *   npx tsx research/futures.ts     (data, once)
 *   npx tsx research/confluence.ts
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_A, runSetupA } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { CACHE_DIR, archiveSymbols, loadSeries, segments, type ResearchBar } from "./data";
import { cachedFutures, type FuturesSeries } from "./futures";
import { compare, header, pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);

type Feature = "fund" | "fund3d" | "oi1d" | "oi3d" | "oi7d" | "global" | "top" | "taker" | "basis";
const FEATURES: Feature[] = ["fund", "fund3d", "oi1d", "oi3d", "oi7d", "global", "top", "taker", "basis"];
const LABEL: Record<Feature, string> = {
  fund: "funding (last)",
  fund3d: "funding (3-day mean)",
  oi1d: "open interest Δ 1 day",
  oi3d: "open interest Δ 3 days",
  oi7d: "open interest Δ 7 days",
  global: "long/short ratio (all accounts)",
  top: "long/short ratio (top traders' positions)",
  taker: "taker buy/sell (1 day ÷ 7 days)",
  basis: "basis (perp ÷ spot − 1)",
};
/** Directions fixed before looking (Tahap 7): +1 = higher is better, −1 = lower is better. */
const HYPOTHESIS: Record<"v1" | "a", Record<Feature, 1 | -1>> = {
  v1: { fund: -1, fund3d: -1, oi1d: -1, oi3d: -1, oi7d: -1, global: -1, top: -1, taker: 1, basis: -1 },
  a: { fund: -1, fund3d: -1, oi1d: 1, oi3d: 1, oi7d: 1, global: -1, top: -1, taker: 1, basis: -1 },
};

/* ───────────────────────────── features ───────────────────────────── */

type Feats = Partial<Record<Feature, number>>;

/** Point-in-time futures features at the close of the 4h bar opening at `openSec`. */
function featureReader(fut: FuturesSeries | null, spot: ResearchBar[]) {
  if (!fut) return () => ({}) as Feats;
  const idx = new Map(fut.bars.t.map((t, i) => [t, i]));
  const kIdx = new Map(fut.klines.t.map((t, i) => [t, i]));
  const sIdx = new Map(spot.map((b, i) => [b.time as number, i]));
  const fundT = fut.funding.map((f) => f.t);
  const lastFunding = (ms: number) => {
    let lo = 0;
    let hi = fundT.length - 1;
    if (!fundT.length || fundT[0] > ms) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fundT[mid] <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return (openSec: number): Feats => {
    const out: Feats = {};
    const close = openSec * 1000 + H4;
    const f = lastFunding(close);
    if (f >= 0 && close - fundT[f] < 1 * DAY) {
      out.fund = fut.funding[f].r;
      let sum = 0;
      let n = 0;
      for (let j = f; j >= 0 && fundT[j] > close - 3 * DAY; j--) {
        sum += fut.funding[j].r;
        n++;
      }
      out.fund3d = sum / n;
    }
    const k = idx.get(openSec);
    if (k !== undefined) {
      const back = (days: number) => idx.get(openSec - (days * DAY) / 1000);
      for (const [key, days] of [["oi1d", 1], ["oi3d", 3], ["oi7d", 7]] as const) {
        const j = back(days);
        if (j !== undefined && fut.bars.oi[j] > 0) out[key] = fut.bars.oi[k] / fut.bars.oi[j] - 1;
      }
      if (fut.bars.global[k] > 0) out.global = fut.bars.global[k];
      if (fut.bars.topPos[k] > 0) out.top = fut.bars.topPos[k];
      const takerMean = (bars: number) => {
        let sum = 0;
        let n = 0;
        for (let j = 0; j < bars; j++) {
          const i = idx.get(openSec - (j * H4) / 1000);
          if (i !== undefined && Number.isFinite(fut.bars.taker[i])) {
            sum += fut.bars.taker[i];
            n++;
          }
        }
        return n >= bars / 2 ? sum / n : Number.NaN;
      };
      const t1 = takerMean(6);
      const t7 = takerMean(42);
      if (Number.isFinite(t1) && Number.isFinite(t7) && t7 > 0) out.taker = t1 / t7;
    }
    const pk = kIdx.get(openSec);
    const sk = sIdx.get(openSec);
    if (pk !== undefined && sk !== undefined) out.basis = fut.klines.close[pk] / (spot[sk].close * fut.mult) - 1;
    return out;
  };
}

/* ───────────────────────────── trades ───────────────────────────── */

interface XTrade extends Trade {
  setup: "v1" | "a";
  reason: "stop" | "exit" | "end";
  breadth: number;
  volumeOk: boolean;
  rsOk: boolean;
  feats: Feats;
  /** Exit-warning variants: the trade cut at the first warning bar (null: no warning while held). */
  warn: Record<string, { exit: number; bars: number } | null>;
}

const WARNINGS: Record<string, (f: Feats, inProfit: boolean, priceChg1d: number) => boolean> = {
  "funding ≥ 0.05% while in profit": (f, p) => p && (f.fund ?? 0) >= 0.0005,
  "OI +20% in a day, price < +2%, in profit": (f, p, d) => p && (f.oi1d ?? 0) >= 0.2 && d < 0.02,
  "long/short (all) ≥ 2.5 while in profit": (f, p) => p && (f.global ?? 0) >= 2.5,
  "basis ≥ +0.5% while in profit": (f, p) => p && (f.basis ?? 0) >= 0.005,
};

function toTrade(
  setup: "v1" | "a",
  symbol: string,
  c: ResearchBar[],
  t: { entryIndex: number; entryPrice: number; stopPrice: number; exitIndex: number | null; exitPrice: number | null; exitReason: string | null },
  feat: (openSec: number) => Feats,
  extra: { breadth?: number; volumeOk?: boolean; rsOk?: boolean },
): XTrade {
  const end = t.exitIndex ?? c.length - 1;
  const closes = c.slice(t.entryIndex, end + 1).map((b) => b.close);
  const exit = t.exitPrice ?? c[end].close;
  closes[closes.length - 1] = exit;
  const warn: XTrade["warn"] = {};
  for (const name of Object.keys(WARNINGS)) warn[name] = null;
  for (let i = t.entryIndex + 1; i < end; i++) {
    const f = feat(c[i].time);
    const inProfit = c[i].close > t.entryPrice * (1 + 2 * SETUP_V1.cost);
    const d = i >= 6 ? c[i].close / c[i - 6].close - 1 : 0;
    for (const [name, rule] of Object.entries(WARNINGS)) if (!warn[name] && rule(f, inProfit, d)) warn[name] = { exit: c[i].close, bars: i - t.entryIndex };
  }
  return {
    symbol, at: c[t.entryIndex].time * 1000 + H4, barMs: H4, entry: t.entryPrice, stopDist: 1 - t.stopPrice / t.entryPrice,
    closes, exitBars: end - t.entryIndex, exit, open: t.exitIndex === null,
    liquidity: liquidity30d(c, t.entryIndex, H4), surge: 1, flow: 0, rs: 0, btcUp: null, fng: null,
    setup, reason: t.exitIndex === null ? "end" : t.exitReason === "stop" ? "stop" : "exit",
    breadth: extra.breadth ?? 0, volumeOk: extra.volumeOk ?? true, rsOk: extra.rsOk ?? true, feats: feat(c[t.entryIndex].time), warn,
  };
}

/** The trade as if closed at its first warning. */
function cutAtWarning(t: XTrade, name: string): XTrade {
  const w = t.warn[name];
  if (!w) return t;
  return { ...t, closes: [...t.closes.slice(0, w.bars), w.exit], exitBars: w.bars, exit: w.exit, open: false, reason: "exit" };
}

/* ───────────────────────────── report ───────────────────────────── */

const net = (t: Trade) => t.exit / t.entry - 1 - SETUP_V1.cost - (t.liquidity < 5e6 ? 0.002 : 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);

interface Confirmed {
  feature: Feature;
  lo: number; // IS tercile cuts
  hi: number;
  dir: 1 | -1;
}

/** F3: terciles cut on the in-sample; confirmed when the hypothesized direction holds in-sample by a margin. */
function diagnose(title: string, trades: XTrade[], setup: "v1" | "a"): Confirmed[] {
  const closed = trades.filter((t) => !t.open);
  const is = closed.filter((t) => t.at < SPLIT);
  const oos = closed.filter((t) => t.at >= SPLIT);
  const withData = (xs: XTrade[]) => xs.filter((t) => Object.keys(t.feats).length > 0).length;
  console.log(`\n${title}: ${closed.length} closed trades · with futures data: IS ${withData(is)}/${is.length} · OOS ${withData(oos)}/${oos.length}`);
  console.log(`  (terciles cut on in-sample trades; cell = n · stop rate · average net return; ✓ = in-sample confirms the direction fixed in advance)`);
  const margin = Math.max(0.01, 0.3 * Math.abs(avg(is.map(net))));
  const confirmed: Confirmed[] = [];
  for (const f of FEATURES) {
    const vals = is.map((t) => t.feats[f]).filter((v): v is number => v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length < 90) continue;
    const lo = vals[Math.floor(vals.length / 3)];
    const hi = vals[Math.floor((2 * vals.length) / 3)];
    const bucket = (t: XTrade) => {
      const v = t.feats[f];
      if (v === undefined || !Number.isFinite(v)) return -1;
      return v < lo ? 0 : v < hi ? 1 : 2;
    };
    const cell = (xs: XTrade[], b: number) => {
      const ys = xs.filter((t) => bucket(t) === b);
      if (!ys.length) return "–".padEnd(22);
      return `${String(ys.length).padStart(4)} · ${((100 * ys.filter((t) => t.reason === "stop").length) / ys.length).toFixed(0).padStart(2)}% · ${pct(avg(ys.map(net)), 1).padStart(6)}`;
    };
    const dir = HYPOTHESIS[setup][f];
    const good = dir === 1 ? 2 : 0;
    const bad = dir === 1 ? 0 : 2;
    const isGood = avg(is.filter((t) => bucket(t) === good).map(net));
    const isBad = avg(is.filter((t) => bucket(t) === bad).map(net));
    const nGood = is.filter((t) => bucket(t) === good).length;
    const nBad = is.filter((t) => bucket(t) === bad).length;
    const ok = isGood - isBad >= margin && nGood >= 30 && nBad >= 30;
    if (ok) confirmed.push({ feature: f, lo, hi, dir });
    const fmt = (v: number) => (Math.abs(v) < 0.1 ? v.toPrecision(2) : v.toFixed(2));
    console.log(`  ${ok ? "✓" : " "} ${LABEL[f].padEnd(42)} cuts ${fmt(lo)} / ${fmt(hi)} · hypothesis: ${dir === 1 ? "higher" : "lower"} is better`);
    console.log(`      IS  low ${cell(is, 0)}  mid ${cell(is, 1)}  high ${cell(is, 2)}`);
    console.log(`      OOS low ${cell(oos, 0)}  mid ${cell(oos, 1)}  high ${cell(oos, 2)}`);
  }
  console.log(`  confirmed in-sample: ${confirmed.map((c) => c.feature).join(", ") || "none"}`);
  return confirmed;
}

const score = (t: XTrade, confirmed: Confirmed[]) => {
  let s = 0;
  for (const c of confirmed) {
    const v = t.feats[c.feature];
    if (v === undefined || !Number.isFinite(v)) continue;
    const b = v < c.lo ? 0 : v < c.hi ? 1 : 2;
    if (b === 1) continue;
    s += (b === 2 ? 1 : -1) * c.dir;
  }
  return s;
};

/* ───────────────────────────── main ───────────────────────────── */

async function main() {
  const btc = await loadSeries("BTCUSDT", "4h", 2021);
  const v1: XTrade[] = [];
  const a: XTrade[] = [];
  const v1Signals: number[] = [];
  let pairs = 0;
  let withFutures = 0;
  const pending: { symbol: string; c: ResearchBar[]; feat: (s: number) => Feats; firsts: ReturnType<typeof runSetupV1> }[] = [];
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", "4h", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    const fut = cachedFutures(symbol);
    pairs++;
    if (fut) withFutures++;
    for (const c of segments(all, 3 * DAY)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      const feat = featureReader(fut, c);
      // Breadth: every v1 signal; entries: first dots only (the bot's rules).
      const base = runSetupV1(c, { stoch: "either", intervalMs: H4 });
      for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) v1Signals.push(t.entryTime + H4);
      pending.push({ symbol, c, feat, firsts: runSetupV1(c, { stoch: "either", intervalMs: H4, firstDotOnly: true }) });
      const ra = runSetupA(c as Candle[], H4, { btc });
      for (const t of [...ra.trades, ...(ra.open ? [ra.open] : [])])
        a.push(toTrade("a", symbol, c, t, feat, { volumeOk: t.surge >= SETUP_A.minSurge, rsOk: t.rs !== null && t.rs < SETUP_A.maxRs }));
    }
  }
  const breadthAt = new Map<number, number>();
  for (const at of v1Signals) breadthAt.set(at, (breadthAt.get(at) ?? 0) + 1);
  for (const p of pending) for (const t of [...p.firsts.trades, ...(p.firsts.open ? [p.firsts.open] : [])]) v1.push(toTrade("v1", p.symbol, p.c, t, p.feat, { breadth: breadthAt.get(t.entryTime + H4) ?? 0 }));
  console.log(`pairs ${pairs} · with a perpetual ${withFutures}`);

  const v12 = v1.filter((t) => t.breadth >= 10 && t.liquidity >= 1e6);
  const aRs = a.filter((t) => t.volumeOk && t.rsOk && t.liquidity >= 1e6);
  const aAll = a.filter((t) => t.volumeOk && t.liquidity >= 1e6);

  /* F3 */
  const cV1 = diagnose("v1.2 (first dot, breadth ≥ 10)", v12, "v1");
  const cA = diagnose("Setup A (volume + RS < −10%)", aRs, "a");
  const cAll = diagnose("Setup A (volume, all RS — incl. ZEC-type)", aAll, "a");

  /* F4 · exposure */
  type Scheme = { name: string; mult: (s: number) => number };
  const schemes: Scheme[] = [
    { name: "none (today)", mult: () => 1 },
    { name: "0.5× / 1.5× at |score| ≥ 1", mult: (s) => (s >= 1 ? 1.5 : s <= -1 ? 0.5 : 1) },
    { name: "0.5× / 1.5× at |score| ≥ 2", mult: (s) => (s >= 2 ? 1.5 : s <= -2 ? 0.5 : 1) },
    { name: "skip at score ≤ −1", mult: (s) => (s <= -1 ? 0 : 1) },
    { name: "skip at score ≤ −2", mult: (s) => (s <= -2 ? 0 : 1) },
    { name: "1.5× at score ≥ 1 only", mult: (s) => (s >= 1 ? 1.5 : 1) },
  ];
  const v1Sleeve = (confirmed: Confirmed[], m: Scheme["mult"]): Sleeve => ({
    trades: v12, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05, riskOf: (t) => 0.01 * m(score(t as XTrade, confirmed)),
  });
  const aSleeve = (trades: XTrade[], confirmed: Confirmed[], m: Scheme["mult"]): Sleeve => ({
    trades, risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025, riskOf: (t) => 0.005 * m(score(t as XTrade, confirmed)),
  });
  const picks: Record<string, Sleeve> = {};
  const today: Record<string, Sleeve> = {};
  for (const [label, confirmed, make] of [
    ["v1.2", cV1, (m: Scheme["mult"]) => v1Sleeve(cV1, m)],
    ["A (RS < −10%)", cA, (m: Scheme["mult"]) => aSleeve(aRs, cA, m)],
    ["A (all RS)", cAll, (m: Scheme["mult"]) => aSleeve(aAll, cAll, m)],
  ] as const) {
    header(`F4 · ${label} · exposure by confluence score (features: ${confirmed.map((c) => c.feature).join(", ") || "none confirmed"})`);
    const rows: { name: string; sleeve: Sleeve; is: Result }[] = [];
    for (const sc of schemes) {
      if (!confirmed.length && sc.name !== "none (today)") continue;
      const sleeve = make(sc.mult);
      rows.push({ name: sc.name, sleeve, is: compare(sc.name, [sleeve], sc.name === "none (today)" ? "= " : "  ") });
    }
    const pick = [...rows].sort((x, y) => y.is.calmar - x.is.calmar)[0];
    console.log(`  ★ in-sample pick: ${pick.name}`);
    picks[label] = pick.sleeve;
    today[label] = rows[0].sleeve;
  }

  header("F4 · COMBINED (shared capital)");
  compare("today: v1.2 + A (RS < −10%)", [today["v1.2"], today["A (RS < −10%)"]], "= ");
  compare("picks: v1.2 + A (RS < −10%)", [picks["v1.2"], picks["A (RS < −10%)"]]);
  compare("today: v1.2 + A (all RS)", [today["v1.2"], today["A (all RS)"]]);
  compare("picks: v1.2 + A (all RS)", [picks["v1.2"], picks["A (all RS)"]]);
  console.log(`\nPER YEAR: today (v1.2 + A RS) │ picks (v1.2 + A RS) │ picks (v1.2 + A all)`);
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve[]) => {
      const r = simulate(s, from, to);
      return `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)}`;
    };
    console.log(`  ${y}  ${f([today["v1.2"], today["A (RS < −10%)"]])} │ ${f([picks["v1.2"], picks["A (RS < −10%)"]])} │ ${f([picks["v1.2"], picks["A (all RS)"]])}`);
  }

  /* F4 · exit warnings (same entries, closed at the first warning) */
  console.log("\nF4 · EXIT WARNINGS: same entries, closed at the close of the first warning bar — average net per trade, today → with the warning (IS │ OOS)");
  for (const [label, trades] of [["v1.2", v12], ["A (RS < −10%)", aRs], ["A (all RS)", aAll]] as const) {
    const closed = trades.filter((t) => !t.open);
    console.log(`  ${label}`);
    for (const name of Object.keys(WARNINGS)) {
      const cell = (xs: XTrade[]) => {
        const hit = xs.filter((t) => t.warn[name]);
        return `warned ${String(hit.length).padStart(4)}/${String(xs.length).padEnd(4)} all ${pct(avg(xs.map(net)), 2).padStart(7)} → ${pct(avg(xs.map((t) => net(cutAtWarning(t, name)))), 2).padStart(7)}`;
      };
      console.log(`    ${name.padEnd(42)} ${cell(closed.filter((t) => t.at < SPLIT))} │ ${cell(closed.filter((t) => t.at >= SPLIT))}`);
    }
  }
}

void main();
