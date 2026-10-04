import { LineSeries, LineStyle, createSeriesMarkers, type IPriceLine, type SeriesMarker, type Time } from "lightweight-charts";
import { stochastic } from "../setups/setupV1";
import type { IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

/**
 * Stochastic oscillator (%K smoothed, %D), TradingView-style, from the same function the
 * setups use. Optional markers flag a %K/%D cross up that starts below the oversold level
 * (the Setup v1 trigger) and a cross down that starts above the overbought level.
 */
export const stochasticIndicator: IndicatorDefinition = {
  type: "stochastic",
  name: "Stochastic",
  description:
    "%K (smoothed) and %D of the close within the recent high–low range. Markers flag a cross up starting below the oversold level (the Setup v1 trigger) and a cross down starting above the overbought level.",
  category: "Oscillator",
  placement: "pane",
  params: [
    { key: "kLength", label: "%K length", type: "number", default: 14, min: 1, max: 200, step: 1 },
    { key: "kSmooth", label: "%K smoothing", type: "number", default: 3, min: 1, max: 50, step: 1 },
    { key: "dSmooth", label: "%D smoothing", type: "number", default: 3, min: 1, max: 50, step: 1 },
    { key: "upper", label: "Overbought", type: "number", default: 80, min: 50, max: 100, step: 1 },
    { key: "lower", label: "Oversold", type: "number", default: 20, min: 0, max: 50, step: 1 },
    { key: "markers", label: "Cross markers", type: "boolean", default: true },
    { key: "kColor", label: "%K colour", type: "color", default: "#2962FF" },
    { key: "dColor", label: "%D colour", type: "color", default: "#FF6D00" },
  ],
  summary: (p) => `${p.kLength},${p.kSmooth},${p.dSmooth}`,

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    let k: number[] = [];
    let d: number[] = [];

    const quiet = { priceLineVisible: false, crosshairMarkerVisible: false } as const;
    const scale = { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) };
    const kSeries = ctx.addSeries(LineSeries, { ...quiet, ...scale, color: String(params.kColor), lineWidth: 2 });
    const dSeries = ctx.addSeries(LineSeries, { ...quiet, ...scale, color: String(params.dColor), lineWidth: 1 });
    const markers = createSeriesMarkers(kSeries, []);
    const level = (price: number, style: LineStyle) =>
      kSeries.createPriceLine({ price, color: "rgba(148, 163, 184, 0.45)", lineStyle: style, lineWidth: 1, axisLabelVisible: false });
    let levels: IPriceLine[] = [];

    const drawLevels = () => {
      for (const line of levels) kSeries.removePriceLine(line);
      levels = [level(Number(params.upper), LineStyle.Dashed), level(50, LineStyle.Dotted), level(Number(params.lower), LineStyle.Dashed)];
    };

    const draw = () => {
      if (!data) return;
      const { candles } = data;
      // Neutral 50 until the oscillator is defined: leave those bars empty.
      const first = Number(params.kLength) + Number(params.kSmooth) + Number(params.dSmooth) - 3;
      const s = stochastic(candles, Number(params.kLength), Number(params.kSmooth), Number(params.dSmooth));
      k = s.k;
      d = s.d;
      kSeries.setData(candles.map((c, i) => (i < first ? { time: c.time } : { time: c.time, value: k[i] })));
      dSeries.setData(candles.map((c, i) => (i < first ? { time: c.time } : { time: c.time, value: d[i] })));
      const list: SeriesMarker<Time>[] = [];
      if (params.markers) {
        for (let i = Math.max(1, first + 1); i < candles.length; i++) {
          const up = k[i] > d[i] && k[i - 1] <= d[i - 1] && Math.min(k[i - 1], d[i - 1]) < Number(params.lower);
          const down = k[i] < d[i] && k[i - 1] >= d[i - 1] && Math.max(k[i - 1], d[i - 1]) > Number(params.upper);
          if (up) list.push({ time: candles[i].time, position: "belowBar", shape: "circle", color: "#22c55e", size: 0.6 });
          if (down) list.push({ time: candles[i].time, position: "aboveBar", shape: "circle", color: "#ef4444", size: 0.6 });
        }
      }
      markers.setMarkers(visible ? list : []);
    };

    drawLevels();

    return {
      render(next) {
        data = next;
        draw();
      },
      setParams(next) {
        params = next;
        kSeries.applyOptions({ color: String(params.kColor) });
        dSeries.applyOptions({ color: String(params.dColor) });
        drawLevels();
        draw();
      },
      setVisible(v) {
        visible = v;
        kSeries.applyOptions({ visible: v });
        dSeries.applyOptions({ visible: v });
        draw();
      },
      legend(_data, index): LegendValue[] {
        if (k[index] === undefined) return [];
        return [
          { label: "K", text: k[index].toFixed(1), color: String(params.kColor) },
          { label: "D", text: d[index].toFixed(1), color: String(params.dColor) },
        ];
      },
      destroy() {
        markers.detach();
      },
    };
  },
};
