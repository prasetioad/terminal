/**
 * What sets the winners apart before they move? Three studies on 4h bars of the whole
 * survivorship-free universe, one set of features computed at each decision (from data known
 * then). Buckets are the in-sample terciles; a feature counts only if it orders the outcome the
 * same way in- and out-of-sample.
 *
 *   1  TRENDS      every Setup A breakout (close above the 120-bar high, 8×ATR stop and
 *                  chandelier, spike tightening; no volume/RS filter, ≥ $1M/day): the trade's
 *                  result in R (cost 0.2%) and P(a big trend: ≥ +30%)
 *   2  REVERSALS   a close ≥ 30% under the 30-day high (the first in 30 days, ≥ $2M/day): over
 *                  the next 30 days, P(+30% before −30%), P(−30% first), the 10- and 30-day return
 *   3  VETOES      the bot's own trades (v1.2 first dot with breadth ≥ 10; A with volume ≥ 1.5× and
 *                  RS < −10%) in the bot's portfolio (cost 0.2%), skipping entries: below the
 *                  30-day value area · funding ≤ −0.05% · basis ≤ −0.6% · up > 10% in 24h · all four
 *
 * Features: volume surge (24h ÷ 30-day average) · RS vs BTC (30 days) · ATR% · 20-day range ·
 * distance from the high so far · age · 30-day and 24h return · funding (last 3) · basis · OI
 * change over 7 days · position in the 30-day value area ((close − VAL) ÷ (VAH − VAL)) · BTC vs its
 * 200-day average · USDT.D proxy under its 50-day average (the day before) · the share of the
 * universe in a ≥ 30% drawdown on that bar. IS 2021 → 2024-06, OOS after.
 *
 *   npx tsx research/anatomy.ts
 */
import fs from "node:fs";
import path from "node:path";
import { buildProfile } from "../lib/profile";
import { SETUP_A, relativeStrength, runSetupA, volumeSurge } from "../lib/setups/setupA";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { type AT, type V1T, toTrade } from "./audit";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { cachedFutures } from "./futures";
import { atr14, prefix } from "./intraday-edge";
import { pct, simulate, type Result, type Sleeve, type Trade } from "./momentum";
import { inUniverse } from "./universe";
import { supply, usdtSupply } from "./usdt-dominance";

const H4 = 4 * 3_600_000;
const DAY = 86_400;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);
const MONTH = 180; // 4h bars

type F = Record<string, number | null>;
const FEATURES = ["surge", "rs30", "atrPct", "range20", "fromHigh", "ageDays", "ret30", "ret1d", "funding", "basis", "oi7", "vaPos", "btcTrend", "usdtRiskOn", "breadthDD"] as const;

/** Highest close of the `len` bars before i (NaN until defined), via a monotonic deque. */
function priorMaxClose(c: ResearchBar[], len: number): Float64Array {
  const out = new Float64Array(c.length).fill(Number.NaN);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0; i < c.length; i++) {
    while (head < dq.length && dq[head] < i - len) head++;
    if (i >= len) out[i] = c[dq[head]].close;
    while (dq.length > head && c[dq[dq.length - 1]].close <= c[i].close) dq.pop();
    dq.push(i);
  }
  return out;
}

