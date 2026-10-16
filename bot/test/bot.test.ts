/**
 * Bot unit tests:  npm run bot:test
 * Exchange calls are mocked; nothing here touches Binance.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSetupA } from "../../lib/setups/setupA";
import { runSetupV1 } from "../../lib/setups/setupV1";
import { zoneOrder } from "../../lib/setups/setupZ";
import type { Candle } from "../../lib/types";
import { BinanceApiError, BinanceSpotBroker, BinanceSpotClient, floorToStep, sign } from "../binance";
import { PaperBroker, type Broker, type Fill, type StopStatus } from "../broker";
import { LIVE_CONFIRM_PHRASE, loadConfig } from "../config";
import { BotStore } from "../db";
import { BotEngine } from "../engine";
import { dailyReport, traitCheck } from "../report";
import { EMPTY_RISK, parseDelistTitles, type RiskList } from "../../lib/server/binanceRisk";

const noRisk = async () => EMPTY_RISK;
/** Brokers in these tests that never rest a limit (Setup Z is off for them). */
const noLimits = { placeLimitBuy: async () => null, limitStatus: async () => ({ state: "done" as const, status: "NONE", fill: null }), lockedCash: async () => 0 };
import { BAR_MS, SETTLE_MS, barDue, lastClosedBar, nextRunAt } from "../market";
import { ReplayMarketData } from "../replay";
import { RiskGate, sizePosition } from "../risk";
import { breadthDD, range20, tagsOf, type TraitSource } from "../traits";

