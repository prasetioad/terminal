/**
 * The timeframe test of research/audit.ts made fair. Applying the engines unchanged to another
 * timeframe changes what they mean:
 *
 *   v1.2   a green dot needs the chart's WaveTrend deeply oversold while the higher timeframe's
 *          is still up. The engine's bias timeframe is 1D for 4h (6×) but 4h for 2h/3h and 1D
 *          for 12h (≤ 2×): the two then move together and no dot ever passes (0 trades).
 *          Here the bias is always 6 × the chart (1h → 6h, 2h → 12h, 3h → 18h, 6h → 36h,
 *          8h → 2D, 12h → 3D). Breadth: ≥ 10 pairs on the same bar, as on 4h.
 *   Setup A  its windows are in bars (a 120-bar breakout is 20 days on 4h, 5 days on 1h).
 *          Here in days, as on 4h: a 20-day breakout, 30-day RS, a warm-up of ~37 days; the
 *          ATR multiples (8, spike 4) scale by √(4h ÷ chart), since ATR grows with √time.
 *
 * Copies of the engines' logic with those knobs (the bot's engines are untouched); on 4h they
 * reproduce lib/setups (checked at the start). Portfolio as audit.ts, cost 0.2%.
 *
 *   npx tsx research/audit-tf.ts
 */
import { computeMaxFlow } from "../lib/maxflow";
import { SETUP_A, atr, runSetupA, volumeSurge } from "../lib/setups/setupA";
import { SETUP_V1, runSetupV1, stochastic } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { type AT, type V1T, aggregate, load1h, toTrade } from "./audit";
import { archiveSymbols, segments, type ResearchBar } from "./data";
import { pct, simulate, type Result, type Sleeve } from "./momentum";
import { inUniverse } from "./universe";

const H = 3_600_000;
const DAY = 24 * H;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.UTC(2026, 9, 3);
const HOURS = [1, 2, 3, 4, 6, 8, 12];

interface Out {
  entryIndex: number;
  entryTime: number;
  exitIndex: number | null;
  exitPrice: number | null;
}

/** runSetupV1 with the bias timeframe as a parameter (and the warm-up in bars as the engine). */
function v1(c: Candle[], intervalMs: number, htfMs: number, firstDotOnly: boolean): Out[] {
  const n = c.length;
  const out: Out[] = [];
  if (n <= SETUP_V1.warmup + 1) return out;
  const mf = computeMaxFlow(c, {
    scalping: false, obosFilter: true, divergence: false, hiddenDivergence: false, mtf: true, htfMs, intervalMs,
    dynamicBands: false, atrLength: 14, volumeArea: false, earlyWarning: false, mfLength: 14, mfSmooth: 3, vwapLength: 8,
  });
  const green = new Uint8Array(n);
  for (const d of mf.dots) if (d.kind === "green" && d.index + 1 < n) green[d.index + 1] = 1;
  const red = new Uint8Array(n);
  for (let i = 1; i + 1 < n; i++) if (mf.wt1[i] < mf.wt2[i] && mf.wt1[i - 1] >= mf.wt2[i - 1] && mf.wt1[i] > 0) red[i + 1] = 1;
  const fast = stochastic(c, 5, 3, 3);
  const slow = stochastic(c, 14, 3, 3);
  const up = (s: { k: number[]; d: number[] }, i: number) => s.k[i] > s.d[i] && s.k[i - 1] <= s.d[i - 1] && Math.min(s.k[i - 1], s.d[i - 1]) < 20;
  let s = SETUP_V1.warmup;
  while (s < n) {
    let dot = false;
    for (let j = s; j >= s - SETUP_V1.dotWindow; j--) if (green[j]) dot = true;
    let earlier = false;
    if (firstDotOnly) for (let j = s - SETUP_V1.dotWindow - 1; j >= Math.max(0, s - SETUP_V1.priorDotBars); j--) if (green[j]) earlier = true;
    if (!dot || !(up(fast, s) || up(slow, s)) || earlier) {
      s++;
      continue;
    }
    const stop = c[s].close * (1 - SETUP_V1.stopPct);
    let x = s + 1;
    let exit: number | null = null;
    for (; x < n; x++) {
      if (c[x].low <= stop) {
        exit = stop;
        break;
      }
      if (red[x]) {
        exit = c[x].close;
        break;
      }
    }
    if (exit === null) {
      out.push({ entryIndex: s, entryTime: c[s].time * 1000, exitIndex: null, exitPrice: null });
      break;
    }
    out.push({ entryIndex: s, entryTime: c[s].time * 1000, exitIndex: x, exitPrice: exit });
    s = x + 1;
  }
  return out;
}

