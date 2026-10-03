"use client";

import { useState } from "react";
import Modal from "./Modal";
import { formatPrice, formatUsdCompact } from "@/lib/format";
import type { ScanResult, ScanRow, ScanStatus } from "@/lib/server/scanner";
import { SETUP_V1, type StochPreset } from "@/lib/setups/setupV1";
import type { ScannerStatus } from "@/hooks/useSetupScanner";

interface SetupScannerProps {
  result: ScanResult | null;
  status: ScannerStatus;
  stoch: StochPreset;
  onStochChange: (stoch: StochPreset) => void;
  notify: boolean;
  onToggleNotify: () => void;
  onOpen: (symbol: string) => void;
  onClose: () => void;
}

const TABS: readonly { key: ScanStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "entry", label: "New entries" },
  { key: "exit", label: "Exits" },
  { key: "open", label: "Open" },
];

const MIN_LIQUIDITY = [
  { value: 0, label: "Any liquidity" },
  { value: SETUP_V1.minLiquidity30d, label: "≥ $1M/day (v1.1)" },
  { value: 1e7, label: "≥ $10M/day" },
  { value: 1e8, label: "≥ $100M/day" },
] as const;

const STATUS_STYLE: Record<ScanStatus, { label: string; cls: string }> = {
  entry: { label: "ENTRY", cls: "bg-[#00FFA3]/15 text-[#00FFA3]" },
  exit: { label: "EXIT", cls: "bg-amber-400/15 text-amber-300" },
  open: { label: "OPEN", cls: "bg-[#00E5FF]/10 text-[#00E5FF]" },
};

const pct = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;
const time = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** Setup v1 across every pair on the last closed 4h bar. */
export default function SetupScanner({ result, status, stoch, onStochChange, notify, onToggleNotify, onOpen, onClose }: SetupScannerProps) {
  const [tab, setTab] = useState<ScanStatus | "all">("all");
  const [minLiquidity, setMinLiquidity] = useState<number>(SETUP_V1.minLiquidity30d);
  const rows = (result?.rows ?? []).filter((r) => r.liquidity30d >= minLiquidity);
  const breadthOk = (result?.breadth ?? 0) >= SETUP_V1.minBreadth;
  const count = (key: ScanStatus | "all") => (key === "all" ? rows.length : rows.filter((r) => r.status === key).length);
  const shown = tab === "all" ? rows : rows.filter((r) => r.status === tab);

  return (
    <Modal title="Setup v1 scanner · 4h · MaxFlow+ × Stoch long" onClose={onClose} width="max-w-5xl">
      <div className="flex flex-col gap-3 p-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded border border-[#1E2631]" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`px-2.5 py-1 font-mono text-[11px] ${tab === t.key ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "text-slate-400 hover:text-slate-200"}`}
              >
                {t.label} <span className="text-slate-500">{count(t.key)}</span>
              </button>
            ))}
          </div>
          <select
            aria-label="Minimum 30-day liquidity"
            value={minLiquidity}
            onChange={(e) => setMinLiquidity(Number(e.target.value))}
            className="rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1 font-mono text-[11px] text-slate-200"
          >
            {MIN_LIQUIDITY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Stochastic"
            value={stoch}
            onChange={(e) => onStochChange(e.target.value as StochPreset)}
            className="rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1 font-mono text-[11px] text-slate-200"
          >
            <option value="either">Stoch 5 or 14 (most signals)</option>
            <option value="5,3,3">Stoch 5,3,3 (most consistent)</option>
            <option value="14,3,3">Stoch 14,3,3</option>
          </select>
          <button
            type="button"
            aria-pressed={notify}
            onClick={onToggleNotify}
            className={`ml-auto rounded px-2.5 py-1 font-mono text-[11px] ${notify ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "border border-[#1E2631] text-slate-400 hover:text-slate-200"}`}
          >
            {notify ? "🔔 Notifying new entries" : "🔕 Notify new entries"}
          </button>
        </div>

        {result && (
          <div
            role="status"
            aria-label="Breadth"
            className={`rounded border px-3 py-2 text-[11px] leading-relaxed ${breadthOk ? "border-[#00FFA3]/40 bg-[#00FFA3]/5 text-[#00FFA3]" : "border-[#1E2631] text-slate-400"}`}
          >
            <span className="font-semibold">Breadth {result.breadth}</span> — pairs with a new entry on this bar.{" "}
            {breadthOk
              ? `Market-wide capitulation: Setup v1.1 takes these entries (most liquid first).`
              : `Setup v1.1 trades only when ≥ ${SETUP_V1.minBreadth} pairs signal at once — isolated signals averaged ~0% on the full, survivorship-free universe.`}
          </div>
        )}

        <div className="max-h-[55vh] overflow-auto rounded border border-[#1E2631]">
          <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#0D1117] text-[10px] uppercase tracking-wider text-slate-500">
              <tr className="border-b border-[#1E2631]">
                <th className="px-3 py-2 text-left font-medium">Pair</th>
                <th className="px-2 py-2 text-left font-medium">Status</th>
                <th className="px-2 py-2 text-right font-medium">Entry</th>
                <th className="px-2 py-2 text-right font-medium">Stop −15%</th>
                <th className="px-2 py-2 text-right font-medium">Last</th>
                <th className="px-2 py-2 text-right font-medium">P&amp;L</th>
                <th className="px-2 py-2 text-right font-medium">Bars</th>
                <th className="px-2 py-2 text-right font-medium" title="Trailing 30-day average daily quote volume">Liquidity/day</th>
                <th className="px-3 py-2 text-right font-medium" title="This setup on this pair over the scanned window (~47 days of 4h bars)">
                  Pair record
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row key={r.symbol} row={r} onOpen={onOpen} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                    {status === "loading" && !result ? "Scanning every pair… (first scan takes about a minute)" : status === "error" && !result ? "Scan unavailable" : "Nothing here on the last 4h bar"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          {result
            ? `Bar ${time(result.barTime)} → ${time(result.barTime + 4 * 3_600_000)} · ${result.pairs} pairs scanned${result.failed ? ` (${result.failed} failed)` : ""} · rescans after every 4h close. `
            : ""}
          Rules (v1.1): green dot, then Stochastic crosses up from below 20 → long at the 4h close, only on bars where ≥ {SETUP_V1.minBreadth} pairs signal and the pair trades ≥ $1M/day; stop
          −15%; exit at the first red dot. Survivorship-free backtest (579 pairs incl. delisted, 2021–2026): ~60% wins, +1.9% / +3.6% per trade in- / out-of-sample. Not financial
          advice; size by risk (1% of the account ≈ 6.7% position with a −15% stop).
        </p>
      </div>
    </Modal>
  );
}

