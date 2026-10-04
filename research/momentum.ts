/**
 * Momentum research: can we catch trends like ZEC (Aug → Oct 2026, $490 → $1,700) that
 * Setup v1.1 never takes? v1.1 buys market-wide capitulation; a lone coin trending up
 * never has breadth. Tests other strategy families and other data on the same
 * survivorship-free universe and the same bot-like portfolio:
 *
 *   A  breakout        new N-bar high, chandelier trailing stop (few winners, big ones)
 *   B  trend pullback  MaxFlow green dot + stoch cross while the coin is in an uptrend
 *   C  rotation        hold the K strongest coins of the week (cross-sectional momentum)
 *   D  1h setup        the owner's method on 1h (needs: npx tsx research/preload.ts 1h)
 *
 * Extra data as features: taker buy flow (orderflow), volume surge, relative strength vs
 * BTC, BTC regime (200D), Crypto Fear & Greed index (alternative.me). Open interest has no
 * public history beyond 30 days, so it can only be collected going forward.
 *
 *   npx tsx research/momentum.ts
 *
 * Parameters are chosen on the in-sample period only; out-of-sample is reported, never
 * used to choose (docs/ROADMAP.md §2).
 */
import fs from "node:fs";
import path from "node:path";
import { SETUP_V1, liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import { CACHE_DIR, archiveSymbols, fetchWithRetry, loadSeries, segments, type ResearchBar } from "./data";
import { inUniverse } from "./universe";

const H1 = 3_600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const START = Date.UTC(2021, 0, 1);
const SPLIT = Date.UTC(2024, 6, 1);
const END = Date.now();
const WARMUP = SETUP_V1.warmup;

/* ───────────────────────────── trades ───────────────────────────── */

export interface Trade {
  symbol: string;
  /** Decision time (close of the signal bar), ms. */
  at: number;
  barMs: number;
  entry: number;
  /** Fraction lost at the initial stop (1 = no stop: the whole position is at risk). */
  stopDist: number;
  /** Closes from the entry bar to the exit bar, for marking to market. */
  closes: number[];
  exitBars: number;
  exit: number;
  open: boolean; // still open at the end of the data (marked, not closed)
  liquidity: number;
  surge: number; // last-day quote volume ÷ 30-day daily average
  flow: number; // taker-buy share of volume, last day minus last 30 days (orderflow)
  rs: number; // 30-day return minus BTC's
  btcUp: boolean | null;
  fng: number | null;
}

const cost = (t: Trade) => SETUP_V1.cost + (t.liquidity < 5e6 ? 0.002 : 0);
const netRet = (t: Trade) => t.exit / t.entry - 1 - cost(t);

/* ───────────────────────────── context ───────────────────────────── */

interface Context {
  btcUp: (t: number) => boolean | null;
  btcRet30: (t: number) => number;
  fng: (t: number) => number | null;
}

export async function loadContext(): Promise<Context> {
  const btc = await loadSeries("BTCUSDT", "4h", 2021);
  const at = btc.map((b) => b.time * 1000 + H4);
  const N = 1200; // 200 days of 4h bars
  const sma: number[] = [];
  let sum = 0;
  btc.forEach((b, i) => {
    sum += b.close;
    if (i >= N) sum -= btc[i - N].close;
    sma.push(i >= N - 1 ? sum / N : Number.NaN);
  });
  const index = (t: number) => {
    let lo = 0;
    let hi = at.length - 1;
    if (t < at[0]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (at[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const file = path.join(CACHE_DIR, "fng.json");
  if (!fs.existsSync(file)) fs.writeFileSync(file, await (await fetchWithRetry("https://api.alternative.me/fng/?limit=0&format=json")).text());
  const fng = new Map<number, number>();
  for (const d of JSON.parse(fs.readFileSync(file, "utf8")).data as { value: string; timestamp: string }[]) fng.set(Math.floor((Number(d.timestamp) * 1000) / DAY), Number(d.value));
  return {
    btcUp: (t) => {
      const i = index(t);
      return i < 0 || Number.isNaN(sma[i]) ? null : btc[i].close > sma[i];
    },
    btcRet30: (t) => {
      const i = index(t);
      return i >= 180 ? btc[i].close / btc[i - 180].close - 1 : 0;
    },
    // the index of a day is published during that day: use the previous day's
    fng: (t) => fng.get(Math.floor(t / DAY) - 1) ?? null,
  };
}

/* ───────────────────────────── indicators ───────────────────────────── */

function atr(bars: ResearchBar[], n = 14): number[] {
  const out: number[] = [];
  let a = Number.NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
    a = i < n ? (i === 0 ? tr : (a * i + tr) / (i + 1)) : (a * (n - 1) + tr) / n;
    out.push(a);
  }
  return out;
}

function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let p = values[0];
  for (const v of values) out.push((p = k * v + (1 - k) * p));
  return out;
}

/** Highest high of the `n` bars before i (excluding i), via a monotonic deque. */
function priorHigh(bars: ResearchBar[], n: number): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  const dq: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    while (dq.length && dq[0] < i - n) dq.shift();
    if (i >= n) out[i] = bars[dq[0]].high;
    while (dq.length && bars[dq.at(-1)!].high <= bars[i].high) dq.pop();
    dq.push(i);
  }
  return out;
}

/** Per-pair features at bar i, using bars up to i only. */
function featurizer(bars: ResearchBar[], barMs: number, ctx: Context) {
  const perDay = Math.round(DAY / barMs);
  const q = [0];
  const v = [0];
  const b = [0];
  for (const x of bars) {
    q.push(q.at(-1)! + x.quoteVolume);
    v.push(v.at(-1)! + x.volume);
    b.push(b.at(-1)! + (x.buyVolume ?? 0));
  }
  const sum = (p: number[], i: number, n: number) => p[i + 1] - p[Math.max(0, i + 1 - n)];
  return (i: number) => {
    const at = bars[i].time * 1000 + barMs;
    const month = 30 * perDay;
    const day = sum(q, i, perDay);
    const avg = sum(q, i, month) / Math.min(30, (i + 1) / perDay);
    const share = (n: number) => (sum(v, i, n) > 0 ? sum(b, i, n) / sum(v, i, n) : 0.5);
    return {
      liquidity: liquidity30d(bars, i, barMs),
      surge: avg > 0 ? day / avg : 1,
      flow: share(perDay) - share(month),
      rs: i >= month ? bars[i].close / bars[i - month].close - 1 - ctx.btcRet30(at) : 0,
      btcUp: ctx.btcUp(at),
      fng: ctx.fng(at),
    };
  };
}

/**
 * Hold from bar s: initial stop `stopDist` below the entry (filled at the stop, or at the
 * open on a gap through it), then exit at the close below the chandelier
 * (highest close since entry − k × ATR) when `k` is given, or at `signalExit`.
 */
function hold(bars: ResearchBar[], s: number, stopDist: number, o: { k?: number; atr?: number[]; signalExit?: (x: number) => boolean }) {
  const entry = bars[s].close;
  const stop = entry * (1 - stopDist);
  const closes = [entry];
  let best = entry;
  for (let x = s + 1; x < bars.length; x++) {
    const bar = bars[x];
    if (bar.low <= stop) {
      closes.push(Math.min(bar.open, stop));
      return { closes, exitBars: x - s, exit: Math.min(bar.open, stop), open: false };
    }
    closes.push(bar.close);
    const trail = o.k !== undefined ? best - o.k * o.atr![x - 1] : Number.NEGATIVE_INFINITY;
    if (bar.close < trail || o.signalExit?.(x)) return { closes, exitBars: x - s, exit: bar.close, open: false };
    best = Math.max(best, bar.close);
  }
  return { closes, exitBars: closes.length - 1, exit: bars.at(-1)!.close, open: true };
}

/* ───────────────────────────── generators ───────────────────────────── */

export interface Family {
  name: string;
  barMs: number;
  /** Trades for one continuous series of one pair (one position at a time). */
  generate: (symbol: string, bars: ResearchBar[], feat: ReturnType<typeof featurizer>) => Trade[];
}

function make(symbol: string, bars: ResearchBar[], s: number, barMs: number, stopDist: number, feat: ReturnType<typeof featurizer>, h: ReturnType<typeof hold>): Trade {
  return { symbol, at: bars[s].time * 1000 + barMs, barMs, entry: bars[s].close, stopDist, ...h, ...feat(s) };
}

/** A: breakout above the N-bar high, stop k×ATR, chandelier k×ATR. */
export const breakout = (n: number, k: number, barMs = H4): Family => ({
  name: `A breakout ${n} bars · ${k}×ATR`,
  barMs,
  generate: (symbol, bars, feat) => {
    const out: Trade[] = [];
    const hh = priorHigh(bars, n);
    const a = atr(bars);
    for (let s = WARMUP; s < bars.length - 1; s++) {
      if (!(bars[s].close > hh[s] && bars[s - 1].close <= hh[s - 1])) continue;
      const stopDist = (k * a[s]) / bars[s].close;
      if (stopDist > 0.25) continue;
      const h = hold(bars, s, stopDist, { k, atr: a });
      out.push(make(symbol, bars, s, barMs, stopDist, feat, h));
      if (h.open) break;
      s += h.exitBars;
    }
    return out;
  },
});

/**
 * B and D: the owner's method (green dot + stoch cross, shared engine) at any interval,
 * trend-filtered (close > EMA200 and EMA50 > EMA200) or not; exit at the first red dot
 * (`k` undefined) or a k×ATR chandelier, with the −15% disaster stop either way.
 */
export const dotStoch = (o: { trend: boolean; k?: number; barMs: number; label: string; stochLevel?: number; htfBias?: boolean; entry?: "stoch" | "dot" }): Family => ({
  name: o.label,
  barMs: o.barMs,
  generate: (symbol, bars, feat) => {
    const out: Trade[] = [];
    const closes = bars.map((b) => b.close);
    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    const a = atr(bars);
    const engine = runSetupV1(bars, { stoch: "either", intervalMs: o.barMs, stochLevel: o.stochLevel, htfBias: o.htfBias, entry: o.entry });
    let free = 0; // with a trailing exit, positions last longer than the engine's
    for (const t of engine.trades.concat(engine.open ? [engine.open] : [])) {
      const s = t.entryIndex;
      if (s < free || (o.trend && !(closes[s] > e200[s] && e50[s] > e200[s]))) continue;
      const h =
        o.k === undefined
          ? t.exitIndex === null
            ? hold(bars, s, SETUP_V1.stopPct, {})
            : { closes: closes.slice(s, t.exitIndex + 1).map((c, j, all) => (j === all.length - 1 ? t.exitPrice! : c)), exitBars: t.exitIndex - s, exit: t.exitPrice!, open: false }
          : hold(bars, s, SETUP_V1.stopPct, { k: o.k, atr: a });
      out.push(make(symbol, bars, s, o.barMs, SETUP_V1.stopPct, feat, h));
      free = s + h.exitBars + 1;
    }
    return out;
  },
});

/** C: weekly rotation into the K strongest liquid coins (lookback L days); no stop. */
/** Close and trailing liquidity per 4h bar, all a weekly rotation needs from a pair. */
interface Compact {
  at: Float64Array; // bar close time, ms
  close: Float64Array;
  liquidity: Float64Array;
}

function compact(bars: ResearchBar[]): Compact {
  const n = bars.length;
  const c: Compact = { at: new Float64Array(n), close: new Float64Array(n), liquidity: new Float64Array(n) };
  const window = 180; // 30 days of 4h bars, as liquidity30d
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += bars[i].volume * bars[i].close;
    if (i >= window) sum -= bars[i - window].volume * bars[i - window].close;
    c.at[i] = bars[i].time * 1000 + H4;
    c.close[i] = bars[i].close;
    c.liquidity[i] = sum / (Math.min(i + 1, window) / 6);
  }
  return c;
}