const load4h = (s: string): ResearchBar[] | null => {
  const f = path.join(CACHE_DIR, "klines", "4h", `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const btc = load4h("BTCUSDT") as ResearchBar[];
  const btcIdx = new Map(btc.map((b, i) => [b.time, i]));
  const btcPre = prefix(btc.map((b) => b.close));
  const btcTrend = (t: number) => {
    const i = btcIdx.get(t);
    return i === undefined || i < 1200 ? null : btc[i].close / ((btcPre[i + 1] - btcPre[i + 1 - 1200]) / 1200) - 1;
  };

  // USDT.D proxy: under its 50-day average, known the day before
  const usdt = await usdtSupply();
  const d1 = (s: string) => JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "klines", "1d", `${s}.json`), "utf8")) as ResearchBar[];
  const eth1 = new Map(d1("ETHUSDT").map((b) => [b.time, b.close]));
  const domDays: number[] = [];
  const dom: number[] = [];
  for (const b of d1("BTCUSDT")) {
    const e = eth1.get(b.time);
    const u = usdt.get(b.time);
    if (e === undefined || u === undefined) continue;
    domDays.push(b.time);
    dom.push(u / (b.close * supply("BTC", b.time) + e * supply("ETH", b.time)));
  }
  const riskOn = new Map<number, number>();
  for (let k = 50; k < dom.length; k++) {
    let m = 0;
    for (let j = k - 49; j <= k; j++) m += dom[j];
    riskOn.set(domDays[k], dom[k] < m / 50 ? 1 : 0);
  }
  const usdtRiskOn = (tSec: number) => riskOn.get(Math.floor(tSec / DAY) * DAY - DAY) ?? null;

  // pass 1: the share of the liquid universe in a ≥ 30% drawdown, per bar
  const ddCount = new Map<number, number>();
  const liqCount = new Map<number, number>();
  for (const s of symbols) {
    const all = load4h(s);
    if (!all?.length) continue;
    for (const c of segments(all, 3 * DAY * 1000)) {
      const q = prefix(c.map((b) => b.quoteVolume));
      const pm = priorMaxClose(c, MONTH);
      for (let i = MONTH; i < c.length; i++) {
        if (((q[i] - q[i - MONTH]) / 30) < 2e6) continue;
        const hi = pm[i];
        liqCount.set(c[i].time, (liqCount.get(c[i].time) ?? 0) + 1);
        if (c[i].close <= 0.7 * hi) ddCount.set(c[i].time, (ddCount.get(c[i].time) ?? 0) + 1);
      }
    }
  }

  interface TrendEv { at: number; f: F; r: number; big: boolean }
  interface RevEv { at: number; f: F; up: boolean; down: boolean; r10: number; r30: number }
  const trends: TrendEv[] = [];
  const revs: RevEv[] = [];
  const v1: (V1T & { f: F })[] = [];
  const aBot: (AT & { f: F })[] = [];
  const signals = new Map<number, number>();

  for (const s of symbols) {
    const all = load4h(s);
    if (!all?.length) continue;
    const fut = cachedFutures(s);
    const perpAt = new Map<number, number>(fut ? fut.klines.t.map((t, k) => [t, fut.klines.close[k] / fut.mult]) : []);
    const oiAt = new Map<number, number>(fut ? fut.bars.t.map((t, k) => [t, fut.bars.oi[k]]) : []);
    const first = all[0].time;
    for (const c of segments(all, 3 * DAY * 1000)) {
      if (c.length < SETUP_V1.warmup + 30) continue;
      const candles = c as unknown as Candle[];
      const a = atr14(c);
      const runHigh = new Float64Array(c.length);
      for (let i = 0; i < c.length; i++) runHigh[i] = Math.max(i ? runHigh[i - 1] : 0, c[i].high);
      const features = (i: number): F => {
        const t = c[i].time;
        const decision = (t + 4 * 3600) * 1000;
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = Math.max(0, i - 120); j < i; j++) {
          lo = Math.min(lo, c[j].low);
          hi = Math.max(hi, c[j].high);
        }
        let funding: number | null = null;
        if (fut) {
          const past = fut.funding.filter((x) => x.t <= decision).slice(-3);
          if (past.length) funding = past.reduce((p, x) => p + x.r, 0) / past.length;
        }
        const perp = perpAt.get(t);
        const oi = oiAt.get(t);
        const oi0 = oiAt.get(t - 7 * DAY);
        let vaPos: number | null = null;
        if (i >= MONTH) {
          const p = buildProfile(candles, i - MONTH, i - 1, { rows: 60, valueAreaPct: 70, lvnRatio: 0.35 });
          if (p) {
            const val = p.rows[p.vaLow].low;
            const vah = p.rows[p.vaHigh].low + p.rowSize;
            vaPos = vah > val ? (c[i].close - val) / (vah - val) : null;
          }
        }
        const liq = liqCount.get(t);
        return {
          surge: volumeSurge(candles, i, H4),
          rs30: relativeStrength(candles, i, btc as unknown as Candle[]),
          atrPct: a[i] / c[i].close,
          range20: (hi - lo) / c[i].close,
          fromHigh: i > 0 ? c[i].close / runHigh[i - 1] - 1 : null,
          ageDays: (t - first) / DAY,
          ret30: i >= MONTH ? c[i].close / c[i - MONTH].close - 1 : null,
          ret1d: i >= 6 ? c[i].close / c[i - 6].close - 1 : null,
          funding,
          basis: perp !== undefined ? perp / c[i].close - 1 : null,
          oi7: oi !== undefined && oi0 !== undefined && oi0 > 0 ? oi / oi0 - 1 : null,
          vaPos,
          btcTrend: btcTrend(t),
          usdtRiskOn: usdtRiskOn(t),
          breadthDD: liq ? (ddCount.get(t) ?? 0) / liq : null,
        };
      };

      // 1 · every Setup A breakout, no filter
      const ra = runSetupA(candles, H4, { btc: btc as unknown as Candle[], spikeTighten: SETUP_A.spikeTighten });
      for (const t of ra.trades) {
        if (liquidity30d(candles, t.entryIndex, H4) < 1e6 || t.exitPrice === null) continue;
        const ret = t.exitPrice / t.entryPrice - 1 - 0.002;
        const f = features(t.entryIndex);
        trends.push({ at: t.entryTime + H4, f, r: ret / (1 - t.stopPrice / t.entryPrice), big: ret >= 0.3 });
      }
      for (const t of [...ra.trades, ...(ra.open ? [ra.open] : [])]) {
        aBot.push({ ...toTrade(s, c, H4, 0, t.entryIndex, t.exitIndex, t.exitPrice, 1 - t.stopPrice / t.entryPrice), rsA: t.rs, surgeA: t.surge, f: features(t.entryIndex) });
      }

      // v1.2 trades and the breadth of all v1 signals
      const base = runSetupV1(candles, { stoch: "either", intervalMs: H4 });
      for (const t of [...base.trades, ...(base.open ? [base.open] : [])]) signals.set(t.entryTime + H4, (signals.get(t.entryTime + H4) ?? 0) + 1);
      const fd = runSetupV1(candles, { stoch: "either", intervalMs: H4, firstDotOnly: true });
      for (const t of [...fd.trades, ...(fd.open ? [fd.open] : [])]) v1.push({ ...toTrade(s, c, H4, 0, t.entryIndex, t.exitIndex, t.exitPrice, SETUP_V1.stopPct), breadth: 0, f: features(t.entryIndex) });

      // 2 · reversal candidates
      const q = prefix(c.map((b) => b.quoteVolume));
      const pm = priorMaxClose(c, MONTH);
      let lastEv = -Infinity;
      for (let i = MONTH; i < c.length - MONTH; i++) {
        const hi = pm[i];
        if (!(c[i].close <= 0.7 * hi) || i - lastEv < MONTH || (q[i] - q[i - MONTH]) / 30 < 2e6) continue;
        lastEv = i;
        const e = c[i].close;
        let up = false;
        let down = false;
        for (let x = i + 1; x <= i + MONTH; x++) {
          if (c[x].close >= 1.3 * e) {
            up = true;
            break;
          }
          if (c[x].close <= 0.7 * e) {
            down = true;
            break;
          }
        }
        revs.push({ at: (c[i].time + 4 * 3600) * 1000, f: features(i), up, down, r10: c[i + 60].close / e - 1, r30: c[i + MONTH].close / e - 1 });
      }
    }
  }
  for (const t of v1) t.breadth = signals.get(t.at) ?? 0;

  // reporting: in-sample terciles per feature
  const cuts = <E extends { at: number; f: F }>(evs: E[], k: string) => {
    const xs = evs.filter((e) => e.at < SPLIT && e.f[k] !== null).map((e) => e.f[k] as number).sort((p, q) => p - q);
    return xs.length < 30 ? null : [xs[Math.floor(xs.length / 3)], xs[Math.floor((2 * xs.length) / 3)]];
  };
  const bucket = (v: number | null, cut: number[] | null) => (v === null || cut === null ? -1 : v < cut[0] ? 0 : v < cut[1] ? 1 : 2);
  const fmt = (v: number) => (Math.abs(v) < 0.01 ? v.toExponential(1) : Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(0));
  function table<E extends { at: number; f: F }>(title: string, evs: E[], cols: [string, (xs: E[]) => string][]) {
    console.log(`\n${title}`);
    console.log(`  ${"feature".padEnd(11)} ${"bucket (IS cut points)".padEnd(26)} IS: ${cols.map(([n]) => n).join(" · ")} │ OOS`);
    for (const k of FEATURES) {
      const cut = k === "usdtRiskOn" ? [0.5, 0.5] : cuts(evs, k);
      if (!cut) continue;
      const names = k === "usdtRiskOn" ? ["fear (above MA50)", "", "risk-on"] : [`< ${fmt(cut[0])}`, `${fmt(cut[0])} – ${fmt(cut[1])}`, `≥ ${fmt(cut[1])}`];
      for (let b = 0; b < 3; b++) {
        if (!names[b]) continue;
        const sel = evs.filter((e) => bucket(e.f[k], cut) === b);
        const is = sel.filter((e) => e.at < SPLIT);
        const oos = sel.filter((e) => e.at >= SPLIT);
        const show = (xs: E[]) => `n ${String(xs.length).padStart(5)} ${cols.map(([, f]) => f(xs)).join(" ")}`;
        console.log(`  ${(b === 0 || (k === "usdtRiskOn" && b === 2) ? k : "").padEnd(11)} ${names[b].padEnd(26)} ${show(is)} │ ${show(oos)}`);
      }
    }
  }
  const mean = <E,>(xs: E[], f: (e: E) => number) => (xs.length ? xs.reduce((p, e) => p + f(e), 0) / xs.length : 0);
  table("1 · TRENDS: every Setup A breakout — mean R · P(≥ +30%)", trends, [
    ["mean R", (xs) => mean(xs, (e) => e.r).toFixed(2).padStart(6)],
    ["P(big)", (xs) => `${(100 * mean(xs, (e) => (e.big ? 1 : 0))).toFixed(0).padStart(3)}%`],
  ]);
  console.log(`  all: IS n ${trends.filter((e) => e.at < SPLIT).length} mean R ${mean(trends.filter((e) => e.at < SPLIT), (e) => e.r).toFixed(2)} │ OOS n ${trends.filter((e) => e.at >= SPLIT).length} mean R ${mean(trends.filter((e) => e.at >= SPLIT), (e) => e.r).toFixed(2)}`);
  table("2 · REVERSALS: ≥ 30% under the 30-day high — P(+30% first) · P(−30% first) · 10d · 30d", revs, [
    ["up", (xs) => `${(100 * mean(xs, (e) => (e.up ? 1 : 0))).toFixed(0).padStart(3)}%`],
    ["down", (xs) => `${(100 * mean(xs, (e) => (e.down ? 1 : 0))).toFixed(0).padStart(3)}%`],
    ["10d", (xs) => pct(mean(xs, (e) => e.r10), 1).padStart(6)],
    ["30d", (xs) => pct(mean(xs, (e) => e.r30), 1).padStart(6)],
  ]);
  const ri = revs.filter((e) => e.at < SPLIT);
  const ro = revs.filter((e) => e.at >= SPLIT);
  console.log(`  all: IS n ${ri.length} up ${(100 * mean(ri, (e) => (e.up ? 1 : 0))).toFixed(0)}% down ${(100 * mean(ri, (e) => (e.down ? 1 : 0))).toFixed(0)}% │ OOS n ${ro.length} up ${(100 * mean(ro, (e) => (e.up ? 1 : 0))).toFixed(0)}% down ${(100 * mean(ro, (e) => (e.down ? 1 : 0))).toFixed(0)}%`);

  // 3 · vetoes on the bot
  const cost = <T extends Trade>(ts: T[]): T[] => ts.map((t) => ({ ...t, exit: t.exit * 0.999, closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * 0.999] }));
  const v1c = cost(v1);
  const ac = cost(aBot);
  type Veto = (f: F) => boolean;
  const book = (veto: Veto): Sleeve[] => [
    { trades: v1c, accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth && !veto((t as V1T & { f: F }).f), risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 },
    {
      trades: ac,
      accept: (t) => {
        const x = t as AT & { f: F };
        return x.surgeA >= SETUP_A.minSurge && x.rsA !== null && x.rsA < SETUP_A.maxRs && !veto(x.f);
      },
      risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025,
    },
  ];
  const below: Veto = (f) => f.vaPos !== null && f.vaPos < 0;
  const fund: Veto = (f) => f.funding !== null && f.funding <= -0.0005;
  const basis: Veto = (f) => f.basis !== null && f.basis <= -0.006;
  const pump: Veto = (f) => f.ret1d !== null && f.ret1d > 0.1;
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y win ${(100 * r.win).toFixed(0)}%`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(36)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  console.log("\n3 · VETOES ON THE BOT (cost 0.2%) — IS │ OOS");
  both("today", book(() => false));
  both("skip below the 30-day value area", book(below));
  both("skip funding ≤ −0.05%", book(fund));
  both("skip basis ≤ −0.6%", book(basis));
  both("skip up > 10% in 24h", book(pump));
  both("all four", book((f) => below(f) || fund(f) || basis(f) || pump(f)));
  const share = (xs: { f: F }[], v: Veto) => `${((100 * xs.filter((x) => v(x.f)).length) / Math.max(1, xs.length)).toFixed(1)}%`;
  const v1ok = v1.filter((t) => t.breadth >= SETUP_V1.minBreadth && t.liquidity >= 1e6);
  const aok = aBot.filter((t) => t.surgeA >= SETUP_A.minSurge && t.rsA !== null && t.rsA < SETUP_A.maxRs && t.liquidity >= 1e6);
  console.log(`  share vetoed (v1.2 │ A): below VA ${share(v1ok, below)} │ ${share(aok, below)} · funding ${share(v1ok, fund)} │ ${share(aok, fund)} · basis ${share(v1ok, basis)} │ ${share(aok, basis)} · pump ${share(v1ok, pump)} │ ${share(aok, pump)}`);
  fs.writeFileSync(path.join(CACHE_DIR, "anatomy-trades.json"), JSON.stringify({ v1: v1.map((t) => ({ at: t.at, symbol: t.symbol, breadth: t.breadth, f: t.f })), a: aBot.map((t) => ({ at: t.at, symbol: t.symbol, f: t.f })) }));
}

if (process.argv[1]?.endsWith("anatomy.ts")) void main();
