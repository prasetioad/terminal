/**
 * Auction-market trades at the previous day's value area, both directions (futures: long and
 * short), refined toward Fabio Valentini's method. 5m candles of 30 liquid pairs; the profile
 * of the previous UTC day from lib/profile.ts (the chart's Volume Profile: 60 rows, VA 70%).
 * Rules fixed before looking at results.
 *
 * Base: a close beyond an edge of value (above VAH, or below VAL), the previous close not
 * beyond it. Within 24 bars the first bar back within 0.05% of the edge is the retest:
 *   holds    it closes beyond the edge → CONTINUATION in the breakout's direction.
 *            Stop 0.1% past the retest's extreme and the edge (whichever is further); target 2R.
 *   fails    it closes back inside value → REVERSION toward the POC. Stop 0.1% past the
 *            excursion's extreme (breakout bar to retest); target the POC (≥ 1R away).
 *   Stops 0.15–2% from the entry; out after 48 bars (4h); a stop and a target in the same bar
 *   count as the stop; one position per pair and rule at a time.
 *
 * Refinements (each alone, then all together = "Fabio"):
 *   context     continuation only on an imbalanced day in its direction (the day opened outside
 *               the previous value on that side); reversion only on a balanced day (it opened
 *               inside the previous value)
 *   aggression  the retest bar's taker flow agrees with the trade (buy ratio > 0.55 for a long,
 *               < 0.45 for a short) on volume ≥ 1.5× its 20-bar average
 *   NY session  entries 13:30–20:00 UTC only
 *
 * 80% RULE (Dalton): the day opens outside the previous value; price comes back inside and
 * closes inside for 12 bars in a row (1h) → trade toward the other edge (short to VAL after
 * an open above, long to VAH after an open below). Stop 0.1% past the day's extreme so far
 * (≤ 2%); out at the other edge or at the day's last bar. Also: how often the other edge is
 * reached that day, against days whose open was inside value.
 *
 * Gross = the break-even cost; net at 0.04% (futures maker) and 0.1% (futures taker). Per
 * event = all trades entered in the same 5-minute bar count as one. IS 2022 → 2024-06, OOS after.
 *
 *   npx tsx research/auction.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, segments, type ResearchBar } from "./data";
import { INTRADAY_PAIRS } from "./intraday-pairs";
import { prefix, stats, type Sample } from "./intraday-edge";
import { pct } from "./momentum";
import { INTRADAY as S, dailyLevels } from "./value-area";

const SPLIT = Date.UTC(2024, 6, 1);
const DAY = 86_400;
const NY_FROM = 13.5 * 3600;
const NY_TO = 20 * 3600;

type Dir = 1 | -1;
interface Trade extends Sample {
  reason: "stop" | "target" | "time";
  mfeR: number;
  bars: number;
}

/** Hold from bar e in direction d: the stop first, then the target; out at `last`. */
function hold(c: ResearchBar[], e: number, d: Dir, stop: number, target: number, last: number): Omit<Trade, "at"> & { bar: number } {
  const entry = c[e].close;
  const risk = Math.abs(entry - stop);
  let best = 0;
  const end = Math.min(c.length - 1, last);
  const done = (px: number, x: number, reason: Trade["reason"]) => ({ gross: (d * (px - entry)) / entry, bar: x, reason, mfeR: best / risk, bars: x - e });
  for (let x = e + 1; x <= end; x++) {
    const b = c[x];
    if (d === 1 ? b.low <= stop : b.high >= stop) return done(d === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop), x, "stop");
    best = Math.max(best, d === 1 ? b.high - entry : entry - b.low);
    if (d === 1 ? b.high >= target : b.low <= target) return done(d === 1 ? Math.max(b.open, target) : Math.min(b.open, target), x, "target");
  }
  return done(c[end].close, end, "time");
}

const book = new Map<string, Trade[]>();
const counts = new Map<string, number>();
const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
const rule80 = { opened: 0, entered: 0, other: 0, insideDays: 0, insideCross: 0 };

