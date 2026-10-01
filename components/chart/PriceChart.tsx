"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { BubblesPrimitive, type DrawnBubble } from "./BubblesPrimitive";
import { IndicatorLegendRow, type LegendRow } from "./IndicatorLegend";
import { timeFormatsFor } from "./timeFormat";
import VenueTag from "../VenueTag";
import type { DrawingController } from "@/lib/drawings/controller";
import type { FlowStore } from "@/lib/flow";
import type { HeatmapStore } from "@/lib/heatmap/store";
import { formatPrice, formatQty, formatTime, formatUsdFull } from "@/lib/format";
import { IndicatorManager } from "@/lib/indicators/manager";
import { indicatorDefinition } from "@/lib/indicators/registry";
import { resolveParams, type ColorScaleState, type IndicatorConfig, type IndicatorData } from "@/lib/indicators/types";
import { loadJson, saveJson } from "@/lib/storage";
import type { TradeFilter } from "@/lib/tradeLog";
import type { Candle, Trade } from "@/lib/types";

export interface PriceChartHandle {
  /**
   * Show a new dataset (symbol or timeframe changed). Replaces every bar and resets
   * the viewport, so the new price range is in view even if the user had zoomed,
   * panned or dragged the price axis (which turns price auto-scaling off).
   */
  loadCandles(candles: readonly Candle[]): void;
  /** Replace the bars of the current dataset (e.g. after trimming history), keeping the viewport. */
  setCandles(candles: readonly Candle[]): void;
  /** Push candles[fromIndex..] to the chart. Only the last bar or new bars may change. */
  updateCandles(candles: readonly Candle[], fromIndex: number): void;
  /** Taker flow changed from bucket `fromTime` (seconds): refresh flow indicators. */
  refreshFlow(fromTime: number): void;
  /** Repaint bubbles after the trades buffer changed. */
  refreshBubbles(): void;
  /** Live colour-scale state of an indicator (for its settings dialog). */
  colorScale(uid: string): ColorScaleState | null;
}

interface PriceChartProps {
  ref?: Ref<PriceChartHandle>;
  /** Shared, chronologically ordered buffer. Mutated in place by the owner. */
  trades: readonly Trade[];
  filter: TradeFilter;
  bubbleScale: number;
  intervalMs: number;
  precision: number;
  minMove: number;
  flow: FlowStore;
  heatmap: HeatmapStore;
  indicators: readonly IndicatorConfig[];
  drawings: DrawingController;
  /** Rendered first in the top-left overlay, above the indicator legends. */
  toolbar?: ReactNode;
  onEditIndicator: (uid: string) => void;
  onToggleIndicator: (uid: string) => void;
  onRemoveIndicator: (uid: string) => void;
}

/** Everything the chart allocates; lives exactly as long as the mounted component. */
interface ChartApi {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  bubbles: BubblesPrimitive;
  indicators: IndicatorManager;
}

interface PaneLegend {
  pane: number;
  top: number;
  rows: LegendRow[];
}

interface Legends {
  overlayRows: LegendRow[];
  paneLegends: PaneLegend[];
}

const NO_LEGENDS: Legends = { overlayRows: [], paneLegends: [] };
const LEGEND_COLLAPSED_KEY = "orderflow-terminal:legend-collapsed";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

const UP = "#00FFA3";
const DOWN = "#FF2D55";
const LEGEND_REFRESH_MS = 500;

