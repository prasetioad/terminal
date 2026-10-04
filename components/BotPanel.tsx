"use client";

import { useCallback, useEffect, useState } from "react";
import Modal from "./Modal";
import type { StatusSnapshot } from "@/bot/api";
import type { Position } from "@/bot/db";

/**
 * The bot's dashboard: mode, account, live results against the backtest, open
 * positions and recent trades, with pause / resume. Reads the bot through /api/bot.
 */

type State = { status: StatusSnapshot; open: Position[]; trades: Position[] } | { error: string };

const pct = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;
const usd = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (v: number) => (v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const time = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

const MODE_STYLE = {
  paper: "bg-slate-500/20 text-slate-200",
  testnet: "bg-amber-400/15 text-amber-300",
  live: "bg-[#FF2D55]/20 text-[#FF2D55]",
} as const;

export default function BotPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State | null>(null);

  const load = useCallback(async () => {
    try {
      const get = async <T,>(p: string): Promise<T> => {
        const res = await fetch(`/api/bot/${p}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body as T;
      };
      const [status, open, trades] = await Promise.all([get<StatusSnapshot>("status"), get<Position[]>("positions"), get<Position[]>("trades")]);
      setState({ status, open, trades });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = async (paused: boolean) => {
    await fetch(`/api/bot/${paused ? "resume" : "pause"}`, { method: "POST" });
    await load();
  };

  return (
    <Modal title="Trading bot" onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col gap-4 p-4 font-mono text-xs">
        {!state && <p className="text-slate-500">Connecting to the bot…</p>}
        {state && "error" in state && (
          <div className="rounded border border-amber-400/30 bg-amber-400/5 p-3 leading-relaxed text-amber-200">
            Bot not reachable ({state.error}). Start it with <code className="text-slate-100">npm run bot</code> (paper mode by default), or set{" "}
            <code className="text-slate-100">BOT_API_URL</code> / <code className="text-slate-100">BOT_API_TOKEN</code> for a bot on a server. See docs/BOT.md.
          </div>
        )}
        {state && "status" in state && <Dashboard {...state} onToggle={toggle} />}
      </div>
    </Modal>
  );
}

function Dashboard({ status: s, open, trades, onToggle }: { status: StatusSnapshot; open: Position[]; trades: Position[]; onToggle: (paused: boolean) => void }) {
  const change = s.startEquity ? s.equity / s.startEquity - 1 : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase ${MODE_STYLE[s.mode]}`}>{s.mode}</span>
        {s.paused ? <span className="rounded bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-300">PAUSED · entries off</span> : <span className="rounded bg-[#00FFA3]/10 px-2 py-0.5 text-[11px] text-[#00FFA3]">RUNNING</span>}
        <span className="font-semibold text-slate-200">{s.setupsName ?? "Setup v1.1"}</span>
        <span className="text-slate-500">
          v1: stoch {s.stoch} · risk {(s.config.riskPerTrade * 100).toFixed(2)}% · max {s.config.maxOpenPositions} · breadth ≥ {s.config.minBreadth}
          {s.config.maxRiskPerBar ? ` · ≤ ${(s.config.maxRiskPerBar * 100).toFixed(0)}%/bar` : ""}
          {s.config.firstDotOnly ? " · first dot only" : ""}
          {s.setups?.includes("a") && s.config.riskPerTradeA !== undefined ? ` · A: risk ${(s.config.riskPerTradeA * 100).toFixed(2)}% · max ${s.config.maxOpenPositionsA}` : ""}
          {s.setups?.includes("a") && s.config.maxRsA != null ? ` · RS < ${(s.config.maxRsA * 100).toFixed(0)}%` : ""}
          {s.setups?.includes("a") && s.config.spikeTightenA ? " · spike trail 4×ATR" : ""} · 30d liquidity ≥ $
          {(s.config.minLiquidity30d / 1e6).toFixed(1)}M
        </span>
        <button
          type="button"
          onClick={() => onToggle(s.paused)}
          className="ml-auto rounded border border-[#1E2631] px-2.5 py-1 text-slate-200 hover:border-[#00E5FF]/50 hover:text-[#00E5FF]"
        >
          {s.paused ? "Resume entries" : "Pause entries"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Equity" value={`${usd(s.equity)} USDT`} sub={change !== null ? pct(change) : undefined} tone={change} />
        <Stat label="Realized P&L" value={`${s.totalPnl >= 0 ? "+" : ""}${usd(s.totalPnl)}`} tone={s.totalPnl} />
        <Stat
          label="Closed trades"
          value={String(s.closedTrades)}
          sub={s.winRate !== null ? `win ${(s.winRate * 100).toFixed(0)}% · avg ${pct(s.avgReturn!)}` : "none yet"}
        />
        <Stat label="Next cycle" value={s.nextRun ? time(s.nextRun) : "—"} sub={s.lastBar ? `last bar ${time(s.lastBar)}` : undefined} />
      </div>
      {s.bySetup && Object.keys(s.bySetup).length > 1 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Object.entries(s.bySetup).map(([id, x]) => (
            <Stat
              key={id}
              label={id === "a" ? "Setup A · breakout" : "Setup v1 · capitulation"}
              value={`${x.totalPnl >= 0 ? "+" : ""}${usd(x.totalPnl)} USDT`}
              sub={`${x.open} open · ${x.closedTrades} closed${x.winRate !== null ? ` · win ${(x.winRate * 100).toFixed(0)}% · avg ${pct(x.avgReturn!)}` : ""}`}
              tone={x.totalPnl}
            />
          ))}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Backtest reference (653 pairs, out-of-sample): v1 about 60% wins, +2% per trade; Setup A about 30–35% wins with winners ~3× losers. A live record needs ~40+
        trades per setup before it can be compared meaningfully.
      </p>

      <Section title={`Open positions (${open.length})`}>
        {open.length === 0 ? (
          <Empty text="No open positions" />
        ) : (
          <Table head={["Pair", "Setup", "Opened", "Entry", "Stop", "Qty", "Cost"]}>
            {open.map((p) => (
              <tr key={p.id} className="border-b border-[#1E2631]/60">
                <td className="px-3 py-1.5 text-slate-100">{p.symbol.replace(/USDT$/, "")}</td>
                <td className="px-2 py-1.5 text-slate-400">{p.setup === "a" ? "A" : "v1"}</td>
                <td className="px-2 py-1.5 text-slate-400">{time(p.openedAt)}</td>
                <td className="px-2 py-1.5 text-right">{price(p.entryPrice)}</td>
                <td className="px-2 py-1.5 text-right text-[#FF2D55]/80">{price(p.stopPrice)}</td>
                <td className="px-2 py-1.5 text-right text-slate-400">{p.qty.toPrecision(5)}</td>
                <td className="px-3 py-1.5 text-right">{usd(p.cost)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={`Recent trades (${trades.length})`}>
        {trades.length === 0 ? (
          <Empty text="No closed trades yet" />
        ) : (
          <Table head={["Pair", "Setup", "Closed", "Exit", "Reason", "P&L", "Return"]}>
            {trades.slice(0, 50).map((p) => (
              <tr key={p.id} className="border-b border-[#1E2631]/60">
                <td className="px-3 py-1.5 text-slate-100">{p.symbol.replace(/USDT$/, "")}</td>
                <td className="px-2 py-1.5 text-slate-400">{p.setup === "a" ? "A" : "v1"}</td>
                <td className="px-2 py-1.5 text-slate-400">{time(p.closedAt!)}</td>
                <td className="px-2 py-1.5 text-right">{price(p.exitPrice!)}</td>
                <td className="px-2 py-1.5 text-right text-slate-400">{p.exitReason}</td>
                <td className={`px-2 py-1.5 text-right ${p.pnl! >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>{usd(p.pnl!)}</td>
                <td className={`px-3 py-1.5 text-right ${p.pnl! >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>{pct(p.pnl! / p.cost)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number | null }) {
  const color = tone === undefined || tone === null ? "text-slate-100" : tone >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]";
  return (
    <div className="rounded border border-[#1E2631] bg-[#0B0E11] p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className="rounded border border-[#1E2631] px-3 py-4 text-center text-slate-600">{text}</p>;

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="max-h-56 overflow-auto rounded border border-[#1E2631]">
      <table className="w-full border-collapse tabular-nums">
        <thead className="sticky top-0 bg-[#0D1117] text-[10px] uppercase tracking-wider text-slate-500">
          <tr className="border-b border-[#1E2631]">
            {head.map((h, i) => (
              <th key={h} className={`py-2 font-medium ${i === 0 ? "px-3 text-left" : i === head.length - 1 ? "px-3 text-right" : "px-2 text-right"} ${i === 1 ? "text-left" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
