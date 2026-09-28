"use client";

import { PRESSURE_RANGES, type PressureRange } from "@/hooks/useTakerPressure";
import { formatUsdCompact } from "@/lib/format";
import type { Pressure } from "@/lib/tradeLog";

interface PressureBarProps {
  base: string;
  pressure: Pressure;
  range: PressureRange;
  onRangeChange: (range: PressureRange) => void;
}

/** Below this net share of total volume, neither side is called dominant. */
const BALANCED_SHARE = 0.05;

type Dominance = "buy" | "sell" | "balanced" | "idle";

const DOMINANCE = {
  buy: { label: "Buy pressure", text: "text-[#00FFA3]", dot: "bg-[#00FFA3] shadow-[0_0_8px_#00FFA3]" },
  sell: { label: "Sell pressure", text: "text-[#FF2D55]", dot: "bg-[#FF2D55] shadow-[0_0_8px_#FF2D55]" },
  balanced: { label: "Balanced", text: "text-slate-300", dot: "bg-amber-400 shadow-[0_0_8px_#fbbf24]" },
  idle: { label: "No prints", text: "text-slate-500", dot: "bg-slate-600" },
} as const satisfies Record<Dominance, { label: string; text: string; dot: string }>;

function dominanceOf({ buyUsd, sellUsd }: Pressure): Dominance {
  const total = buyUsd + sellUsd;
  if (total === 0) return "idle";
  const netShare = (buyUsd - sellUsd) / total;
  if (Math.abs(netShare) < BALANCED_SHARE) return "balanced";
  return netShare > 0 ? "buy" : "sell";
}

/** Aggressive buy vs sell notional of the visible big trades, as a tug-of-war bar. */
export default function PressureBar({ base, pressure, range, onRangeChange }: PressureBarProps) {
  const { buyUsd, sellUsd } = pressure;
  const total = buyUsd + sellUsd;
  const net = buyUsd - sellUsd;
  const sellPct = total > 0 ? (sellUsd / total) * 100 : 50;
  const buyPct = 100 - sellPct;
  const dominance = dominanceOf(pressure);
  const style = DOMINANCE[dominance];
  const idle = dominance === "idle";

  return (
    <section className="border-b border-[#1E2631] px-4 pb-3 pt-2.5" aria-label="Taker pressure">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${idle ? "" : "animate-pulse"}`} />
          Taker pressure · {base}
        </h2>
        <div className="flex shrink-0 overflow-hidden rounded border border-[#1E2631]" role="group" aria-label="Pressure range">
          {(Object.keys(PRESSURE_RANGES) as PressureRange[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onRangeChange(key)}
              aria-pressed={range === key}
              className={`px-1.5 py-px font-mono text-[9px] uppercase transition-colors ${
                range === key ? "bg-[#00E5FF]/15 text-[#00E5FF]" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-baseline gap-2 whitespace-nowrap font-mono">
        <span className={`text-sm font-semibold tabular-nums ${style.text}`}>
          {idle ? "Net: —" : `Net: ${net >= 0 ? "↑" : "↓"} ${formatUsdCompact(Math.abs(net))}`}
        </span>
        <span className={`text-[9px] uppercase tracking-wider ${style.text}`}>{style.label}</span>
      </div>

      <div
        className={`relative mt-1.5 flex h-2.5 overflow-hidden rounded-full bg-[#1E2631] ${idle ? "" : "pressure-shimmer"}`}
        role="meter"
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

      <div className="mt-1.5 flex justify-between gap-2 whitespace-nowrap font-mono text-[10px] tabular-nums">
        <span className="text-[#FF2D55]/90">
          Sell {formatUsdCompact(sellUsd)}
          {!idle && <span className="text-slate-500"> · {sellPct.toFixed(0)}%</span>}
        </span>
        <span className="text-[#00FFA3]/90">
          {!idle && <span className="text-slate-500">{buyPct.toFixed(0)}% · </span>}
          {formatUsdCompact(buyUsd)} Buy
        </span>
      </div>
    </section>
  );
}
