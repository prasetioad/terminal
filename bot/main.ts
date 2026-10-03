/**
 * Setup v1 bot — entry point.
 *
 *   npm run bot          (reads bot/.env; PAPER mode unless configured otherwise)
 *
 * See docs/BOT.md for configuration, the testnet → live path and deployment.
 */
import { loadEnvFile } from "node:process";
import { statusSnapshot, startApi } from "./api";
import { BINANCE_SPOT, BinanceSpotBroker, BinanceSpotClient } from "./binance";
import { PaperBroker, type Broker } from "./broker";
import { loadConfig } from "./config";
import { BotStore } from "./db";
import { BotEngine, type Notifier } from "./engine";
import { BAR_MS, BinanceMarketData, SETTLE_MS, lastClosedBar } from "./market";
import { ConsoleNotifier, TelegramNotifier } from "./telegram";

try {
  loadEnvFile("bot/.env");
} catch {
  // no .env file: environment variables only
}

const cfg = loadConfig();
const store = new BotStore(cfg.dbPath);
const broker: Broker =
  cfg.mode === "paper"
    ? new PaperBroker(store, cfg.paperStartEquity, cfg.feeRate, cfg.slippage)
    : new BinanceSpotBroker(cfg.mode, new BinanceSpotClient(BINANCE_SPOT[cfg.mode], cfg.binanceApiKey!, cfg.binanceApiSecret!));
const telegram = cfg.telegramToken && cfg.telegramChatId ? new TelegramNotifier(cfg.telegramToken, cfg.telegramChatId) : null;
const notifier: Notifier = telegram ?? new ConsoleNotifier();
const engine = new BotEngine(cfg, store, new BinanceMarketData(), broker, notifier);

let nextRun: number | null = null;
let timer: NodeJS.Timeout | undefined;
let running = false;
const shutdown = new AbortController();

const statusText = async () => {
  const s = await statusSnapshot(engine, nextRun);
  return [
    `<b>Setup v1 bot · ${s.mode.toUpperCase()}</b>${s.paused ? " · ⏸ PAUSED" : ""}`,
    `Equity ${s.equity.toFixed(2)} USDT (cash ${s.cash.toFixed(2)})`,
    `Open ${s.openPositions}/${s.config.maxOpenPositions} · closed ${s.closedTrades}${s.winRate !== null ? ` · win ${(s.winRate * 100).toFixed(0)}% · avg ${(s.avgReturn! * 100).toFixed(2)}%` : ""}`,
    `Realized P&L ${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(2)} USDT`,
    s.nextRun ? `Next cycle ${new Date(s.nextRun).toISOString().slice(0, 16).replace("T", " ")} UTC` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

async function cycle(barTime: number) {
  if (running) return;
  running = true;
  try {
    const r = await engine.runCycle(barTime);
    console.log(`[cycle] ${new Date(barTime).toISOString()} · ${r.evaluated} pairs · entries ${r.entries.length} · exits ${r.exits.length} · skipped ${r.skipped.length} · errors ${r.errors.length}`);
  } catch (err) {
    store.log("error", "cycle", (err as Error).message);
    await notifier.send(`⚠️ Cycle failed: ${(err as Error).message}`).catch(() => {});
  } finally {
    running = false;
  }
}

/** Run after every 4h close (plus a settle delay); catch up on start if the last bar wasn't processed. */
function schedule() {
  const next = lastClosedBar(Date.now()) + 2 * BAR_MS + SETTLE_MS;
  nextRun = next;
  timer = setTimeout(async () => {
    await cycle(lastClosedBar(Date.now()));
    schedule();
  }, next - Date.now());
}

async function start() {
  console.log(`Setup v1 bot · mode ${cfg.mode.toUpperCase()} · stoch ${cfg.stoch} · risk ${(cfg.riskPerTrade * 100).toFixed(2)}%/trade · db ${cfg.dbPath}`);
  store.log("info", "start", `mode ${cfg.mode}`);
  await notifier.send(`🤖 Setup v1 bot started · <b>${cfg.mode.toUpperCase()}</b>`).catch(() => {});

  const api = startApi(engine, () => nextRun);
  const reconcile = cfg.mode === "paper" ? undefined : setInterval(() => void engine.reconcile(), 60_000);
  if (telegram) void telegram.listen(engine, statusText, shutdown.signal);

  const bar = lastClosedBar(Date.now());
  if (Number(store.get("last_bar") ?? 0) < bar) await cycle(bar);
  schedule();

  const stop = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    shutdown.abort();
    clearTimeout(timer);
    clearInterval(reconcile);
    api.close();
    while (running) await new Promise((r) => setTimeout(r, 500)); // never stop mid-cycle
    store.log("info", "stop", signal);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

void start();
