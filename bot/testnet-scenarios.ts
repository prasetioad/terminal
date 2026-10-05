/**
 * Execution scenarios on the Binance Spot TESTNET (play money), through the bot's own
 * engine and broker: every order path a live position can take, in minutes instead of
 * waiting days for real signals. Signals are synthetic (4h bars built around the testnet
 * price); orders, fills, stops and balances are real testnet ones.
 *
 *   1  Setup A entry: market buy, 8×ATR stop resting on the exchange
 *   2  restart mid-position: a new engine on the same database takes no second entry
 *   3  trail exit: the stop is cancelled, the position sold at market
 *   4  stop filled on the exchange: a tight stop, reconcile books the fill
 *   5  sold by hand outside the bot: reconcile marks the position "manual"
 *   6  /pause blocks a new entry; /flatten sells everything and stays paused
 *   7  coins already in the account (outside the bot) block an entry on that pair
 *   8  a pair Binance will delist: no entry, and a held position is sold
 *
 *   npx tsx bot/testnet-scenarios.ts [SYMBOL]      (keys from bot/.env; refuses anything but the testnet)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import type { Candle } from "../lib/types";
import { BINANCE_SPOT, BinanceSpotBroker, BinanceSpotClient } from "./binance";
import { loadConfig } from "./config";
import { BotStore } from "./db";
import { EMPTY_RISK, type RiskList } from "../lib/server/binanceRisk";
import { BotEngine } from "./engine";
import { BAR_MS, type MarketData, type PairInfo, lastClosedBar } from "./market";

try {
  loadEnvFile("bot/.env");
} catch {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(46)} ${detail}`);
};

/** Synthetic 4h bars: a flat range 3% under `price`, then a breakout bar closing at `price` on 4× volume. */
function breakoutBars(price: number, endTime: number, after: number[] = []): Candle[] {
  const n = 520;
  const base = price * 0.97;
  const bars: Candle[] = [];
  for (let i = 0; i < n - 1; i++) {
    const time = (endTime - (n - 1 - i) * BAR_MS) / 1000;
    // A flat range never closes above its own past highs: the only breakout is the last bar.
    bars.push({ time: time as Candle["time"], open: base, high: base * 1.003, low: base * 0.997, close: base, volume: i >= n - 6 ? 4000 : 1000, buyVolume: 500 });
  }
  bars.push({ time: (endTime / 1000) as Candle["time"], open: base, high: price * 1.002, low: base * 0.997, close: price, volume: 4000, buyVolume: 2000 });
  // Bars after the entry: closes given as multiples of the entry price.
  let prev = price;
  after.forEach((m, j) => {
    const close = price * m;
    bars.push({ time: ((endTime + (j + 1) * BAR_MS) / 1000) as Candle["time"], open: prev, high: Math.max(prev, close) * 1.002, low: Math.min(prev, close) * 0.998, close, volume: 1000, buyVolume: 500 });
    prev = close;
  });
  return bars;
}

class ScenarioMarket implements MarketData {
  bars: Candle[] = [];
  constructor(
    private readonly symbol: string,
    private readonly client: BinanceSpotClient,
  ) {}
  async universe(): Promise<PairInfo[]> {
    return [{ symbol: this.symbol, base: this.symbol.replace(/USDT$/, ""), precision: 8 }];
  }
  async closedBars(symbol: string, barTime: number): Promise<Candle[] | null> {
    if (symbol !== this.symbol) return null;
    const upTo = this.bars.filter((b) => b.time * 1000 <= barTime);
    return upTo.length && upTo[upTo.length - 1].time * 1000 === barTime ? upTo : null;
  }
  async price(symbol: string): Promise<number> {
    return Number((await this.client.request<{ price: string }>("GET", "/api/v3/ticker/price", { symbol }, false)).price);
  }
}

