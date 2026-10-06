/**
 * Gemini's fixes to its intraday strategy (after research/vwap-breakout.ts lost on every
 * combination), on the same 15m data of 30 liquid pairs since 2021. Rules fixed before looking:
 *
 *   base       close > daily VWAP and > EMA20 · close > the prior 20 bars' high · volume >
 *              1.5 × SMA20(volume)                                        (the original)
 *   1a ADX     ADX(14) on 15m > 25 (Gemini) — or > 20
 *   1b HTF     close > EMA200 of the last closed 1h bar — or no such filter
 *   2  entry   "retest": within 12 bars after the breakout, a bar touches the broken level
 *              (low ≤ level × 1.002) and closes above it as a bullish engulfing or a pin bar
 *              (lower wick ≥ 2 × body, close in the upper third) → buy that close; cancelled
 *              if a close falls 0.5% under the level — or "direct": buy the breakout close
 *   3  stop    entry − 1.5 × ATR(14) (Gemini) — or 2 × ATR; target entry + rr × risk,
 *              rr 2 (Gemini) — or 1.5 / 3; the stop is checked first in a bar
 *   fees       0.1% a side
 *
 *   npx tsx research/vwap-breakout-v2.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, segments, type ResearchBar } from "./data";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { compare, header, pct, simulate, type Sleeve, type Trade } from "./momentum";

const M15 = 15 * 60_000;
const H1 = 3_600_000;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);
const FEE = 0.001;

interface Prepared {
  symbol: string;
  c: ResearchBar[];
  base: Uint8Array; // the original trigger (regime + breakout + volume 1.5×)
  level: Float64Array; // the broken 20-bar high
  adx: Float64Array;
  htf: Uint8Array; // close > EMA200 of the last closed 1h bar
  atr: Float64Array;
}

function wilder(values: number[], n: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < n) {
      s += values[i];
      if (i === n - 1) out[i] = s / n;
    } else out[i] = (out[i - 1] * (n - 1) + values[i]) / n;
  }
  return out;
}

function prepare(symbol: string, c: ResearchBar[]): Prepared {
  const n = c.length;
  const base = new Uint8Array(n);
  const level = new Float64Array(n);
  const htf = new Uint8Array(n);
  // VWAP (daily, UTC), EMA20, volume SMA20, prior 20-bar high
  let day = -1;
  let tpv = 0;
  let vol = 0;
  let ema = c[0].close;
  let volSum = 0;
  for (let i = 0; i < n; i++) {
    const b = c[i];
    const d = Math.floor((b.time * 1000) / DAY);
    if (d !== day) {
      day = d;
      tpv = 0;
      vol = 0;
    }
    tpv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    ema = i === 0 ? b.close : (2 / 21) * b.close + (1 - 2 / 21) * ema;
    volSum += b.volume;
    if (i >= 20) volSum -= c[i - 20].volume;
    if (i < 20) continue;
    let hi = Number.NEGATIVE_INFINITY;
    for (let j = i - 20; j < i; j++) hi = Math.max(hi, c[j].high);
    level[i] = hi;
    const vwap = vol > 0 ? tpv / vol : b.close;
    if (b.close > vwap && b.close > ema && b.close > hi && b.volume > 1.5 * (volSum / 20)) base[i] = 1;
  }
  // ATR(14) and ADX(14), Wilder
  const tr: number[] = [];
  const pdm: number[] = [];
  const ndm: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = c[i];
    if (i === 0) {
      tr.push(b.high - b.low);
      pdm.push(0);
      ndm.push(0);
      continue;
    }
    const p = c[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
    const up = b.high - p.high;
    const down = p.low - b.low;
    pdm.push(up > down && up > 0 ? up : 0);
    ndm.push(down > up && down > 0 ? down : 0);
  }
  const atr = wilder(tr, 14);
  const pdi = wilder(pdm, 14);
  const ndi = wilder(ndm, 14);
  const dx = Array.from({ length: n }, (_, i) => {
    const plus = (100 * pdi[i]) / atr[i];
    const minus = (100 * ndi[i]) / atr[i];
    return plus + minus > 0 ? (100 * Math.abs(plus - minus)) / (plus + minus) : 0;
  });
  const adx = wilder(dx.map((x) => (Number.isFinite(x) ? x : 0)), 14);
  // EMA200 on 1h closes. A 15m bar closing at T sees the 1h bars that ended by T.
  const hourClose = new Map<number, number>(); // hour index → close of its last 15m bar
  for (const b of c) hourClose.set(Math.floor((b.time * 1000) / H1), b.close);
  const ema200 = new Map<number, number>();
  let e200 = Number.NaN;
  let count = 0;
  for (const [h, close] of [...hourClose.entries()].sort((x, y) => x[0] - y[0])) {
    e200 = Number.isNaN(e200) ? close : (2 / 201) * close + (1 - 2 / 201) * e200;
    if (++count >= 200) ema200.set(h, e200);
  }
  for (let i = 0; i < n; i++) {
    const lastClosedHour = Math.floor((c[i].time * 1000 + M15) / H1) - 1;
    const ref = ema200.get(lastClosedHour);
    htf[i] = ref !== undefined && c[i].close > ref ? 1 : 0;
  }
  return { symbol, c, base, level, adx, htf, atr };
}

interface Combo {
  adx: number;
  htf: boolean;
  entry: "retest" | "direct";
  atrMult: number;
  rr: number;
}

const name = (o: Combo) => `ADX>${o.adx} · ${o.htf ? "1h>EMA200" : "no HTF"} · ${o.entry} · SL ${o.atrMult}×ATR · 1:${o.rr}`;

const confirmation = (c: ResearchBar[], j: number) => {
  const b = c[j];
  const p = c[j - 1];
  const body = Math.abs(b.close - b.open);
  const range = b.high - b.low;
  const engulfing = p.close < p.open && b.close > b.open && b.close >= p.open && b.open <= p.close;
  const pinbar = range > 0 && Math.min(b.open, b.close) - b.low >= 2 * body && b.close >= b.low + (2 / 3) * range;
  return engulfing || pinbar;
};

interface Tr extends Trade {
  gross: number;
}

function run(p: Prepared, o: Combo): Tr[] {
  const { c } = p;
  const out: Tr[] = [];
  const n = c.length;
  for (let i = 220; i < n - 1; i++) {
    if (!p.base[i] || !(p.adx[i] > o.adx) || (o.htf && !p.htf[i])) continue;
    let e = i;
    if (o.entry === "retest") {
      e = -1;
      const L = p.level[i];
      for (let j = i + 1; j <= Math.min(n - 2, i + 12); j++) {
        if (c[j].close < L * 0.995) break; // the breakout failed
        if (c[j].low <= L * 1.002 && c[j].close > L && confirmation(c, j)) {
          e = j;
          break;
        }
      }
      if (e < 0) continue;
    }
    const entry = c[e].close;
    const stop = entry - o.atrMult * p.atr[e];
    if (!(stop > 0) || stop >= entry) continue;
    const target = entry + o.rr * (entry - stop);
    const closes = [entry];
    let x = e + 1;
    let exit = c[n - 1].close;
    let done = false;
    for (; x < n; x++) {
      const b = c[x];
      if (b.low <= stop) {
        exit = Math.min(b.open, stop);
        done = true;
      } else if (b.high >= target) {
        exit = Math.max(b.open, target);
        done = true;
      }
      closes.push(done ? exit : b.close);
      if (done) break;
    }
    if (!done) break;
    out.push({ symbol: p.symbol, at: c[e].time * 1000 + M15, barMs: M15, entry, stopDist: 1 - stop / entry, closes, exitBars: x - e, exit, open: false, liquidity: 1e9, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null, gross: exit / entry - 1 });
    i = x; // one position at a time per pair
  }
  return out;
}

async function main() {
  const prepared: Prepared[] = [];
  for (const symbol of INTRADAY_PAIRS) {
    const file = path.join(CACHE_DIR, "klines", "15m", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const seg of segments(JSON.parse(fs.readFileSync(file, "utf8")), 3 * 60 * 60_000)) if (seg.length > 3000) prepared.push(prepare(symbol, seg));
  }
  const combos: Combo[] = [];
  for (const adx of [25, 20]) for (const htf of [true, false]) for (const entry of ["retest", "direct"] as const) for (const atrMult of [1.5, 2]) for (const rr of [2, 1.5, 3]) combos.push({ adx, htf, entry, atrMult, rr });
  const gemini = combos[0]; // ADX > 25 · 1h > EMA200 · retest · 1.5 ATR · 1:2

  const stat = (xs: Tr[]) => {
    if (!xs.length) return { n: 0, gross: 0, net: 0, win: 0, pf: 0, sl: 0 };
    const nets = xs.map((t) => t.gross - 2 * FEE);
    const w = nets.filter((x) => x > 0);
    const l = nets.filter((x) => x < 0);
    return { n: xs.length, gross: xs.reduce((s, t) => s + t.gross, 0) / xs.length, net: nets.reduce((a, b) => a + b, 0) / nets.length, win: w.length / nets.length, pf: l.length ? w.reduce((a, b) => a + b, 0) / -l.reduce((a, b) => a + b, 0) : 0, sl: xs.reduce((s, t) => s + t.stopDist, 0) / xs.length };
  };
  const fmt = (s: ReturnType<typeof stat>) => `n ${String(s.n).padStart(6)} · win ${(100 * s.win).toFixed(1)}% · SL ${pct(s.sl, 2)} · gross ${pct(s.gross, 3).padStart(8)} · net ${pct(s.net, 3).padStart(8)} · PF ${s.pf.toFixed(2)}`;
  const rows = combos.map((o) => {
    const all = prepared.flatMap((p) => run(p, o));
    return { o, is: stat(all.filter((t) => t.at < SPLIT)), oos: stat(all.filter((t) => t.at >= SPLIT)) };
  });
  console.log(`${new Set(prepared.map((p) => p.symbol)).size} pairs · 15m since 2021 · IS 2021 → 2024-06 │ OOS 2024-07 → now · fee 0.1%/side\n`);
  console.log(`combinations with a positive average net trade: IS ${rows.filter((r) => r.is.net > 0).length}/${rows.length} · OOS ${rows.filter((r) => r.oos.net > 0).length}/${rows.length}`);
  console.log(`combinations with a positive average trade BEFORE fees: IS ${rows.filter((r) => r.is.gross > 0).length}/${rows.length} · OOS ${rows.filter((r) => r.oos.gross > 0).length}/${rows.length}\n`);
  const g = rows[0];
  console.log(`GEMINI'S FIXED VERSION (${name(gemini)})\n  IS  ${fmt(g.is)}\n  OOS ${fmt(g.oos)}\n`);
  console.log("EVERY COMBINATION, best in-sample first:");
  for (const r of [...rows].sort((a, b) => b.is.net - a.is.net)) console.log(`  ${name(r.o).padEnd(52)} IS ${fmt(r.is)}\n  ${"".padEnd(52)} OOS ${fmt(r.oos)}`);

  const best = [...rows].sort((a, b) => b.is.net - a.is.net)[0].o;
  const sleeve = (o: Combo): Sleeve => ({ trades: prepared.flatMap((p) => run(p, o)).map((t) => ({ ...t, exit: t.exit * (1 + 0.001 - 2 * FEE) })), risk: 0.01, maxFrac: 0.5, maxOpen: 4, maxBarRisk: 1 });
  header("PORTFOLIO (1% risk per trade, ≤ 4 open, ≤ 50% a position)");
  const sg = sleeve(gemini);
  const sb = sleeve(best);
  compare("Gemini's fixed version", [sg]);
  compare(`in-sample best (${name(best)})`.slice(0, 44), [sb]);
  console.log("  per year (CAGR / DD): Gemini's fixed │ in-sample best");
  for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
    const from = Date.UTC(y, 0, 1);
    const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
    const f = (s: Sleeve) => {
      const r = simulate([s], from, to);
      return `${pct(r.cagr).padStart(7)} ${pct(r.maxDD).padStart(6)} (${r.trades})`;
    };
    console.log(`    ${y}  ${f(sg)} │ ${f(sb)}`);
  }
}

void main();
