"use client";

import { useState } from "react";
import Modal from "./Modal";
import { formatPrice, formatUsdCompact } from "@/lib/format";
import type { ScanResult, ScanRow, ScanSetup, ScanStatus } from "@/lib/server/scanner";
import { SETUP_A } from "@/lib/setups/setupA";
import { SETUP_V1, type StochPreset } from "@/lib/setups/setupV1";
import type { ScannerStatus } from "@/hooks/useSetupScanner";

interface SetupScannerProps {
  setup: ScanSetup;
  onSetupChange: (setup: ScanSetup) => void;
  /** Unseen validated entries per setup (badges on the setup switch). */
  unseen: Record<ScanSetup, number>;
  result: ScanResult | null;
  status: ScannerStatus;
  stoch: StochPreset;
  onStochChange: (stoch: StochPreset) => void;
  notify: boolean;
  onToggleNotify: () => void;
  onOpen: (symbol: string) => void;
  onClose: () => void;
}

const SETUPS: readonly { key: ScanSetup; label: string; hint: string }[] = [
  { key: "v1", label: "Setup v1.1 · Capitulation", hint: "Green dot × Stoch, many pairs at once" },
  { key: "a", label: "Setup A · Breakout", hint: "20-day high, 8×ATR trail, a coin trending on its own" },
];

const TABS: readonly { key: ScanStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "entry", label: "New entries" },
  { key: "exit", label: "Exits" },
  { key: "open", label: "Open" },
];

const MIN_LIQUIDITY = [
  { value: 0, label: "Any liquidity" },
  { value: SETUP_V1.minLiquidity30d, label: "≥ $1M/day (validated)" },
  { value: 1e7, label: "≥ $10M/day" },
  { value: 1e8, label: "≥ $100M/day" },
] as const;

const STATUS_STYLE: Record<ScanStatus, { label: string; cls: string }> = {
  entry: { label: "ENTRY", cls: "bg-[#00FFA3]/15 text-[#00FFA3]" },
  exit: { label: "EXIT", cls: "bg-amber-400/15 text-amber-300" },
  open: { label: "OPEN", cls: "bg-[#00E5FF]/10 text-[#00E5FF]" },
};

