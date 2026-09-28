"use client";

import { memo } from "react";
import VenueTag from "./VenueTag";
import { formatPrice, formatQty, formatTime, formatUsdCompact } from "@/lib/format";
import type { Trade } from "@/lib/types";

interface TradeFeedProps {
  trades: Trade[]; // newest first
  threshold: number;
  precision: number;
}

export default function TradeFeed({ trades, threshold, precision }: TradeFeedProps) {
  const maxUsd = trades.reduce((m, t) => (t.usd > m ? t.usd : m), threshold);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-[#1E2631] px-4 py-2.5">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Big trades · live</h2>
        <span className="font-mono text-[10px] text-slate-500">
          {trades.length} shown · ≥ {formatUsdCompact(threshold)}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse font-mono text-[11px] tabular-nums">
          <thead className="sticky top-0 z-10 bg-[#0D1117] text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="border-b border-[#1E2631]">
              <th className="w-[27%] px-3 py-2 text-left font-medium">Time</th>
              <th className="w-[23%] px-2 py-2 text-right font-medium">Price</th>
              <th className="w-[17%] px-2 py-2 text-right font-medium">Size</th>
              <th className="w-[15%] px-2 py-2 text-right font-medium">Side</th>
              <th className="w-[18%] px-3 py-2 text-right font-medium">Venue</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <FeedRow key={t.id} trade={t} maxUsd={maxUsd} precision={precision} />
            ))}
          </tbody>
        </table>
        {trades.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-slate-600">
            Waiting for prints ≥ {formatUsdCompact(threshold)}…
          </div>
        )}
      </div>
    </section>
  );
}

const FeedRow = memo(function FeedRow({
  trade,
  maxUsd,
  precision,
}: {
  trade: Trade;
  maxUsd: number;
  precision: number;
}) {
  const isBuy = trade.side === "BUY";
  // Size bar is log-scaled so mid-size prints are still visible next to a whale.
  const intensity = Math.min(1, Math.log10(1 + trade.usd / 10_000) / Math.log10(1 + maxUsd / 10_000));
  const tone = isBuy ? "0, 255, 163" : "255, 45, 85";

  return (
    <tr
      className={`feed-row border-b border-[#1E2631]/60 ${isBuy ? "feed-row-buy" : "feed-row-sell"}`}
      style={{
        backgroundImage: `linear-gradient(to left, rgba(${tone}, ${0.06 + 0.16 * intensity}) ${Math.round(intensity * 100)}%, transparent ${Math.round(intensity * 100)}%)`,
      }}
      title={`${formatQty(trade.qty)} @ ${formatPrice(trade.price, precision)}${trade.fills > 1 ? ` · ${trade.fills} fills` : ""}`}
    >
      <td className="px-3 py-1.5 text-slate-400">{formatTime(trade.time)}</td>
      <td className="truncate px-2 py-1.5 text-right text-slate-200">{formatPrice(trade.price, precision)}</td>
      <td className={`px-2 py-1.5 text-right font-semibold ${isBuy ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>
        {formatUsdCompact(trade.usd)}
      </td>
      <td className="px-2 py-1.5 text-right">
        <span
          className={`inline-block rounded px-1.5 py-px text-[10px] font-semibold ${
            isBuy ? "bg-[#00FFA3]/15 text-[#00FFA3]" : "bg-[#FF2D55]/15 text-[#FF2D55]"
          }`}
        >
          {trade.side}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right">
        <VenueTag source={trade.source} />
      </td>
    </tr>
  );
});