function Row({ row: r, onOpen }: { row: ScanRow; onOpen: (symbol: string) => void }) {
  const style = STATUS_STYLE[r.status];
  return (
    <tr onClick={() => onOpen(r.symbol)} className="cursor-pointer border-b border-[#1E2631]/60 hover:bg-[#00E5FF]/5" title={`Open ${r.base}/USDT on 4h`}>
      <td className="px-3 py-1.5 text-slate-100">
        <span className="font-semibold">{r.base}</span>
        <span className="ml-1.5 text-[10px] text-slate-500">{r.rank === null ? "—" : `#${r.rank}`}</span>
      </td>
      <td className="px-2 py-1.5">
        <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${style.cls}`}>
          {style.label}
          {r.exitReason === "stop" ? " · STOP" : ""}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right text-slate-200">{formatPrice(r.entryPrice, r.precision)}</td>
      <td className="px-2 py-1.5 text-right text-[#FF2D55]/80">{formatPrice(r.stopPrice, r.precision)}</td>
      <td className="px-2 py-1.5 text-right text-slate-300">{formatPrice(r.lastPrice, r.precision)}</td>
      <td className={`px-2 py-1.5 text-right ${r.ret >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>{r.status === "entry" ? "—" : pct(r.ret)}</td>
      <td className="px-2 py-1.5 text-right text-slate-400">{r.barsHeld}</td>
      <td className="px-2 py-1.5 text-right text-slate-400">{formatUsdCompact(r.liquidity30d)}</td>
      <td className="px-3 py-1.5 text-right text-slate-500">
        {r.record.count ? `${r.record.count} · ${(r.record.winRate * 100).toFixed(0)}% · ${pct(r.record.avgRet)}` : "—"}
      </td>
    </tr>
  );
}