async function main() {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET (testnet) missing in bot/.env");
  const client = new BinanceSpotClient(BINANCE_SPOT.testnet, key, secret);
  const broker = new BinanceSpotBroker("testnet", client);

  // A pair the testnet account holds none of, so a manual sale is visible.
  const balances = await client.balances();
  const info = await client.request<{ symbols: { symbol: string; status: string; quoteAsset: string; baseAsset: string }[] }>("GET", "/api/v3/exchangeInfo", {}, false);
  const preferred = ["SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "DOTUSDT", "NEARUSDT", "LTCUSDT", "TRXUSDT"];
  const free = (s: { baseAsset: string }) => (balances.get(s.baseAsset)?.free ?? 0) + (balances.get(s.baseAsset)?.locked ?? 0) === 0;
  const pairs = info.symbols.filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && free(s));
  let symbol = process.argv[2] ?? [...preferred.filter((p) => pairs.some((x) => x.symbol === p)), ...pairs.map((x) => x.symbol)][0] ?? "";
  if (!symbol) {
    // The testnet account holds every coin: empty one pair first (play money), dust < 1 USDT stays.
    for (const p of preferred) {
      if (!info.symbols.some((x) => x.symbol === p && x.status === "TRADING") || !(await broker.rules(p)).ok) continue;
      const held = await broker.holding(p);
      if (held > 0) await broker.sell(p, held, 0, `scn-${Date.now().toString(36)}-z`).catch((err) => console.log(`  (could not empty ${p}: ${(err as Error).message})`));
      const px = Number((await client.request<{ price: string }>("GET", "/api/v3/ticker/price", { symbol: p }, false)).price);
      if ((await broker.holding(p)) * px < 1) {
        symbol = p;
        console.log(`  emptied ${p} on the testnet (sold the account's own ${held.toPrecision(6)}) for the manual-sale scenario`);
        break;
      }
    }
  }
  if (!symbol) throw new Error("no USDT pair could be emptied on the testnet — pass one as an argument");
  const market = new ScenarioMarket(symbol, client);
  const usdt0 = await broker.cash();
  const held0 = await broker.holding(symbol);
  console.log(`testnet · ${symbol} · USDT free ${usdt0.toFixed(2)} · base held before ${held0.toPrecision(6)}\n`);

  const dbFile = path.join(os.tmpdir(), `testnet-scenarios-${Date.now()}.sqlite`);
  const cfg = {
    ...loadConfig({ MODE: "testnet", BINANCE_API_KEY: key, BINANCE_API_SECRET: secret, SETUPS: "a", RISK_PER_TRADE_A: "0.0005" }),
    minLiquidity30d: 0,
    dbPath: dbFile,
  };
  const silent = { send: async () => {} };
  // Binance's warning lists, set by scenario 8 (empty otherwise).
  let risk: RiskList = EMPTY_RISK;
  const run = Date.now();
  // Each scenario its own signal bar (unique client order ids on every run).
  let bar = lastClosedBar(run) - 600 * BAR_MS;
  const nextSignal = async (after: number[] = []) => {
    bar -= 50 * BAR_MS;
    market.bars = breakoutBars(await market.price(symbol), bar, after);
    return bar;
  };
  const open = (store: BotStore) => store.openPositions().find((p) => p.symbol === symbol);

  /* 1 · entry */
  let store = new BotStore(dbFile);
  let engine = new BotEngine(cfg, store, market, broker, silent, () => Date.now(), async () => risk);
  const rise = Array.from({ length: 10 }, (_, j) => 1 + 0.01 * (j + 1));
  const t1 = await nextSignal([...rise, 1.0]);
  const r1 = await engine.runCycle(t1);
  let pos = open(store);
  ok("1 entry: market buy, position booked", Boolean(pos) && r1.entries.length === 1, r1.entries[0] ?? r1.errors.join("; ") ?? r1.skipped.join("; "));
  ok("1 entry: stop resting on the exchange", Boolean(pos?.stopOrderId), pos ? `order ${pos.stopOrderId} @ ${pos.stopPrice.toPrecision(6)} (−${(100 * (1 - pos.stopPrice / pos.entryPrice)).toFixed(1)}%)` : "");
  if (!pos) throw new Error("no position — cannot continue");

  /* 2 · restart */
  store.close();
  store = new BotStore(dbFile);
  engine = new BotEngine(cfg, store, market, broker, silent, () => Date.now(), async () => risk);
  const r2 = await engine.runCycle(t1);
  await engine.reconcile();
  ok("2 restart: no second entry for the same signal", r2.entries.length === 0 && store.openPositions().length === 1);
  ok("2 restart: position and stop still in place", open(store)?.stopOrderId === pos.stopOrderId);

  /* 3 · trail exit (10 bars up, then a close under the chandelier) */
  const r3 = await engine.runCycle(t1 + 11 * BAR_MS);
  const closed3 = store.closedPositions(10).find((p) => p.id === pos!.id);
  ok("3 trail exit: position closed by the chandelier", closed3?.exitReason === "trail", r3.exits[0] ?? r3.errors.join("; "));
  await sleep(1500);
  ok("3 trail exit: stop cancelled, coins sold", (await broker.holding(symbol)) - held0 < pos.qty * 0.05, `left ${((await broker.holding(symbol)) - held0).toPrecision(4)} beyond the account's own`);

  /* 4 · stop filled on the exchange */
  const t4 = await nextSignal();
  await engine.runCycle(t4);
  pos = open(store);
  if (pos?.stopOrderId) {
    await broker.cancelStop(symbol, pos.stopOrderId);
    const px = await market.price(symbol);
    const tight = await broker.placeStop(symbol, pos.qty, px * 0.9995, `scn-${run.toString(36)}-t`);
    store.setStopOrder(pos.id, tight);
    console.log(`  … tight stop @ ${(px * 0.9995).toPrecision(6)} (0.05% under ${px.toPrecision(6)}), waiting for the price to touch it (≤ 20 min)`);
    const until = Date.now() + 20 * 60_000;
    while (Date.now() < until && open(store)) {
      await sleep(15_000);
      await engine.reconcile();
    }
    const closed4 = store.closedPositions(10).find((p) => p.id === pos!.id);
    ok("4 stop: fill on the exchange booked by reconcile", closed4?.exitReason === "stop", closed4 ? `@ ${closed4.exitPrice?.toPrecision(6)} · P&L ${closed4.pnl?.toFixed(4)} USDT` : "not filled in 20 minutes");
    if (!closed4) await engine.flatten("scenario 4 cleanup");
  } else ok("4 stop: entry", false, "no position");

  /* 5 · sold by hand */
  store.set("paused", "0");
  const t5 = await nextSignal();
  await engine.runCycle(t5);
  pos = open(store);
  if (pos) {
    if (pos.stopOrderId) await broker.cancelStop(symbol, pos.stopOrderId);
    await broker.sell(symbol, Math.min(pos.qty, await broker.holding(symbol)), 0, `scn-${run.toString(36)}-m`);
    await engine.reconcile();
    const closed5 = store.closedPositions(10).find((p) => p.id === pos!.id);
    ok("5 manual sale: detected and booked as manual", closed5?.exitReason === "manual");
  } else ok("5 manual sale: entry", false, "no position");

  /* 6 · pause and flatten */
  const t6 = await nextSignal();
  await engine.runCycle(t6);
  pos = open(store);
  engine.risk.setPaused(true, "scenario 6");
  const t6b = await nextSignal();
  const r6 = await engine.runCycle(t6b);
  ok("6 pause: a new signal is not taken", r6.entries.length === 0 && r6.skipped.some((x) => /paused/.test(x)), r6.skipped.find((x) => /paused/.test(x)) ?? "");
  // Same pair: the existing position blocks a second one anyway — check the gate on the report above.
  const lines = await engine.flatten("scenario 6");
  await sleep(1500);
  ok("6 flatten: everything sold, entries stay paused", store.openPositions().length === 0 && engine.risk.paused, lines.join(" · "));

  /* 7 · coins already in the account block an entry */
  engine.risk.setPaused(false, "scenario 7");
  const px7 = await market.price(symbol);
  const own = await broker.buy(symbol, 15, px7, `scn-${run.toString(36)}-o`);
  const t7 = await nextSignal();
  const r7 = await engine.runCycle(t7);
  ok("7 coins held outside the bot: entry skipped", r7.entries.length === 0 && r7.skipped.some((x) => /outside the bot/.test(x)), r7.skipped.find((x) => /outside the bot/.test(x)) ?? r7.entries.join("; "));
  await broker.sell(symbol, Math.min(own.qty, await broker.holding(symbol)), px7, `scn-${run.toString(36)}-p`);

  /* 8 · delisting: no entry, and a held position is sold */
  risk = { ...EMPTY_RISK, delist: new Map([[symbol, Date.now() + 2 * 86_400_000]]), fetchedAt: Date.now() };
  const r8 = await engine.runCycle(await nextSignal());
  ok("8 delisting: entry skipped", r8.entries.length === 0 && r8.skipped.some((x) => /delists it/.test(x)), r8.skipped.find((x) => /delists it/.test(x)) ?? "");
  risk = EMPTY_RISK;
  await engine.runCycle(await nextSignal());
  pos = open(store);
  risk = { ...EMPTY_RISK, delist: new Map([[symbol, Date.now() + 2 * 86_400_000]]), fetchedAt: Date.now() };
  const r8b = await engine.runCycle(t1); // any bar: the delisting check comes first
  await sleep(1500);
  const closed8 = pos ? store.closedPositions(20).find((p) => p.id === pos!.id) : undefined;
  ok("8 delisting: held position sold, stop cancelled", closed8?.exitReason === "delist" && (await broker.holding(symbol)) - held0 < (pos?.qty ?? 1) * 0.05, r8b.warnings[0] ?? "no position");
  risk = EMPTY_RISK;

  /* clean state */
  const orders = await client.request<unknown[]>("GET", "/api/v3/openOrders", { symbol }, true);
  ok("no orders left open", orders.length === 0, `${orders.length} open`);
  const usdt1 = await broker.cash();
  const pnl = store.closedPositions(100).reduce((s, p) => s + (p.pnl ?? 0), 0);
  console.log(`\nbooks: ${store.closedPositions(100).length} closed · P&L ${pnl.toFixed(4)} USDT · USDT free ${usdt0.toFixed(2)} → ${usdt1.toFixed(2)} (Δ ${(usdt1 - usdt0).toFixed(4)})`);
  store.close();
  fs.rmSync(dbFile, { force: true });
  console.log(failures ? `\n${failures} SCENARIO(S) FAILED` : "\nALL TESTNET SCENARIOS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
});
