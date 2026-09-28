import { HistogramSeries, type HistogramData, type Time, type WhitespaceData } from "lightweight-charts";
import { FLOW_SOURCE_PARAMS, flowSummary, selectFlow, updateSeriesFrom } from "./common";
import { formatSigned } from "../format";
import type { IndicatorData, IndicatorDefinition, IndicatorParams } from "./types";

const UP = "rgba(0, 255, 163, 0.75)";
const DOWN = "rgba(255, 45, 85, 0.75)";

/** Taker buy − sell for bar `i`, in coins or USD; null before the selection is covered. */
export function barDelta(data: IndicatorData, params: IndicatorParams, i: number): number | null {
  const { sources, startTime } = selectFlow(params, data);
  const c = data.candles[i];
  if (!c || c.time < startTime) return null;
  const coins = data.flow.delta(c.time, sources);
  return params.unit === "usd" ? coins * c.close : coins;
}

export const UNIT_PARAM = {
  key: "unit",
  label: "Unit",
  type: "select",
  default: "coin",
  options: [
    { value: "coin", label: "Coins" },
    { value: "usd", label: "USD (≈ × close)" },
  ],
} as const;

export const deltaIndicator: IndicatorDefinition = {
  type: "delta",
  name: "Delta",
  description: "Aggressive buy minus aggressive sell volume per bar. Positive bars mean market buyers dominated.",
  category: "Orderflow",
  placement: "pane",
  usesFlow: true,
  params: [...FLOW_SOURCE_PARAMS, UNIT_PARAM],
  summary: (p) => `${flowSummary(p)}${p.unit === "usd" ? " · USD" : ""}`,

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    const series = ctx.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false });

    const point = (data: IndicatorData, i: number): HistogramData<Time> | WhitespaceData<Time> => {
      const time = data.candles[i].time;
      const value = barDelta(data, params, i);
      return value === null ? { time } : { time, value, color: value >= 0 ? UP : DOWN };
    };

    return {
      render(data) {
        series.setData(data.candles.map((_, i) => point(data, i)));
      },
      update(data, from) {
        updateSeriesFrom(series, data.candles.length, from, (i) => point(data, i));
      },
      setParams(next) {
        params = next;
      },
      setVisible(visible) {
        series.applyOptions({ visible });
      },
      legend(data, index) {
        const value = barDelta(data, params, index);
        return value === null ? [] : [{ text: formatSigned(value), color: value >= 0 ? "#00FFA3" : "#FF2D55" }];
      },
      destroy() {},
    };
  },
};