export function rotation(series: Map<string, Compact>, ctx: Context, k: number, lookbackDays: number, btcFilter: boolean): Trade[] {
  const grid: number[] = [];
  for (let t = START + H4; t <= END; t += H4) grid.push(t);
  const symbols = [...series.keys()];
  const C = symbols.map(() => new Float64Array(grid.length).fill(Number.NaN));
  const L = symbols.map(() => new Float64Array(grid.length).fill(0));
  symbols.forEach((sym, p) => {
    const s = series.get(sym)!;
    for (let i = 0; i < s.at.length; i++) {
      const g = Math.round((s.at[i] - grid[0]) / H4);
      if (g >= 0 && g < grid.length) {
        C[p][g] = s.close[i];
        L[p][g] = s.liquidity[i];
      }
    }
  });
  const lastPrice = (p: number, g: number) => {
    for (let j = g; j >= 0; j--) if (!Number.isNaN(C[p][j])) return { g: j, price: C[p][j] };
    return null;
  };
  const back = lookbackDays * 6;
  const out: Trade[] = [];
  const held = new Map<number, number>(); // pair → entry grid index
  const close = (p: number, g: number) => {
    const e = held.get(p)!;
    held.delete(p);
    const path: number[] = [];
    for (let j = e; j <= g; j++) path.push(lastPrice(p, j)!.price);
    const t: Trade = { symbol: symbols[p], at: grid[e], barMs: H4, entry: C[p][e], stopDist: 1, closes: path, exitBars: g - e, exit: path.at(-1)!, open: g === grid.length - 1, liquidity: L[p][e], surge: 1, flow: 0, rs: 0, btcUp: ctx.btcUp(grid[e]), fng: ctx.fng(grid[e]) };
    out.push(t);
  };
  for (let g = back; g < grid.length; g++) {
    const d = new Date(grid[g]);
    if (!(d.getUTCDay() === 1 && d.getUTCHours() === 0)) continue;
    const ranked = symbols
      .map((_, p) => p)
      .filter((p) => !Number.isNaN(C[p][g]) && !Number.isNaN(C[p][g - back]) && L[p][g] >= 5e6)
      .sort((x, y) => C[y][g] / C[y][g - back] - C[x][g] / C[x][g - back]);
    const top = new Set(btcFilter && ctx.btcUp(grid[g]) === false ? [] : ranked.slice(0, k));
    for (const p of [...held.keys()]) if (!top.has(p)) close(p, g);
    for (const p of top) if (!held.has(p)) held.set(p, g);
  }
  for (const p of [...held.keys()]) close(p, grid.length - 1);
  return out;
}

