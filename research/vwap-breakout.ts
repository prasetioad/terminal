/**
 * Gemini's intraday spot strategy (crypto_intraday_backtest.py), on 15m candles of the 30
 * liquid pairs since 2021 — rules exactly as its script:
 *
 *   regime   close > daily VWAP (typical price × volume, reset 00:00 UTC) and close > EMA20
 *   trigger  close > the highest high of the previous 20 bars, volume > vol_factor × SMA20(volume)
 *   entry    at that close (long only); stop entry × (1 − sl_pct); target entry + rrr × risk
 *   exits    the stop is checked before the target in a bar; filled exactly at the level
 *            (the script) — and, realistically, at the open when a bar gaps through the stop
 *   fees     0.1% a side (0.2% round trip)
 *   grid     sl_pct 0.8–2.0% (0.2) × vol_factor 1.2–2.0 (0.2) × rrr 1.5–3.0 (0.5) = 140
 *   screen   optional, as its workflow: 24h quote volume > $50M and daily ATR > 3% (both known
 *            before the bar)
 *
 * Every combination is reported for in-sample (2021 → 2024-06) and out-of-sample; the
 * in-sample's best is then run as a portfolio (1% risk per trade).
 *
 *   npx tsx research/vwap-breakout.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, segments, type ResearchBar } from "./data";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { compare, header, pct, simulate, type Sleeve, type Trade } from "./momentum";

const M15 = 15 * 60_000;
const DAY = 86_400_000;
const SPLIT = Date.UTC(2024, 6, 1);
const FEE = 0.001;

const SLS = [0.008, 0.01, 0.012, 0.014, 0.016, 0.018, 0.02];
const VFS = [1.2, 1.4, 1.6, 1.8, 2.0];
const RRS = [1.5, 2, 2.5, 3];

interface Prepared {
  symbol: string;
  c: ResearchBar[];
  regime: Uint8Array; // close > VWAP and close > EMA20
  breakout: Uint8Array; // close > prior 20-bar high
  volRatio: Float64Array; // volume ÷ SMA20(volume) (pandas: the window includes this bar)
  screened: Uint8Array; // 24h quote volume > $50M and 14-day ATR > 3%
}

function prepare(symbol: string, c: ResearchBar[]): Prepared {
  const n = c.length;
  const regime = new Uint8Array(n);
  const breakout = new Uint8Array(n);
  const volRatio = new Float64Array(n);
  const screened = new Uint8Array(n);
  let day = -1;
  let tpv = 0;
  let vol = 0;
  let ema = c[0].close;
  const k = 2 / 21;
  let volSum = 0;
  let quote24 = 0;
  // daily bars for the ATR screen
  const dayRange: number[] = [];
  let dHigh = 0;
  let dLow = Number.POSITIVE_INFINITY;
  let dClose = 0;
  let prevClose = 0;
  let atr14 = Number.NaN;
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = c[i];
    const d = Math.floor((b.time * 1000) / DAY);
    if (d !== day) {
      if (day >= 0) {
        const tr = prevClose ? Math.max(dHigh - dLow, Math.abs(dHigh - prevClose), Math.abs(dLow - prevClose)) : dHigh - dLow;
        trs.push(tr / dClose);
        if (trs.length >= 14) atr14 = trs.slice(-14).reduce((a, x) => a + x, 0) / 14;
        prevClose = dClose;
        dayRange.push(tr);
      }
      day = d;
      tpv = 0;
      vol = 0;
      dHigh = b.high;
      dLow = b.low;
    } else {
      dHigh = Math.max(dHigh, b.high);
      dLow = Math.min(dLow, b.low);
    }
    dClose = b.close;
    tpv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    const vwap = vol > 0 ? tpv / vol : b.close;
    ema = i === 0 ? b.close : k * b.close + (1 - k) * ema;
    regime[i] = b.close > vwap && b.close > ema ? 1 : 0;
    volSum += b.volume;
    if (i >= 20) volSum -= c[i - 20].volume;
    volRatio[i] = i >= 19 && volSum > 0 ? b.volume / (volSum / 20) : 0;
    if (i >= 20) {
      let hi = Number.NEGATIVE_INFINITY;
      for (let j = i - 20; j < i; j++) hi = Math.max(hi, c[j].high);
      breakout[i] = b.close > hi ? 1 : 0;
    }
    // the screen uses what is known at the bar: the last 24h and the completed days
    quote24 += b.quoteVolume;
    if (i >= 96) quote24 -= c[i - 96].quoteVolume;
    screened[i] = i >= 96 && quote24 > 50e6 && atr14 > 0.03 ? 1 : 0;
  }
  return { symbol, c, regime, breakout, volRatio, screened };
}

interface Combo {
  sl: number;
  vf: number;
  rr: number;
}

interface Tr extends Trade {
  gross: number;
  win: boolean;
}

/** One position at a time per pair, as the script. `gap`: a bar opening under the stop fills at the open. */
function run(p: Prepared, o: Combo, screen: boolean, gap: boolean): Tr[] {
  const { c } = p;
  const out: Tr[] = [];
  let inPos = false;
  let entry = 0;
  let stop = 0;
  let target = 0;
  let e = 0;
  let closes: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const b = c[i];
    if (inPos) {
      let exit = Number.NaN;
      if (b.low <= stop) exit = gap ? Math.min(b.open, stop) : stop;
      else if (b.high >= target) exit = target;
      if (Number.isNaN(exit)) closes.push(b.close);
      else {
        closes.push(exit);
        const gross = exit / entry - 1;
        out.push({
          symbol: p.symbol, at: c[e].time * 1000 + M15, barMs: M15, entry, stopDist: o.sl, closes, exitBars: i - e, exit, open: false,
          liquidity: 1e9, surge: 1, flow: 0, rs: 0, btcUp: null, fng: null, gross, win: gross - 2 * FEE > 0,
        });
        inPos = false;
      }
    }
    // as the script: a new entry may follow an exit on the same bar
    if (!inPos && i >= 20 && p.regime[i] && p.breakout[i] && p.volRatio[i] > o.vf && (!screen || p.screened[i])) {
      inPos = true;
      entry = b.close;
      stop = entry * (1 - o.sl);
      target = entry + o.rr * (entry - stop);
      e = i;
      closes = [entry];
    }
  }
  return out;
}

