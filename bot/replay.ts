/**
 * Replay: run the bot over history, bar by bar, through the same `runCycle` that trades
 * live (paper broker, real store). Proves the bot executes exactly what was backtested
 * before any money is involved.
 *
 *   npx tsx bot/replay.ts [--days 365] [--pairs BTCUSDT,ETHUSDT,...]
 */
import { SETUP_A, runSetupA } from "../lib/setups/setupA";
import { liquidity30d, runSetupV1 } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import { loadSeries } from "../research/data";
import { PaperBroker } from "./broker";
import { loadConfig, type BotConfig } from "./config";
import { BotStore } from "./db";
import { BotEngine, type Notifier } from "./engine";
import { BAR_MS, type MarketData, type PairInfo } from "./market";

const LIVE_WINDOW = 500; // bars the live market data serves

export class ReplayMarketData implements MarketData {
  current = 0; // bar open time being replayed

  constructor(private readonly series: Map<string, Candle[]>) {}

  async universe(): Promise<PairInfo[]> {
    return [...this.series.keys()].map((symbol) => ({ symbol, base: symbol.replace(/USDT$/, ""), precision: 8 }));
  }

  async closedBars(symbol: string, barTime: number, minBars: number): Promise<Candle[] | null> {
    const bars = this.series.get(symbol);
    if (!bars) return null;
    let end = bars.length - 1;
    while (end >= 0 && bars[end].time * 1000 > barTime) end--;
    if (end < 0 || bars[end].time * 1000 !== barTime) return null;
    const count = Math.max(LIVE_WINDOW, minBars);
    return bars.slice(Math.max(0, end - count + 1), end + 1);
  }

  async price(symbol: string): Promise<number> {
    const bars = this.series.get(symbol)!;
    let i = bars.length - 1;
    while (i > 0 && bars[i].time * 1000 > this.current) i--;
    return bars[i].close;
  }
}

const silent: Notifier = { send: async () => {} };

export interface ReplayResult {
  store: BotStore;
  /** Engine trades the bot should have taken (fresh entries inside the window, liquid enough; Setup A: confirmed). */
  expected: { setup: "v1" | "a"; symbol: string; entryTime: number; exitTime: number | null; reason: string | null }[];
}

export async function replay(series: Map<string, Candle[]>, from: number, to: number, cfg: BotConfig): Promise<ReplayResult> {
  const store = new BotStore(":memory:");
  const market = new ReplayMarketData(series);
  let clock = from;
  const engine = new BotEngine(cfg, store, market, new PaperBroker(store, cfg.paperStartEquity, cfg.feeRate, cfg.slippage), silent, () => clock);
  for (let bar = from; bar <= to; bar += BAR_MS) {
    market.current = bar;
    clock = bar + BAR_MS + 90_000;
    await engine.runCycle(bar);
  }
  const expected: ReplayResult["expected"] = [];
  for (const [symbol, bars] of series) {
    const window = bars.filter((b) => b.time * 1000 <= to);
    const take = (setup: "v1" | "a", t: { entryTime: number; entryIndex: number; exitTime: number | null; exitReason: string | null }) => {
      if (t.entryTime < from || t.entryTime > to) return;
      if (liquidity30d(bars, t.entryIndex, BAR_MS) < cfg.minLiquidity30d) return;
      expected.push({ setup, symbol, entryTime: t.entryTime, exitTime: t.exitTime, reason: t.exitReason });
    };
    if (cfg.setups.includes("v1")) {
      const r = runSetupV1(window, { stoch: cfg.stoch, intervalMs: BAR_MS, firstDotOnly: cfg.firstDotOnly });
      for (const t of [...r.trades, ...(r.open ? [r.open] : [])]) take("v1", t);
    }
    if (cfg.setups.includes("a")) {
      const r = runSetupA(window, BAR_MS, { btc: series.get("BTCUSDT"), maxRs: cfg.maxRsA ?? undefined, spikeTighten: cfg.spikeTightenA ? SETUP_A.spikeTighten : undefined });
      for (const t of [...r.trades, ...(r.open ? [r.open] : [])]) if (t.passes) take("a", t);
    }
  }
  return { store, expected };
}

