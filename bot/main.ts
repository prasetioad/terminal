/**
 * Setup bot — entry point.
 *
 *   npm run bot                               (reads bot/.env; PAPER mode unless configured otherwise)
 *   BOT_ENV_FILE=bot/.env.local npm run bot   (another configuration, e.g. a local experiment)
 *
 * See docs/BOT.md for configuration, the testnet → live path and deployment.
 */
import { loadEnvFile } from "node:process";
import { statusSnapshot, startApi } from "./api";
import { BINANCE_SPOT, BinanceSpotBroker, BinanceSpotClient } from "./binance";
import { PaperBroker, type Broker } from "./broker";
import { loadConfig } from "./config";
import { BotStore } from "./db";
import { BotEngine, setupsName, type Notifier } from "./engine";
import { dailyReport } from "./report";
import { BAR_MS, BinanceMarketData, SETTLE_MS, lastClosedBar } from "./market";
import { ConsoleNotifier, TelegramNotifier } from "./telegram";

try {
  loadEnvFile(process.env.BOT_ENV_FILE ?? "bot/.env");
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
    `<b>${setupsName(cfg)} bot · ${s.mode.toUpperCase()}</b>${s.paused ? " · ⏸ PAUSED" : ""}`,
    `Equity ${s.equity.toFixed(2)} USDT (cash ${s.cash.toFixed(2)})`,
    `Open ${s.openPositions} · closed ${s.closedTrades}${s.winRate !== null ? ` · win ${(s.winRate * 100).toFixed(0)}% · avg ${(s.avgReturn! * 100).toFixed(2)}%` : ""}`,
    ...(cfg.setups.length > 1
      ? cfg.setups.map((id) => {
          const x = s.bySetup![id]!;
          return `· ${id === "a" ? "A" : "v1"}: open ${x.open} · closed ${x.closedTrades} · P&L ${x.totalPnl >= 0 ? "+" : ""}${x.totalPnl.toFixed(2)}`;
        })
      : []),
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

/** The daily report at REPORT_UTC_HOUR (default 01:00 UTC = 08:00 WIB): if it does not arrive, something is down. */
const REPORT_HOUR = Number(process.env.REPORT_UTC_HOUR ?? 1);
let reportTimer: NodeJS.Timeout | undefined;
function scheduleReport() {
  const now = Date.now();
  const today = Math.floor(now / 86_400_000) * 86_400_000 + REPORT_HOUR * 3_600_000;
  const next = today > now ? today : today + 86_400_000;
  reportTimer = setTimeout(async () => {
    try {
      await notifier.send(await dailyReport(engine, nextRun));
    } catch (err) {
      store.log("error", "report", (err as Error).message);
    }
    scheduleReport();
  }, next - now);
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
  const risks = cfg.setups.map((id) => (id === "a" ? `A ${(cfg.riskPerTradeA * 100).toFixed(2)}%` : `v1 ${(cfg.riskPerTrade * 100).toFixed(2)}%${cfg.maxRiskPerBar ? ` (≤ ${(cfg.maxRiskPerBar * 100).toFixed(0)}%/bar)` : ""}`));
  console.log(`${setupsName(cfg)} bot · mode ${cfg.mode.toUpperCase()} · stoch ${cfg.stoch} · risk ${risks.join(", ")}/trade · db ${cfg.dbPath}`);
  store.log("info", "start", `mode ${cfg.mode}`);
  await notifier.send(`🤖 ${setupsName(cfg)} bot started · <b>${cfg.mode.toUpperCase()}</b>`).catch(() => {});

  const api = startApi(engine, () => nextRun);
  const reconcile = cfg.mode === "paper" ? undefined : setInterval(() => void engine.reconcile(), 60_000);
  if (telegram) void telegram.listen(engine, statusText, shutdown.signal, () => dailyReport(engine, nextRun));
  scheduleReport();

  const bar = lastClosedBar(Date.now());
  if (Number(store.get("last_bar") ?? 0) < bar) await cycle(bar);
  schedule();

  const stop = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    shutdown.abort();
    clearTimeout(timer);
    clearTimeout(reportTimer);
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