/* ───────────────────────────── portfolio ───────────────────────────── */

export interface Sleeve {
  trades: Trade[];
  accept?: (t: Trade, breadth: number) => boolean;
  /** Higher first. */
  score?: (t: Trade) => number;
  risk: number; // equity lost at the initial stop
  maxFrac: number; // cap of one position, fraction of equity
  maxOpen: number;
  maxBarRisk: number;
  /** Cap on this sleeve's marked value, fraction of equity (capital split between setups). */
  maxExposure?: number;
  /** Risk of this trade (default `risk`): exposure scaling by confluence; 0 skips the trade. */
  riskOf?: (t: Trade) => number;
}

export interface Result {
  trades: number;
  perYear: number;
  win: number;
  avg: number;
  payoff: number; // average win ÷ average loss
  holdDays: number;
  cagr: number;
  maxDD: number;
  calmar: number;
  exposure: number;
}

export function simulate(sleeves: Sleeve[], from: number, to: number): Result {
  const step = Math.min(...sleeves.map((s) => s.trades[0]?.barMs ?? H4));
  type Pending = { t: Trade; s: Sleeve; breadth: number };
  const byTime = new Map<number, Pending[]>();
  for (const s of sleeves) {
    const breadth = new Map<number, number>();
    for (const t of s.trades) breadth.set(t.at, (breadth.get(t.at) ?? 0) + 1);
    for (const t of s.trades) {
      if (t.at < from || t.at >= to || t.liquidity < 1e6) continue;
      if (s.accept && !s.accept(t, breadth.get(t.at)!)) continue;
      (byTime.get(t.at) ?? byTime.set(t.at, []).get(t.at)!).push({ t, s, breadth: breadth.get(t.at)! });
    }
  }
  type Pos = { t: Trade; qty: number; s: Sleeve };
  let cash = 1;
  let open: Pos[] = [];
  let peak = 1;
  let maxDD = 0;
  let n = 0;
  let wins = 0;
  let sum = 0;
  let winSum = 0;
  let lossSum = 0;
  let holdSum = 0;
  let expSum = 0;
  let steps = 0;
  const mark = (p: Pos, t: number) => p.qty * p.t.closes[Math.min(Math.floor((t - p.t.at) / p.t.barMs), p.t.closes.length - 1)];
  const start = Math.ceil(from / step) * step;
  for (let t = start; t < to; t += step) {
    open = open.filter((p) => {
      if (p.t.open || t < p.t.at + p.t.exitBars * p.t.barMs) return true;
      const r = netRet(p.t);
      cash += p.qty * p.t.entry * (1 + r);
      n++;
      sum += r;
      holdSum += (p.t.exitBars * p.t.barMs) / DAY;
      if (r > 0) {
        wins++;
        winSum += r;
      } else lossSum -= r;
      return false;
    });
    let equity = cash + open.reduce((a, p) => a + mark(p, t), 0);
    const list = byTime.get(t);
    if (list) {
      const barRisk = new Map<Sleeve, number>();
      for (const { t: tr, s } of list.sort((a, b) => (b.s.score?.(b.t) ?? b.t.liquidity) - (a.s.score?.(a.t) ?? a.t.liquidity))) {
        if (open.filter((p) => p.s === s).length >= s.maxOpen || open.some((p) => p.t.symbol === tr.symbol)) continue;
        const risk = s.riskOf ? s.riskOf(tr) : s.risk;
        if (risk <= 0) continue;
        if ((barRisk.get(s) ?? 0) + risk > s.maxBarRisk + 1e-12) continue;
        const room = s.maxExposure === undefined ? Number.POSITIVE_INFINITY : equity * s.maxExposure - open.filter((p) => p.s === s).reduce((a, p) => a + mark(p, t), 0);
        const quote = Math.min((equity * risk) / tr.stopDist, equity * s.maxFrac, cash * 0.98, room);
        if (quote < equity * 0.002) continue;
        cash -= quote;
        barRisk.set(s, (barRisk.get(s) ?? 0) + risk);
        open.push({ t: tr, qty: quote / tr.entry, s });
      }
      equity = cash + open.reduce((a, p) => a + mark(p, t), 0);
    }
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity / peak - 1);
    expSum += 1 - cash / equity;
    steps++;
  }
  const equity = cash + open.reduce((a, p) => a + mark(p, to), 0);
  const years = (to - from) / (365.25 * DAY);
  const cagr = Math.pow(Math.max(equity, 1e-9), 1 / years) - 1;
  const losses = n - wins;
  return { trades: n, perYear: n / years, win: n ? wins / n : 0, avg: n ? sum / n : 0, payoff: wins && losses ? winSum / wins / (lossSum / losses) : 0, holdDays: n ? holdSum / n : 0, cagr, maxDD, calmar: maxDD < 0 ? cagr / -maxDD : 0, exposure: expSum / steps };
}

