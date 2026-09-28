"use client";

import { useEffect, useState } from "react";
import SourceList, { type SourceListProps } from "./SourceList";
import SymbolPicker from "./SymbolPicker";
import type { PairsStatus } from "@/hooks/usePairs";
import { formatPrice, formatUsdCompact, formatTime } from "@/lib/format";
import { STORE_FLOOR_USD } from "@/lib/tradeLog";
import { INTERVALS, type FlowStats, type IntervalKey, type Pair } from "@/lib/types";

interface ControlPanelProps {
  pairs: Pair[];
  pairsStatus: PairsStatus;
  pair: Pair;
  onSymbolChange: (symbol: string) => void;
  interval: IntervalKey;
  onIntervalChange: (i: IntervalKey) => void;
  threshold: number;
  onThresholdChange: (v: number) => void;
  bubbleScale: number;
  onBubbleScaleChange: (v: number) => void;
  audioOn: boolean;
  onToggleAudio: () => void;
  onClear: () => void;
  stats: FlowStats;
  sources: SourceListProps;
}

const MIN_USD = STORE_FLOOR_USD;
const MAX_USD = 5_000_000;
const SLIDER_STEPS = 1000;
const PRESETS = [50_000, 100_000, 250_000, 500_000, 1_000_000];

/** Log-scale slider: equal travel for 10K→100K and 100K→1M. */
const usdToSlider = (usd: number) =>
  Math.round((Math.log(usd / MIN_USD) / Math.log(MAX_USD / MIN_USD)) * SLIDER_STEPS);

const sliderToUsd = (v: number) => {
  const raw = MIN_USD * Math.pow(MAX_USD / MIN_USD, v / SLIDER_STEPS);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)) - 1); // snap to 2 significant digits
  return Math.round(raw / magnitude) * magnitude;
};

const clampUsd = (v: number) => Math.min(MAX_USD, Math.max(MIN_USD, Math.round(v)));

