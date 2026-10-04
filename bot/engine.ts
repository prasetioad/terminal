import { SETUP_A, runSetupA, type SetupAResult } from "../lib/setups/setupA";
import { SETUP_V1, isFreshEntry, liquidity30d, runSetupV1, type SetupResult } from "../lib/setups/setupV1";
import type { Candle } from "../lib/types";
import type { Broker } from "./broker";
import type { BotConfig, SetupId } from "./config";
import type { BotStore, ExitReason, Position } from "./db";
import { BAR_MS, type MarketData, type PairInfo } from "./market";
import { RiskGate, setupRules, sizePosition } from "./risk";

/**
 * The bot: once per closed 4h bar it runs its setups (the same engines as the research,
 * the chart and the scanner) over every pair, manages what it holds, then takes fresh
 * entries that pass the risk gates. Setup v1 (capitulation) and Setup A (breakout) share
 * one account and one position per pair, as in the research portfolio (docs/ROADMAP.md
 * §4.10). Between bars, `reconcile` follows the stops that rest on the exchange.
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
  /** Pairs with a fresh, volume-confirmed Setup A breakout on this bar (before filters). */
  breakouts: number;
  entries: string[];
  exits: string[];
  skipped: string[];
  errors: string[];
}

interface Evaluation {
  pair: PairInfo;
  bars: Candle[];
  result: SetupResult;
  /** Setup v1 without `firstDotOnly`: breadth counts every v1 signal (the market's capitulation), as in the research. */
  breadthResult: SetupResult;
  resultA: SetupAResult | null;
}

/** A fresh entry signal of one setup on the bar being processed. */
interface Candidate {
  setup: SetupId;
  ev: Evaluation;
  liquidity: number;
  signalTime: number;
  /** Fraction lost at the stop. */
  stopPct: number;
}

export const SETUP_LABEL: Record<SetupId, string> = { v1: "v1", a: "A" };
/** Human name of the configured setups, e.g. "Setups v1.2 + A". */
export const setupsName = (cfg: BotConfig) =>
  `Setup${cfg.setups.length > 1 ? "s" : ""} ${cfg.setups
    .map((s) =>
      s === "v1"
        ? `${cfg.maxRiskPerBar > 0 ? "v1.2" : "v1.1"}${cfg.firstDotOnly ? " (first dot)" : ""}`
        : `A${cfg.maxRsA !== null ? ` (RS below ${(cfg.maxRsA * 100).toFixed(0)}%)` : ""}`, // no "<": Telegram messages are HTML
    )
    .join(" + ")}`;

const CONCURRENCY = 4;