async function main() {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const days = Number(arg("days", "365"));
  const symbols = arg("pairs", "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,LTCUSDT,BCHUSDT,ATOMUSDT,NEARUSDT,FILUSDT,UNIUSDT,AAVEUSDT,ETCUSDT,TRXUSDT,XLMUSDT,INJUSDT,ZECUSDT,SANDUSDT,CRVUSDT,ALGOUSDT").split(",");
  const series = new Map<string, Candle[]>();
  for (const s of symbols) series.set(s, await loadSeries(s, "4h", 2021));
  const last = Math.min(...[...series.values()].map((b) => b.at(-1)!.time * 1000));
  const to = last;
  const from = Math.floor((to - days * 86_400_000) / BAR_MS) * BAR_MS;

  // 1) Fidelity, per setup: unconstrained sizing → the bot must take exactly the engine's trades.
  // (breadth 1: the fidelity check covers execution; breadth is measured on the full universe in research/)
  for (const setup of ["v1", "a"] as const) {
    const wide = { ...loadConfig({ ...process.env, MODE: "paper", SETUPS: setup }), maxOpenPositions: 50, maxOpenPositionsA: 50, riskPerTrade: 0.0005, riskPerTradeA: 0.0005, minLiquidity30d: 0, minBreadth: 1, maxRiskPerBar: 0, paperStartEquity: 1e6 };
    const a = await replay(series, from, to, wide);
    const taken = [...a.store.openPositions(), ...a.store.closedPositions(100_000)];
    const key = (s: string, t: number) => `${s}|${t}`;
    const takenKeys = new Set(taken.map((p) => key(p.symbol, p.signalTime)));
    const expectedKeys = new Set(a.expected.map((e) => key(e.symbol, e.entryTime)));
    const missing = a.expected.filter((e) => !takenKeys.has(key(e.symbol, e.entryTime)));
    const extra = taken.filter((p) => !expectedKeys.has(key(p.symbol, p.signalTime)));
    // The bot books a v1 signal exit as "signal" and a Setup A one as "trail"; both are the engine's non-stop exit.
    const exitMismatch = a.store.closedPositions(100_000).filter((p) => {
      const e = a.expected.find((x) => key(x.symbol, x.entryTime) === key(p.symbol, p.signalTime));
      return !e || (e.reason === "stop") !== (p.exitReason === "stop");
    });
    console.log(`replay ${days}d · ${symbols.length} pairs · Setup ${setup} fidelity: engine ${a.expected.length} trades · bot ${taken.length} · missing ${missing.length} · extra ${extra.length} · exit mismatches ${exitMismatch.length}`);
  }

  // 2) The configured setups and risk (bot/.env, e.g. SETUPS=v1,a): what the paper bot would have done.
  // 25 pairs rarely reach a breadth of 10, so this run shows the risk machinery with breadth off.
  const configured = loadConfig({ ...process.env, MODE: "paper" });
  const b = await replay(series, from, to, { ...configured, minBreadth: 1 });
  const closed = b.store.closedPositions(100_000);
  const rets = closed.map((p) => p.pnl! / p.cost);
  const curve = b.store.equityCurve(100_000);
  let peak = 0;
  let maxDD = 0;
  for (const c of curve) {
    peak = Math.max(peak, c.equity);
    maxDD = Math.min(maxDD, c.equity / peak - 1);
  }
  const startEq = configured.paperStartEquity;
  const endEq = curve.at(-1)?.equity ?? startEq;
  console.log(
    `configured (${configured.setups.join("+")}, breadth off) · ${closed.length} closed (${b.store.openPositions().length} open) · win ${((100 * rets.filter((r) => r > 0).length) / Math.max(1, rets.length)).toFixed(0)}% · avg ${((100 * rets.reduce((x, y) => x + y, 0)) / Math.max(1, rets.length)).toFixed(2)}% · equity ${startEq} → ${endEq.toFixed(0)} (${(((endEq / startEq) - 1) * 100).toFixed(1)}%) · max drawdown ${(maxDD * 100).toFixed(1)}% (marked to market each bar)`,
  );
}

if (process.argv[1]?.endsWith("replay.ts")) void main();