function scan(c: ResearchBar[]) {
  const n = c.length;
  const lv = dailyLevels(c, S);
  const vol = prefix(c.map((b) => b.volume));
  // per bar: the day's first bar index
  const dayStart = new Int32Array(n);
  for (let i = 0; i < n; i++) dayStart[i] = i > 0 && Math.floor(c[i].time / DAY) === Math.floor(c[i - 1].time / DAY) ? dayStart[i - 1] : i;
  const dayEnd = (i: number) => {
    let k = i;
    while (k + 1 < n && dayStart[k + 1] === dayStart[i]) k++;
    return k;
  };
  const busy = new Map<string, number>();
  const take = (key: string, e: number, d: Dir, stop: number, target: number, last: number) => {
    if ((busy.get(key) ?? -1) >= e) return;
    const { bar, ...r } = hold(c, e, d, stop, target, last);
    busy.set(key, bar);
    const list = book.get(key) ?? [];
    list.push({ at: c[e].time * 1000 + S.barMs, ...r });
    book.set(key, list);
  };

  for (let i = 21; i < n - 2; i++) {
    const L = lv[i];
    if (!L) continue;
    const open = c[dayStart[i]].open;
    const dayState = open > L.vah ? 1 : open < L.val ? -1 : 0; // imbalance up / down, balance

    for (const [edge, d] of [[L.vah, 1], [L.val, -1]] as const) {
      const beyond = (px: number) => (d === 1 ? px > edge : px < edge);
      if (!beyond(c[i].close) || beyond(c[i - 1].close)) continue;
      const side = d === 1 ? "VAH" : "VAL";
      count(`${side} breakout`);
      for (let j = i + 1; j <= Math.min(n - 2, i + S.window); j++) {
        const back = d === 1 ? c[j].low <= edge * (1 + S.tol) : c[j].high >= edge * (1 - S.tol);
        if (!back) continue;
        count(`${side} retest`);
        const entry = c[j].close;
        const holds = beyond(entry);
        const t: Dir = holds ? d : (-d as Dir);
        let stop: number;
        let target: number;
        if (holds) {
          count(`${side} retest holds`);
          stop = d === 1 ? Math.min(c[j].low, edge) * (1 - S.buf) : Math.max(c[j].high, edge) * (1 + S.buf);
          target = entry + t * 2 * Math.abs(entry - stop);
        } else {
          count(`${side} retest fails`);
          let ext = d === 1 ? -Infinity : Infinity;
          for (let k = i; k <= j; k++) ext = d === 1 ? Math.max(ext, c[k].high) : Math.min(ext, c[k].low);
          stop = d === 1 ? ext * (1 + S.buf) : ext * (1 - S.buf);
          target = L.poc;
          if (t * (target - entry) < Math.abs(entry - stop)) break;
        }
        const sd = Math.abs(entry - stop) / entry;
        if (sd < S.minStop || sd > S.maxStop) break;
        const name = `${side} ${holds ? "continuation" : "fails → POC"} (${t === 1 ? "long" : "short"})`;
        const ratio = c[j].volume > 0 ? (c[j].buyVolume ?? 0) / c[j].volume : 0.5;
        const ok = {
          context: holds ? dayState === d : dayState === 0,
          aggression: (t === 1 ? ratio > 0.55 : ratio < 0.45) && c[j].volume >= (1.5 * (vol[j] - vol[j - 20])) / 20,
          ny: (c[j].time % DAY) >= NY_FROM && (c[j].time % DAY) < NY_TO,
        };
        const last = j + S.hold;
        take(`${name} · base`, j, t, stop, target, last);
        if (ok.context) take(`${name} · context`, j, t, stop, target, last);
        if (ok.aggression) take(`${name} · aggression`, j, t, stop, target, last);
        if (ok.ny) take(`${name} · NY session`, j, t, stop, target, last);
        if (ok.context && ok.aggression && ok.ny) take(`${name} · Fabio (all three)`, j, t, stop, target, last);
        break;
      }
    }

    // 80% rule, once per day at its first bar
    if (i !== dayStart[i]) continue;
    const end = dayEnd(i);
    if (end - i < 200) continue;
    if (dayState === 0) {
      rule80.insideDays++;
      let hi = false;
      let lo = false;
      for (let k = i; k <= end; k++) {
        hi ||= c[k].high >= L.vah;
        lo ||= c[k].low <= L.val;
      }
      if (hi && lo) rule80.insideCross++;
      continue;
    }
    rule80.opened++;
    let run = 0;
    for (let k = i; k <= end - 1; k++) {
      run = c[k].close < L.vah && c[k].close > L.val ? run + 1 : 0;
      if (run < 12) continue;
      rule80.entered++;
      const t: Dir = dayState === 1 ? -1 : 1;
      const target = t === 1 ? L.vah : L.val;
      let ext = t === 1 ? Infinity : -Infinity;
      for (let q = i; q <= k; q++) ext = t === 1 ? Math.min(ext, c[q].low) : Math.max(ext, c[q].high);
      const stop = t === 1 ? ext * (1 - S.buf) : ext * (1 + S.buf);
      let reached = false;
      for (let q = k + 1; q <= end; q++) if (t === 1 ? c[q].high >= target : c[q].low <= target) reached = true;
      if (reached) rule80.other++;
      if (Math.abs(c[k].close - stop) / c[k].close <= S.maxStop) take(`80% rule (${t === 1 ? "long to VAH" : "short to VAL"})`, k, t, stop, target, end);
      break;
    }
  }
}

