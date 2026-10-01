import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { logicalToTime } from "../chart/timeAxis";
import { formatPrice } from "../format";
import { HIDDEN_ON_TIMEFRAME, SESSIONS, sessionWindows, spansEnoughBars, type SessionId } from "../sessions";
import { firstIndexFrom, xAtTime } from "./common";
import type { IndicatorData, IndicatorDefinition, IndicatorParams } from "./types";

const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

export const sessionsIndicator: IndicatorDefinition = {
  type: "sessions",
  name: "Sessions",
  description: "Shades the Asia (Tokyo), London and New York sessions in their local exchange hours (daylight saving handled), with each session's high and low.",
  category: "Orderflow",
  placement: "overlay",
  params: [
    ...SESSIONS.map((s) => ({ key: s.id, label: s.name, type: "boolean" as const, default: true })),
    { key: "showRange", label: "Session high / low", type: "boolean", default: true },
    { key: "showLabels", label: "Labels", type: "boolean", default: true },
  ],
  summary: (p) =>
    SESSIONS.filter((s) => p[s.id])
      .map((s) => s.name)
      .join(" · "),

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;

    const enabled = () => new Set(SESSIONS.filter((s) => params[s.id]).map((s) => s.id as SessionId));

    const paint = (scope: DrawScope) => {
      if (!visible || !data || data.candles.length === 0) return;
      const d = data;
      const range = scope.chart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      const fromMs = logicalToTime(d.candles, d.intervalMs, range.from);
      const toMs = logicalToTime(d.candles, d.intervalMs, range.to);
      if (fromMs === null || toMs === null) return;
      const { ctx, series, height, width } = scope;
      ctx.font = FONT;

      for (const w of sessionWindows(fromMs, toMs, enabled())) {
        if (!spansEnoughBars(w.end - w.start, d.intervalMs)) continue;
        const x0 = xAtTime(scope, d, w.start);
        const x1 = xAtTime(scope, d, w.end);
        if (x0 === null || x1 === null || x1 < 0 || x0 > width) continue;
        const rgb = w.def.color;
        ctx.fillStyle = `rgba(${rgb}, 0.05)`;
        ctx.fillRect(x0, 0, x1 - x0, height);
        ctx.fillStyle = `rgba(${rgb}, 0.55)`;
        ctx.fillRect(x0, 0, x1 - x0, 2);
        if (params.showLabels) {
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillStyle = `rgba(${rgb}, 0.85)`;
          ctx.fillText(w.def.name, x0 + 4, 5);
        }
        if (!params.showRange) continue;

        const from = firstIndexFrom(d, w.start / 1000);
        const to = firstIndexFrom(d, w.end / 1000) - 1;
        if (to < from) continue;
        let high = Number.NEGATIVE_INFINITY;
        let low = Number.POSITIVE_INFINITY;
        for (let i = from; i <= to; i++) {
          high = Math.max(high, d.candles[i].high);
          low = Math.min(low, d.candles[i].low);
        }
        ctx.strokeStyle = `rgba(${rgb}, 0.6)`;
        ctx.setLineDash([3, 3]);
        for (const [price, tag] of [[high, "H"], [low, "L"]] as const) {
          const y = series.priceToCoordinate(price);
          if (y === null) continue;
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(y) + 0.5);
          ctx.lineTo(x1, Math.round(y) + 0.5);
          ctx.stroke();
          if (params.showLabels) {
            ctx.textAlign = "right";
            ctx.textBaseline = tag === "H" ? "bottom" : "top";
            ctx.fillStyle = `rgba(${rgb}, 0.9)`;
            ctx.fillText(`${w.def.name} ${tag} ${formatPrice(price, d.precision)}`, x1 - 4, y + (tag === "H" ? -2 : 2));
          }
        }
        ctx.setLineDash([]);
      }
    };

    const primitive = new CanvasPrimitive(paint, "bottom");
    ctx.priceSeries.attachPrimitive(primitive);

    return {
      render(next) {
        data = next;
        primitive.refresh();
      },
      update(next) {
        data = next;
        primitive.refresh();
      },
      setParams(next) {
        params = next;
        primitive.refresh();
      },
      setVisible(next) {
        visible = next;
        primitive.refresh();
      },
      legend(d) {
        const now = Date.now();
        const today = sessionWindows(now - 86_400_000, now + 86_400_000, enabled());
        if (today.length && today.every((w) => !spansEnoughBars(w.end - w.start, d.intervalMs))) return [HIDDEN_ON_TIMEFRAME];
        const open = today.filter((w) => w.start <= now && now < w.end);
        return open.length
          ? open.map((w) => ({ text: `${w.def.name} open`, color: `rgb(${w.def.color})` }))
          : [{ text: "No session open", color: "#64748B" }];
      },
      destroy() {
        ctx.priceSeries.detachPrimitive(primitive);
      },
    };
  },
};
