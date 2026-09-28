import { LineSeries, LineStyle, type LineData, type Time, type WhitespaceData } from "lightweight-charts";
import { FLOW_SOURCE_PARAMS, flowSummary, updateSeriesFrom } from "./common";
import { UNIT_PARAM, barDelta } from "./delta";
import { ANCHOR_OPTIONS, anchorStart, type AnchorKind } from "../sessions";
import { formatSigned } from "../format";
import type { IndicatorData, IndicatorDefinition, IndicatorParams } from "./types";

export const cvdIndicator: IndicatorDefinition = {
  type: "cvd",
  name: "Cumulative Volume Delta",
  description: "Running total of aggressive buy − sell volume. Rising CVD with flat price hints at absorption; divergence between CVD and price flags weakening moves.",
  category: "Orderflow",
  placement: "pane",
  usesFlow: true,
  params: [
    ...FLOW_SOURCE_PARAMS,
    UNIT_PARAM,
    { key: "reset", label: "Reset", type: "select", default: "day", options: ANCHOR_OPTIONS },
    { key: "color", label: "Colour", type: "color", default: "#00E5FF" },
  ],
  summary: (p) => {
    const reset = ANCHOR_OPTIONS.find((o) => o.value === p.reset)?.label ?? "";
    return `${flowSummary(p)} · reset ${reset.toLowerCase()}${p.unit === "usd" ? " · USD" : ""}`;
  },

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    const series = ctx.addSeries(LineSeries, {
      color: String(params.color),
      lineWidth: 2,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
    });
    series.createPriceLine({ price: 0, color: "rgba(148, 163, 184, 0.35)", lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });

    /** Cumulative value per bar (null = not covered), rebuilt from any bar onwards. */
    let cum: (number | null)[] = [];
    let anchors: number[] = [];

    const recompute = (data: IndicatorData, from: number) => {
      const { candles } = data;
      cum.length = anchors.length = candles.length;
      for (let i = Math.max(0, from); i < candles.length; i++) {
        anchors[i] = anchorStart(params.reset as AnchorKind, candles[i].time * 1000);
        const delta = barDelta(data, params, i);
        if (delta === null) {
          cum[i] = null;
          continue;
        }
        const prev = i > 0 && anchors[i - 1] === anchors[i] ? cum[i - 1] : null;
        cum[i] = (prev ?? 0) + delta;
      }
    };

    const point = (data: IndicatorData, i: number): LineData<Time> | WhitespaceData<Time> => {
      const time = data.candles[i].time;
      const value = cum[i];
      return value === null || value === undefined ? { time } : { time, value };
    };

    return {
      render(data) {
        cum = [];
        anchors = [];
        recompute(data, 0);
        series.setData(data.candles.map((_, i) => point(data, i)));
      },
      update(data, from) {
        recompute(data, from);
        updateSeriesFrom(series, data.candles.length, from, (i) => point(data, i));
      },
      setParams(next) {
        params = next;
        series.applyOptions({ color: String(params.color) });
      },
      setVisible(visible) {
        series.applyOptions({ visible });
      },
      legend(_data, index) {
        const value = cum[index];
        return value === null || value === undefined ? [] : [{ text: formatSigned(value), color: String(params.color) }];
      },
      destroy() {},
    };
  },
};