const toCandle = (c: Candle): CandlestickData<Time> => ({
  time: c.time,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

function createPriceChart(container: HTMLElement): Omit<ChartApi, "indicators"> {
  // Canvas can't resolve CSS variables, so resolve the next/font family name up front.
  const monoFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim() || "monospace";

  const chart = createChart(container, {
    autoSize: true, // internal ResizeObserver, disconnected by chart.remove()
    layout: {
      background: { type: ColorType.Solid, color: "#0B0E11" },
      textColor: "#8B95A5",
      fontFamily: `${monoFamily}, ui-monospace, monospace`,
      fontSize: 11,
      attributionLogo: false,
      panes: { separatorColor: "#1E2631", separatorHoverColor: "rgba(0, 229, 255, 0.25)", enableResize: true },
    },
    localization: { timeFormatter: timeFormatsFor(60_000).timeFormatter }, // set per timeframe below
    grid: {
      vertLines: { color: "rgba(42, 52, 68, 0.35)" },
      horzLines: { color: "rgba(42, 52, 68, 0.35)" },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "rgba(0, 229, 255, 0.35)", style: LineStyle.Dashed, labelBackgroundColor: "#11161D" },
      horzLine: { color: "rgba(0, 229, 255, 0.35)", style: LineStyle.Dashed, labelBackgroundColor: "#11161D" },
    },
    rightPriceScale: { borderColor: "#1E2631", scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: {
      borderColor: "#1E2631",
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 10,
    },
  });

  const candles = chart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    borderUpColor: UP,
    borderDownColor: DOWN,
    wickUpColor: "rgba(0, 255, 163, 0.7)",
    wickDownColor: "rgba(255, 45, 85, 0.7)",
    priceLineColor: "#00E5FF",
  });

  const bubbles = new BubblesPrimitive();
  candles.attachPrimitive(bubbles);

  return { chart, candles, bubbles };
}

/** Back to the default view: every price scale auto-fits and the latest bar is in sight at default zoom. */
function resetViewport(chart: IChartApi): void {
  for (const pane of chart.panes()) {
    for (const series of pane.getSeries()) series.priceScale().applyOptions({ autoScale: true });
  }
  chart.timeScale().resetTimeScale();
}