export default function ControlPanel(props: ControlPanelProps) {
  const { threshold, onThresholdChange, stats } = props;
  const [draft, setDraft] = useState(String(threshold));

  useEffect(() => setDraft(String(threshold)), [threshold]);

  const commitDraft = () => {
    const parsed = Number(draft.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) onThresholdChange(clampUsd(parsed));
    else setDraft(String(threshold));
  };

  const totalUsd = stats.buyUsd + stats.sellUsd;
  const buyShare = totalUsd > 0 ? (stats.buyUsd / totalUsd) * 100 : 50;
  const delta = stats.buyUsd - stats.sellUsd;

  return (
    <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto bg-[#0D1117] p-4">
      <Section title="Market">
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 flex flex-col gap-1">
            <span className="label">Pair · top {props.pairs.length} CMC</span>
            <SymbolPicker
              pairs={props.pairs}
              value={props.pair.symbol}
              onChange={props.onSymbolChange}
              status={props.pairsStatus}
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <span className="label">Timeframe</span>
            <div className="grid grid-cols-3 overflow-hidden rounded border border-[#1E2631]">
              {(Object.keys(INTERVALS) as IntervalKey[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => props.onIntervalChange(k)}
                  className={`py-1.5 font-mono text-xs transition-colors ${
                    props.interval === k
                      ? "bg-[#00E5FF]/15 text-[#00E5FF]"
                      : "bg-[#0B0E11] text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Big trade filter">
        <div className="flex items-center justify-between">
          <span className="label">Min USD threshold</span>
          <span className="font-mono text-sm font-semibold text-[#00E5FF]">{formatUsdCompact(threshold)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          value={usdToSlider(threshold)}
          onChange={(e) => onThresholdChange(sliderToUsd(Number(e.target.value)))}
          className="range w-full"
          aria-label="Minimum USD threshold"
        />
        <div className="flex justify-between font-mono text-[10px] text-slate-600">
          <span>{formatUsdCompact(MIN_USD)}</span>
          <span>{formatUsdCompact(MAX_USD)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">$</span>
          <input
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => e.key === "Enter" && commitDraft()}
            className="w-full rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1.5 font-mono text-xs tabular-nums text-slate-100 outline-none focus:border-[#00E5FF]/60"
            aria-label="Threshold in USD"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onThresholdChange(p)}
              className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                threshold === p
                  ? "border-[#00E5FF]/60 bg-[#00E5FF]/10 text-[#00E5FF]"
                  : "border-[#1E2631] text-slate-400 hover:border-slate-500 hover:text-slate-200"
              }`}
            >
              {formatUsdCompact(p)}
            </button>
          ))}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <span className="label">Bubble scale</span>
          <span className="font-mono text-xs text-slate-300">{props.bubbleScale.toFixed(1)}×</span>
        </div>
        <input
          type="range"
          min={0.4}
          max={2.5}
          step={0.1}
          value={props.bubbleScale}
          onChange={(e) => props.onBubbleScaleChange(Number(e.target.value))}
          className="range w-full"
          aria-label="Bubble scale"
        />
      </Section>

      <Section title="Sources">
        <SourceList {...props.sources} />
      </Section>

      <Section title="Controls">
        <button
          type="button"
          onClick={props.onToggleAudio}
          aria-pressed={props.audioOn}
          className="flex w-full items-center justify-between rounded border border-[#1E2631] bg-[#0B0E11] px-3 py-2 text-xs transition-colors hover:border-slate-500"
        >
          <span className="text-slate-300">Audio alerts</span>
          <span className={`relative h-4 w-8 rounded-full transition-colors ${props.audioOn ? "bg-[#00E5FF]/70" : "bg-[#1E2631]"}`}>
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${props.audioOn ? "left-4.5" : "left-0.5"}`}
            />
          </span>
        </button>
        <button
          type="button"
          onClick={props.onClear}
          className="w-full rounded border border-[#FF2D55]/40 bg-[#FF2D55]/10 px-3 py-2 text-xs font-medium uppercase tracking-wider text-[#FF2D55] transition-colors hover:bg-[#FF2D55]/20"
        >
          Clear data logs
        </button>
      </Section>

      <Section title="Session flow">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Aggr. buys" value={formatUsdCompact(stats.buyUsd)} sub={`${stats.buyCount} prints`} tone="buy" />
          <Metric label="Aggr. sells" value={formatUsdCompact(stats.sellUsd)} sub={`${stats.sellCount} prints`} tone="sell" />
        </div>
        <div>
          <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
            <span>Buy {buyShare.toFixed(0)}%</span>
            <span>Sell {(100 - buyShare).toFixed(0)}%</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-[#FF2D55]/70">
            <div className="bg-[#00FFA3] transition-[width] duration-300" style={{ width: `${buyShare}%` }} />
          </div>
        </div>
        <div className="flex items-center justify-between rounded border border-[#1E2631] bg-[#0B0E11] px-3 py-2">
          <span className="label">Net delta</span>
          <span className={`font-mono text-sm font-semibold tabular-nums ${delta >= 0 ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>
            {delta >= 0 ? "+" : ""}
            {formatUsdCompact(delta)}
          </span>
        </div>
        {stats.largest && (
          <div className="rounded border border-[#1E2631] bg-[#0B0E11] px-3 py-2 font-mono text-[11px]">
            <div className="label mb-1">Largest print</div>
            <div className="flex justify-between">
              <span className={stats.largest.side === "BUY" ? "text-[#00FFA3]" : "text-[#FF2D55]"}>
                {formatUsdCompact(stats.largest.usd)} {stats.largest.side}
              </span>
              <span className="text-slate-300">@ {formatPrice(stats.largest.price, props.pair.precision)}</span>
            </div>
            <div className="text-slate-500">{formatTime(stats.largest.time)}</div>
          </div>
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="border-b border-[#1E2631] pb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "buy" | "sell" }) {
  const color = tone === "buy" ? "text-[#00FFA3] border-[#00FFA3]/25" : "text-[#FF2D55] border-[#FF2D55]/25";
  return (
    <div className={`rounded border bg-[#0B0E11] px-2.5 py-2 ${color}`}>
      <div className="label">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
      <div className="font-mono text-[10px] text-slate-500">{sub}</div>
    </div>
  );
}
