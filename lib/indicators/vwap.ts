import { LineSeries, LineStyle, type ISeriesApi, type LineData, type Time, type WhitespaceData } from "lightweight-charts";
import { hexToRgb, updateSeriesFrom, withAlpha } from "./common";
import { formatPrice } from "../format";
import { ANCHOR_OPTIONS, anchorStart, type AnchorKind } from "../sessions";
import type { IndicatorData, IndicatorDefinition, IndicatorParams } from "./types";

const BAND_MULTIPLIERS = [1, 2] as const;

export const vwapIndicator: IndicatorDefinition = {
  type: "vwap",
  name: "VWAP",
  description: "Volume-weighted average price since the anchor (day, week or a session open), with optional standard-deviation bands.",
  category: "Orderflow",
  placement: "overlay",
  params: [
    { key: "anchor", label: "Anchor", type: "select", default: "day", options: ANCHOR_OPTIONS.filter((o) => o.value !== "none") },
    {
      key: "bands",
      label: "Bands",
      type: "select",
      default: "1",
      options: [
        { value: "0", label: "None" },
        { value: "1", label: "±1σ" },
        { value: "2", label: "±1σ and ±2σ" },
      ],
    },
    { key: "color", label: "Colour", type: "color", default: "#F5C542" },
  ],
  summary: (p) => ANCHOR_OPTIONS.find((o) => o.value === p.anchor)?.label ?? "",

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    const vwap = ctx.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
    // Upper/lower band per multiplier.
    const bands: [ISeriesApi<"Line">, ISeriesApi<"Line">][] = BAND_MULTIPLIERS.map(() => [
      ctx.addSeries(LineSeries, { lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      ctx.addSeries(LineSeries, { lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    ]);

    // Running sums per bar, reset at each anchor.
    let sumPV: number[] = [];
    let sumV: number[] = [];
    let sumP2V: number[] = [];
    let anchors: number[] = [];

    const applyStyle = () => {
      const rgb = hexToRgb(String(params.color));
      vwap.applyOptions({ color: String(params.color), visible });
      const shown = Number(params.bands);
      bands.forEach((pair, k) =>
        pair.forEach((s) => s.applyOptions({ color: withAlpha(rgb, k === 0 ? 0.55 : 0.35), visible: visible && k < shown })),
      );
    };
    applyStyle();

    const recompute = (data: IndicatorData, from: number) => {
      const { candles } = data;
      for (let i = Math.max(0, from); i < candles.length; i++) {
        const c = candles[i];
        anchors[i] = anchorStart(params.anchor as AnchorKind, c.time * 1000);
        const fresh = i === 0 || anchors[i - 1] !== anchors[i];
        const typical = (c.high + c.low + c.close) / 3;
        sumPV[i] = (fresh ? 0 : sumPV[i - 1]) + typical * c.volume;
        sumV[i] = (fresh ? 0 : sumV[i - 1]) + c.volume;
        sumP2V[i] = (fresh ? 0 : sumP2V[i - 1]) + typical * typical * c.volume;
      }
      sumPV.length = sumV.length = sumP2V.length = anchors.length = candles.length;
    };

    const valueAt = (i: number): { mean: number; sd: number } | null => {
      if (!(sumV[i] > 0)) return null;
      const mean = sumPV[i] / sumV[i];
      return { mean, sd: Math.sqrt(Math.max(0, sumP2V[i] / sumV[i] - mean * mean)) };
    };

    const point = (data: IndicatorData, i: number, offset: number): LineData<Time> | WhitespaceData<Time> => {
      const time = data.candles[i].time;
      const v = valueAt(i);
      return v ? { time, value: v.mean + offset * v.sd } : { time };
    };

    const push = (data: IndicatorData, from: number | null) => {
      const n = data.candles.length;
      const each = (series: ISeriesApi<"Line">, offset: number) =>
        from === null
          ? series.setData(data.candles.map((_, i) => point(data, i, offset)))
          : updateSeriesFrom(series, n, from, (i) => point(data, i, offset));
      each(vwap, 0);
      bands.forEach(([upper, lower], k) => {
        each(upper, BAND_MULTIPLIERS[k]);
        each(lower, -BAND_MULTIPLIERS[k]);
      });
    };

    return {
      render(data) {
        sumPV = [];
        sumV = [];
        sumP2V = [];
        anchors = [];
        recompute(data, 0);
        push(data, null);
      },
      update(data, from) {
        recompute(data, from);
        push(data, from);
      },
      setParams(next) {
        params = next;
        applyStyle();
      },
      setVisible(next) {
        visible = next;
        applyStyle();
      },
      legend(data, index) {
        const v = valueAt(index);
        return v ? [{ text: formatPrice(v.mean, data.precision), color: String(params.color) }] : [];
      },
      destroy() {},
    };
  },
};
