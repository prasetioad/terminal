import { HistogramSeries, type HistogramData, type Time } from "lightweight-charts";
import { updateSeriesFrom } from "./common";
import { formatSigned } from "../format";
import type { IndicatorDefinition, IndicatorParams } from "./types";
import type { Candle } from "../types";

const UP = "rgba(0, 255, 163, 0.28)";
const DOWN = "rgba(255, 45, 85, 0.28)";
const SCALE_ID = "volume";

export const volumeIndicator: IndicatorDefinition = {
  type: "volume",
  name: "Volume",
  description: "Traded volume per bar at the bottom of the price pane, coloured by bar direction or by which side was more aggressive.",
  category: "Orderflow",
  placement: "overlay",
  params: [
    {
      key: "colorBy",
      label: "Colour by",
      type: "select",
      default: "candle",
      options: [
        { value: "candle", label: "Bar direction" },
        { value: "delta", label: "Aggressor (taker buy vs sell)" },
      ],
    },
  ],
  summary: (p) => (p.colorBy === "delta" ? "Aggressor" : ""),

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    const series = ctx.addSeries(HistogramSeries, {
      priceScaleId: SCALE_ID,
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    ctx.chart.priceScale(SCALE_ID).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const buyDominant = (c: Candle) => (params.colorBy === "delta" ? c.buyVolume * 2 >= c.volume : c.close >= c.open);
    const point = (c: Candle): HistogramData<Time> => ({ time: c.time, value: c.volume, color: buyDominant(c) ? UP : DOWN });

    return {
      render(data) {
        series.setData(data.candles.map(point));
      },
      update(data, from) {
        updateSeriesFrom(series, data.candles.length, from, (i) => point(data.candles[i]));
      },
      setParams(next) {
        params = next;
      },
      setVisible(visible) {
        series.applyOptions({ visible });
      },
      legend(data, index) {
        const c = data.candles[index];
        if (!c) return [];
        return [
          { text: formatSigned(c.volume).replace("+", ""), color: "#94A3B8" },
          { label: "Δ", text: formatSigned(c.buyVolume * 2 - c.volume), color: buyDominant(c) ? "#00FFA3" : "#FF2D55" },
        ];
      },
      destroy() {},
    };
  },
};