interface OutA extends Out {
  stopPrice: number;
  surge: number;
  rs: number | null;
}

/** runSetupA with its windows in days and its ATR multiples scaled by √(4h ÷ chart). */
function setupA(c: Candle[], intervalMs: number, btc: Candle[]): OutA[] {
  const perDay = DAY / intervalMs;
  const lookback = Math.round(20 * perDay);
  const warmup = Math.round((SETUP_A.warmup * 4 * H) / intervalMs);
  const scale = Math.sqrt((4 * H) / intervalMs);
  const k0 = SETUP_A.atrMult * scale;
  const spikeK = SETUP_A.spikeTighten.k * scale;
  const rsBars = Math.round(30 * perDay);
  const n = c.length;
  const out: OutA[] = [];
  if (n <= warmup + 1) return out;
  const hh = new Array<number>(n).fill(Number.NaN);
  {
    const dq: number[] = [];
    let head = 0;
    for (let i = 0; i < n; i++) {
      while (head < dq.length && dq[head] < i - lookback) head++;
      if (i >= lookback) hh[i] = c[dq[head]].high;
      while (dq.length > head && c[dq[dq.length - 1]].high <= c[i].high) dq.pop();
      dq.push(i);
    }
  }
  const a = atr(c, SETUP_A.atrLength);
  // relative strength over 30 days, as the engine's helper (which counts SETUP_A.rsBars bars)
  const btcAt = (t: number) => {
    let lo = 0;
    let hi = btc.length - 1;
    if (!btc.length || btc[0].time > t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (btc[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const rsOf = (i: number) => {
    if (i < rsBars) return null;
    const j = btcAt(c[i].time);
    if (j < rsBars) return null;
    return c[i].close / c[i - rsBars].close - btc[j].close / btc[j - rsBars].close;
  };
  for (let s = warmup; s < n; s++) {
    if (!(c[s].close > hh[s] && c[s - 1].close <= hh[s - 1])) continue;
    const entry = c[s].close;
    const stopDist = (k0 * a[s]) / entry;
    if (stopDist > SETUP_A.maxStopPct) continue;
    const stopPrice = entry * (1 - stopDist);
    let best = entry;
    let k = k0;
    let x = s + 1;
    let exit: number | null = null;
    for (; x < n; x++) {
      const bar = c[x];
      if (bar.low <= stopPrice) {
        exit = Math.min(bar.open, stopPrice);
        break;
      }
      if (bar.close < best - k * a[x - 1]) {
        exit = bar.close;
        break;
      }
      best = Math.max(best, bar.close);
      if (bar.close > entry * (1 + 2 * SETUP_A.cost) && bar.close > bar.open && bar.high - bar.low >= SETUP_A.spikeTighten.range * a[x - 1]) k = Math.min(k, spikeK);
    }
    const t = { entryIndex: s, entryTime: c[s].time * 1000, stopPrice, surge: volumeSurge(c, s, intervalMs), rs: rsOf(s) };
    if (exit === null) {
      out.push({ ...t, exitIndex: null, exitPrice: null });
      break;
    }
    out.push({ ...t, exitIndex: x, exitPrice: exit });
    s = x;
  }
  return out;
}

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  const btc1h = load1h("BTCUSDT");
  if (!btc1h) throw new Error("BTCUSDT 1h missing");

  // the copies must reproduce the bot's engines on 4h
  {
    const c = aggregate(load1h("SOLUSDT") ?? [], 4, 0) as unknown as Candle[];
    const b4 = aggregate(btc1h, 4, 0) as unknown as Candle[];
    const e1 = runSetupV1(c, { stoch: "either", intervalMs: 4 * H, firstDotOnly: true });
    const m1 = v1(c, 4 * H, DAY, true);
    const eA = runSetupA(c, 4 * H, { btc: b4, spikeTighten: SETUP_A.spikeTighten });
    const mA = setupA(c, 4 * H, b4);
    const same = (p: { entryIndex: number; exitIndex: number | null }[], q: { entryIndex: number; exitIndex: number | null }[]) =>
      p.length === q.length && p.every((t, i) => t.entryIndex === q[i].entryIndex && t.exitIndex === q[i].exitIndex);
    const eAll = [...eA.trades, ...(eA.open ? [eA.open] : [])];
    const e1All = [...e1.trades, ...(e1.open ? [e1.open] : [])];
    const rsSame = eAll.every((t, i) => (t.rs === null && mA[i]?.rs === null) || Math.abs((t.rs ?? 0) - (mA[i]?.rs ?? 0)) < 1e-9);
    console.log(`check on SOL 4h: v1 ${same(e1All, m1) ? "identical" : "DIFFERENT"} (${m1.length}) · A ${same(eAll, mA) && rsSame ? "identical" : "DIFFERENT"} (${mA.length})`);
  }

  const v1T = new Map<number, V1T[]>(HOURS.map((h) => [h, []]));
  const aT = new Map<number, AT[]>(HOURS.map((h) => [h, []]));
  const breadth = new Map<number, Map<number, number>>(HOURS.map((h) => [h, new Map()]));
  const btcBy = new Map(HOURS.map((h) => [h, aggregate(btc1h, h, 0) as unknown as Candle[]]));
  let done = 0;
  for (const symbol of symbols) {
    const bars = load1h(symbol);
    if (!bars) continue;
    for (const h of HOURS) {
      const barMs = h * H;
      for (const c of segments(aggregate(bars, h, 0), Math.max(3 * DAY, 6 * barMs))) {
        if (c.length < SETUP_V1.warmup + 30) continue;
        const candles = c as unknown as Candle[];
        const map = breadth.get(h) ?? new Map();
        for (const t of v1(candles, barMs, 6 * barMs, false)) map.set(t.entryTime + barMs, (map.get(t.entryTime + barMs) ?? 0) + 1);
        for (const t of v1(candles, barMs, 6 * barMs, true)) v1T.get(h)?.push({ ...toTrade(symbol, c as ResearchBar[], barMs, 0, t.entryIndex, t.exitIndex, t.exitPrice, SETUP_V1.stopPct), breadth: 0 });
        for (const t of setupA(candles, barMs, btcBy.get(h) ?? [])) aT.get(h)?.push({ ...toTrade(symbol, c as ResearchBar[], barMs, 0, t.entryIndex, t.exitIndex, t.exitPrice, 1 - t.stopPrice / c[t.entryIndex].close), rsA: t.rs, surgeA: t.surge });
      }
    }
    if (++done % 100 === 0) console.log(`  ${done} pairs…`);
  }
  for (const h of HOURS) for (const t of v1T.get(h) ?? []) t.breadth = breadth.get(h)?.get(t.at) ?? 0;

  const cost = <T extends V1T | AT>(ts: T[]): T[] => ts.map((t) => ({ ...t, exit: t.exit * 0.999, closes: [...t.closes.slice(0, -1), (t.closes.at(-1) ?? t.exit) * 0.999] }));
  const row = (r: Result) => `CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)} · ${r.perYear.toFixed(0).padStart(4)}/y win ${(100 * r.win).toFixed(0)}%`;
  const both = (label: string, s: Sleeve[]) => console.log(`  ${label.padEnd(26)} ${row(simulate(s, START, SPLIT))} │ ${row(simulate(s, SPLIT, END))}`);
  console.log("\nFAIR TIMEFRAMES (bias 6× the chart; Setup A in days), cost 0.2% — IS │ OOS");
  for (const h of HOURS) {
    const sv1: Sleeve = { trades: cost(v1T.get(h) ?? []), accept: (t) => (t as V1T).breadth >= SETUP_V1.minBreadth, risk: 0.01, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.05 };
    const sa: Sleeve = {
      trades: cost(aT.get(h) ?? []),
      accept: (t) => (t as AT).surgeA >= SETUP_A.minSurge && (t as AT).rsA !== null && ((t as AT).rsA ?? 0) < SETUP_A.maxRs,
      risk: 0.005, maxFrac: 0.1, maxOpen: 15, maxBarRisk: 0.025,
    };
    both(`${h}h both`, [sv1, sa]);
    both(`    v1.2 (bias ${h * 6 >= 24 ? `${(h * 6) / 24}D` : `${h * 6}h`})`, [sv1]);
    both("    Setup A (in days)", [sa]);
  }
}

if (process.argv[1]?.endsWith("audit-tf.ts")) void main();