describe("binance primitives", () => {
  it("signs exactly like the Binance API documentation example", () => {
    const query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    assert.equal(sign(query, secret), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  it("floors to the step as an exact decimal string", () => {
    assert.equal(floorToStep(0.1234567, "0.001"), "0.123");
    assert.equal(floorToStep(12.9999999, "0.01"), "12.99");
    assert.equal(floorToStep(0.3, "0.1"), "0.3"); // float noise (0.1 + 0.2) must not floor to 0.2
    assert.equal(floorToStep(1234.5, "1"), "1234");
    assert.equal(floorToStep(0.000123456, "0.00000100"), "0.000123");
  });
});

describe("config", () => {
  it("defaults to paper", () => assert.equal(loadConfig({}).mode, "paper"));
  it("refuses live without the confirmation phrase", () => {
    assert.throws(() => loadConfig({ MODE: "live", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }), /LIVE_CONFIRM/);
    assert.throws(() => loadConfig({ MODE: "live", LIVE_CONFIRM: "yes", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }), /LIVE_CONFIRM/);
    assert.equal(loadConfig({ MODE: "live", LIVE_CONFIRM: LIVE_CONFIRM_PHRASE, BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }).mode, "live");
  });
  it("needs API keys outside paper", () => assert.throws(() => loadConfig({ MODE: "testnet" }), /BINANCE_API_KEY/));
  it("rejects out-of-range risk", () => assert.throws(() => loadConfig({ RISK_PER_TRADE: "0.5" }), /RISK_PER_TRADE/));
  it("runs Setup v1 alone with v1.1 rules unless told otherwise", () => {
    const c = loadConfig({});
    assert.deepEqual(c.setups, ["v1"]);
    assert.equal(c.maxRiskPerBar, 0);
  });
  it("keeps the entry improvements off unless switched on", () => {
    const c = loadConfig({});
    assert.equal(c.firstDotOnly, false);
    assert.equal(c.maxRsA, null);
    const on = loadConfig({ V1_FIRST_DOT_ONLY: "1", A_MAX_RS: "-0.1" });
    assert.equal(on.firstDotOnly, true);
    assert.equal(on.maxRsA, -0.1);
    assert.throws(() => loadConfig({ V1_FIRST_DOT_ONLY: "maybe" }), /V1_FIRST_DOT_ONLY/);
  });
  it("parses and validates the setups", () => {
    assert.deepEqual(loadConfig({ SETUPS: "v1, a" }).setups, ["v1", "a"]);
    assert.deepEqual(loadConfig({ SETUPS: "a" }).setups, ["a"]);
    assert.throws(() => loadConfig({ SETUPS: "v1,b" }), /SETUPS/);
    assert.throws(() => loadConfig({ SETUPS: "a,a" }), /SETUPS/);
  });
});

describe("risk", () => {
  const cfg = loadConfig({});
  it("sizes 1% risk at a −15% stop to 6.67% of equity", () => {
    const d = sizePosition(cfg, { equity: 10_000, cash: 10_000, openPositions: 0, minNotional: 5 });
    assert.ok(d.ok && Math.abs(d.quote - 666.67) < 0.01);
  });
  it("caps by free cash and by position count", () => {
    const d = sizePosition(cfg, { equity: 10_000, cash: 100, openPositions: 0, minNotional: 5 });
    assert.ok(d.ok && Math.abs(d.quote - 98) < 1e-9);
    assert.equal(sizePosition(cfg, { equity: 10_000, cash: 10_000, openPositions: 15, minNotional: 5 }).ok, false);
    assert.equal(sizePosition(cfg, { equity: 100, cash: 100, openPositions: 0, minNotional: 10 }).ok, false); // 6.67 < 15
  });
  it("sizes Setup A by its own stop and risk, and keeps its stop a valid order", () => {
    const a = loadConfig({ SETUPS: "v1,a" });
    const d = sizePosition(a, { equity: 300, cash: 300, openPositions: 0, minNotional: 5, setup: "a", stopPct: 0.2 });
    assert.ok(d.ok && Math.abs(d.quote - 7.5) < 1e-9); // 0.5% of 300 at a −20% stop
    // 250 × 0.5% ÷ 20% = 6.25 → the stop would sell 5.00 < 5.50: refused
    assert.equal(sizePosition(a, { equity: 250, cash: 250, openPositions: 0, minNotional: 5, setup: "a", stopPct: 0.2 }).ok, false);
    assert.equal(sizePosition(a, { equity: 1e4, cash: 1e4, openPositions: 15, minNotional: 5, setup: "a", stopPct: 0.2 }).ok, false);
  });
  it("small accounts: takes the smallest valid size only when its risk stays within the cap", () => {
    const off = loadConfig({ SETUPS: "v1,a" });
    assert.equal(sizePosition(off, { equity: 98, cash: 98, openPositions: 0, minNotional: 5, setup: "a", stopPct: 0.2 }).ok, false); // 2.45 USDT
    const on = loadConfig({ SETUPS: "v1,a", MIN_SIZE_MAX_RISK: "0.015" });
    const d = sizePosition(on, { equity: 98, cash: 98, openPositions: 0, minNotional: 5, setup: "a", stopPct: 0.2 });
    assert.ok(d.ok && Math.abs(d.quote - 6.875) < 1e-9); // 5 × 1.1 ÷ 0.8; loses 1.375 (1.4%) at the stop
    // a 25% stop: the minimum (7.33) would lose 1.83 = 1.9% > 1.5% → still skipped
    assert.equal(sizePosition(on, { equity: 98, cash: 98, openPositions: 0, minNotional: 5, setup: "a", stopPct: 0.25 }).ok, false);
    // a size already above the minimum is unchanged
    const v1 = sizePosition(on, { equity: 300, cash: 300, openPositions: 0, minNotional: 5 });
    assert.ok(v1.ok && Math.abs(v1.quote - 20) < 1e-9);
    assert.throws(() => loadConfig({ MIN_SIZE_MAX_RISK: "0.1" }), /MIN_SIZE_MAX_RISK/);
  });
  it("keeps the stop a valid order on a pair with a coarse quantity step", () => {
    // NEAR, Oct 2026: $5.12, step 0.1 ($0.51), min $5. Without the step, $6.52 passed; filled 1.2, the stop could only take 1.1 ($4.79).
    const live = loadConfig({ MIN_SIZE_MAX_RISK: "0.015" });
    const plain = sizePosition(live, { equity: 97.77, cash: 65, openPositions: 0, minNotional: 5 });
    assert.ok(plain.ok && Math.abs(plain.quote - 6.518) < 0.01);
    const near = sizePosition(live, { equity: 97.77, cash: 65, openPositions: 0, minNotional: 5, stepValue: 0.512 });
    assert.ok(near.ok && near.quote > 7.4, "the minimum valid size, within the 1.5% cap");
    // what Binance does with it: buy floored to the step, a base-asset fee, the stop floored again
    const held = Math.floor((near.quote / 5.12) * 10) / 10 - 0.0014;
    assert.ok((Math.floor(held * 10) / 10) * 5.12 * 0.85 >= 5);
    // without the small-account cap it is skipped, not taken too small
    assert.equal(sizePosition(loadConfig({}), { equity: 97.77, cash: 65, openPositions: 0, minNotional: 5, stepValue: 0.512 }).ok, false);
  });

  it("blocks entries past the daily loss limit, and when paused", () => {
    const store = new BotStore(":memory:");
    const gate = new RiskGate(cfg, store);
    const t = Date.UTC(2026, 0, 5, 1);
    assert.equal(gate.entryBlock(10_000, t), null); // records the day's start
    assert.equal(gate.entryBlock(9_600, t + 3_600_000), null);
    assert.match(gate.entryBlock(9_400, t + 7_200_000) ?? "", /daily loss/);
    assert.equal(gate.entryBlock(9_400, t + 86_400_000), null); // a new day resets
    gate.setPaused(true, "test");
    assert.equal(gate.entryBlock(20_000, t + 86_400_000), "paused");
  });
});

describe("store and paper broker", () => {
  it("never records the same signal twice", () => {
    const store = new BotStore(":memory:");
    const p = { setup: "v1" as const, symbol: "BTCUSDT", signalTime: 1, qty: 1, entryPrice: 100, entryFee: 0.1, cost: 100, stopPrice: 85, stopOrderId: null, openedAt: 1 };
    store.insertPosition(p);
    assert.equal(store.hasSignal("BTCUSDT", 1), true);
    assert.throws(() => store.insertPosition(p), /UNIQUE/);
  });

  it("books P&L from cash flows: a round trip at one price loses exactly fees and slippage", async () => {
    const store = new BotStore(":memory:");
    const broker = new PaperBroker(store, 1000, 0.001, 0.0005);
    const buy = await broker.buy("X", 100, 10, "e");
    const pos = store.insertPosition({ setup: "v1", symbol: "X", signalTime: 1, qty: buy.qty, entryPrice: buy.price, entryFee: buy.fee, cost: buy.quote, stopPrice: 8.5, stopOrderId: null, openedAt: 1 });
    const sell = await broker.sell("X", pos.qty, 10, "x");
    const done = store.closePosition(pos.id, { price: sell.price, fee: sell.fee, proceeds: sell.quote, reason: "signal", time: 2 });
    const expected = 100 * (1 - 0.001) / (10 * 1.0005) * 10 * 0.9995 * (1 - 0.001) - 100;
    assert.ok(Math.abs(done.pnl! - expected) < 1e-9);
    assert.ok(Math.abs((await broker.cash()) - (1000 + expected)) < 1e-9); // cash agrees with the books
  });
});

/* ───────────────────────────── Binance broker (mocked HTTP) ───────────────────────────── */

type Route = (url: URL, method: string) => { status: number; body: unknown } | "network-error";

function mockFetch(route: Route, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname} ${url.searchParams.get("type") ?? ""}`.trim());
    const r = route(url, method);
    if (r === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

const exchangeInfo = (orderTypes: string[]) => ({
  symbols: [
    {
      symbol: "SOLUSDT",
      status: "TRADING",
      baseAsset: "SOL",
      quoteAsset: "USDT",
      orderTypes,
      isSpotTradingAllowed: true,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
        { filterType: "LOT_SIZE", stepSize: "0.00100000", minQty: "0.00100000" },
        { filterType: "NOTIONAL", minNotional: "5.00000000" },
      ],
    },
  ],
});

describe("binance broker", () => {
  it("does not buy twice when the order request dies in flight", async () => {
    const calls: string[] = [];
    let posts = 0;
    const order = { orderId: 42, clientOrderId: "sv1-x-e", status: "FILLED", executedQty: "2.000", cummulativeQuoteQty: "300.00", fills: [{ price: "150", qty: "2", commission: "0.002", commissionAsset: "SOL" }] };
    const fetchImpl = mockFetch((url, method) => {
      if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
      if (url.pathname === "/api/v3/exchangeInfo") return { status: 200, body: exchangeInfo(["MARKET", "STOP_LOSS_LIMIT"]) };
      if (url.pathname === "/api/v3/order" && method === "POST") return posts++ === 0 ? "network-error" : { status: 200, body: order };
      if (url.pathname === "/api/v3/order" && method === "GET") return { status: 200, body: order }; // it went through
      return { status: 404, body: {} };
    }, calls);
    const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://testnet.example", "k", "s", fetchImpl));
    const fill = await broker.buy("SOLUSDT", 300, 150, "sv1-x-e");
    assert.equal(posts, 1, "exactly one order request");
    assert.ok(calls.includes("GET /api/v3/order"), "looked the order up by client id");
    // The SOL commission reduces the holding; cost is what left the account.
    assert.ok(Math.abs(fill.qty - 1.998) < 1e-12);
    assert.ok(Math.abs(fill.quote - 300) < 1e-9);
    assert.ok(Math.abs(fill.fee - 0.3) < 1e-9);
  });

  it("does not retry an order the exchange rejected", async () => {
    let posts = 0;
    const fetchImpl = mockFetch((url, method) => {
      if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
      if (url.pathname === "/api/v3/order" && method === "POST") return (posts++, { status: 400, body: { code: -2010, msg: "Account has insufficient balance" } });
      return { status: 404, body: {} };
    }, []);
    const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
    await assert.rejects(broker.buy("SOLUSDT", 300, 150, "c"), (e) => e instanceof BinanceApiError && e.code === -2010);
    assert.equal(posts, 1);
  });

  it("uses a stop-market when allowed, else a stop-limit 2% under, rounded to tick and step", async () => {
    for (const [types, expected] of [[["MARKET", "STOP_LOSS", "STOP_LOSS_LIMIT"], "STOP_LOSS"], [["MARKET", "STOP_LOSS_LIMIT"], "STOP_LOSS_LIMIT"]] as const) {
      let sent: URLSearchParams | null = null;
      const fetchImpl = mockFetch((url, method) => {
        if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
        if (url.pathname === "/api/v3/exchangeInfo") return { status: 200, body: exchangeInfo([...types]) };
        if (url.pathname === "/api/v3/order" && method === "POST") return (sent = url.searchParams, { status: 200, body: { orderId: 7, status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" } });
        return { status: 404, body: {} };
      }, []);
      const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
      assert.equal(await broker.placeStop("SOLUSDT", 1.99876, 127.123456, "s"), "7");
      const p = sent! as URLSearchParams;
      assert.equal(p.get("type"), expected);
      assert.equal(p.get("quantity"), "1.998");
      assert.equal(p.get("stopPrice"), "127.12");
      if (expected === "STOP_LOSS_LIMIT") assert.equal(p.get("price"), "124.58");
    }
  });

  it("treats cancelling an already-gone order as done", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
      return { status: 400, body: { code: -2011, msg: "Unknown order sent." } };
    }, []);
    const broker = new BinanceSpotBroker("testnet", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
    await broker.cancelStop("SOLUSDT", "7");
  });
});

/* ───────────────────────────── engine safety ───────────────────────────── */

/** A random walk with enough swings to produce Setup v1 entries. */
function syntheticSeries(n: number, seed: number): Candle[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const start = Math.floor(Date.UTC(2025, 0, 1) / BAR_MS) * BAR_MS;
  let price = 100;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1 + (rand() - 0.5) * 0.06 + Math.sin(i / 15) * 0.01;
    const high = Math.max(open, price) * (1 + rand() * 0.01);
    const low = Math.min(open, price) * (1 - rand() * 0.01);
    out.push({ time: ((start + i * BAR_MS) / 1000) as Candle["time"], open, high, low, close: price, volume: 1e6, buyVolume: 5e5 });
  }
  return out;
}

describe("engine", () => {
  const bars = syntheticSeries(1500, 7);
  const fresh = runSetupV1(bars, { stoch: "either", intervalMs: BAR_MS }).trades[0];
  const barTime = bars[fresh.entryIndex].time * 1000;
  const market = new ReplayMarketData(new Map([["TESTUSDT", bars]]));
  market.current = barTime;
  const cfg = { ...loadConfig({}), minLiquidity30d: 0, minBreadth: 1 };

  it("takes a fresh entry once, with its −15% stop", async () => {
    const store = new BotStore(":memory:");
    const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => barTime + BAR_MS, noRisk);
    await engine.runCycle(barTime);
    await engine.runCycle(barTime); // a re-run (crash recovery) must not enter again
    const open = store.openPositions();
    assert.equal(open.length, 1);
    assert.equal(open[0].signalTime, fresh.entryTime);
    assert.ok(Math.abs(open[0].stopPrice / open[0].entryPrice - 0.85) < 1e-12);
  });

  it("records the entry's traits after the entry, and a failing lookup never blocks it", async () => {
    const source: TraitSource = { btcTrend: async () => 0.05, forPair: async () => ({ funding: 0.0002, basis: -0.001, oi7: -0.2, ageDays: 900 }) };
    const store = new BotStore(":memory:");
    const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => barTime + BAR_MS, noRisk, source);
    const report = await engine.runCycle(barTime);
    const [p] = store.openPositions();
    assert.deepEqual({ ...p.traits, range20: null, breadthDD: null }, { range20: null, funding: 0.0002, basis: -0.001, oi7: -0.2, ageDays: 900, breadthDD: null, btcTrend: 0.05 });
    assert.ok(p.traits!.range20! > 0 && p.traits!.breadthDD !== null);
    assert.match(report.entries[0], /OI flushed ✓ · mature coin ✓ · BTC not hot ✓/);

    const failing: TraitSource = { btcTrend: async () => { throw new Error("down"); }, forPair: async () => { throw new Error("down"); } };
    const store2 = new BotStore(":memory:");
    const engine2 = new BotEngine(cfg, store2, market, new PaperBroker(store2, 10_000, 0.001, 0), { send: async () => {} }, () => barTime + BAR_MS, noRisk, failing);
    await engine2.runCycle(barTime);
    const [q] = store2.openPositions();
    assert.equal(q.traits?.funding, null);
    assert.equal(q.traits?.btcTrend, null);
  });

  it("on an exchange account, skips a pair whose coins the owner already holds", async () => {
    const store = new BotStore(":memory:");
    const paper = new PaperBroker(store, 10_000, 0.001, 0);
    const exchange: Broker = {
      kind: "testnet",
      ...noLimits,
      cash: () => paper.cash(),
      holding: async () => 3, // the owner's coins
      rules: async () => ({ ok: true, minNotional: 5 }),
      buy: (s, q, p, c) => paper.buy(s, q, p, c),
      sell: (s, q, p, c) => paper.sell(s, q, p, c),
      placeStop: async () => "1",
      cancelStop: async () => {},
      stopStatus: async () => ({ state: "resting" }),
    };
    const engine = new BotEngine(cfg, store, market, exchange, { send: async () => {} }, () => barTime + BAR_MS, noRisk);
    const report = await engine.runCycle(barTime);
    assert.equal(store.openPositions().length, 0);
    assert.match(report.skipped.join(" "), /outside the bot/);
  });

  it("never keeps a position whose stop could not be placed", async () => {
    const store = new BotStore(":memory:");
    const paper = new PaperBroker(store, 10_000, 0.001, 0);
    const sells: string[] = [];
    const broken: Broker = {
      kind: "testnet",
      ...noLimits,
      cash: () => paper.cash(),
      holding: async () => 0,
      rules: async () => ({ ok: true, minNotional: 5 }),
      buy: (s, q, p, c) => paper.buy(s, q, p, c),
      sell: async (s, q, p, c): Promise<Fill> => (sells.push(c), paper.sell(s, q, p, c)),
      placeStop: async () => {
        throw new Error("stop rejected");
      },
      cancelStop: async () => {},
      stopStatus: async () => ({ state: "resting" }),
    };
    const engine = new BotEngine(cfg, store, market, broken, { send: async () => {} }, () => barTime + BAR_MS, noRisk);
    const report = await engine.runCycle(barTime);
    assert.equal(store.openPositions().length, 0);
    assert.equal(sells.length, 1, "the entry was sold back");
    assert.match(report.errors.join(" "), /entry reversed/);
  });
});

describe("engine with several setups", () => {
  const base = syntheticSeries(1500, 7);
  // A volume-confirmed Setup A breakout: lift the last day's volume before the first breakout.
  const first = runSetupA(base, BAR_MS).trades[0];
  const bars = base.map((c, i) => (i > first.entryIndex - 6 && i <= first.entryIndex ? { ...c, volume: c.volume * 3 } : c));
  const breakout = runSetupA(bars, BAR_MS).trades.find((t) => t.entryIndex === first.entryIndex)!;
  const cfgA = { ...loadConfig({ SETUPS: "a" }), minLiquidity30d: 0 };

  it("enters a confirmed breakout with its ATR stop, and exits it as the setup does", async () => {
    assert.ok(breakout?.passes, "fixture: a confirmed breakout");
    const market = new ReplayMarketData(new Map([["TESTUSDT", bars]]));
    const store = new BotStore(":memory:");
    let clock = 0;
    const engine = new BotEngine(cfgA, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => clock, noRisk);
    const at = (i: number) => bars[i].time * 1000;
    market.current = at(breakout.entryIndex);
    clock = at(breakout.entryIndex) + BAR_MS;
    await engine.runCycle(at(breakout.entryIndex));
    const [pos] = store.openPositions();
    assert.equal(pos?.setup, "a");
    assert.ok(Math.abs(pos.stopPrice / pos.entryPrice - breakout.stopPrice / breakout.entryPrice) < 1e-12);
    for (let i = breakout.entryIndex + 1; i <= breakout.exitIndex!; i++) {
      market.current = at(i);
      clock = at(i) + BAR_MS;
      await engine.runCycle(at(i));
    }
    const [done] = store.closedPositions();
    assert.equal(store.openPositions().length, 0);
    assert.equal(done.exitReason, breakout.exitReason);
    if (breakout.exitReason === "trail") assert.ok(Math.abs(done.exitPrice! - breakout.exitPrice!) < 1e-9);
  });

  it("caps the v1 risk taken on one bar (v1.2)", async () => {
    const v1 = syntheticSeries(1500, 7);
    const signal = runSetupV1(v1, { stoch: "either", intervalMs: BAR_MS }).trades[0];
    const series = new Map(Array.from({ length: 8 }, (_, k) => [`T${k}USDT`, v1] as const));
    const market = new ReplayMarketData(series);
    const barTime = v1[signal.entryIndex].time * 1000;
    market.current = barTime;
    const store = new BotStore(":memory:");
    const cfg = { ...loadConfig({ MAX_RISK_PER_BAR: "0.05" }), minLiquidity30d: 0, minBreadth: 1 };
    const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => barTime + BAR_MS, noRisk);
    const report = await engine.runCycle(barTime);
    assert.equal(report.breadth, 8);
    assert.equal(store.openPositions().length, 5); // 5 × 1% = the 5% cap
    assert.equal(report.skipped.filter((x) => /per-bar risk cap/.test(x)).length, 3);
  });

  it("keeps one position per pair across setups", async () => {
    const store = new BotStore(":memory:");
    store.insertPosition({ setup: "v1", symbol: "TESTUSDT", signalTime: 1, qty: 1, entryPrice: 1, entryFee: 0, cost: 1, stopPrice: 0.85, stopOrderId: null, openedAt: 1 });
    const market = new ReplayMarketData(new Map([["TESTUSDT", bars]]));
    const t = bars[breakout.entryIndex].time * 1000;
    market.current = t;
    const engine = new BotEngine(cfgA, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => t + BAR_MS, noRisk);
    await engine.runCycle(t);
    assert.equal(store.openPositions().length, 1);
    assert.equal(store.openPositions()[0].setup, "v1");
  });
});

describe("entry improvements", () => {
  const base = syntheticSeries(1500, 7);
  const first = runSetupA(base, BAR_MS).trades[0];
  const bars = base.map((c, i) => (i > first.entryIndex - 6 && i <= first.entryIndex ? { ...c, volume: c.volume * 3 } : c));
  // BTC that outran the pair by far (the pair lagged → passes) and BTC identical to it (rs 0 → filtered).
  const strongBtc = bars.map((c, i) => ({ ...c, close: c.close * 1.004 ** i, open: c.open * 1.004 ** i, high: c.high * 1.004 ** i, low: c.low * 1.004 ** i }));

  it("Setup A's relative-strength filter only changes which breakouts pass, never the trade sequence", () => {
    const plain = runSetupA(bars, BAR_MS);
    const lagging = runSetupA(bars, BAR_MS, { btc: strongBtc, maxRs: -0.1 });
    const same = runSetupA(bars, BAR_MS, { btc: bars, maxRs: -0.1 });
    assert.deepEqual(lagging.trades.map((t) => t.entryIndex), plain.trades.map((t) => t.entryIndex));
    const t = lagging.trades.find((x) => x.entryIndex === first.entryIndex)!;
    assert.ok(t.rs !== null && t.rs < -0.1 && t.passes);
    const u = same.trades.find((x) => x.entryIndex === first.entryIndex)!;
    assert.ok(Math.abs(u.rs!) < 1e-12 && !u.passes);
    assert.ok(runSetupA(bars, BAR_MS, { maxRs: -0.1 }).trades.every((x) => x.rs === null && !x.passes), "no BTC → nothing passes the RS filter");
  });

  it("the bot skips a breakout of a coin that did not lag BTC, and takes it when it did", async () => {
    const at = bars[first.entryIndex].time * 1000;
    for (const [btc, expected] of [[bars, 0], [strongBtc, 1]] as const) {
      const market = new ReplayMarketData(new Map([["TESTUSDT", bars], ["BTCUSDT", btc]]));
      market.current = at;
      const store = new BotStore(":memory:");
      const cfg = { ...loadConfig({ SETUPS: "a", A_MAX_RS: "-0.1" }), minLiquidity30d: 0 };
      const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => at + BAR_MS, noRisk);
      await engine.runCycle(at);
      assert.equal(store.openPositions().filter((p) => p.symbol === "TESTUSDT").length, expected);
    }
  });

  it("with first dot only, breadth still counts every v1 signal (as in the research)", async () => {
    // A pair whose signal is a second dot, next to pairs whose signal is a first dot, on the same bar.
    const v1 = syntheticSeries(1500, 7);
    const all = runSetupV1(v1, { stoch: "either", intervalMs: BAR_MS }).trades;
    const firsts = new Set(runSetupV1(v1, { stoch: "either", intervalMs: BAR_MS, firstDotOnly: true }).trades.map((t) => t.entryIndex));
    const later = all.find((t) => !firsts.has(t.entryIndex));
    if (!later) return; // the fixture has no second-dot signal
    const at = v1[later.entryIndex].time * 1000;
    const market = new ReplayMarketData(new Map(Array.from({ length: 3 }, (_, k) => [`T${k}USDT`, v1] as const)));
    market.current = at;
    const store = new BotStore(":memory:");
    const cfg = { ...loadConfig({ V1_FIRST_DOT_ONLY: "1" }), minLiquidity30d: 0, minBreadth: 3 };
    const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => at + BAR_MS, noRisk);
    const report = await engine.runCycle(at);
    assert.ok(report.breadth >= 3, "the second-dot signals count toward breadth");
  });
  it("the spike trail only ever tightens the chandelier, so a trade never exits later", () => {
    const plain = runSetupA(base, BAR_MS);
    const tight = runSetupA(base, BAR_MS, { spikeTighten: { range: 3, k: 4 } });
    assert.ok(tight.trades.length >= plain.trades.length);
    const first = tight.trades[0];
    const same = plain.trades.find((t) => t.entryIndex === first.entryIndex)!;
    assert.ok(first.exitIndex! <= same.exitIndex!);
    for (let j = 0; j < first.trail.length; j++) assert.ok(first.trail[j] >= same.trail[j] - 1e-9);
    assert.equal(loadConfig({}).spikeTightenA, false);
    assert.equal(loadConfig({ A_SPIKE_TIGHTEN: "1" }).spikeTightenA, true);
  });
  it("first dot only drops second dots of a drop and keeps the rest of the sequence valid", () => {
    const all = runSetupV1(base, { stoch: "either", intervalMs: BAR_MS });
    const firsts = runSetupV1(base, { stoch: "either", intervalMs: BAR_MS, firstDotOnly: true });
    assert.ok(firsts.trades.length > 0 && firsts.trades.length <= all.trades.length);
  });
});

describe("Binance warnings (delisting, Monitoring)", () => {
  const bars = syntheticSeries(1500, 7);
  const fresh = runSetupV1(bars, { stoch: "either", intervalMs: BAR_MS }).trades[0];
  const barTime = bars[fresh.entryIndex].time * 1000;
  const market = new ReplayMarketData(new Map([["TESTUSDT", bars]]));
  market.current = barTime;
  const cfg = { ...loadConfig({}), minLiquidity30d: 0, minBreadth: 1 };
  const lists = (delist: string[], monitoring: string[]): (() => Promise<RiskList>) => async () => ({
    delist: new Map(delist.map((s) => [s, Date.UTC(2030, 0, 1, 3)])), monitoring: new Set(monitoring), fetchedAt: 1, source: { delist: "schedule", monitoring: true },
  });

  for (const [name, risk, why] of [
    ["delisting", lists(["TESTUSDT"], []), /delists it/],
    ["Monitoring tag", lists([], ["TESTUSDT"]), /Monitoring/],
  ] as const) {
    it(`takes no entry on a pair with a ${name}`, async () => {
      const store = new BotStore(":memory:");
      const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => barTime + BAR_MS, risk);
      const report = await engine.runCycle(barTime);
      assert.equal(store.openPositions().length, 0);
      assert.match(report.skipped.join(" "), why);
    });
  }

  it("sells a held position once its delisting is announced; only warns once on a Monitoring tag", async () => {
    const store = new BotStore(":memory:");
    let risk = lists([], []);
    const sent: string[] = [];
    const engine = new BotEngine(cfg, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async (t) => void sent.push(t) }, () => barTime + BAR_MS, () => risk());
    await engine.runCycle(barTime);
    assert.equal(store.openPositions().length, 1);
    risk = lists([], ["TESTUSDT"]);
    const r1 = await engine.runCycle(barTime);
    const r2 = await engine.runCycle(barTime);
    assert.equal(r1.warnings.length, 1);
    assert.equal(r2.warnings.length, 0, "the Monitoring warning is sent once");
    assert.equal(store.openPositions().length, 1, "a Monitoring tag alone does not sell");
    risk = lists(["TESTUSDT"], ["TESTUSDT"]);
    const r3 = await engine.runCycle(barTime);
    assert.equal(store.openPositions().length, 0);
    assert.equal(store.closedPositions()[0].exitReason, "delist");
    assert.match(r3.warnings.join(" "), /delists it/);
    assert.ok(sent.some((t) => t.includes("🚩")), "warnings reach Telegram");
  });

  it("reads token delistings from Binance's announcement titles", () => {
    const now = Date.UTC(2026, 7, 21);
    const m = parseDelistTitles(
      [
        { title: "Binance Will Delist ICX, SCRT, STORJ on 2026-09-03", releaseDate: Date.UTC(2026, 7, 20) },
        { title: "Binance Will Delist COS, D, HIGH, MBOX on 2026-06-19", releaseDate: Date.UTC(2026, 5, 5) }, // past
        { title: "Binance Futures Will Delist Multiple Perpetual Contracts", releaseDate: Date.UTC(2026, 7, 20) },
      ],
      now,
    );
    assert.deepEqual([...m.keys()].sort(), ["ICXUSDT", "SCRTUSDT", "STORJUSDT"]);
    assert.equal(m.get("ICXUSDT"), Date.UTC(2026, 8, 3, 3));
  });
});

describe("a stop that ends without filling (cancelled, expired, unknown)", () => {
  const fill = (qty: number, price: number): Fill => ({ qty, price, fee: 0, quote: qty * price, orderId: "x" });
  function setup(o: { status: StopStatus; holding: number; price: number; placeFails?: boolean }) {
    const store = new BotStore(":memory:");
    const pos = store.insertPosition({ setup: "a", symbol: "TESTUSDT", signalTime: 1, qty: 10, entryPrice: 100, entryFee: 0, cost: 1000, stopPrice: 80, stopOrderId: "1", openedAt: 1 });
    const sold: number[] = [];
    const placed: number[] = [];
    const sent: string[] = [];
    const broker: Broker = {
      kind: "live",
      ...noLimits,
      cash: async () => 0,
      holding: async () => o.holding,
      rules: async () => ({ ok: true, minNotional: 5 }),
      buy: async () => fill(0, 0),
      sell: async (_s, q, p) => (sold.push(q), fill(q, p)),
      placeStop: async (_s, q) => {
        if (o.placeFails) throw new Error("Stop price would trigger immediately");
        placed.push(q);
        return "2";
      },
      cancelStop: async () => {},
      stopStatus: async () => o.status,
    };
    const market = { universe: async () => [], closedBars: async () => null, price: async () => o.price };
    const engine = new BotEngine(loadConfig({ SETUPS: "a" }), store, market, broker, { send: async (t) => void sent.push(t) }, () => 2, noRisk);
    return { store, pos, sold, placed, sent, engine };
  }

  it("cancelled outside the bot, price above the stop: the stop is placed again", async () => {
    const t = setup({ status: { state: "gone", status: "CANCELED", fill: null }, holding: 10, price: 95 });
    await t.engine.reconcile();
    assert.deepEqual(t.placed, [10]);
    assert.equal(t.store.openPositions()[0]?.stopOrderId, "2");
    assert.match(t.sent.join(" "), /canceled outside the bot — placed again/);
  });

  it("cancelled, and the price is already under the stop: sold at market", async () => {
    const t = setup({ status: { state: "gone", status: "CANCELED", fill: null }, holding: 10, price: 75 });
    await t.engine.reconcile();
    assert.deepEqual(t.sold, [10]);
    assert.equal(t.store.closedPositions()[0].exitReason, "stop");
  });

  it("expired after a partial fill: the rest is sold and both legs are booked", async () => {
    const t = setup({ status: { state: "gone", status: "EXPIRED", fill: fill(6, 79) }, holding: 4, price: 78 });
    await t.engine.reconcile();
    assert.deepEqual(t.sold, [4]);
    const done = t.store.closedPositions()[0];
    assert.equal(done.exitReason, "stop");
    assert.ok(Math.abs(done.proceeds! - (6 * 79 + 4 * 78)) < 1e-9);
  });

  it("the stop cannot rest again: sold rather than left unprotected", async () => {
    const t = setup({ status: { state: "gone", status: "CANCELED", fill: null }, holding: 10, price: 95, placeFails: true });
    await t.engine.reconcile();
    assert.deepEqual(t.sold, [10]);
    assert.equal(t.store.openPositions().length, 0);
  });

  it("unknown order and no coins left: booked as a sale by hand", async () => {
    const t = setup({ status: { state: "gone", status: "UNKNOWN", fill: null }, holding: 0, price: 95 });
    await t.engine.reconcile();
    assert.equal(t.store.closedPositions()[0].exitReason, "manual");
  });

  it("the Binance broker reads cancelled, filled and unknown stops", async () => {
    for (const [reply, expected] of [
      [{ status: 200, body: { orderId: 7, status: "CANCELED", executedQty: "0", cummulativeQuoteQty: "0" } }, "gone"],
      [{ status: 200, body: { orderId: 7, status: "NEW", executedQty: "0", cummulativeQuoteQty: "0" } }, "resting"],
      [{ status: 400, body: { code: -2013, msg: "Order does not exist." } }, "gone"],
    ] as const) {
      const fetchImpl = mockFetch((url) => {
        if (url.pathname === "/api/v3/time") return { status: 200, body: { serverTime: Date.now() } };
        if (url.pathname === "/api/v3/order") return reply;
        return { status: 404, body: {} };
      }, []);
      const broker = new BinanceSpotBroker("live", new BinanceSpotClient("https://t", "k", "s", fetchImpl));
      assert.equal((await broker.stopStatus("SOLUSDT", "7")).state, expected);
    }
  });
});

describe("daily report", () => {
  it("says the bot is alive, flags missing cycles and errors, and reads the collector", async () => {
    const fsm = await import("node:fs");
    const os = await import("node:os");
    const pathm = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const now = Date.UTC(2026, 9, 6, 1);
    const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), "collector-"));
    const db = new Database(pathm.join(dir, "collector-2026-10.sqlite"));
    db.exec("CREATE TABLE liquidations (time INTEGER, symbol TEXT, side TEXT, price REAL, qty REAL, quote REAL); CREATE TABLE depth (time INTEGER, symbol TEXT, mid REAL, spread REAL)");
    db.prepare("INSERT INTO liquidations VALUES (?, 'BTCUSDT', 'long', 1, 1, 2000000)").run(now - 3_600_000);
    db.prepare("INSERT INTO depth (time, symbol, mid, spread) VALUES (?, 'BTCUSDT', 1, 0)").run(now - 2 * 60_000);
    db.close();
    process.env.COLLECTOR_DIR = dir;
    try {
      const store = new BotStore(":memory:");
      store.insertPosition({ setup: "a", symbol: "TESTUSDT", signalTime: 1, qty: 10, entryPrice: 100, entryFee: 0, cost: 1000, stopPrice: 80, stopOrderId: null, openedAt: now - 3_600_000 });
      for (let k = 0; k < 3; k++) store.log("info", "cycle", "bar", now - k * 4 * 3_600_000);
      store.log("error", "cycle", "boom", now - 600_000);
      const market = { universe: async () => [], closedBars: async () => null, price: async () => 110 };
      const engine = new BotEngine(loadConfig({ SETUPS: "a" }), store, market, new PaperBroker(store, 1000, 0.001, 0), { send: async () => {} }, () => now, noRisk);
      const text = await dailyReport(engine, null, now);
      assert.match(text, /Daily report/);
      assert.match(text, /only 3 of 6 cycles/);
      assert.match(text, /1 error\(s\).*boom/);
      assert.match(text, /\[A\] TESTUSDT \+10\.00%/);
      assert.match(text, /Collector 24h: 1 liquidations \(2\.0M USDT\) · 1 depth rows · last 2 min ago/);
      assert.doesNotMatch(text, /<(?!\/?b>)/, "only <b> tags: Telegram parses HTML");
    } finally {
      delete process.env.COLLECTOR_DIR;
      fsm.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("entry traits", () => {
  const bar = (time: number, close: number, high = close, low = close): Candle => ({ time: time as Candle["time"], open: close, high, low, close, volume: 1, buyVolume: 0.5 });
  it("tags by the locked thresholds, unknown when the value is missing", () => {
    const t = { range20: 0.1, funding: 0.0001, basis: null, oi7: -0.2, ageDays: 100, breadthDD: 0.7, btcTrend: 0.2 };
    assert.deepEqual(tagsOf("a", t).map((x) => x.on), [true, true, null]);
    assert.deepEqual(tagsOf("v1", t).map((x) => x.on), [true, true, false, false]);
  });
  it("measures the base and the market's drawdown from the bars before", () => {
    const flat = Array.from({ length: 121 }, (_, i) => bar(i, 100, 105, 95));
    assert.ok(Math.abs(range20(flat)! - 0.1) < 1e-12);
    assert.equal(range20(flat.slice(1)), null);
    const fell = [...Array.from({ length: 180 }, (_, i) => bar(i, 100)), bar(180, 69)];
    const held = [...Array.from({ length: 180 }, (_, i) => bar(i, 100)), bar(180, 90)];
    assert.equal(breadthDD([fell, held, held.slice(1)]), 0.5);
  });
  it("compares closed trades with and without each trait, in R", () => {
    const store = new BotStore(":memory:");
    const open = (symbol: string, traits: Parameters<BotStore["setTraits"]>[1], exit: number) => {
      const p = store.insertPosition({ setup: "a", symbol, signalTime: 1, qty: 1, entryPrice: 100, entryFee: 0, cost: 100, stopPrice: 80, stopOrderId: null, openedAt: 1 });
      store.setTraits(p.id, traits);
      store.closePosition(p.id, { price: exit, fee: 0, proceeds: exit, reason: "trail", time: 2 });
    };
    const base = { funding: null, basis: null, oi7: null, ageDays: null, breadthDD: null, btcTrend: null };
    open("AUSDT", { ...base, range20: 0.1 }, 140); // +2R
    open("BUSDT", { ...base, range20: 0.3 }, 90); // −0.5R
    const text = traitCheck(store.closedPositions()).join("\n");
    assert.match(text, /tight base 2\.00R \(1\) │ -0\.50R \(1\)/);
    assert.match(text, /funding up – \(0\) │ – \(0\)/);
  });
});

describe("setup Z (demand-zone add-on, paper)", () => {
  const bar = (i: number, close: number, open = close): Candle => ({ time: (i * 14_400) as Candle["time"], open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1, buyVolume: 0.5 });
  it("picks the nearest zone 2–10% under the close, its stop 0.5% under the zone's low", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const close = i < 151 ? 100 : i <= 154 ? 100 + 2 * (i - 150) : 105; // a +8% rally from bar 150 within 4 bars
      c.push(bar(i, close));
    }
    assert.deepEqual(zoneOrder(c, 199), { level: 100, stop: 99 * 0.995 });
    // the zone is 4.8% under 105: none when the close is barely above it, or far above it
    assert.equal(zoneOrder([...c.slice(0, 199), bar(199, 101)], 199), null);
    assert.equal(zoneOrder([...c.slice(0, 199), bar(199, 120)], 199), null);
  });
  it("runs next to Setup v1, off unless switched on", () => {
    assert.equal(loadConfig({}).zAddon, false);
    assert.equal(loadConfig({ Z_ADDON: "1" }).zAddon, true);
    assert.equal(loadConfig({ Z_ADDON: "1", MODE: "testnet", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }).zAddon, true);
    assert.throws(() => loadConfig({ Z_ADDON: "1", SETUPS: "a" }), /needs Setup v1/);
  });

  const bars = syntheticSeries(1500, 7);
  const v1 = runSetupV1(bars, { stoch: "either", intervalMs: BAR_MS }).trades.find((t) => t.exitIndex! - t.entryIndex >= 4)!;
  const at = (i: number) => bars[i].time * 1000;
  const cfgZ = { ...loadConfig({ Z_ADDON: "1" }), minLiquidity30d: 0, minBreadth: 1 };
  const run = async (level: (s: number) => { level: number; stop: number } | null) => {
    const market = new ReplayMarketData(new Map([["TESTUSDT", bars]]));
    const store = new BotStore(":memory:");
    let clock = 0;
    const engine = new BotEngine(cfgZ, store, market, new PaperBroker(store, 10_000, 0.001, 0), { send: async () => {} }, () => clock, noRisk);
    for (let i = v1.entryIndex; i <= v1.exitIndex!; i++) {
      market.current = at(i);
      clock = at(i) + BAR_MS;
      await engine.runCycle(at(i));
      if (i === v1.entryIndex) {
        const [parent] = store.openPositions();
        const order = level(v1.entryIndex);
        // the test sets the resting limit itself (the zone rule is covered above)
        store.delete(`z_pending:${parent.id}`);
        if (order) store.set(`z_pending:${parent.id}`, JSON.stringify({ symbol: "TESTUSDT", ...order, after: at(i) }));
      }
    }
    return store;
  };

  it("fills the limit from the bars, then closes with its v1 position", async () => {
    const f = v1.entryIndex + 1;
    let low = Infinity;
    for (let k = f; k <= v1.exitIndex!; k++) low = Math.min(low, bars[k].low);
    const level = bars[f].low + (bars[f].high - bars[f].low) * 0.5;
    const store = await run(() => ({ level, stop: Math.min(low * 0.99, level * 0.95) }));
    const z = store.closedPositions().find((p) => p.setup === "z");
    assert.ok(z, "a Z position was opened and closed");
    assert.equal(z.signalTime, at(f));
    assert.ok(Math.abs(z.entryPrice - Math.min(bars[f].open, level)) < 1e-9);
    assert.equal(z.exitReason, "signal");
    assert.equal(z.closedAt, store.closedPositions().find((p) => p.setup === "v1")!.closedAt);
    assert.equal(store.withPrefix("z_pending:").length, 0);
  });

  it("cancels a limit that never filled when its v1 position closes", async () => {
    const store = await run(() => ({ level: 1e-6, stop: 0.9e-6 }));
    assert.equal(store.closedPositions().filter((p) => p.setup === "z").length, 0);
    assert.equal(store.withPrefix("z_pending:").length, 0);
  });
});

describe("cycle schedule", () => {
  const bar = Date.UTC(2026, 9, 15, 12); // a 4h bar's open
  it("runs each bar once, after its close and the settle delay", () => {
    const now = bar + BAR_MS + SETTLE_MS + 5_000; // just after the 12:00 bar closed and settled
    assert.equal(lastClosedBar(now), bar);
    assert.equal(nextRunAt(now), bar + 2 * BAR_MS + SETTLE_MS); // the 16:00 bar's turn
  });
  it("processes the scheduled bar even when the timer fires a little early", () => {
    const due = nextRunAt(bar + BAR_MS + SETTLE_MS + 5_000);
    // fired 3 ms early: recomputing from the clock alone would give the 12:00 bar again (Oct 2026: bars run twice, the next one skipped)
    assert.equal(lastClosedBar(due - 3), bar);
    assert.equal(barDue(due, due - 3), bar + BAR_MS);
    assert.equal(barDue(due, due + 60_000), bar + BAR_MS);
  });
});

describe("setup Z on an exchange (limit orders)", () => {
  /** A fake exchange: a scripted limit order, stops that rest, market orders that fill at the reference price. */
  function exchange(limit: { state: "open" | "done"; status: string; fill: Fill | null }, opts: { stopFails?: boolean; afterCancel?: { state: "open" | "done"; status: string; fill: Fill | null } } = {}) {
    const log: string[] = [];
    let current = limit;
    // Binance: newClientOrderId must match ^[.A-Z:/a-z0-9_-]{1,36}$
    const valid = (id: string) => {
      if (!/^[.A-Za-z0-9:/_-]{1,36}$/.test(id)) throw new Error(`invalid client order id ${id}`);
    };
    const broker: Broker = {
      kind: "testnet",
      cash: async () => 1000,
      lockedCash: async () => 25,
      holding: async () => 1e9,
      rules: async () => ({ ok: true, minNotional: 5, stepSize: 0.01 }),
      buy: async (_s, q, p) => ({ qty: q / p, price: p, fee: 0, quote: q, orderId: "b" }),
      sell: async (_s, q, p, c) => {
        valid(c);
        log.push(`sell ${q} ${c}`);
        return { qty: q, price: p, fee: 0, quote: q * p, orderId: "x" };
      },
      placeStop: async (_s, q, p, c) => {
        valid(c);
        if (opts.stopFails) throw new Error("rejected");
        log.push(`stop ${q} @ ${p}`);
        return `S${log.length}`;
      },
      cancelStop: async (_s, id) => {
        log.push(`cancel ${id}`);
        if (id === "L1" && opts.afterCancel) current = opts.afterCancel;
      },
      stopStatus: async () => ({ state: "resting" }),
      placeLimitBuy: async (_s, q, p, c) => {
        valid(c);
        log.push(`limit ${q} @ ${p}`);
        return "L1";
      },
      limitStatus: async () => current,
    };
    return { broker, log };
  }
  const market = new ReplayMarketData(new Map([["TESTUSDT", syntheticSeries(300, 3)]]));
  market.current = Number.MAX_SAFE_INTEGER;
  const cfg = { ...loadConfig({ Z_ADDON: "1", MODE: "testnet", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }), minLiquidity30d: 0 };
  const setup = (broker: Broker) => {
    const store = new BotStore(":memory:");
    const engine = new BotEngine(cfg, store, market, broker, { send: async () => {} }, () => Date.UTC(2026, 9, 16), noRisk);
    const parent = store.insertPosition({ setup: "v1", symbol: "TESTUSDT", signalTime: Date.UTC(2026, 9, 15, 12), qty: 3, entryPrice: 12, entryFee: 0, cost: 36, stopPrice: 10.2, stopOrderId: "P", openedAt: 1 });
    store.set(`z_pending:${parent.id}`, JSON.stringify({ symbol: "TESTUSDT", level: 11, stop: 10.5, after: 0, orderId: "L1" }));
    return { store, engine, parent };
  };
  const filled: Fill = { qty: 2, price: 11, fee: 0.02, quote: 22.02, orderId: "L1" };

  it("a filled limit becomes a position with its stop resting at once", async () => {
    const { broker, log } = exchange({ state: "done", status: "FILLED", fill: filled });
    const { store, engine } = setup(broker);
    await engine.reconcile();
    const z = store.openPositions().find((p) => p.setup === "z");
    assert.ok(z && z.qty === 2 && z.entryPrice === 11 && z.stopPrice === 10.5 && z.stopOrderId);
    assert.deepEqual(log, ["stop 2 @ 10.5"]);
    assert.equal(store.withPrefix("z_pending:").length, 0);
  });

  it("keeps waiting while the limit rests, and counts its USDT as equity", async () => {
    const { broker, log } = exchange({ state: "open", status: "NEW", fill: null });
    const { store, engine } = setup(broker);
    await engine.reconcile();
    assert.equal(store.withPrefix("z_pending:").length, 1);
    assert.deepEqual(log, []);
    const { equity, cash } = await engine.account();
    assert.equal(cash, 1000);
    assert.ok(equity >= 1025, "free + locked + the v1 position");
  });

  it("cancels the limit when its v1 position closes, and sells what it had bought", async () => {
    const part: Fill = { qty: 1, price: 11, fee: 0.01, quote: 11.01, orderId: "L1" };
    const { broker, log } = exchange({ state: "open", status: "PARTIALLY_FILLED", fill: part }, { afterCancel: { state: "done", status: "CANCELED", fill: part } });
    const { store, engine, parent } = setup(broker);
    store.closePosition(parent.id, { price: 12.5, fee: 0, proceeds: 37.5, reason: "signal", time: 2 });
    await engine.reconcile();
    assert.equal(log[0], "cancel L1");
    assert.match(log[1], /^sell 1 svz-/);
    const z = store.closedPositions().find((p) => p.setup === "z");
    assert.ok(z && z.exitReason === "signal");
    assert.equal(store.withPrefix("z_pending:").length, 0);
  });

  it("drops a limit that ended unfilled", async () => {
    const { broker } = exchange({ state: "done", status: "EXPIRED", fill: null });
    const { store, engine } = setup(broker);
    await engine.reconcile();
    assert.equal(store.withPrefix("z_pending:").length, 0);
    assert.equal(store.openPositions().filter((p) => p.setup === "z").length, 0);
  });

  it("never holds a Z position without its stop", async () => {
    const { broker, log } = exchange({ state: "done", status: "FILLED", fill: filled }, { stopFails: true });
    const { store, engine } = setup(broker);
    await engine.reconcile();
    assert.match(log[0], /^sell 2 svz-.*-f$/);
    assert.equal(store.openPositions().filter((p) => p.setup === "z").length, 0);
  });

  it("follows its v1 position when that one is stopped between bars", async () => {
    const { broker, log } = exchange({ state: "done", status: "FILLED", fill: filled });
    const { store, engine, parent } = setup(broker);
    await engine.reconcile(); // the Z position opens with its stop
    store.closePosition(parent.id, { price: 10.2, fee: 0, proceeds: 30.6, reason: "stop", time: 3 });
    await engine.reconcile();
    const z = store.closedPositions().find((p) => p.setup === "z");
    assert.ok(z && z.exitReason === "signal", "out with its v1 position");
    assert.ok(log.some((l) => l.startsWith("cancel S")), "its stop cancelled first");
  });

  it("builds valid order ids even from a signal time that is not a whole second", async () => {
    const { broker, log } = exchange({ state: "done", status: "FILLED", fill: filled });
    const store = new BotStore(":memory:");
    const engine = new BotEngine(cfg, store, market, broker, { send: async () => {} }, () => 0, noRisk);
    const parent = store.insertPosition({ setup: "v1", symbol: "TESTUSDT", signalTime: Date.UTC(2026, 9, 15, 12) + 7, qty: 3, entryPrice: 12, entryFee: 0, cost: 36, stopPrice: 10.2, stopOrderId: "P", openedAt: 1 });
    store.set(`z_pending:${parent.id}`, JSON.stringify({ symbol: "TESTUSDT", level: 11, stop: 10.5, after: 0, orderId: "L1" }));
    await engine.reconcile();
    assert.ok(store.openPositions().find((p) => p.setup === "z")?.stopOrderId, "the stop was accepted");
    assert.deepEqual(log, ["stop 2 @ 10.5"]);
  });

  it("places a missing stop on reconcile, and sells when it cannot", async () => {
    const { broker, log } = exchange({ state: "done", status: "NONE", fill: null });
    const store = new BotStore(":memory:");
    const engine = new BotEngine(cfg, store, market, broker, { send: async () => {} }, () => 0, noRisk);
    const p = store.insertPosition({ setup: "v1", symbol: "TESTUSDT", signalTime: Date.UTC(2026, 9, 15, 12), qty: 2, entryPrice: 11, entryFee: 0, cost: 22, stopPrice: 10.5, stopOrderId: null, openedAt: 1 });
    await engine.reconcile();
    assert.ok(store.position(p.id)?.stopOrderId, "placed");
    assert.deepEqual(log, ["stop 2 @ 10.5"]);
    const { broker: failing, log: log2 } = exchange({ state: "done", status: "NONE", fill: null }, { stopFails: true });
    const store2 = new BotStore(":memory:");
    const engine2 = new BotEngine(cfg, store2, market, failing, { send: async () => {} }, () => 0, noRisk);
    const q = store2.insertPosition({ setup: "v1", symbol: "TESTUSDT", signalTime: Date.UTC(2026, 9, 15, 12), qty: 2, entryPrice: 11, entryFee: 0, cost: 22, stopPrice: 10.5, stopOrderId: null, openedAt: 1 });
    await engine2.reconcile();
    assert.equal(store2.position(q.id)?.status, "closed");
    assert.match(log2[0], /^sell 2 /);
  });

  it("flatten cancels the resting limits", async () => {
    const { broker, log } = exchange({ state: "open", status: "NEW", fill: null });
    const { store, engine } = setup(broker);
    await engine.flatten("test");
    assert.ok(log.includes("cancel L1"));
    assert.equal(store.withPrefix("z_pending:").length, 0);
  });
});

describe("deposits and withdrawals", () => {
  it("keep the daily loss limit and the report apart from the results", async () => {
    const cfg = loadConfig({});
    const store = new BotStore(":memory:");
    const risk = new RiskGate(cfg, store);
    const now = Date.UTC(2026, 9, 16, 10);
    assert.equal(risk.withinDailyLoss(100, now), true); // the day starts at 100
    store.addFlow(now, -20, "to the BTC wallet");
    assert.equal(risk.withinDailyLoss(80, now), true, "a withdrawal is not a loss");
    store.addFlow(now, 50);
    assert.equal(risk.withinDailyLoss(124, now), false, "a deposit does not hide a 6% loss");
    assert.equal(store.netFlows(), 30);
  });
  it("move the paper cash and show up in the report", async () => {
    const store = new BotStore(":memory:");
    const engine = new BotEngine(loadConfig({ PAPER_START_EQUITY: "100" }), store, new ReplayMarketData(new Map()), new PaperBroker(store, 100, 0.001, 0), { send: async () => {} }, () => Date.UTC(2026, 9, 16), noRisk);
    await engine.recordFlow(400, "top-up");
    assert.equal((await engine.account()).equity, 500);
    const text = await dailyReport(engine, null, Date.UTC(2026, 9, 16));
    assert.match(text, /since start \+0\.00%/);
    assert.match(text, /net deposits \+400\.00/);
  });
});
