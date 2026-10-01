"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DrawingInspector, DrawingToolbar } from "./chart/DrawingTools";
import IndicatorPicker from "./chart/IndicatorPicker";
import IndicatorSettings from "./chart/IndicatorSettings";
import PriceChart, { type PriceChartHandle } from "./chart/PriceChart";
import Header from "./Header";
import ControlPanel from "./ControlPanel";
import PressurePanel from "./PressurePanel";
import TradeFeed from "./TradeFeed";
import { useAlertSound } from "@/hooks/useAlertSound";
import { useIndicators } from "@/hooks/useIndicators";
import { useHeatmapEngine } from "@/hooks/useHeatmapEngine";
import { useOrderflow } from "@/hooks/useOrderflow";
import { usePairs } from "@/hooks/usePairs";
import { useFlowPressure } from "@/hooks/useFlowPressure";
import { DrawingController } from "@/lib/drawings/controller";
import { heatmapSources } from "@/lib/indicators/heatmap";
import type { PressureRange } from "@/lib/pressure";
import type { TradeFilter } from "@/lib/tradeLog";
import { INTERVALS, type IntervalKey } from "@/lib/types";
import type { SourceId } from "@/lib/venues";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_THRESHOLD_USD = 50_000;

export default function OrderflowTerminal() {
  const { pairs, status: pairsStatus, unavailableSources } = usePairs();
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [interval, setIntervalKey] = useState<IntervalKey>("1m");
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_USD);
  const [bubbleScale, setBubbleScale] = useState(1);
  const [hiddenSources, setHiddenSources] = useState<ReadonlySet<SourceId>>(() => new Set());
  const [pressureRange, setPressureRange] = useState<PressureRange>("5m");

  const pair = pairs.find((p) => p.symbol === symbol) ?? pairs[0];
  const filter = useMemo<TradeFilter>(() => ({ minUsd: threshold, hiddenSources }), [threshold, hiddenSources]);

  const toggleSource = useCallback((source: SourceId) => {
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (!next.delete(source)) next.add(source);
      return next;
    });
  }, []);

  const chartRef = useRef<PriceChartHandle>(null);
  const alerts = useAlertSound(threshold);
  const market = useOrderflow({ pair, interval, filter, chartRef, onBigTrade: alerts.play });
  const pressure = useFlowPressure(market.log, market.tape, filter, pressureRange);

  const indicators = useIndicators();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const editing = indicators.configs.find((c) => c.uid === editingUid);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const closeSettings = useCallback(() => setEditingUid(null), []);

  // Order books stream only while a heatmap indicator needs them.
  const bookSources = useMemo(() => heatmapSources(indicators.configs), [indicators.configs]);
  const heatmap = useHeatmapEngine({ pair, sources: bookSources });

  // Drawings belong to a symbol and are saved per symbol.
  const [drawings] = useState(() => new DrawingController());
  useEffect(() => drawings.setSymbol(symbol), [drawings, symbol]);

  return (
    <div className="flex h-dvh min-h-[640px] flex-col bg-[#0B0E11] text-slate-200">
      <Header
        pair={pair}
        lastPrice={market.lastPrice}
        ticker={market.ticker}
        statuses={market.statuses}
        interval={interval}
        historyStatus={market.historyStatus}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-[#1E2631] lg:grid-cols-[272px_minmax(0,1fr)_380px]">
        <ControlPanel
          pairs={pairs}
          pairsStatus={pairsStatus}
          pair={pair}
          onSymbolChange={setSymbol}
          interval={interval}
          onIntervalChange={setIntervalKey}
          threshold={threshold}
          onThresholdChange={setThreshold}
          bubbleScale={bubbleScale}
          onBubbleScaleChange={setBubbleScale}
          audioOn={alerts.enabled}
          onToggleAudio={alerts.toggle}
          onClear={market.clearLog}
          stats={market.stats}
          sources={{
            listings: pair.listings,
            statuses: market.statuses,
            unavailable: unavailableSources,
            hidden: hiddenSources,
            onToggle: toggleSource,
          }}
        />

        <section className="relative order-first flex h-[60vh] min-h-[380px] bg-[#0B0E11] lg:order-none lg:h-auto">
          <DrawingToolbar controller={drawings} />
          <div className="relative min-w-0 flex-1">
            <PriceChart
              ref={chartRef}
              trades={market.trades}
              filter={filter}
              bubbleScale={bubbleScale}
              intervalMs={INTERVALS[interval]}
              precision={pair.precision}
              minMove={pair.minMove}
              flow={market.flow}
              heatmap={heatmap}
              indicators={indicators.configs}
              drawings={drawings}
              toolbar={<ChartToolbar threshold={threshold} onOpenIndicators={() => setPickerOpen(true)} />}
              onEditIndicator={setEditingUid}
              onToggleIndicator={indicators.toggleVisible}
              onRemoveIndicator={indicators.remove}
            />
            <DrawingInspector controller={drawings} />
          </div>
        </section>

        <div className="flex h-[480px] min-h-0 flex-col bg-[#0D1117] lg:h-auto">
          <PressurePanel
            base={pair.base}
            threshold={threshold}
            pressure={pressure}
            range={pressureRange}
            onRangeChange={setPressureRange}
          />
          <TradeFeed trades={market.feed} threshold={threshold} precision={pair.precision} />
        </div>
      </main>

      {pickerOpen && <IndicatorPicker active={indicators.configs} onAdd={indicators.add} onClose={closePicker} />}
      {editing && (
        <IndicatorSettings
          key={editing.uid}
          config={editing}
          onChange={(params) => indicators.updateParams(editing.uid, params)}
          onClose={closeSettings}
          getColorScale={() => chartRef.current?.colorScale(editing.uid) ?? null}
        />
      )}
    </div>
  );
}

/** Top-left of the chart: the indicator picker button and the bubble legend. */
function ChartToolbar({ threshold, onOpenIndicators }: { threshold: number; onOpenIndicators: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onOpenIndicators}
        className="flex items-center gap-1.5 rounded border border-[#1E2631] bg-[#0D1117]/90 px-2.5 py-1 text-xs text-slate-200 backdrop-blur hover:border-[#00E5FF]/50 hover:text-[#00E5FF]"
      >
        <span className="font-serif italic">ƒx</span> Indicators
      </button>
      <BubbleLegend threshold={threshold} />
    </div>
  );
}

function BubbleLegend({ threshold }: { threshold: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-[#1E2631] bg-[#0B0E11]/80 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 backdrop-blur">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full border border-[#00FFA3] bg-[#00FFA3]/25" /> Aggr. buy
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full border border-[#FF2D55] bg-[#FF2D55]/25" /> Aggr. sell
      </span>
      <span className="text-slate-500">≥ ${threshold.toLocaleString("en-US")}</span>
    </div>
  );
}
