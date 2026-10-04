import type { Logical } from "lightweight-charts";
import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { formatPrice } from "../format";
import { SETUP_A, runSetupA, type SetupAResult, type SetupATrade } from "../setups/setupA";
import { scoreTrades } from "../setups/setupV1";
import { visibleBars } from "./common";
import type { IndicatorData, IndicatorDefinition, IndicatorParams, LegendValue } from "./types";

/**
 * Setup A on the price chart: each breakout entry, its 20-day high, the initial stop,
 * the chandelier trail, the exit and its result, and the open position. Breakouts
 * without the volume confirmation are faded (or hidden). Same engine as the scanner
 * (lib/setups/setupA.ts).
 */

const UP = "0, 255, 163";
const DOWN = "255, 45, 85";
const TRAIL = "251, 191, 36";
const MUTED = "148, 163, 184";
const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

const pct = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)}%`;

export const setupAIndicator: IndicatorDefinition = {
  type: "setup-a",
  name: SETUP_A.name,
  description:
    "Validated on 4h: the close breaks above the 20-day (120-bar) high → long at the close; stop and chandelier trail 8×ATR; exit on a close below the trail. Validated filter: volume of the last day ≥ 1.5× its 30-day average. Few wins (~30–37%) but large ones; holds ~3 weeks.",
  category: "Setups",
  placement: "overlay",
  params: [
    { key: "spikeTighten", label: "Tighten the trail to 4×ATR after a tall up-bar (≥ 3×ATR)", type: "boolean", default: true },
    { key: "showUnconfirmed", label: "Show breakouts without volume (faded)", type: "boolean", default: false },
    { key: "showHistory", label: "Show past trades", type: "boolean", default: true },
  ],
  summary: (p) => `20D high · ${SETUP_A.atrMult}×ATR${p.spikeTighten ? ` → ${SETUP_A.spikeTighten.k}× after a spike` : ""} · vol ≥ ${SETUP_A.minSurge}×`,

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    let result: SetupAResult | null = null;

    const compute = (d: IndicatorData) => {
      data = d;
      result = runSetupA(d.candles, d.intervalMs, { spikeTighten: params.spikeTighten ? SETUP_A.spikeTighten : undefined });
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

      const drawTrade = (t: SetupATrade, open: boolean) => {
        const last = d.candles.length - 1;
        const endIndex = open ? last : t.exitIndex!;
        const endPrice = open ? d.candles[last].close : t.exitPrice!;
        if (endIndex < bars.from || t.entryIndex > bars.to) return;
        const faded = !t.passes;
        const x0 = x(t.entryIndex);
        const x1 = x(endIndex);
        const yEntry = y(t.entryPrice);
        const yEnd = y(endPrice);
        if (x0 === null || x1 === null || yEntry === null || yEnd === null) return;
        const ret = endPrice / t.entryPrice - 1 - (open ? 0 : SETUP_A.cost);
        const rgb = faded ? MUTED : ret >= 0 ? UP : DOWN;
        const alpha = faded ? 0.5 : 1;

        g.fillStyle = `rgba(${rgb}, ${faded ? 0.05 : open ? 0.08 : 0.11})`;
        g.fillRect(x0, Math.min(yEntry, yEnd), Math.max(1, x1 - x0), Math.abs(yEnd - yEntry));

        // Chandelier trail (the exit line), stepping up bar by bar.
        g.strokeStyle = `rgba(${faded ? MUTED : TRAIL}, ${faded ? 0.35 : 0.85})`;
        g.lineWidth = 1;
        g.beginPath();
        let started = false;
        for (let j = 0; j < t.trail.length && t.entryIndex + j <= endIndex; j++) {
          const xi = x(t.entryIndex + j);
          const yi = y(Math.max(t.trail[j], t.stopPrice));
          if (xi === null || yi === null) continue;
          if (started) g.lineTo(xi, yi);
          else g.moveTo(xi, yi);
          started = true;
        }
        g.stroke();

        // Entry arrow.
        const low = y(d.candles[t.entryIndex].low);
        if (low !== null) {
          g.fillStyle = `rgba(${faded ? MUTED : UP}, ${alpha})`;
          g.beginPath();
          g.moveTo(x0, low + 6);
          g.lineTo(x0 - 5, low + 14);
          g.lineTo(x0 + 5, low + 14);
          g.closePath();
          g.fill();
        }

        g.fillStyle = `rgba(${rgb}, ${alpha})`;
        g.textAlign = "center";
        if (open) {
          const stop = Math.max(t.trail[t.trail.length - 1], t.stopPrice);
          g.textBaseline = "bottom";
          g.fillText(`OPEN ${pct(ret)} · exit < ${formatPrice(stop, d.precision)}`, x1, Math.min(yEntry, yEnd) - 4);
        } else {
          g.beginPath();
          g.arc(x1, yEnd, 3.5, 0, Math.PI * 2);
          g.fill();
          const above = ret >= 0;
          g.textBaseline = above ? "bottom" : "top";
          g.fillText(`${pct(ret)}${t.exitReason === "stop" ? " stop" : ""}`, x1, yEnd + (above ? -6 : 6));
        }
      };

      const shown = (t: SetupATrade) => t.passes || params.showUnconfirmed;
      if (params.showHistory) for (const t of result.trades) if (shown(t)) drawTrade(t, false);
      if (result.open && shown(result.open)) drawTrade(result.open, true);
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
        if (d.intervalMs !== SETUP_A.validatedInterval) values.push({ text: "validated on 4h only", color: "#FBBF24" });
        const s = scoreTrades(r.trades.filter((t) => t.passes));
        values.push({
          label: "Trades",
          text: s.count ? `${s.count} · ${(s.winRate * 100).toFixed(0)}% · avg ${pct(s.avgRet)}` : "0",
          color: s.avgRet >= 0 ? "#00FFA3" : "#FF2D55",
        });
        const o = r.open;
        if (o) {
          const last = d.candles[d.candles.length - 1];
          const ret = last.close / o.entryPrice - 1;
          const stop = Math.max(o.trail[o.trail.length - 1], o.stopPrice);
          values.push({
            label: o.passes ? "Open" : "Open (no volume)",
            text: `${pct(ret)} · exit < ${formatPrice(stop, d.precision)}`,
            color: o.passes ? (ret >= 0 ? "#00FFA3" : "#FF2D55") : "#94A3B8",
          });
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
