import { SETUP_V1, isFreshEntry, liquidity30d, runSetupV1, type SetupResult } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import type { Broker } from "./broker";
import type { BotConfig } from "./config";
import type { BotStore, ExitReason, Position } from "./db";
import { BAR_MS, type MarketData, type PairInfo } from "./market";
import { RiskGate, sizePosition } from "./risk";

/**
 * The bot: once per closed 4h bar it runs Setup v1 (the same engine as the research,
 * the chart and the scanner) over every pair, manages what it holds, then takes fresh
 * entries that pass the risk gates. Between bars, `reconcile` follows the stops that
 * rest on the exchange.
 *
 * Idempotent by construction: an entry is keyed by (symbol, signal bar) and never
 * repeated; a position is closed once. Re-running a cycle after a crash is safe.
 */

export interface Notifier {
  send(text: string): Promise<void>;
}

export interface CycleReport {
  barTime: number;
  evaluated: number;
  /** Pairs with a fresh Setup v1 signal on this bar (before filters). */
  breadth: number;
  entries: string[];
  exits: string[];
  skipped: string[];
  errors: string[];
}

interface Evaluation {
  pair: PairInfo;
  bars: Candle[];
  result: SetupResult;
}

const CONCURRENCY = 4;

/** Binance client order id: ≤ 36 chars of [A-Za-z0-9-_]. */
const clientId = (symbol: string, signalTime: number, step: "e" | "s" | "x" | "f") => `sv1-${symbol}-${(signalTime / 1000).toString(36)}-${step}`;