function main() {
  let pairs = 0;
  for (const symbol of INTRADAY_PAIRS) {
    const file = path.join(CACHE_DIR, "klines", "5m", `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    pairs++;
    const all: ResearchBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of segments(all, 30 * 60_000)) if (c.length >= 5000) scan(c);
  }
  console.log(`${pairs} pairs · 5m · profile of the previous UTC day · IS 2022 → 2024-06 │ OOS after\n`);

  console.log("HOW PRICE BEHAVES AT THE EDGES (all periods)");
  for (const side of ["VAH", "VAL"]) {
    const b = counts.get(`${side} breakout`) ?? 0;
    const r = counts.get(`${side} retest`) ?? 0;
    const h = counts.get(`${side} retest holds`) ?? 0;
    console.log(`  ${side}: ${b} closes beyond · retested within 2h ${((100 * r) / b).toFixed(0)}% · of the retests, held ${((100 * h) / r).toFixed(0)}% / failed back inside ${((100 * (r - h)) / r).toFixed(0)}%`);
  }
  console.log(`  80% rule: ${rule80.opened} days opened outside value · came back inside for 1h on ${rule80.entered} (${((100 * rule80.entered) / rule80.opened).toFixed(0)}%) · of those, reached the other edge the same day ${((100 * rule80.other) / Math.max(1, rule80.entered)).toFixed(0)}%`);
  console.log(`  (days that opened inside value: ${rule80.insideDays}, touched both edges that day ${((100 * rule80.insideCross) / rule80.insideDays).toFixed(0)}%)\n`);

  console.log("PER TRADE: gross (t per event) · net maker 0.04% · net taker 0.1% · stop/target/time · stopped trades that first reached ≥ 1R");
  const row = (xs: Trade[]) => {
    const s = stats(xs);
    if (!s) return "–";
    const share = (f: (t: Trade) => boolean, of = xs) => `${((100 * of.filter(f).length) / Math.max(1, of.length)).toFixed(0)}%`;
    const stops = xs.filter((t) => t.reason === "stop");
    return `n ${String(s.n).padStart(6)} · ${pct(s.g, 3).padStart(8)} (t ${s.eventT.toFixed(1).padStart(5)}) · ${pct(s.g - 0.0004, 3).padStart(8)} · ${pct(s.g - 0.001, 3).padStart(8)} · ${share((t) => t.reason === "stop")}/${share((t) => t.reason === "target")}/${share((t) => t.reason === "time")} · ${share((t) => t.mfeR >= 1, stops)}`;
  };
  for (const key of [...book.keys()].sort()) {
    const xs = book.get(key) ?? [];
    console.log(`  ${key}`);
    console.log(`    IS  ${row(xs.filter((t) => t.at < SPLIT))}`);
    console.log(`    OOS ${row(xs.filter((t) => t.at >= SPLIT))}`);
  }

  console.log("\nPER YEAR, gross per trade (n) — base and Fabio rows");
  for (const key of [...book.keys()].sort()) {
    if (!/base|Fabio|80%/.test(key)) continue;
    const xs = book.get(key) ?? [];
    const years: string[] = [];
    for (let y = 2022; y <= new Date().getUTCFullYear(); y++) {
      const s = stats(xs.filter((t) => new Date(t.at).getUTCFullYear() === y));
      years.push(s ? `${y} ${pct(s.g, 3)} (${s.n})` : `${y} –`);
    }
    console.log(`  ${key.padEnd(52)} ${years.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("auction.ts")) main();
