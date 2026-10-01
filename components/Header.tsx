"use client";

import { useEffect, useRef, useState } from "react";
import { formatPct, formatPrice, formatRank, formatUsdCompact } from "@/lib/format";
import { TONE_STYLE, summarizeFeeds } from "./connectionStatus";
import type { SourceStatuses } from "@/hooks/useMarketStreams";
import { INTERVAL_LABELS, type HistoryStatus, type IntervalKey, type Pair, type Ticker24h } from "@/lib/types";

interface HeaderProps {
  pair: Pair;
  lastPrice: number | null;
  ticker: Ticker24h | null;
  statuses: SourceStatuses;
  interval: IntervalKey;
  historyStatus: HistoryStatus;
}

export default function Header({ pair, lastPrice, ticker, statuses, interval, historyStatus }: HeaderProps) {
  const { base, precision } = pair;
  const price = lastPrice ?? ticker?.lastPrice ?? null;
  // Live 24h change: last trade vs the rolling window's open.
  const changePct = price !== null && ticker ? ((price - ticker.open) / ticker.open) * 100 : null;
  const tick = usePriceTick(price);
  const feeds = summarizeFeeds(statuses);
  const tone = TONE_STYLE[feeds.tone];

  return (
    <header className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-[#1E2631] bg-[#0D1117] px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded border border-[#00E5FF]/40 bg-[#00E5FF]/10 font-mono text-xs font-bold text-[#00E5FF]">
          OF
        </div>
        <div className="leading-tight">
          <div className="font-mono text-sm font-semibold tracking-wide text-slate-100">
            {base}
            <span className="text-slate-500">/USDT</span>
            <span className="ml-2 rounded bg-[#1E2631] px-1.5 py-0.5 text-[10px] text-slate-400">SPOT · {INTERVAL_LABELS[interval]}</span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
            {pair.name} · {pair.rank === null ? "Unranked" : `CMC ${formatRank(pair.rank)}`}
          </div>
        </div>
      </div>

      <div className="flex items-baseline gap-3">
        <span
          className={`font-mono text-2xl font-semibold tabular-nums transition-colors duration-300 ${
            tick === "up" ? "text-[#00FFA3]" : tick === "down" ? "text-[#FF2D55]" : "text-slate-100"
          }`}
        >
          {price !== null ? formatPrice(price, precision) : "—"}
        </span>
        <span
          className={`font-mono text-sm tabular-nums ${
            changePct === null ? "text-slate-500" : changePct >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"
          }`}
        >
          {changePct !== null ? formatPct(changePct) : "—"}
        </span>
      </div>

      <dl className="hidden gap-6 font-mono text-[11px] md:flex">
        <Stat label="24h High" value={ticker ? formatPrice(ticker.high, precision) : "—"} />
        <Stat label="24h Low" value={ticker ? formatPrice(ticker.low, precision) : "—"} />
        <Stat label="24h Vol" value={ticker ? formatUsdCompact(ticker.quoteVolume) : "—"} />
      </dl>

      <div className="ml-auto flex items-center gap-4 font-mono text-[11px]">
        {historyStatus !== "ready" && (
          <span className={historyStatus === "error" ? "text-amber-400" : "text-slate-500"}>
            {historyStatus === "loading" ? "Loading history…" : "History unavailable · live only"}
          </span>
        )}
        <span
          className="flex items-center gap-2 rounded border border-[#1E2631] bg-[#0B0E11] px-2.5 py-1"
          title="Connected feeds · per-venue detail in the Sources panel"
        >
          <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
          <span className={`uppercase tracking-wider ${tone.text}`}>{feeds.label}</span>
        </span>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="tabular-nums text-slate-200">{value}</dd>
    </div>
  );
}

/** Returns the direction of the last price change, fading back to neutral. */
function usePriceTick(price: number | null): "up" | "down" | null {
  const prev = useRef<number | null>(null);
  const [tick, setTick] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (price === null) {
      prev.current = null;
      return;
    }
    const before = prev.current;
    prev.current = price;
    if (before === null || price === before) return;
    setTick(price > before ? "up" : "down");
    const id = setTimeout(() => setTick(null), 600);
    return () => clearTimeout(id);
  }, [price]);

  return tick;
}