const select = "rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1 font-mono text-[11px] text-slate-200";
const pct = (r: number, digits = 2) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(digits)}%`;
const time = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function fearGreedLabel(v: number): { text: string; cls: string } {
  if (v < 25) return { text: "extreme fear: breakouts were weak here", cls: "text-[#FF2D55]" };
  if (v < 50) return { text: "fear", cls: "text-amber-300" };
  if (v < 75) return { text: "greed", cls: "text-[#00FFA3]" };
  return { text: "extreme greed", cls: "text-[#00FFA3]" };
}

/** Setup v1 or Setup A across every pair on the last closed 4h bar. */
export default function SetupScanner(props: SetupScannerProps) {
  const { setup, onSetupChange, unseen, result, status, stoch, onStochChange, notify, onToggleNotify, onOpen, onClose } = props;
  const [tab, setTab] = useState<ScanStatus | "all">("all");
  const [minLiquidity, setMinLiquidity] = useState<number>(SETUP_V1.minLiquidity30d);
  const [confirmedOnly, setConfirmedOnly] = useState(true);
  const [laggingOnly, setLaggingOnly] = useState(false);
  const isA = setup === "a";
  // A result of the other setup can linger for a moment after switching.
  const current = result?.setup === setup ? result : null;
  const rows = (current?.rows ?? []).filter(
    (r) => r.liquidity30d >= minLiquidity && (!isA || ((!confirmedOnly || r.passes) && (!laggingOnly || (r.rs30d !== null && r.rs30d < SETUP_A.maxRs)))),
  );
  const count = (key: ScanStatus | "all") => (key === "all" ? rows.length : rows.filter((r) => r.status === key).length);
  const shown = tab === "all" ? rows : rows.filter((r) => r.status === tab);
  const columns = isA ? 11 : 9;

  return (
    <Modal title="Setup scanner · 4h · every pair" onClose={onClose} width="max-w-6xl">
      <div className="flex flex-col gap-3 p-4 text-xs">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="tablist" aria-label="Setup">
          {SETUPS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={setup === s.key}
              onClick={() => onSetupChange(s.key)}
              className={`flex items-center justify-between rounded border px-3 py-2 text-left ${setup === s.key ? "border-[#00E5FF]/60 bg-[#00E5FF]/10" : "border-[#1E2631] hover:border-slate-600"}`}
            >
              <span>
                <span className={`block font-semibold ${setup === s.key ? "text-[#00E5FF]" : "text-slate-200"}`}>{s.label}</span>
                <span className="block text-[10px] text-slate-500">{s.hint}</span>
              </span>
              {unseen[s.key] > 0 && (
                <span className="rounded-full bg-[#00FFA3] px-1.5 font-mono text-[10px] font-bold text-[#0B0E11]">{unseen[s.key]} new</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded border border-[#1E2631]" role="tablist" aria-label="Status">
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
          <select aria-label="Minimum 30-day liquidity" value={minLiquidity} onChange={(e) => setMinLiquidity(Number(e.target.value))} className={select}>
            {MIN_LIQUIDITY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {isA ? (
            <label className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
              <input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} className="accent-[#00E5FF]" />
              Volume ≥ {SETUP_A.minSurge}× only (validated)
            </label>
          ) : null}
          {isA ? (
            <label
              className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300"
              title="Research §4.12: breakouts of coins that trailed BTC by more than 10% over 30 days won ~47% of the time at ~+13% per trade, with far fewer stop-outs. Fewer trades; misses some big runners."
            >
              <input type="checkbox" checked={laggingOnly} onChange={(e) => setLaggingOnly(e.target.checked)} className="accent-[#00E5FF]" />
              RS &lt; {(SETUP_A.maxRs * 100).toFixed(0)}% only (lagged BTC)
            </label>
          ) : (
            <select aria-label="Stochastic" value={stoch} onChange={(e) => onStochChange(e.target.value as StochPreset)} className={select}>
              <option value="either">Stoch 5 or 14 (most signals)</option>
              <option value="5,3,3">Stoch 5,3,3 (most consistent)</option>
              <option value="14,3,3">Stoch 14,3,3</option>
            </select>
          )}
          <button
            type="button"
            aria-pressed={notify}
            onClick={onToggleNotify}
            className={`ml-auto rounded px-2.5 py-1 font-mono text-[11px] ${notify ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "border border-[#1E2631] text-slate-400 hover:text-slate-200"}`}
            title="Browser notification for each new validated entry of both setups"
          >
            {notify ? "🔔 Notifying new entries" : "🔕 Notify new entries"}
          </button>
        </div>

        {current && (isA ? <BreakoutBanner result={current} /> : <BreadthBanner result={current} />)}

        <div className="max-h-[52vh] overflow-auto rounded border border-[#1E2631]">
          <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#0D1117] text-[10px] uppercase tracking-wider text-slate-500">
              <tr className="border-b border-[#1E2631]">
                <th className="px-3 py-2 text-left font-medium">Pair</th>
                <th className="px-2 py-2 text-left font-medium">Status</th>
                <th className="px-2 py-2 text-right font-medium">Entry</th>
                <th className="px-2 py-2 text-right font-medium" title={isA ? "Close below this exits (chandelier 8×ATR, never below the initial stop)" : "Resting stop −15%"}>
                  {isA ? "Exit below" : "Stop −15%"}
                </th>
                <th className="px-2 py-2 text-right font-medium">Last</th>
                <th className="px-2 py-2 text-right font-medium">P&amp;L</th>
                <th className="px-2 py-2 text-right font-medium">Bars</th>
                {isA && (
                  <th className="px-2 py-2 text-right font-medium" title="Last day's volume ÷ its 30-day daily average, at the entry">
                    Vol ×
                  </th>
                )}
                {isA && (
                  <th className="px-2 py-2 text-right font-medium" title="30-day return minus BTC's at the entry. Breakouts of coins that had lagged BTC by more than 10% (a base breaking out) did best; coins already stronger than BTC did worst.">
                    RS vs BTC
                  </th>
                )}
                <th className="px-2 py-2 text-right font-medium" title="Trailing 30-day average daily quote volume">
                  Liquidity/day
                </th>
                <th className="px-3 py-2 text-right font-medium" title="This setup on this pair over the scanned window (~47 days of 4h bars)">
                  Pair record
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row key={r.symbol} row={r} isA={isA} onOpen={onOpen} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={columns} className="px-3 py-8 text-center text-slate-500">
                    {status === "loading" && !current
                      ? "Scanning every pair… (first scan takes about a minute)"
                      : status === "error" && !current
                        ? "Scan unavailable"
                        : "Nothing here on the last 4h bar"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          {current
            ? `Bar ${time(current.barTime)} → ${time(current.barTime + 4 * 3_600_000)} · ${current.pairs} pairs scanned${current.failed ? ` (${current.failed} failed)` : ""} · rescans after every 4h close. `
            : ""}
          {isA ? (
            <>
              Rules (Setup A): the 4h close breaks above the 20-day high → long at the close; stop {SETUP_A.atrMult}×ATR; exit on a close below the chandelier (highest close −{" "}
              {SETUP_A.atrMult}×ATR); validated filter: volume ≥ {SETUP_A.minSurge}× the 30-day average. Survivorship-free backtest (653 pairs, 2021–2026, 0.5% risk per trade): ~30–35%
              wins, winners ~3× losers, holds ~3 weeks; +12–20%/yr with −15 to −25% drawdowns in- and out-of-sample. Research only — not traded by the bot.
            </>
          ) : (
            <>
              Rules (v1.1): green dot, then Stochastic crosses up from below 20 → long at the 4h close, only on bars where ≥ {SETUP_V1.minBreadth} pairs signal and the pair trades ≥
              $1M/day; stop −15%; exit at the first red dot. Survivorship-free backtest (653 pairs incl. delisted, 2021–2026): ~60% wins, +1.9% / +3.6% per trade in- / out-of-sample.
            </>
          )}{" "}
          Not financial advice.
        </p>
      </div>
    </Modal>
  );
}

function BreadthBanner({ result }: { result: ScanResult }) {
  const ok = result.breadth >= SETUP_V1.minBreadth;
  return (
    <div
      role="status"
      aria-label="Breadth"
      className={`rounded border px-3 py-2 text-[11px] leading-relaxed ${ok ? "border-[#00FFA3]/40 bg-[#00FFA3]/5 text-[#00FFA3]" : "border-[#1E2631] text-slate-400"}`}
    >
      <span className="font-semibold">Breadth {result.breadth}</span> — pairs with a new entry on this bar.{" "}
      {ok
        ? "Market-wide capitulation: Setup v1.1 takes these entries (most liquid first)."
        : `Setup v1.1 trades only when ≥ ${SETUP_V1.minBreadth} pairs signal at once — isolated signals averaged ~0% on the full, survivorship-free universe.`}
    </div>
  );
}

function BreakoutBanner({ result }: { result: ScanResult }) {
  const fg = result.fearGreed;
  const label = fg === null ? null : fearGreedLabel(fg);
  return (
    <div role="status" aria-label="Market" className="rounded border border-[#1E2631] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
      <span className="font-semibold text-slate-200">{result.breadth} confirmed breakout{result.breadth === 1 ? "" : "s"}</span> on this bar
      {" · "}Fear &amp; Greed{" "}
      {fg === null || !label ? (
        <span>unavailable</span>
      ) : (
        <span className={label.cls}>
          {fg} ({label.text})
        </span>
      )}
      . Breakouts win rarely but big: expect most to stop out small and a few to run for weeks.
    </div>
  );
}

function Row({ row: r, isA, onOpen }: { row: ScanRow; isA: boolean; onOpen: (symbol: string) => void }) {
  const style = STATUS_STYLE[r.status];
  return (
    <tr
      onClick={() => onOpen(r.symbol)}
      className={`cursor-pointer border-b border-[#1E2631]/60 hover:bg-[#00E5FF]/5 ${r.passes ? "" : "opacity-50"}`}
      title={`Open ${r.base}/USDT on 4h${r.passes ? "" : " (no volume confirmation)"}`}
    >
      <td className="px-3 py-1.5 text-slate-100">
        <span className="font-semibold">{r.base}</span>
        <span className="ml-1.5 text-[10px] text-slate-500">{r.rank === null ? "—" : `#${r.rank}`}</span>
      </td>
      <td className="px-2 py-1.5">
        <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${style.cls}`}>
          {style.label}
          {r.exitReason === "stop" ? " · STOP" : r.exitReason === "trail" ? " · TRAIL" : ""}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right text-slate-200">{formatPrice(r.entryPrice, r.precision)}</td>
      <td className={`px-2 py-1.5 text-right ${isA ? "text-amber-300/80" : "text-[#FF2D55]/80"}`}>{formatPrice(r.stopPrice, r.precision)}</td>
      <td className="px-2 py-1.5 text-right text-slate-300">{formatPrice(r.lastPrice, r.precision)}</td>
      <td className={`px-2 py-1.5 text-right ${r.ret >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>{r.status === "entry" ? "—" : pct(r.ret)}</td>
      <td className="px-2 py-1.5 text-right text-slate-400">{r.barsHeld}</td>
      {isA && <td className={`px-2 py-1.5 text-right ${r.passes ? "text-[#00FFA3]" : "text-slate-500"}`}>{r.surge === null ? "—" : `${r.surge.toFixed(1)}×`}</td>}
      {isA && (
        <td className={`px-2 py-1.5 text-right ${r.rs30d === null ? "text-slate-500" : r.rs30d < SETUP_A.maxRs ? "text-[#00FFA3]" : r.rs30d >= 0 ? "text-[#FF2D55]" : "text-slate-300"}`}>
          {r.rs30d === null ? "—" : pct(r.rs30d, 0)}
        </td>
      )}
      <td className="px-2 py-1.5 text-right text-slate-400">{formatUsdCompact(r.liquidity30d)}</td>
      <td className="px-3 py-1.5 text-right text-slate-500">
        {r.record.count ? `${r.record.count} · ${(r.record.winRate * 100).toFixed(0)}% · ${pct(r.record.avgRet)}` : "—"}
      </td>
    </tr>
  );
}
