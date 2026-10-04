import http from "node:http";
import type { BotConfig } from "./config";
import { setupsName, type BotEngine } from "./engine";

/**
 * Read-mostly HTTP API for the web app's Bot panel.
 *   GET  /status /positions /trades /equity /events
 *   POST /pause /resume
 * Requires `Authorization: Bearer <API_TOKEN>` when API_TOKEN is set; without a token
 * it only listens on 127.0.0.1.
 */

export interface SetupStats {
  open: number;
  closedTrades: number;
  winRate: number | null;
  avgReturn: number | null;
  totalPnl: number;
}

export interface StatusSnapshot {
  mode: BotConfig["mode"];
  /** e.g. "Setups v1.2 + A" (absent from bots older than several setups). */
  setupsName?: string;
  setups?: BotConfig["setups"];
  /** Results per setup. */
  bySetup?: Partial<Record<BotConfig["setups"][number], SetupStats>>;
  stoch: string;
  paused: boolean;
  lastBar: number | null;
  nextRun: number | null;
  equity: number;
  cash: number;
  startEquity: number | null;
  openPositions: number;
  closedTrades: number;
  winRate: number | null;
  avgReturn: number | null;
  totalPnl: number;
  config: Pick<BotConfig, "riskPerTrade" | "maxOpenPositions" | "maxPositionFraction" | "minBreadth" | "minLiquidity30d" | "dailyLossLimit"> &
    Partial<Pick<BotConfig, "maxRiskPerBar" | "riskPerTradeA" | "maxOpenPositionsA" | "firstDotOnly" | "maxRsA" | "spikeTightenA">>;
}

function stats(open: number, closed: { pnl: number | null; cost: number }[]): SetupStats {
  const rets = closed.map((p) => p.pnl! / p.cost);
  return {
    open,
    closedTrades: closed.length,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : null,
    avgReturn: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
    totalPnl: closed.reduce((s, p) => s + p.pnl!, 0),
  };
}

export async function statusSnapshot(engine: BotEngine, nextRun: number | null): Promise<StatusSnapshot> {
  const { equity, cash } = await engine.account();
  const closed = engine.store.closedPositions(100_000);
  const rets = closed.map((p) => p.pnl! / p.cost);
  const curve = engine.store.equityCurve(1);
  const open = engine.store.openPositions();
  const bySetup: StatusSnapshot["bySetup"] = {};
  for (const id of engine.cfg.setups) bySetup[id] = stats(open.filter((p) => p.setup === id).length, closed.filter((p) => p.setup === id));
  return {
    mode: engine.cfg.mode,
    setupsName: setupsName(engine.cfg),
    setups: engine.cfg.setups,
    bySetup,
    stoch: engine.cfg.stoch,
    paused: engine.risk.paused,
    lastBar: engine.store.get("last_bar") ? Number(engine.store.get("last_bar")) : null,
    nextRun,
    equity,
    cash,
    startEquity: engine.cfg.mode === "paper" ? engine.cfg.paperStartEquity : (curve[0]?.equity ?? null),
    openPositions: engine.store.openPositions().length,
    closedTrades: closed.length,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : null,
    avgReturn: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
    totalPnl: closed.reduce((s, p) => s + p.pnl!, 0),
    config: {
      riskPerTrade: engine.cfg.riskPerTrade,
      maxOpenPositions: engine.cfg.maxOpenPositions,
      maxPositionFraction: engine.cfg.maxPositionFraction,
      minBreadth: engine.cfg.minBreadth,
      minLiquidity30d: engine.cfg.minLiquidity30d,
      dailyLossLimit: engine.cfg.dailyLossLimit,
      maxRiskPerBar: engine.cfg.maxRiskPerBar,
      riskPerTradeA: engine.cfg.riskPerTradeA,
      maxOpenPositionsA: engine.cfg.maxOpenPositionsA,
      firstDotOnly: engine.cfg.firstDotOnly,
      maxRsA: engine.cfg.maxRsA,
      spikeTightenA: engine.cfg.spikeTightenA,
    },
  };
}

export function startApi(engine: BotEngine, nextRun: () => number | null): http.Server {
  const { apiToken, apiPort } = engine.cfg;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) return send(401, { error: "unauthorized" });
    const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    try {
      switch (route) {
        case "GET /status":
          return send(200, await statusSnapshot(engine, nextRun()));
        case "GET /positions":
          return send(200, engine.store.openPositions());
        case "GET /trades":
          return send(200, engine.store.closedPositions(500));
        case "GET /equity":
          return send(200, engine.store.equityCurve(5000));
        case "GET /events":
          return send(200, engine.store.events(200));
        case "POST /pause":
          engine.risk.setPaused(true, "api /pause");
          return send(200, { paused: true });
        case "POST /resume":
          engine.risk.setPaused(false, "api /resume");
          return send(200, { paused: false });
        default:
          return send(404, { error: "not found" });
      }
    } catch (err) {
      return send(500, { error: (err as Error).message });
    }
  });
  server.listen(apiPort, apiToken ? "0.0.0.0" : "127.0.0.1");
  return server;
}
