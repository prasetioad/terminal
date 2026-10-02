import type { ISeriesApi, SeriesType, Time, WhitespaceData } from "lightweight-charts";
import { logicalToX, timeToLogical } from "../chart/timeAxis";
import type { DrawScope } from "../chart/CanvasPrimitive";
import { ALL_SOURCES, splitSource, type SourceId } from "../venues";
import type { IndicatorData, IndicatorParams, ParamSpec } from "./types";

/* ───────────────────── flow source selection (Delta / CVD) ───────────────────── */

export const FLOW_SOURCE_PARAMS: readonly ParamSpec[] = [
  {
    key: "venues",
    label: "Venues",
    type: "select",
    default: "binance",
    options: [
      { value: "binance", label: "Binance (with history)" },
      { value: "all", label: "All venues (live since load)" },
    ],
  },
  {
    key: "market",
    label: "Market",
    type: "select",
    default: "spot",
    options: [
      { value: "spot", label: "Spot" },
      { value: "perp", label: "Perpetual" },
      { value: "both", label: "Spot + Perpetual" },
    ],
  },
];

export interface FlowSelection {
  sources: SourceId[];
  /** First bar (seconds) the selection is fully covered; earlier bars stay empty. */
  startTime: number;
}

/**
 * Binance spot and perp come with kline history. Other venues exist only from the
 * moment streaming started, so an all-venue series starts there instead of mixing
 * partial history into it.
 */
export function selectFlow(params: IndicatorParams, data: IndicatorData): FlowSelection {
  const binanceOnly = params.venues === "binance";
  const sources = flowSources(binanceOnly, params.market as FlowMarket);
  return { sources, startTime: binanceOnly ? Number.NEGATIVE_INFINITY : data.flow.liveStart };
}

type FlowMarket = "spot" | "perp" | "both";

function flowSources(binanceOnly: boolean, market: FlowMarket): SourceId[] {
  return ALL_SOURCES.filter((s) => {
    const { venue, market: m } = splitSource(s);
    return (market === "both" || m === market) && (!binanceOnly || venue === "binance");
  });
}

/** Every source set the flow params can select: the groups whose intrabar delta path is recorded. */
export const FLOW_SELECTIONS: readonly SourceId[][] = [true, false].flatMap((binanceOnly) =>
  (["spot", "perp", "both"] as const).map((market) => flowSources(binanceOnly, market)),
);

export function flowSummary(params: IndicatorParams): string {
  const venues = params.venues === "binance" ? "Binance" : "All venues";
  const market = params.market === "both" ? "Spot+Perp" : params.market === "perp" ? "Perp" : "Spot";
  return `${venues} · ${market}`;
}

/** Index of the first bar at or after `time` (seconds). */
export function firstIndexFrom(data: IndicatorData, time: number): number {
  const { candles } = data;
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ─────────────────────────── series helpers ─────────────────────────── */

/**
 * Push bars [from, n) to a series that already holds one point per candle.
 * Older bars use lightweight-charts' historical update; the last bar is a plain update.
 */
export function updateSeriesFrom<T extends SeriesType, P extends WhitespaceData<Time>>(
  series: ISeriesApi<T>,
  n: number,
  from: number,
  pointAt: (index: number) => P,
): void {
  for (let i = Math.max(0, from); i < n; i++) {
    series.update(pointAt(i) as Parameters<ISeriesApi<T>["update"]>[0], i < n - 1);
  }
}

/* ─────────────────────────── canvas helpers ─────────────────────────── */

/** X coordinate of a wall-clock time on the price pane, or null without data. */
export function xAtTime(scope: DrawScope, data: IndicatorData, ms: number): number | null {
  const logical = timeToLogical(data.candles, data.intervalMs, ms);
  return logical === null ? null : logicalToX(scope.chart.timeScale(), logical);
}

/** Visible bar index range, clamped to the data. */
export function visibleBars(scope: DrawScope, data: IndicatorData): { from: number; to: number } | null {
  const range = scope.chart.timeScale().getVisibleLogicalRange();
  if (!range || data.candles.length === 0) return null;
  const from = Math.max(0, Math.ceil(range.from));
  const to = Math.min(data.candles.length - 1, Math.floor(range.to));
  return to >= from ? { from, to } : null;
}

export const withAlpha = (rgb: string, alpha: number) => `rgba(${rgb}, ${alpha})`;

/** "#00E5FF" → "0, 229, 255" */
export function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