export default function PriceChart({
  ref,
  trades,
  filter,
  bubbleScale,
  intervalMs,
  precision,
  minMove,
  flow,
  heatmap,
  indicators,
  drawings,
  toolbar,
  onEditIndicator,
  onToggleIndicator,
  onRemoveIndicator,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ChartApi | null>(null);
  const candlesRef = useRef<readonly Candle[]>([]);
  const envRef = useRef({ intervalMs, precision, minMove, flow, heatmap });
  const [hover, setHover] = useState<DrawnBubble | null>(null);
  const [crosshairIndex, setCrosshairIndex] = useState<number | null>(null);
  const [legendTick, setLegendTick] = useState(0);
  const [legends, setLegends] = useState<Legends>(NO_LEGENDS);
  const [legendCollapsed, setLegendCollapsed] = useState(() => loadJson(LEGEND_COLLAPSED_KEY, isBoolean) ?? false);
  useEffect(() => saveJson(LEGEND_COLLAPSED_KEY, legendCollapsed), [legendCollapsed]);

  useEffect(() => {
    envRef.current = { intervalMs, precision, minMove, flow, heatmap };
  }, [intervalMs, precision, minMove, flow, heatmap]);

  const dataFor = useCallback((): IndicatorData => ({ candles: candlesRef.current, ...envRef.current }), []);

  // Create the chart once; everything it allocates is released in cleanup.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = createPriceChart(container);
    const api: ChartApi = { ...base, indicators: new IndicatorManager(base.chart, base.candles) };
    drawings.attach(base.chart, base.candles, container);

    let hoveredId: string | null = null;
    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const hit = param.point ? api.bubbles.bubbleAt(param.point.x, param.point.y) : null;
      const id = hit?.trade.id ?? null;
      if (id !== hoveredId) {
        hoveredId = id;
        setHover(hit);
      }
      setCrosshairIndex(param.logical === undefined ? null : Math.round(param.logical));
    };
    api.chart.subscribeCrosshairMove(onCrosshairMove);
    apiRef.current = api;

    return () => {
      apiRef.current = null;
      api.chart.unsubscribeCrosshairMove(onCrosshairMove);
      drawings.detach();
      api.indicators.destroy();
      api.candles.detachPrimitive(api.bubbles);
      api.chart.remove(); // destroys canvases, listeners and the resize observer
    };
  }, [drawings]);

  // Indicator configuration → chart.
  useEffect(() => {
    apiRef.current?.indicators.sync(indicators);
    setLegendTick((t) => t + 1);
  }, [indicators]);

  // Time labels depend on the timeframe (daily bars are labelled by UTC date).
  useEffect(() => {
    const { timeFormatter, tickMarkFormatter, timeVisible } = timeFormatsFor(intervalMs);
    apiRef.current?.chart.applyOptions({ localization: { timeFormatter }, timeScale: { tickMarkFormatter, timeVisible } });
  }, [intervalMs]);

  // Push render settings into the bubble primitive without re-creating anything.
  useEffect(() => {
    const bubbles = apiRef.current?.bubbles;
    if (!bubbles) return;
    bubbles.trades = trades;
    bubbles.filter = filter;
    bubbles.scale = bubbleScale;
    bubbles.intervalMs = intervalMs;
    bubbles.refresh();
  }, [trades, filter, bubbleScale, intervalMs]);

  // Each pair has its own tick size (BTC 0.01, PEPE 0.00000001).
  useEffect(() => {
    apiRef.current?.candles.applyOptions({ priceFormat: { type: "price", precision, minMove } });
  }, [precision, minMove]);

  // Legend values follow live data even when the mouse is still.
  useEffect(() => {
    const id = setInterval(() => setLegendTick((t) => t + 1), LEGEND_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useImperativeHandle(ref, () => {
    const setCandles = (candles: readonly Candle[]) => {
      const api = apiRef.current;
      if (!api) return;
      candlesRef.current = candles;
      const data = dataFor();
      api.candles.setData(candles.map(toCandle));
      api.indicators.setData(data);
      drawings.setData(candles, data.intervalMs, data.precision, data.minMove);
      api.bubbles.refresh();
      setHover(null);
    };

    return {
      setCandles,
      loadCandles(candles) {
        setCandles(candles);
        if (apiRef.current) resetViewport(apiRef.current.chart);
      },
      updateCandles(candles, fromIndex) {
        const api = apiRef.current;
        if (!api) return;
        candlesRef.current = candles;
        for (let i = Math.max(0, fromIndex); i < candles.length; i++) api.candles.update(toCandle(candles[i]));
        const data = dataFor();
        api.indicators.updateBars(data, fromIndex);
        drawings.setData(candles, data.intervalMs, data.precision, data.minMove);
      },
      refreshFlow(fromTime) {
        apiRef.current?.indicators.updateFlow(dataFor(), fromTime);
      },
      refreshBubbles() {
        apiRef.current?.bubbles.refresh();
      },
      colorScale(uid) {
        return apiRef.current?.indicators.colorScale(uid) ?? null;
      },
    };
  }, [dataFor, drawings]);

  // Legend rows read chart layout and indicator values, so they are derived after render.
  useEffect(() => {
    const api = apiRef.current;
    const container = containerRef.current;
    if (!api || !container) return;
    setLegends(buildLegends(api, container, indicators, crosshairIndex, candlesRef.current.length));
  }, [indicators, crosshairIndex, legendTick]);

  const { overlayRows, paneLegends } = legends;
  const actions = { onEdit: onEditIndicator, onToggle: onToggleIndicator, onRemove: onRemoveIndicator };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />

      <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[70%] flex-col items-start gap-1">
        {toolbar && <div className="pointer-events-auto">{toolbar}</div>}
        {!legendCollapsed &&
          overlayRows.map((row) => <IndicatorLegendRow key={row.uid} row={row} {...actions} />)}
        {overlayRows.length > 0 && (
          <LegendToggle collapsed={legendCollapsed} count={overlayRows.length} onToggle={() => setLegendCollapsed((c) => !c)} />
        )}
      </div>

      {paneLegends.map(({ pane, top, rows }) => (
        <div key={pane} className="pointer-events-none absolute left-2 z-10 flex flex-col items-start" style={{ top: top + 4 }}>
          {rows.map((row) => (
            <IndicatorLegendRow key={row.uid} row={row} {...actions} />
          ))}
        </div>
      ))}

      {hover && <BubbleTooltip bubble={hover} precision={precision} />}
    </div>
  );
}

/** Overlays stack in the price pane; pane indicators sit at the top of their own pane. */
function buildLegends(
  api: ChartApi,
  container: HTMLDivElement,
  configs: readonly IndicatorConfig[],
  crosshairIndex: number | null,
  barCount: number,
): Legends {
  const overlayRows: LegendRow[] = [];
  const byPane = new Map<number, LegendRow[]>();

  const index = crosshairIndex !== null && crosshairIndex >= 0 && crosshairIndex < barCount ? crosshairIndex : barCount - 1;
  for (const config of configs) {
    const def = indicatorDefinition(config.type);
    if (!def) continue;
    const row: LegendRow = {
      uid: config.uid,
      name: def.name,
      summary: def.summary(resolveParams(def, config.params)),
      values: index >= 0 ? api.indicators.legend(config.uid, index) : [],
      visible: config.visible,
    };
    const pane = api.indicators.paneIndex(config.uid);
    if (pane === null) overlayRows.push(row);
    else byPane.set(pane, [...(byPane.get(pane) ?? []), row]);
  }

  const origin = container.getBoundingClientRect().top;
  const paneLegends = [...byPane].map(([pane, rows]) => {
    const el = api.chart.panes()[pane]?.getHTMLElement();
    return { pane, top: el ? el.getBoundingClientRect().top - origin : 0, rows };
  });
  return { overlayRows, paneLegends };
}

/** TradingView-style collapse / expand of the price-pane indicator list. */
function LegendToggle({ collapsed, count, onToggle }: { collapsed: boolean; count: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Show indicators" : "Hide indicators"}
      className="pointer-events-auto flex items-center gap-1 rounded border border-[#1E2631] bg-[#0B0E11]/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 backdrop-blur hover:border-slate-500 hover:text-slate-100"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden className={collapsed ? "rotate-180" : ""}>
        <path d="M6 15l6-6 6 6" />
      </svg>
      {collapsed && <span>{count} indicator{count === 1 ? "" : "s"}</span>}
    </button>
  );
}

function BubbleTooltip({ bubble, precision }: { bubble: DrawnBubble; precision: number }) {
  const { trade, x, y, r } = bubble;
  const isBuy = trade.side === "BUY";
  return (
    <div
      className="pointer-events-none absolute z-20 min-w-44 rounded-md border bg-[#0F141A]/95 px-3 py-2 font-mono text-[11px] shadow-xl backdrop-blur"
      style={{
        left: x + r + 10,
        top: Math.max(4, y - 44),
        borderColor: isBuy ? "rgba(0,255,163,0.5)" : "rgba(255,45,85,0.5)",
      }}
    >
      <div className={`mb-1 font-semibold tracking-widest ${isBuy ? "text-[#00FFA3]" : "text-[#FF2D55]"}`}>
        {isBuy ? "AGGRESSIVE BUY" : "AGGRESSIVE SELL"}
      </div>
      <div className="mb-1">
        <VenueTag source={trade.source} withName />
      </div>
      <Row label="Size" value={formatUsdFull(trade.usd)} />
      <Row label="Price" value={formatPrice(trade.price, precision)} />
      <Row label="Qty" value={formatQty(trade.qty)} />
      {trade.fills > 1 && <Row label="Fills" value={String(trade.fills)} />}
      <Row label="Time" value={formatTime(trade.time)} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-100">{value}</span>
    </div>
  );
}
