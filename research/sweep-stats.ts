/**
 * What happens after price breaks a support (the events of research/stop-entry.ts): how often it
 * comes back, how deep it sweeps first, and whether a deeper sweep makes a bounce more or less
 * likely. Descriptive, no trades.
 *
 *   event     a bar whose low goes under the support (the lowest low of the N bars before), the
 *             support untouched for N/2 bars; ATR14 of the bar before
 *   bounce    a close back above the support within N bars
 *   depth     the lowest low from the event to the bounce (or over the N bars without one), under
 *             the support, in ATR and in %
 *   classic stop   support − 0.5 × ATR: how often it is hit, and how often price bounces after it
 *   P(bounce | depth ≥ x)   among events that went at least x ATR under the support, the share
 *             that still closed back above it
 *   after a bounce    the share that reaches the resistance (the N-bar high) within N bars of the
 *             event
 *
 * 1h (N 48), 4h (N 60), 1D (N 30); the whole universe at ≥ $2M/day; 2021 → now.
 *
 *   npx tsx research/sweep-stats.ts
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, archiveSymbols, segments, type ResearchBar } from "./data";
import { atr14, prefix } from "./intraday-edge";
import { inUniverse } from "./universe";

const TFS = [
  { tf: "1h", sec: 3600, n: 48 },
  { tf: "4h", sec: 14_400, n: 60 },
  { tf: "1d", sec: 86_400, n: 30 },
];

interface Ev {
  bounced: boolean;
  depthAtr: number;
  depthPct: number;
  stopHit: boolean; // the classic stop (0.5 ATR under) was touched before the bounce (or at all)
  resistance: boolean; // reached the resistance within N bars
  barsToBounce: number;
}

function events(n: number, c: ResearchBar[], barSec: number, out: Ev[]) {
  const len = c.length;
  const a = atr14(c);
  const qv = prefix(c.map((b) => b.quoteVolume));
  const perDay = 86_400 / barSec;
  const month = Math.round(30 * perDay);
  let lastEvent = -Infinity;
  for (let i = Math.max(n, month); i < len - n; i++) {
    let sup = Infinity;
    let res = -Infinity;
    for (let k = i - n; k < i; k++) {
      sup = Math.min(sup, c[k].low);
      res = Math.max(res, c[k].high);
    }
    if (!(c[i].low < sup)) continue;
    const fresh = i - lastEvent > n / 2;
    lastEvent = i;
    if (!fresh || Number.isNaN(a[i - 1]) || (qv[i] - qv[i - month]) / 30 < 2e6) continue;
    const atr = a[i - 1];
    let low = Infinity;
    let bounce = -1;
    for (let x = i; x < i + n; x++) {
      low = Math.min(low, c[x].low);
      if (c[x].close > sup) {
        bounce = x;
        break;
      }
    }
    let resistance = false;
    if (bounce >= 0) for (let x = bounce; x < i + n; x++) if (c[x].high >= res) resistance = true;
    out.push({
      bounced: bounce >= 0,
      depthAtr: (sup - low) / atr,
      depthPct: (sup - low) / sup,
      stopHit: sup - low >= 0.5 * atr,
      resistance,
      barsToBounce: bounce >= 0 ? bounce - i : n,
    });
  }
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const share = (xs: Ev[], f: (e: Ev) => boolean) => `${((100 * xs.filter(f).length) / Math.max(1, xs.length)).toFixed(0)}%`;

async function main() {
  const symbols = (await archiveSymbols()).filter(inUniverse);
  for (const { tf, sec, n } of TFS) {
    const ev: Ev[] = [];
    for (const symbol of symbols) {
      const file = path.join(CACHE_DIR, "klines", tf, `${symbol}.json`);
      if (!fs.existsSync(file)) continue;
      for (const c of segments(JSON.parse(fs.readFileSync(file, "utf8")), Math.max(3 * 86_400_000, 6 * sec * 1000))) if (c.length > 400) events(n, c, sec, ev);
    }
    const b = ev.filter((e) => e.bounced);
    const nb = ev.filter((e) => !e.bounced);
    console.log(`\n${tf} (support = low of ${n} bars) · ${ev.length} breaks`);
    console.log(`  bounced (closed back above within ${n} bars): ${share(ev, (e) => e.bounced)} · median ${q(b.map((e) => e.barsToBounce), 0.5)} bars (75%: ${q(b.map((e) => e.barsToBounce), 0.75)})`);
    console.log(`  depth before the bounce, ATR: 25% ${q(b.map((e) => e.depthAtr), 0.25).toFixed(2)} · median ${q(b.map((e) => e.depthAtr), 0.5).toFixed(2)} · 75% ${q(b.map((e) => e.depthAtr), 0.75).toFixed(2)} · 90% ${q(b.map((e) => e.depthAtr), 0.9).toFixed(2)}`);
    console.log(`  depth before the bounce, %:   25% ${(100 * q(b.map((e) => e.depthPct), 0.25)).toFixed(2)} · median ${(100 * q(b.map((e) => e.depthPct), 0.5)).toFixed(2)} · 75% ${(100 * q(b.map((e) => e.depthPct), 0.75)).toFixed(2)} · 90% ${(100 * q(b.map((e) => e.depthPct), 0.9)).toFixed(2)}`);
    console.log(`  no bounce: depth over ${n} bars median ${q(nb.map((e) => e.depthAtr), 0.5).toFixed(2)} ATR (${(100 * q(nb.map((e) => e.depthPct), 0.5)).toFixed(1)}%)`);
    console.log(`  classic stop (−0.5 ATR) hit: ${share(ev, (e) => e.stopHit)} of breaks · of those, bounced anyway (stop hunted): ${share(ev.filter((e) => e.stopHit), (e) => e.bounced)}`);
    console.log(`  after a bounce, reached the resistance: ${share(b, (e) => e.resistance)} (= ${share(ev, (e) => e.resistance)} of all breaks)`);
    const rows: string[] = [];
    for (const x of [0, 0.25, 0.5, 1, 1.5, 2, 3]) {
      const deep = ev.filter((e) => e.depthAtr >= x);
      rows.push(`≥${x} ATR: ${share(deep, (e) => e.bounced)} (${deep.length})`);
    }
    console.log(`  P(bounce | went at least x ATR under): ${rows.join(" · ")}`);
  }
}

if (process.argv[1]?.endsWith("sweep-stats.ts")) void main();
