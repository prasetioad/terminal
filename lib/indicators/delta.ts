import { CandlestickSeries, type CandlestickData, type Time, type WhitespaceData } from "lightweight-charts";
import { FLOW_SOURCE_PARAMS, flowSummary, selectFlow, updateSeriesFrom } from "./common";
import { formatSigned } from "../format";
import type { IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

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

export interface DeltaCandle {
  close: number;
  high: number;
  low: number;
  /** Whether high/low come from the intrabar path (bars seen live), not just the body. */
  ranged: boolean;
}

/**
 * Bar `i`'s delta as a candle: it opens at 0 and closes at the bar's delta; the wicks
 * reach the highest and lowest the running delta went inside the bar. A wick beyond
 * the close is delta that was pushed back (pressure absorbed); a wick on the other
 * side of zero is the opposite side leading before the bar turned. History has no
 * intrabar path, so those bars have no wicks.
 */
export function barDeltaCandle(data: IndicatorData, params: IndicatorParams, i: number): DeltaCandle | null {
  const close = barDelta(data, params, i);
  if (close === null) return null;
  const c = data.candles[i];
  const range = data.flow.deltaRange(c.time, selectFlow(params, data).sources);
  const scale = params.unit === "usd" ? c.close : 1;
  return {
    close,
    high: Math.max(0, close, (range?.high ?? 0) * scale),
    low: Math.min(0, close, (range?.low ?? 0) * scale),
    ranged: range !== null,
  };
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
  description:
    "Aggressive buy minus aggressive sell volume per bar. Positive bars mean market buyers dominated; wicks show how far delta went inside the bar before it was pushed back.",
  category: "Orderflow",
  placement: "pane",
  usesFlow: true,
  params: [
    ...FLOW_SOURCE_PARAMS,
    UNIT_PARAM,
    { key: "wicks", label: "Wicks (intrabar delta high / low, live bars)", type: "boolean", default: true },
  ],
  summary: (p) => `${flowSummary(p)}${p.unit === "usd" ? " · USD" : ""}`,

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    const series = ctx.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
    });

    const point = (data: IndicatorData, i: number): CandlestickData<Time> | WhitespaceData<Time> => {
      const time = data.candles[i].time;
      const bar = barDeltaCandle(data, params, i);
      if (!bar) return { time };
      const { close } = bar;
      return params.wicks
        ? { time, open: 0, close, high: bar.high, low: bar.low }
        : { time, open: 0, close, high: Math.max(0, close), low: Math.min(0, close) };
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
        const bar = barDeltaCandle(data, params, index);
        if (!bar) return [];
        const values: LegendValue[] = [{ text: formatSigned(bar.close), color: bar.close >= 0 ? "#00FFA3" : "#FF2D55" }];
        if (params.wicks && bar.ranged) {
          values.push({ label: "H", text: formatSigned(bar.high), color: "#00FFA3" });
          values.push({ label: "L", text: formatSigned(bar.low), color: "#FF2D55" });
        }
        return values;
      },
      destroy() {},
    };
  },
};