/* ───────────────────────────── report ───────────────────────────── */

export const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;
const row = (r: Result) =>
  `${String(r.trades).padStart(5)} (${r.perYear.toFixed(0).padStart(4)}/y) win ${(100 * r.win).toFixed(0).padStart(2)}% avg ${pct(r.avg, 2).padStart(7)} W/L ${r.payoff.toFixed(1).padStart(4)} hold ${r.holdDays.toFixed(1).padStart(4)}d · CAGR ${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} Cal ${r.calmar.toFixed(2).padStart(5)}`;

export function compare(name: string, sleeves: Sleeve[], mark = "") {
  const a = simulate(sleeves, START, SPLIT);
  const b = simulate(sleeves, SPLIT, END);
  console.log(`${(mark + name).padEnd(44)} ${row(a)} │ ${row(b)}`);
  return a;
}

export function header(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 150 - title.length))}`);
  console.log(`${"".padEnd(44)} ${"IN-SAMPLE 2021-01 → 2024-06".padEnd(118)} │ OUT-OF-SAMPLE 2024-07 → now`);
}

/** Per-trade net return by feature bucket, in- vs out-of-sample (does the data carry information?). */
function diagnose(name: string, trades: Trade[]) {
  const liquid = trades.filter((t) => t.liquidity >= 1e6 && !t.open);
  const feats: [string, (t: Trade) => number | null, number[]][] = [
    ["flow (taker buy Δ)", (t) => t.flow, [-0.02, 0, 0.02]],
    ["volume surge ×", (t) => t.surge, [1, 1.5, 3]],
    ["RS vs BTC 30d", (t) => t.rs, [-0.1, 0, 0.2]],
    ["Fear & Greed", (t) => t.fng, [25, 50, 75]],
    ["BTC > 200D (1=yes)", (t) => (t.btcUp === null ? null : t.btcUp ? 1 : 0), [0.5]],
  ];
  console.log(`\n${name}: average net return per trade by feature bucket (IS │ OOS), n in brackets`);
  for (const [label, f, cuts] of feats) {
    const cells: string[] = [];
    for (let b = 0; b <= cuts.length; b++) {
      const lo = b === 0 ? Number.NEGATIVE_INFINITY : cuts[b - 1];
      const hi = b === cuts.length ? Number.POSITIVE_INFINITY : cuts[b];
      const stat = (from: number, to: number) => {
        const xs = liquid.filter((t) => t.at >= from && t.at < to && f(t) !== null && f(t)! >= lo && f(t)! < hi).map(netRet);
        return xs.length ? `${pct(xs.reduce((a, x) => a + x, 0) / xs.length, 2)} [${xs.length}]` : "–";
      };
      const range = b === 0 ? `<${cuts[0]}` : b === cuts.length ? `≥${cuts.at(-1)}` : `${lo}…${hi}`;
      cells.push(`${range}: ${stat(START, SPLIT)} │ ${stat(SPLIT, END)}`);
    }
    console.log(`  ${label.padEnd(20)} ${cells.join("   ")}`);
  }
}

export function zec(name: string, trades: Trade[], accept?: Sleeve["accept"]) {
  const z = trades.filter((t) => t.symbol === "ZECUSDT" && t.at >= Date.UTC(2026, 7, 1) && (!accept || accept(t, 1)));
  const fmt = (t: Trade) => `${new Date(t.at).toISOString().slice(5, 13)}h @${t.entry.toFixed(0)} → ${t.exit.toFixed(0)} ${pct(netRet(t))}${t.open ? " (open)" : ""}`;
  console.log(`  ZEC ${name.padEnd(40)} ${z.length ? z.map(fmt).join(" · ") : "no trade"}`);
}

/* ───────────────────────────── main ───────────────────────────── */

export async function collect(families: Family[], interval: string, ctx: Context, keep?: Map<string, Compact>) {
  const out = families.map(() => [] as Trade[]);
  const barMs = interval === "1h" ? H1 : interval === "1d" ? DAY : H4;
  for (const symbol of (await archiveSymbols()).filter(inUniverse)) {
    const file = path.join(CACHE_DIR, "klines", interval, `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    keep?.set(symbol, compact(all));
    for (const bars of segments(all, 3 * DAY)) {
      if (bars.length < WARMUP + 30) continue;
      const feat = featurizer(bars, barMs, ctx);
      families.forEach((f, i) => out[i].push(...f.generate(symbol, bars, feat)));
    }
  }
  return out;
}