const fmt = (v: number) => (v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const pct = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export class BotEngine {
  readonly risk: RiskGate;

  constructor(
    readonly cfg: BotConfig,
    readonly store: BotStore,
    private readonly market: MarketData,
    readonly broker: Broker,
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
  ) {
    this.risk = new RiskGate(cfg, store);
  }

  /* ───────────────────────────── the 4h cycle ───────────────────────────── */

  async runCycle(barTime: number): Promise<CycleReport> {
    const report: CycleReport = { barTime, evaluated: 0, breadth: 0, entries: [], exits: [], skipped: [], errors: [] };
    const held = this.store.openPositions();
    const universe = await this.market.universe();
    const heldSymbols = new Set(held.map((p) => p.symbol));
    // Held pairs that left the universe (delisted, renamed) are still evaluated.
    const pairs = [...universe, ...held.filter((p) => !universe.some((u) => u.symbol === p.symbol)).map((p) => ({ symbol: p.symbol, base: p.symbol.replace(/USDT$/, ""), precision: 8 }))];

    const evals = new Map<string, Evaluation>();
    await mapLimit(pairs, CONCURRENCY, async (pair) => {
      const position = held.find((p) => p.symbol === pair.symbol);
      // A held position needs bars back to its signal; a fresh scan needs the warm-up.
      const minBars = position ? Math.ceil((barTime - position.signalTime) / BAR_MS) + SETUP_V1.warmup + 5 : SETUP_V1.warmup + 2;
      try {
        const bars = await this.market.closedBars(pair.symbol, barTime, minBars);
        if (!bars || bars.length < SETUP_V1.warmup + 2) return;
        evals.set(pair.symbol, { pair, bars, result: runSetupV1(bars, { stoch: this.cfg.stoch, intervalMs: BAR_MS }) });
      } catch (err) {
        if (heldSymbols.has(pair.symbol)) report.errors.push(`${pair.symbol}: ${(err as Error).message}`);
      }
    });
    report.evaluated = evals.size;

    for (const position of held) await this.manage(position, evals.get(position.symbol), report);
    await this.enter(barTime, evals, report);
    await this.markEquity(barTime + BAR_MS, evals);

    this.store.set("last_bar", String(barTime));
    this.store.log("info", "cycle", `bar ${new Date(barTime).toISOString()} · ${report.evaluated} pairs · breadth ${report.breadth} · ${report.entries.length} entries · ${report.exits.length} exits`, this.now());
    if (report.breadth) this.store.set("last_breadth", JSON.stringify({ barTime, breadth: report.breadth }));
    for (const e of report.errors) this.store.log("error", "cycle", e, this.now());
    if (report.entries.length || report.exits.length || report.errors.length) {
      await this.notify(
        [
          `<b>Setup v1 · ${this.broker.kind.toUpperCase()}</b> · 4h bar ${new Date(barTime + BAR_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`,
          ...report.entries.map((e) => `🟢 ${e}`),
          ...report.exits.map((e) => `🔴 ${e}`),
          ...report.errors.map((e) => `⚠️ ${e}`),
        ].join("\n"),
      );
    }
    return report;
  }

  /** Exit a held position when the setup has closed it. */
  private async manage(position: Position, ev: Evaluation | undefined, report: CycleReport): Promise<void> {
    if (!ev) {
      report.errors.push(`${position.symbol}: no data this bar — position kept, stop still resting`);
      return;
    }
    const closed = ev.result.trades.find((t) => t.entryTime === position.signalTime);
    if (!closed) {
      if (ev.result.open?.entryTime !== position.signalTime) report.errors.push(`${position.symbol}: setup has no record of this position — kept`);
      return;
    }
    if (this.broker.kind === "paper") {
      // Paper fills follow the bars, exactly as the backtest: the stop at its level, the signal at the close.
      const ref = closed.exitReason === "stop" ? Math.min(position.stopPrice, ev.bars[closed.exitIndex!].open) : closed.exitPrice!;
      await this.exit(position, ref, closed.exitReason === "stop" ? "stop" : "signal", report);
      return;
    }
    // Live: the stop rests on the exchange (reconcile records it); the signal exit sells at market.
    if (closed.exitReason === "signal") await this.exit(position, ev.bars[ev.bars.length - 1].close, "signal", report);
  }

  private async exit(position: Position, refPrice: number, reason: ExitReason, report: CycleReport): Promise<void> {
    try {
      if (position.stopOrderId) await this.broker.cancelStop(position.symbol, position.stopOrderId);
      const qty = this.broker.kind === "paper" ? position.qty : Math.min(position.qty, await this.broker.holding(position.symbol));
      const fill = await this.broker.sell(position.symbol, qty, refPrice, clientId(position.symbol, position.signalTime, "x"));
      const done = this.store.closePosition(position.id, { price: fill.price, fee: fill.fee, proceeds: fill.quote, reason, time: this.now() });
      report.exits.push(`${position.symbol} ${reason} @ ${fmt(fill.price)} · ${pct(done.pnl! / done.cost)} (${done.pnl! >= 0 ? "+" : ""}${done.pnl!.toFixed(2)} USDT)`);
    } catch (err) {
      report.errors.push(`${position.symbol}: exit failed — ${(err as Error).message}`);
    }
  }

  /** Fresh Setup v1 entries on this bar, most liquid first, through the v1.1 filters and the risk gates. */
  private async enter(barTime: number, evals: Map<string, Evaluation>, report: CycleReport): Promise<void> {
    const fresh = [...evals.values()]
      .filter((ev) => isFreshEntry(ev.result, ev.bars.length))
      .map((ev) => ({ ev, liquidity: liquidity30d(ev.bars, ev.bars.length - 1, BAR_MS) }))
      .sort((a, b) => b.liquidity - a.liquidity);
    report.breadth = fresh.length;
    if (!fresh.length) return;
    // v1.1: the edge is market-wide capitulation — isolated signals are skipped.
    if (fresh.length < this.cfg.minBreadth) {
      report.skipped.push(`breadth ${fresh.length} < ${this.cfg.minBreadth}: ${fresh.map((f) => f.ev.pair.symbol).join(", ")}`);
      return;
    }

    let { equity, cash } = await this.account(evals);
    const block = this.risk.entryBlock(equity, this.now());
    for (const { ev, liquidity } of fresh) {
      const symbol = ev.pair.symbol;
      const signal = ev.result.open!;
      if (block) {
        report.skipped.push(`${symbol}: ${block}`);
        continue;
      }
      if (this.store.hasSignal(symbol, signal.entryTime)) continue; // already acted on
      if (this.store.openPositions().some((p) => p.symbol === symbol)) continue;
      if (liquidity < this.cfg.minLiquidity30d) {
        report.skipped.push(`${symbol}: 30d liquidity ${(liquidity / 1e6).toFixed(2)}M < ${(this.cfg.minLiquidity30d / 1e6).toFixed(2)}M/day`);
        continue;
      }
      const rules = await this.broker.rules(symbol);
      if (!rules.ok) {
        report.skipped.push(`${symbol}: ${rules.reason}`);
        continue;
      }
      const size = sizePosition(this.cfg, { equity, cash, openPositions: this.store.openPositions().length, minNotional: rules.minNotional });
      if (!size.ok) {
        report.skipped.push(`${symbol}: ${size.reason}`);
        continue;
      }
      try {
        const close = ev.bars[ev.bars.length - 1].close;
        const fill = await this.broker.buy(symbol, size.quote, close, clientId(symbol, signal.entryTime, "e"));
        const stopPrice = fill.price * (1 - SETUP_V1.stopPct);
        let stopOrderId: string | null;
        try {
          stopOrderId = await this.broker.placeStop(symbol, fill.qty, stopPrice, clientId(symbol, signal.entryTime, "s"));
        } catch (err) {
          // Never hold a position without its stop: undo the entry.
          await this.broker.sell(symbol, fill.qty, close, clientId(symbol, signal.entryTime, "f")).catch(() => {});
          throw new Error(`stop could not be placed (${(err as Error).message}) — entry reversed`);
        }
        this.store.insertPosition({ symbol, signalTime: signal.entryTime, qty: fill.qty, entryPrice: fill.price, entryFee: fill.fee, cost: fill.quote, stopPrice, stopOrderId, openedAt: this.now() });
        cash -= fill.quote;
        report.entries.push(`${symbol} long @ ${fmt(fill.price)} · ${fill.quote.toFixed(2)} USDT · stop ${fmt(stopPrice)} (−15%)`);
      } catch (err) {
        report.errors.push(`${symbol}: entry failed — ${(err as Error).message}`);
      }
      equity = (await this.account(evals)).equity;
    }
  }

  /** Free cash plus open positions marked at their last close. */
  async account(evals?: Map<string, Evaluation>): Promise<{ equity: number; cash: number }> {
    const cash = await this.broker.cash();
    let value = 0;
    for (const p of this.store.openPositions()) {
      const bars = evals?.get(p.symbol)?.bars;
      const price = bars ? bars[bars.length - 1].close : await this.market.price(p.symbol).catch(() => p.entryPrice);
      value += p.qty * price;
    }
    return { equity: cash + value, cash };
  }

  private async markEquity(time: number, evals: Map<string, Evaluation>): Promise<void> {
    const { equity, cash } = await this.account(evals);
    this.store.recordEquity(time, equity, cash, this.store.openPositions().length);
  }

  /* ─────────────────────────── between bars ─────────────────────────── */

  /** Exchange modes: record stops that filled, and positions that vanished (sold by hand). */
  async reconcile(): Promise<void> {
    if (this.broker.kind === "paper") return;
    for (const p of this.store.openPositions()) {
      try {
        if (p.stopOrderId) {
          const fill = await this.broker.stopFill(p.symbol, p.stopOrderId);
          if (fill) {
            const done = this.store.closePosition(p.id, { price: fill.price, fee: fill.fee, proceeds: fill.quote, reason: "stop", time: this.now() });
            await this.notify(`🛑 ${p.symbol} stopped @ ${fmt(fill.price)} · ${pct(done.pnl! / done.cost)} (${done.pnl!.toFixed(2)} USDT)`);
            continue;
          }
        }
        const holding = await this.broker.holding(p.symbol);
        if (holding < p.qty * 0.05) {
          const price = await this.market.price(p.symbol).catch(() => p.entryPrice);
          this.store.closePosition(p.id, { price, fee: 0, proceeds: p.qty * price, reason: "manual", time: this.now() });
          this.store.log("warn", "reconcile", `${p.symbol}: no longer held on the exchange — marked closed (manual)`, this.now());
          await this.notify(`⚠️ ${p.symbol} is no longer held on the exchange — marked as closed manually`);
        }
      } catch (err) {
        this.store.log("error", "reconcile", `${p.symbol}: ${(err as Error).message}`, this.now());
      }
    }
  }

  /** Sell everything now (kill switch). New entries stay paused afterwards. */
  async flatten(reason: string): Promise<string[]> {
    this.risk.setPaused(true, `flatten: ${reason}`);
    const report: CycleReport = { barTime: 0, evaluated: 0, breadth: 0, entries: [], exits: [], skipped: [], errors: [] };
    for (const p of this.store.openPositions()) {
      const price = await this.market.price(p.symbol).catch(() => p.entryPrice);
      await this.exit(p, price, "flatten", report);
    }
    const lines = [...report.exits, ...report.errors];
    await this.notify(`⛔ Flattened (${reason})\n${lines.join("\n") || "nothing was open"}`);
    return lines;
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.notifier.send(text);
    } catch (err) {
      this.store.log("warn", "notify", (err as Error).message, this.now());
    }
  }
}
