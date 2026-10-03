import type { Logical } from "lightweight-charts";
import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { formatPrice } from "../format";
import { SETUP_V1, runSetupV1, scoreTrades, type SetupResult, type SetupTrade, type StochPreset } from "../setups/setupV1";
import { visibleBars } from "./common";
import type { IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

/**
 * Setup v1 on the price chart: every entry, its −15% stop, the exit and its result,
 * the open position if any, and the setup's score over the loaded bars. Uses the
 * same engine as the scanner (lib/setups/setupV1.ts).
 */

const UP = "0, 255, 163";
const DOWN = "255, 45, 85";
const STOP = "255, 45, 85";
const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

const pct = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;

export const setupV1Indicator: IndicatorDefinition = {
  type: "setup-v1",
  name: SETUP_V1.name,
  description:
    "Validated on 4h: MaxFlow+ green dot, then Stochastic crosses up from below 20 → long at the close; −15% disaster stop; exit at the first red dot (first bearish WaveTrend cross above zero). Shows every trade on the loaded history and the open position.",
  category: "Setups",
  placement: "overlay",
  params: [
    {
      key: "stoch",
      label: "Stochastic",
      type: "select",
      default: "either",
      options: [
        { value: "either", label: "5,3,3 or 14,3,3 (most signals)" },
        { value: "5,3,3", label: "5,3,3 (most consistent)" },
        { value: "14,3,3", label: "14,3,3" },
      ],
    },
    { key: "showHistory", label: "Show past trades", type: "boolean", default: true },
  ],
  summary: (p) => `Stoch ${p.stoch === "either" ? "5 or 14" : p.stoch} · stop −15%`,

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    let result: SetupResult | null = null;

    const compute = (d: IndicatorData) => {
      data = d;
      result = runSetupV1(d.candles, { stoch: params.stoch as StochPreset, intervalMs: d.intervalMs });
    };

    const paint = (scope: DrawScope) => {
      if (!visible || !data || !result) return;
      const bars = visibleBars(scope, data);
      if (!bars) return;
      const { ctx: g, series, chart } = scope;
      const ts = chart.timeScale();
      const d = data;
      const x = (i: number) => ts.logicalToCoordinate(i as Logical);
      const y = (price: number) => series.priceToCoordinate(price);
      g.font = FONT;

      const drawTrade = (t: SetupTrade, endIndex: number, endPrice: number, open: boolean) => {
        if (endIndex < bars.from || t.entryIndex > bars.to) return;
        const x0 = x(t.entryIndex);
        const x1 = x(endIndex);
        const yEntry = y(t.entryPrice);
        const yEnd = y(endPrice);
        const yStop = y(t.stopPrice);
        if (x0 === null || x1 === null || yEntry === null || yEnd === null) return;
        const ret = endPrice / t.entryPrice - 1 - (open ? 0 : SETUP_V1.cost);
        const rgb = ret >= 0 ? UP : DOWN;

        // Result zone between entry and exit, like a position tool.
        g.fillStyle = `rgba(${rgb}, ${open ? 0.1 : 0.14})`;
        g.fillRect(x0, Math.min(yEntry, yEnd), Math.max(1, x1 - x0), Math.abs(yEnd - yEntry));
        // Stop level.
        if (yStop !== null) {
          g.strokeStyle = `rgba(${STOP}, 0.55)`;
          g.lineWidth = 1;
          g.setLineDash([2, 3]);
          g.beginPath();
          g.moveTo(x0, Math.round(yStop) + 0.5);
          g.lineTo(x1, Math.round(yStop) + 0.5);
          g.stroke();
          g.setLineDash([]);
        }
        // Entry arrow under the entry bar.
        const low = y(d.candles[t.entryIndex].low);
        if (low !== null) {
          g.fillStyle = `rgb(${UP})`;
          g.beginPath();
          g.moveTo(x0, low + 6);
          g.lineTo(x0 - 5, low + 14);
          g.lineTo(x0 + 5, low + 14);
          g.closePath();
          g.fill();
        }
        // Exit marker and result.
        g.fillStyle = `rgb(${rgb})`;
        g.textAlign = "center";
        if (open) {
          g.textBaseline = "bottom";
          g.fillText(`OPEN ${pct(ret)} · stop ${formatPrice(t.stopPrice, d.precision)}`, x1, Math.min(yEntry, yEnd) - 4);
        } else {
          g.beginPath();
          g.arc(x1, yEnd, 3.5, 0, Math.PI * 2);
          g.fill();
          const above = ret >= 0;
          g.textBaseline = above ? "bottom" : "top";
          g.fillText(`${pct(ret)}${t.exitReason === "stop" ? " stop" : ""}`, x1, yEnd + (above ? -6 : 6));
        }
      };

      if (params.showHistory) for (const t of result.trades) drawTrade(t, t.exitIndex!, t.exitPrice!, false);
      const open = result.open;
      if (open) {
        const last = d.candles.length - 1;
        drawTrade(open, last, d.candles[last].close, true);
      }
    };

    const primitive = new CanvasPrimitive(paint, "top");
    ctx.priceSeries.attachPrimitive(primitive);

    return {
      render(d) {
        compute(d);
        primitive.refresh();
      },
      update(d) {
        compute(d);
        primitive.refresh();
      },
      setParams(next) {
        params = next; // the host renders right after
      },
      setVisible(next) {
        visible = next;
        primitive.refresh();
      },
      legend(d): LegendValue[] {
        const r = result;
        if (!r) return [];
        const values: LegendValue[] = [];
        if (d.intervalMs !== SETUP_V1.validatedInterval) values.push({ text: "validated on 4h only", color: "#FBBF24" });
        const s = scoreTrades(r.trades);
        values.push({
          label: "Trades",
          text: s.count ? `${s.count} · ${(s.winRate * 100).toFixed(0)}% · avg ${pct(s.avgRet)}` : "0",
          color: s.avgRet >= 0 ? "#00FFA3" : "#FF2D55",
        });
        if (r.open) {
          const last = d.candles[d.candles.length - 1];
          const ret = last.close / r.open.entryPrice - 1;
          values.push({ label: "Open", text: `${pct(ret)} since ${formatPrice(r.open.entryPrice, d.precision)}`, color: ret >= 0 ? "#00FFA3" : "#FF2D55" });
        } else {
          values.push({ label: "Position", text: "flat", color: "#94A3B8" });
        }
        return values;
      },
      destroy() {
        ctx.priceSeries.detachPrimitive(primitive);
      },
    };
  },
};