async function main() {
  const ctx = await loadContext();
  const series = new Map<string, Compact>();
  const fams4h: Family[] = [
    breakout(30, 4), breakout(30, 8), breakout(120, 4), breakout(120, 8),
    dotStoch({ trend: false, barMs: H4, label: "v1 (all, first red)" }),
    dotStoch({ trend: true, barMs: H4, label: "B pullback in uptrend · first red" }),
    dotStoch({ trend: true, k: 6, barMs: H4, label: "B pullback in uptrend · 6×ATR trail" }),
  ];
  const t4 = await collect(fams4h, "4h", ctx, series);
  const v1All = t4[4];
  const base = { risk: 0.01, maxFrac: 0.2, maxOpen: 15, maxBarRisk: 0.05 };
  const v12: Sleeve = { ...base, trades: v1All, accept: (_t, breadth) => breadth >= 10 };

  header("REFERENCE");
  compare("v1.2 candidate (breadth ≥10, ≤5% per bar)", [v12]);

  header("A · BREAKOUT + CHANDELIER (1% risk/trade, ≤15 open, ≤5% per bar)");
  const aRes = fams4h.slice(0, 4).map((f, i) => ({ i, r: compare(f.name, [{ ...base, trades: t4[i] }]) }));
  const aBest = aRes.sort((x, y) => y.r.calmar - x.r.calmar)[0].i;
  console.log(`  ★ in-sample pick: ${fams4h[aBest].name}`);
  diagnose(fams4h[aBest].name, t4[aBest]);

  header("B · OWNER'S METHOD WHILE THE COIN TRENDS UP (no breadth)");
  for (const i of [4, 5, 6]) compare(fams4h[i].name, [{ ...base, trades: t4[i] }]);
  diagnose(fams4h[6].name, t4[6]);

  header("C · WEEKLY ROTATION INTO THE STRONGEST COINS (equal weight, no stop)");
  const rot: { name: string; trades: Trade[]; k: number; r: Result }[] = [];
  for (const k of [5, 10])
    for (const lb of [7, 30])
      for (const f of [false, true]) {
        const trades = rotation(series, ctx, k, lb, f);
        const name = `C top ${k} by ${lb}d return${f ? " · BTC>200D" : ""}`;
        rot.push({ name, trades, k, r: compare(name, [{ trades, risk: 1 / k, maxFrac: 1 / k, maxOpen: k, maxBarRisk: 1 }]) });
      }
  const cBest = rot.sort((x, y) => y.r.calmar - x.r.calmar)[0];
  console.log(`  ★ in-sample pick: ${cBest.name}`);

  // Filters from the data, one at a time on the picked families; kept only if they help in-sample.
  const filters: [string, Sleeve["accept"]][] = [
    ["+ flow > 0 (taker buying)", (t) => t.flow > 0],
    ["+ volume surge ≥ 1.5×", (t) => t.surge >= 1.5],
    ["+ RS vs BTC > 0", (t) => t.rs > 0],
    ["+ BTC > 200D", (t) => t.btcUp === true],
    ["+ Fear & Greed < 75", (t) => (t.fng ?? 50) < 75],
  ];
  for (const [label, i] of [["A", aBest], ["B", 6]] as const) {
    header(`${label} · FILTERS (${fams4h[i].name})`);
    compare("no filter", [{ ...base, trades: t4[i] }]);
    for (const [name, accept] of filters) compare(name, [{ ...base, trades: t4[i], accept }]);
  }

  // A refined with what the in-sample diagnostics show (monotone in-sample, not tuned on OOS):
  // breakouts of coins that lagged BTC (a base breaking out) beat extended ones; volume
  // below average and extreme fear are the weak buckets.
  header(`A · REFINED (${fams4h[aBest].name}); in-sample pick by Calmar`);
  const rules: [string, (t: Trade) => boolean][] = [
    ["RS<0", (t) => t.rs < 0],
    ["surge≥1.5", (t) => t.surge >= 1.5],
    ["F&G≥25", (t) => (t.fng ?? 50) >= 25],
  ];
  const refined: { name: string; sleeve: Sleeve; r: Result }[] = [];
  for (let mask = 0; mask < 1 << rules.length; mask++)
    for (const risk of [0.005, 0.01]) {
      const used = rules.filter((_, j) => mask & (1 << j));
      const sleeve: Sleeve = { ...base, risk, maxBarRisk: 5 * risk, trades: t4[aBest], accept: (t) => used.every(([, f]) => f(t)) };
      const name = `${used.map(([n]) => n).join(" + ") || "no filter"} · risk ${risk * 100}%`;
      refined.push({ name, sleeve, r: compare(name, [sleeve]) });
    }
  const aPick = refined.sort((x, y) => y.r.calmar - x.r.calmar)[0];
  console.log(`  ★ in-sample pick: ${aPick.name}`);

  header("COMBINED: v1.2 (capitulation) + momentum sleeves, shared capital");
  const bSleeve: Sleeve = { ...base, trades: t4[6] };
  const cSleeve: Sleeve = { trades: cBest.trades, risk: 0.5 / cBest.k, maxFrac: 0.5 / cBest.k, maxOpen: cBest.k, maxBarRisk: 1 };
  compare(`v1.2 + A (${aPick.name})`, [v12, aPick.sleeve]);
  compare("v1.2 + B", [v12, bSleeve]);
  compare("v1.2 + C (50% of capital)", [v12, cSleeve]);

  console.log(`\nPER YEAR: v1.2 │ A refined │ v1.2 + A refined`);
  for (let y = 2021; y <= new Date(END).getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), END);
    const f = (r: Result) => `${pct(r.cagr).padStart(7)} DD ${pct(r.maxDD).padStart(7)} (${r.trades})`;
    console.log(`  ${y}  ${f(simulate([v12], from, to))} │ ${f(simulate([aPick.sleeve], from, to))} │ ${f(simulate([v12, aPick.sleeve], from, to))}`);
  }

  console.log("\nZEC Aug → Oct 2026 (the screenshot): what each strategy did");
  zec("v1.2 (breadth ≥10)", v1All.filter((t) => v1All.filter((u) => u.at === t.at).length >= 10));
  zec("v1 (all)", v1All);
  for (const i of [aBest, 5, 6]) zec(fams4h[i].name, t4[i]);
  zec(`A refined (${aPick.name})`, t4[aBest], aPick.sleeve.accept);
  zec(cBest.name, cBest.trades);

  // D: the owner's method on 1h (needs the 1h cache)
  const n1h = fs.existsSync(path.join(CACHE_DIR, "klines", "1h")) ? fs.readdirSync(path.join(CACHE_DIR, "klines", "1h")).length : 0;
  if (n1h < 600) {
    console.log(`\n(1h skipped: ${n1h} pairs cached; run npx tsx research/preload.ts 1h)`);
    return;
  }
  series.clear();
  const fams1h: Family[] = [
    dotStoch({ trend: false, barMs: H1, label: "D 1h method · first red" }),
    dotStoch({ trend: true, barMs: H1, label: "D 1h method in uptrend · first red" }),
    breakout(120, 6, H1),
  ];
  const t1 = await collect(fams1h, "1h", ctx);
  header("D · 1h (1% risk/trade, ≤15 open, ≤5% per bar)");
  for (let i = 0; i < fams1h.length; i++) compare(fams1h[i].name, [{ ...base, trades: t1[i] }]);
  for (const b of [5, 10, 20]) compare(`D 1h method · breadth ≥${b}`, [{ ...base, trades: t1[0], accept: (_t, br) => br >= b }]);
  // The in-sample diagnostics: the 1h method only pays while the market is fearful.
  compare("D 1h method · BTC<200D + F&G<50", [{ ...base, trades: t1[0], accept: (t) => t.btcUp === false && (t.fng ?? 50) < 50 }]);
  compare("v1.2 + A refined + D fear", [v12, aPick.sleeve, { ...base, trades: t1[0], accept: (t) => t.btcUp === false && (t.fng ?? 50) < 50 }]);
  diagnose(fams1h[0].name, t1[0]);
  for (let i = 0; i < fams1h.length; i++) zec(fams1h[i].name, t1[i]);
}

if (process.argv[1]?.endsWith("momentum.ts")) void main();
