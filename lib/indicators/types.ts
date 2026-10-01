import type {
  IChartApi,
  ISeriesApi,
  SeriesDefinition,
  SeriesPartialOptionsMap,
  SeriesType,
} from "lightweight-charts";
import type { FlowStore } from "../flow";
import type { HeatmapStore } from "../heatmap/store";
import type { Candle } from "../types";

/* ─────────────────────────── parameters ─────────────────────────── */

export type ParamValue = number | string | boolean;
export type IndicatorParams = Record<string, ParamValue>;

interface ParamBase {
  key: string;
  label: string;
}

export type ParamSpec =
  | (ParamBase & { type: "number"; default: number; min: number; max: number; step: number })
  | (ParamBase & { type: "select"; default: string; options: readonly { value: string; label: string }[] })
  | (ParamBase & { type: "boolean"; default: boolean })
  | (ParamBase & { type: "color"; default: string });

/* ─────────────────────────── data & host ─────────────────────────── */

/** Everything an indicator may compute from. Arrays are shared, never copied. */
export interface IndicatorData {
  candles: readonly Candle[]; // chart source bars, chronological
  intervalMs: number;
  flow: FlowStore; // per-venue taker buy/sell per bar
  heatmap: HeatmapStore; // recorded order-book liquidity
  precision: number; // price decimals of the pair
  minMove: number; // tick size of the pair
}

/** What the host gives an indicator instance to put things on the chart. */
export interface IndicatorContext {
  chart: IChartApi;
  /** The candlestick series: attach price-pane primitives here. */
  priceSeries: ISeriesApi<"Candlestick">;
  /** Add a series in this indicator's pane (the price pane for overlays, its own pane otherwise). */
  addSeries<T extends SeriesType>(definition: SeriesDefinition<T>, options?: SeriesPartialOptionsMap[T]): ISeriesApi<T>;
}

/** An interactive colour-scale legend (e.g. the heatmap's min/max), CoinGlass-style. */
export interface ColorScaleState {
  mode: "auto" | "manual";
  /** Effective range the colours are stretched over, in USD. */
  min: number;
  max: number;
  /** Upper end of the slider: the largest value on screen, or `max` if that is larger. */
  domainMax: number;
  /** CSS gradient of the value → colour mapping from min to max. */
  gradient: string;
}

/** Which params hold a colour scale, so the legend can write the user's choice back. */
export interface ColorScaleParams {
  mode: string; // select param: "auto" | "manual"
  min: string; // number param
  max: string; // number param
}

export interface LegendValue {
  label?: string;
  text: string;
  color: string;
}

/** A live indicator on the chart. Created by its definition, driven by the host. */
export interface IndicatorInstance {
  /** Recompute and redraw everything (new dataset, new params, visibility change). */
  render(data: IndicatorData): void;
  /** Bars from `fromIndex` changed (live ticks). Defaults to a full render when omitted. */
  update?(data: IndicatorData, fromIndex: number): void;
  setParams(params: IndicatorParams): void;
  setVisible(visible: boolean): void;
  /** Values at bar `index` for the legend (the last bar when the crosshair is away). */
  legend?(data: IndicatorData, index: number): LegendValue[];
  /** Current colour scale, for indicators that declare `colorScaleParams`. */
  colorScale?(): ColorScaleState | null;
  /** Remove every series/primitive this instance added. */
  destroy(): void;
}

export type IndicatorPlacement = "overlay" | "pane";

export interface IndicatorDefinition {
  type: string;
  name: string;
  description: string;
  category: "Orderflow" | "Oscillator";
  placement: IndicatorPlacement;
  /** Whether live updates of other venues' flow (not only candles) affect it. */
  usesFlow?: boolean;
  params: readonly ParamSpec[];
  /** Params behind an interactive colour-scale legend, if the indicator has one. */
  colorScaleParams?: ColorScaleParams;
  /** Short parameter summary for the legend, e.g. "Binance · Spot · Daily". */
  summary(params: IndicatorParams): string;
  create(ctx: IndicatorContext, params: IndicatorParams): IndicatorInstance;
}

/** A saved indicator: survives reloads. */
export interface IndicatorConfig {
  uid: string;
  type: string;
  params: IndicatorParams;
  visible: boolean;
}

export function defaultParams(def: IndicatorDefinition): IndicatorParams {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/** Saved params merged over defaults, dropping keys the definition no longer has. */
export function resolveParams(def: IndicatorDefinition, saved: IndicatorParams): IndicatorParams {
  const params = defaultParams(def);
  for (const spec of def.params) {
    const value = saved[spec.key];
    if (typeof value === typeof spec.default) params[spec.key] = value;
  }
  return params;
}
