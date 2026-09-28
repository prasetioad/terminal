import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import { firstIndexFrom } from "./common";
import { indicatorDefinition } from "./registry";
import {
  resolveParams,
  type ColorScaleState,
  type IndicatorConfig,
  type IndicatorContext,
  type IndicatorData,
  type IndicatorDefinition,
  type IndicatorInstance,
  type LegendValue,
} from "./types";

interface Entry {
  config: IndicatorConfig;
  def: IndicatorDefinition;
  instance: IndicatorInstance;
  /** Series the host created for this instance (removed by the host on destroy). */
  series: ISeriesApi<SeriesType>[];
  paramsKey: string;
}

const PRICE_PANE_STRETCH = 3;
/** Beyond this many changed bars a full re-render beats bar-by-bar historical updates. */
const FULL_RENDER_BEYOND = 64;
const INDICATOR_PANE_STRETCH = 1;

/**
 * Runs the configured indicators on a chart: creates/removes instances (and their
 * panes), applies param and visibility changes in place, and forwards data updates.
 * Knows nothing about React; the chart component drives it.
 */
export class IndicatorManager {
  private readonly entries = new Map<string, Entry>();
  private data: IndicatorData | null = null;

  constructor(
    private readonly chart: IChartApi,
    private readonly priceSeries: ISeriesApi<"Candlestick">,
  ) {}

  /** Bring the chart in line with `configs` (order = pane order for new panes). */
  sync(configs: readonly IndicatorConfig[]): void {
    const wanted = new Set(configs.map((c) => c.uid));
    for (const uid of [...this.entries.keys()]) {
      if (!wanted.has(uid)) this.remove(uid);
    }

    for (const config of configs) {
      const def = indicatorDefinition(config.type);
      if (!def) continue; // saved config of an indicator that no longer exists
      const params = resolveParams(def, config.params);
      const paramsKey = JSON.stringify(params);
      const entry = this.entries.get(config.uid);

      if (!entry) {
        this.add(config, def, params, paramsKey);
        continue;
      }
      if (entry.paramsKey !== paramsKey) {
        entry.paramsKey = paramsKey;
        entry.instance.setParams(params);
        if (this.data) entry.instance.render(this.data);
      }
      if (entry.config.visible !== config.visible) entry.instance.setVisible(config.visible);
      entry.config = config;
    }
    this.layoutPanes();
  }

  /** New dataset: every indicator recomputes. */
  setData(data: IndicatorData): void {
    this.data = data;
    for (const e of this.entries.values()) e.instance.render(data);
  }

  /** Bars from `fromIndex` changed. */
  updateBars(data: IndicatorData, fromIndex: number): void {
    this.data = data;
    for (const e of this.entries.values()) this.updateEntry(e, data, fromIndex);
  }

  /** Taker flow changed from bucket `fromTime` (seconds); only flow-based indicators care. */
  updateFlow(data: IndicatorData, fromTime: number): void {
    this.data = data;
    const from = firstIndexFrom(data, fromTime);
    if (from >= data.candles.length) return;
    for (const e of this.entries.values()) if (e.def.usesFlow) this.updateEntry(e, data, from);
  }

  legend(uid: string, index: number): LegendValue[] {
    const e = this.entries.get(uid);
    if (!e || !this.data || !e.instance.legend || !e.config.visible) return [];
    return e.instance.legend(this.data, index);
  }

  /** Colour scale of an indicator that has one (and is visible). */
  colorScale(uid: string): ColorScaleState | null {
    const e = this.entries.get(uid);
    if (!e || !e.config.visible || !e.instance.colorScale) return null;
    return e.instance.colorScale();
  }

  /** Pane index of a pane indicator (for positioning its legend), null for overlays. */
  paneIndex(uid: string): number | null {
    const e = this.entries.get(uid);
    if (!e || e.def.placement !== "pane" || e.series.length === 0) return null;
    return e.series[0].getPane().paneIndex();
  }

  destroy(): void {
    for (const uid of [...this.entries.keys()]) this.remove(uid);
  }

  private updateEntry(e: Entry, data: IndicatorData, from: number): void {
    if (e.instance.update && data.candles.length - from <= FULL_RENDER_BEYOND) e.instance.update(data, from);
    else e.instance.render(data);
  }

  private add(config: IndicatorConfig, def: IndicatorDefinition, params: ReturnType<typeof resolveParams>, paramsKey: string) {
    const series: ISeriesApi<SeriesType>[] = [];
    const ctx: IndicatorContext = {
      chart: this.chart,
      priceSeries: this.priceSeries,
      addSeries: (definition, options) => {
        // Overlays share the price pane; a pane indicator gets a new pane at the bottom.
        const pane =
          def.placement === "overlay" ? 0 : series.length > 0 ? series[0].getPane().paneIndex() : this.chart.panes().length;
        const s = this.chart.addSeries(definition, options, pane);
        series.push(s as ISeriesApi<SeriesType>);
        return s;
      },
    };
    const instance = def.create(ctx, params);
    const entry: Entry = { config, def, instance, series, paramsKey };
    this.entries.set(config.uid, entry);
    if (!config.visible) instance.setVisible(false);
    if (this.data) instance.render(this.data);
  }

  private remove(uid: string): void {
    const e = this.entries.get(uid);
    if (!e) return;
    this.entries.delete(uid);
    e.instance.destroy();
    for (const s of e.series) this.chart.removeSeries(s);
  }

  private layoutPanes(): void {
    const panes = this.chart.panes();
    panes.forEach((pane, i) => pane.setStretchFactor(i === 0 ? PRICE_PANE_STRETCH : INDICATOR_PANE_STRETCH));
  }
}