/** Binance client order id: ≤ 36 chars of [A-Za-z0-9-_]. Setup v1 keeps its original prefix. */
const clientId = (setup: SetupId, symbol: string, signalTime: number, step: "e" | "s" | "x" | "f") =>
  `${setup === "v1" ? "sv1" : "sva"}-${symbol}-${(signalTime / 1000).toString(36)}-${step}`;

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

  /** Setup v1 as configured, and the plain signal sequence breadth is counted on. */
  private evaluateV1(bars: Candle[]): { result: SetupResult; breadthResult: SetupResult } {
    const base = runSetupV1(bars, { stoch: this.cfg.stoch, intervalMs: BAR_MS });
    return { breadthResult: base, result: this.cfg.firstDotOnly ? runSetupV1(bars, { stoch: this.cfg.stoch, intervalMs: BAR_MS, firstDotOnly: true }) : base };
  }

  /* ───────────────────────────── the 4h cycle ───────────────────────────── */

  async runCycle(barTime: number): Promise<CycleReport> {
    const report: CycleReport = { barTime, evaluated: 0, breadth: 0, breakouts: 0, entries: [], exits: [], skipped: [], errors: [] };
    const held = this.store.openPositions();
    const universe = await this.market.universe();
    const heldSymbols = new Set(held.map((p) => p.symbol));
    // Held pairs that left the universe (delisted, renamed) are still evaluated.
    const pairs = [...universe, ...held.filter((p) => !universe.some((u) => u.symbol === p.symbol)).map((p) => ({ symbol: p.symbol, base: p.symbol.replace(/USDT$/, ""), precision: 8 }))];

    // BTC first: Setup A's relative-strength filter compares every pair with it.
    const needsBtc = this.cfg.setups.includes("a") || held.some((p) => p.setup === "a");
    const btc = needsBtc ? await this.market.closedBars("BTCUSDT", barTime, SETUP_V1.warmup + 2).catch(() => null) : null;
    if (needsBtc && !btc && this.cfg.maxRsA !== null) report.errors.push("BTCUSDT: no bars this cycle — Setup A entries need it for the RS filter and are skipped");
    const optionsA = { btc: btc ?? undefined, maxRs: this.cfg.maxRsA ?? undefined };

    const evals = new Map<string, Evaluation>();
    await mapLimit(pairs, CONCURRENCY, async (pair) => {
      const position = held.find((p) => p.symbol === pair.symbol);
      // A held position needs bars back to its signal; a fresh scan needs the warm-up.
      const minBars = position ? Math.ceil((barTime - position.signalTime) / BAR_MS) + SETUP_V1.warmup + 5 : SETUP_V1.warmup + 2;
      try {
        const bars = await this.market.closedBars(pair.symbol, barTime, minBars);
        if (!bars || bars.length < SETUP_V1.warmup + 2) return;
        evals.set(pair.symbol, {
          pair,
          bars,
          ...this.evaluateV1(bars),
          resultA: this.cfg.setups.includes("a") || position?.setup === "a" ? runSetupA(bars, BAR_MS, optionsA) : null,
        });
      } catch (err) {
        if (heldSymbols.has(pair.symbol)) report.errors.push(`${pair.symbol}: ${(err as Error).message}`);
      }
    });
    report.evaluated = evals.size;

    for (const position of held) await this.manage(position, evals.get(position.symbol), report);
    await this.enter(evals, report);
    await this.markEquity(barTime + BAR_MS, evals);

    this.store.set("last_bar", String(barTime));
    this.store.log(
      "info",
      "cycle",
      `bar ${new Date(barTime).toISOString()} · ${report.evaluated} pairs · breadth ${report.breadth}${this.cfg.setups.includes("a") ? ` · breakouts ${report.breakouts}` : ""} · ${report.entries.length} entries · ${report.exits.length} exits`,
      this.now(),
    );
    if (report.breadth) this.store.set("last_breadth", JSON.stringify({ barTime, breadth: report.breadth }));
    for (const e of report.errors) this.store.log("error", "cycle", e, this.now());
    if (report.entries.length || report.exits.length || report.errors.length) {
      await this.notify(
        [
          `<b>${setupsName(this.cfg)} · ${this.broker.kind.toUpperCase()}</b> · 4h bar ${new Date(barTime + BAR_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`,
          ...report.entries.map((e) => `🟢 ${e}`),
          ...report.exits.map((e) => `🔴 ${e}`),
          ...report.errors.map((e) => `⚠️ ${e}`),
        ].join("\n"),
      );
    }
    return report;
  }

  /** Exit a held position when its setup has closed it. */
  private async manage(position: Position, ev: Evaluation | undefined, report: CycleReport): Promise<void> {
    if (!ev) {
      report.errors.push(`${position.symbol}: no data this bar — position kept, stop still resting`);
      return;
    }
    let result = position.setup === "a" ? ev.resultA : ev.result;
    // A v1 position opened before `firstDotOnly` was switched on may come from a second dot: follow it with the rule it was opened under.
    if (position.setup === "v1" && this.cfg.firstDotOnly && !result?.trades.some((t) => t.entryTime === position.signalTime) && result?.open?.entryTime !== position.signalTime) {
      result = runSetupV1(ev.bars, { stoch: this.cfg.stoch, intervalMs: BAR_MS });
    }
    const closed = result?.trades.find((t) => t.entryTime === position.signalTime);
    if (!closed) {
      if (result?.open?.entryTime !== position.signalTime) report.errors.push(`${position.symbol}: setup ${SETUP_LABEL[position.setup]} has no record of this position — kept`);
      return;
    }
    const reason: ExitReason = closed.exitReason === "stop" ? "stop" : position.setup === "a" ? "trail" : "signal";
    if (this.broker.kind === "paper") {
      // Paper fills follow the bars, exactly as the backtest: the stop at its level, the signal at the close.
      const ref = reason === "stop" ? Math.min(position.stopPrice, ev.bars[closed.exitIndex!].open) : closed.exitPrice!;
      await this.exit(position, ref, reason, report);
      return;
    }
    // Live: the stop rests on the exchange (reconcile records it); a signal or trail exit sells at market.
    if (reason !== "stop") await this.exit(position, ev.bars[ev.bars.length - 1].close, reason, report);
  }

  private async exit(position: Position, refPrice: number, reason: ExitReason, report: CycleReport): Promise<void> {
    try {
      if (position.stopOrderId) await this.broker.cancelStop(position.symbol, position.stopOrderId);
      const qty = this.broker.kind === "paper" ? position.qty : Math.min(position.qty, await this.broker.holding(position.symbol));
      const fill = await this.broker.sell(position.symbol, qty, refPrice, clientId(position.setup, position.symbol, position.signalTime, "x"));
      const done = this.store.closePosition(position.id, { price: fill.price, fee: fill.fee, proceeds: fill.quote, reason, time: this.now() });
      report.exits.push(`[${SETUP_LABEL[position.setup]}] ${position.symbol} ${reason} @ ${fmt(fill.price)} · ${pct(done.pnl! / done.cost)} (${done.pnl! >= 0 ? "+" : ""}${done.pnl!.toFixed(2)} USDT)`);
    } catch (err) {
      report.errors.push(`${position.symbol}: exit failed — ${(err as Error).message}`);
    }
  }

  /** Fresh v1 and A signals on this bar. v1 needs breadth (v1.1); A needs the volume confirmation. */
  private candidates(evals: Map<string, Evaluation>, report: CycleReport): Candidate[] {
    const out: Candidate[] = [];
    if (this.cfg.setups.includes("v1")) {
      const signals = [...evals.values()].filter((ev) => isFreshEntry(ev.breadthResult, ev.bars.length));
      const fresh = [...evals.values()].filter((ev) => isFreshEntry(ev.result, ev.bars.length));
      report.breadth = signals.length;
      // v1.1: the edge is market-wide capitulation — isolated signals are skipped.
      if (signals.length && signals.length < this.cfg.minBreadth) report.skipped.push(`v1 breadth ${signals.length} < ${this.cfg.minBreadth}: ${signals.map((ev) => ev.pair.symbol).join(", ")}`);
      else for (const ev of fresh) out.push({ setup: "v1", ev, liquidity: liquidity30d(ev.bars, ev.bars.length - 1, BAR_MS), signalTime: ev.result.open!.entryTime, stopPct: SETUP_V1.stopPct });
    }
    if (this.cfg.setups.includes("a")) {
      for (const ev of evals.values()) {
        const t = ev.resultA?.open;
        if (!t || t.entryIndex !== ev.bars.length - 1 || !t.passes) continue;
        report.breakouts++;
        out.push({ setup: "a", ev, liquidity: liquidity30d(ev.bars, ev.bars.length - 1, BAR_MS), signalTime: t.entryTime, stopPct: 1 - t.stopPrice / t.entryPrice });
      }
    }
    return out;
  }

  /**
   * Fresh entries of every setup on this bar, most liquid first (as the research portfolio),
   * through the liquidity filter, the per-bar risk cap and the risk gates.
   */
  private async enter(evals: Map<string, Evaluation>, report: CycleReport): Promise<void> {
    const fresh = this.candidates(evals, report).sort((a, b) => b.liquidity - a.liquidity);
    if (!fresh.length) return;

    let { equity, cash } = await this.account(evals);
    const block = this.risk.entryBlock(equity, this.now());
    const barRisk: Record<SetupId, number> = { v1: 0, a: 0 };
    // v1.2: ≤ maxRiskPerBar of v1 risk per bar (0 = off). Setup A: ≤ 5 × its risk per bar (research).
    const barCap: Record<SetupId, number> = { v1: this.cfg.maxRiskPerBar > 0 ? this.cfg.maxRiskPerBar : Number.POSITIVE_INFINITY, a: 5 * this.cfg.riskPerTradeA };
    for (const { setup, ev, liquidity, signalTime, stopPct } of fresh) {
      const symbol = ev.pair.symbol;
      const tag = `[${SETUP_LABEL[setup]}] ${symbol}`;
      if (block) {
        report.skipped.push(`${tag}: ${block}`);
        continue;
      }
      if (this.store.hasSignal(symbol, signalTime)) continue; // already acted on
      if (this.store.openPositions().some((p) => p.symbol === symbol)) continue; // one position per pair across setups
      if (liquidity < this.cfg.minLiquidity30d) {
        report.skipped.push(`${tag}: 30d liquidity ${(liquidity / 1e6).toFixed(2)}M < ${(this.cfg.minLiquidity30d / 1e6).toFixed(2)}M/day`);
        continue;
      }
      const { risk } = setupRules(this.cfg, setup);
      if (barRisk[setup] + risk > barCap[setup] + 1e-12) {
        report.skipped.push(`${tag}: per-bar risk cap ${(barCap[setup] * 100).toFixed(1)}% reached`);
        continue;
      }
      const rules = await this.broker.rules(symbol);
      if (!rules.ok) {
        report.skipped.push(`${tag}: ${rules.reason}`);
        continue;
      }
      const openOfSetup = this.store.openPositions().filter((p) => p.setup === setup).length;
      const size = sizePosition(this.cfg, { equity, cash, openPositions: openOfSetup, minNotional: rules.minNotional, setup, stopPct });
      if (!size.ok) {
        report.skipped.push(`${tag}: ${size.reason}`);
        continue;
      }
      try {
        const close = ev.bars[ev.bars.length - 1].close;
        const fill = await this.broker.buy(symbol, size.quote, close, clientId(setup, symbol, signalTime, "e"));
        const stopPrice = fill.price * (1 - stopPct);
        let stopOrderId: string | null;
        try {
          stopOrderId = await this.broker.placeStop(symbol, fill.qty, stopPrice, clientId(setup, symbol, signalTime, "s"));
        } catch (err) {
          // Never hold a position without its stop: undo the entry.
          await this.broker.sell(symbol, fill.qty, close, clientId(setup, symbol, signalTime, "f")).catch(() => {});
          throw new Error(`stop could not be placed (${(err as Error).message}) — entry reversed`);
        }
        this.store.insertPosition({ setup, symbol, signalTime, qty: fill.qty, entryPrice: fill.price, entryFee: fill.fee, cost: fill.quote, stopPrice, stopOrderId, openedAt: this.now() });
        barRisk[setup] += risk;
        cash -= fill.quote;
        report.entries.push(`${tag} long @ ${fmt(fill.price)} · ${fill.quote.toFixed(2)} USDT · stop ${fmt(stopPrice)} (−${(stopPct * 100).toFixed(1)}%)`);
      } catch (err) {
        report.errors.push(`${tag}: entry failed — ${(err as Error).message}`);
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
    const report: CycleReport = { barTime: 0, evaluated: 0, breadth: 0, breakouts: 0, entries: [], exits: [], skipped: [], errors: [] };
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
