"use client";

import type { FlowPressure } from "@/hooks/useFlowPressure";
import { formatUsdCompact } from "@/lib/format";
import {
  PRESSURE_RANGES,
  compareFlow,
  dominanceOf,
  type Alignment,
  type Dominance,
  type FlowComparison,
  type Pressure,
  type PressureRange,
} from "@/lib/pressure";

interface PressurePanelProps {
  base: string;
  threshold: number;
  pressure: FlowPressure;
  range: PressureRange;
  onRangeChange: (range: PressureRange) => void;
}

const DOMINANCE = {
  buy: { label: "Buy pressure", short: "↑ Buy", text: "text-[#00FFA3]", dot: "bg-[#00FFA3] shadow-[0_0_8px_#00FFA3]" },
  sell: { label: "Sell pressure", short: "↓ Sell", text: "text-[#FF2D55]", dot: "bg-[#FF2D55] shadow-[0_0_8px_#FF2D55]" },
  balanced: { label: "Balanced", short: "Balanced", text: "text-slate-300", dot: "bg-amber-400 shadow-[0_0_8px_#fbbf24]" },
  idle: { label: "No prints", short: "—", text: "text-slate-500", dot: "bg-slate-600" },
} as const satisfies Record<Dominance, { label: string; short: string; text: string; dot: string }>;

const ALIGNMENT = {
  with: {
    label: "With flow",
    badge: "border-[#00E5FF]/40 bg-[#00E5FF]/10 text-[#00E5FF]",
    hint: "Large trades push the same way as the rest of the market: conviction behind the move.",
  },
  against: {
    label: "Against flow",
    badge: "border-amber-400/40 bg-amber-400/10 text-amber-300",
    hint: "Large trades push against the rest of the market: absorption, or size positioning against the crowd.",
  },
  unclear: {
    label: "No clear read",
    badge: "border-[#1E2631] text-slate-400",
    hint: "One side is balanced, so there is no direction to compare.",
  },
  idle: {
    label: "Waiting",
    badge: "border-[#1E2631] text-slate-500",
    hint: "Not enough trades in this range yet.",
  },
} as const satisfies Record<Alignment, { label: string; badge: string; hint: string }>;

/**
 * Taker pressure of the large trades and of the whole market over one shared range,
 * plus whether the large trades go with or against everyone else.
 */
export default function PressurePanel({ base, threshold, pressure, range, onRangeChange }: PressurePanelProps) {
  const comparison = compareFlow(pressure.large, pressure.market);
  const largeNote = `≥ ${formatUsdCompact(threshold)}${comparison.alignment === "idle" ? "" : ` · ${(comparison.largeShare * 100).toFixed(0)}% vol`
    }`;

  return (
    <section className="border-b border-[#1E2631]" aria-label="Order pressure">
      {/* Rows wrap instead of overlapping when space runs short (narrow column, larger system font). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-2.5">
        <h2 className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Pressure · {base}
        </h2>
        <RangeSelector range={range} onChange={onRangeChange} />
      </div>
      <PressureMeter title="Market pressure" note="All trades" noteHint="Every print, whatever its size" pressure={pressure.market} />
      <PressureMeter title="Large pressure" note={largeNote} noteHint="Big trades only; % vol = their share of all traded volume" pressure={pressure.large} />
      <FlowAlignment comparison={comparison} />
    </section>
  );
}

function RangeSelector({ range, onChange }: { range: PressureRange; onChange: (range: PressureRange) => void }) {
  return (
    <div
      className="flex shrink-0 overflow-hidden rounded border border-[#1E2631]"
      role="group"
      aria-label="Pressure range"
      title="Applies to both large and market pressure"
    >
      {(Object.keys(PRESSURE_RANGES) as PressureRange[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={range === key}
          className={`px-1.5 py-px font-mono text-[9px] uppercase transition-colors ${range === key ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "text-slate-500 hover:text-slate-300"
            }`}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

interface PressureMeterProps {
  title: string;
  note: string;
  noteHint: string;
  pressure: Pressure;
}

/** Aggressive buy vs sell notional as a tug-of-war bar. */
function PressureMeter({ title, note, noteHint, pressure }: PressureMeterProps) {
  const { buyUsd, sellUsd } = pressure;
  const total = buyUsd + sellUsd;
  const net = buyUsd - sellUsd;
  const sellPct = total > 0 ? (sellUsd / total) * 100 : 50;
  const buyPct = 100 - sellPct;
  const style = DOMINANCE[dominanceOf(pressure)];
  const idle = total <= 0;

  return (
    <div className="px-4 pb-3 pt-2.5" role="group" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <h3 className="flex items-center gap-2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${idle ? "" : "animate-pulse"}`} />
          {title}
        </h3>
        <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-wider text-slate-500" title={noteHint}>
          {note}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 whitespace-nowrap font-mono">
        <span className={`text-sm font-semibold tabular-nums ${style.text}`}>
          {idle ? "Net: —" : `Net: ${net >= 0 ? "↑" : "↓"} ${formatUsdCompact(Math.abs(net))}`}
        </span>
        <span className={`text-[9px] uppercase tracking-wider ${style.text}`}>{style.label}</span>
      </div>

      <div
        className={`relative mt-1.5 flex h-2.5 overflow-hidden rounded-full bg-[#1E2631] ${idle ? "" : "pressure-shimmer"}`}
        role="meter"
        aria-label={`${title} buy share`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(buyPct)}
        aria-valuetext={`Buy ${buyPct.toFixed(0)}%, sell ${sellPct.toFixed(0)}%`}
      >
        {!idle && (
          <>
            <div
              className="h-full bg-gradient-to-r from-[#8F1D2C] to-[#FF2D55] transition-[width] duration-500 ease-out"
              style={{ width: `${sellPct}%` }}
            />
            <div
              className="h-full bg-gradient-to-r from-[#00FFA3] to-[#0B7A55] transition-[width] duration-500 ease-out"
              style={{ width: `${buyPct}%` }}
            />
          </>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 gap-y-0.5 whitespace-nowrap font-mono text-[10px] tabular-nums">
        <span className="text-[#FF2D55]/90">
          Sell {formatUsdCompact(sellUsd)}
          {!idle && <span className="text-slate-500"> · {sellPct.toFixed(0)}%</span>}
        </span>
        <span className="text-[#00FFA3]/90">
          {!idle && <span className="text-slate-500">{buyPct.toFixed(0)}% · </span>}
          {formatUsdCompact(buyUsd)} Buy
        </span>
      </div>
    </div>
  );
}

/** Large trades' direction against the rest of the tape (all trades minus the large ones). */
function FlowAlignment({ comparison: cmp }: { comparison: FlowComparison }) {
  const verdict = ALIGNMENT[cmp.alignment];

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-[#1E2631]/70 px-4 py-2 font-mono text-[10px]"
      role="status"
      aria-label="Large vs rest of market"
      title={`${verdict.hint} Compared with the rest of the market (all trades minus the large ones), since large trades are part of the market total.`}
    >
      <span className="flex items-center gap-1.5 whitespace-nowrap uppercase tracking-wider">
        <span className="text-slate-500">Large</span>
        <span className={DOMINANCE[cmp.large].text}>{DOMINANCE[cmp.large].short}</span>
        <span className="text-slate-600">vs rest</span>
        <span className={DOMINANCE[cmp.restDominance].text}>{DOMINANCE[cmp.restDominance].short}</span>
      </span>
      <span className={`ml-auto whitespace-nowrap rounded border px-1.5 py-px uppercase tracking-wider ${verdict.badge}`}>
        {verdict.label}
      </span>
    </div>
  );
}