interface Stat {
  n: number;
  net: number; // mean net per trade
  win: number;
  pf: number;
  compounded: number; // the script's total return: Π(1 + net) − 1, averaged over pairs
}

function stats(trades: Tr[], pairsCompounded: number[]): Stat {
  const nets = trades.map((t) => t.gross - 2 * FEE);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x < 0);
  return {
    n: nets.length,
    net: nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0,
    win: nets.length ? wins.length / nets.length : 0,
    pf: losses.length ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0) : Number.POSITIVE_INFINITY,
    compounded: pairsCompounded.length ? pairsCompounded.reduce((a, b) => a + b, 0) / pairsCompounded.length : 0,
  };
}

async function main() {
  const prepared: Prepared[] = [];
  for (const symbol of INTRADAY_PAIRS) {
    const file = path.join(CACHE_DIR, "klines", "15m", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    for (const seg of segments(JSON.parse(fs.readFileSync(file, "utf8")), 3 * 60 * 60_000)) if (seg.length > 2000) prepared.push(prepare(symbol, seg));
  }
  console.log(`${new Set(prepared.map((p) => p.symbol)).size} pairs · 15m since 2021 · IS 2021 → 2024-06 │ OOS 2024-07 → now · fee 0.1%/side\n`);

  const combos: Combo[] = [];
  for (const sl of SLS) for (const vf of VFS) for (const rr of RRS) combos.push({ sl, vf, rr });

  for (const [screen, gap] of [[false, false], [true, false], [false, true]] as const) {
    const label = `${screen ? "screened ($50M + ATR 3%)" : "all 30 pairs"} · stop fill ${gap ? "at the open on a gap (realistic)" : "exactly at the level (the script)"}`;
    const evaluate = (o: Combo) => {
      const all = prepared.flatMap((p) => run(p, o, screen, gap));
      const per = (from: number, to: number) => {
        const xs = all.filter((t) => t.at >= from && t.at < to);
        const symbols = [...new Set(prepared.map((p) => p.symbol))];
        const comp = symbols.map((sym) => xs.filter((t) => t.symbol === sym).reduce((acc, t) => acc * (1 + t.gross - 2 * FEE), 1) - 1);
        return stats(xs, comp);
      };
      return { o, is: per(0, SPLIT), oos: per(SPLIT, Date.now()) };
    };
    const rows = combos.map(evaluate); // trades are not kept: 140 × the history would not fit
    const positive = (k: "is" | "oos") => rows.filter((r) => r[k].net > 0).length;
    const median = (k: "is" | "oos") => {
      const v = rows.map((r) => r[k].net).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    console.log(`── ${label}`);
    console.log(`  combinations with a positive average net trade: IS ${positive("is")}/140 · OOS ${positive("oos")}/140 · median net per trade IS ${pct(median("is"), 3)} · OOS ${pct(median("oos"), 3)}`);
    const ranked = [...rows].sort((a, b) => b.is.net - a.is.net);
    const fmt = (s: Stat) => `n ${String(s.n).padStart(6)} · win ${(100 * s.win).toFixed(1)}% · net ${pct(s.net, 3).padStart(8)} · PF ${s.pf.toFixed(2)} · script's return/pair ${pct(s.compounded, 0).padStart(7)}`;
    console.log("  best 5 in-sample → the same out-of-sample:");
    for (const r of ranked.slice(0, 5)) console.log(`    sl ${(r.o.sl * 100).toFixed(1)}% · vol ${r.o.vf.toFixed(1)}× · rr ${r.o.rr}  IS ${fmt(r.is)}\n${"".padEnd(34)}OOS ${fmt(r.oos)}`);
    const defaults: Combo = { sl: 0.012, vf: 1.5, rr: 2 };
    const def = evaluate(defaults);
    console.log(`  Gemini's default (sl 1.2% · vol 1.5× · rr 2)  IS ${fmt(def.is)}\n${"".padEnd(34)}OOS ${fmt(def.oos)}`);

    // Portfolio: the in-sample best, 1% risk per trade (position = 1% ÷ stop), ≤ 4 open, ≤ 50% a position.
    const best = { o: ranked[0].o, all: prepared.flatMap((p) => run(p, ranked[0].o, screen, gap)) };
    const defAll = prepared.flatMap((p) => run(p, defaults, screen, gap));
    const sleeve = (xs: Tr[]): Sleeve => ({ trades: xs.map((t) => ({ ...t, exit: t.exit * (1 + 0.001 - 2 * FEE) })), risk: 0.01, maxFrac: 0.5, maxOpen: 4, maxBarRisk: 1 });
    header(`PORTFOLIO · in-sample best (sl ${(best.o.sl * 100).toFixed(1)}% · vol ${best.o.vf}× · rr ${best.o.rr}) and Gemini's default · 1% risk per trade · ${label}`);
    compare("in-sample best", [sleeve(best.all)]);
    compare("Gemini's default", [sleeve(defAll)]);
    console.log("  per year (CAGR / DD), in-sample best │ Gemini's default:");
    for (let y = 2021; y <= new Date().getUTCFullYear(); y++) {
      const from = Date.UTC(y, 0, 1);
      const to = Math.min(Date.UTC(y + 1, 0, 1), Date.now());
      const f = (xs: Tr[]) => {
        const r = simulate([sleeve(xs)], from, to);
        return `${pct(r.cagr).padStart(7)} ${pct(r.maxDD).padStart(6)}`;
      };
      console.log(`    ${y}  ${f(best.all)} │ ${f(defAll)}`);
    }
    console.log("");
  }
}

void main();
