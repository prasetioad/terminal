import { CanvasPrimitive, type DrawScope } from "../chart/CanvasPrimitive";
import { formatPrice } from "../format";
import { buildProfile, type VolumeProfile } from "../profile";
import { HIDDEN_ON_TIMEFRAME, SESSIONS, sessionWindows, spansEnoughBars, type SessionId } from "../sessions";
import { firstIndexFrom, visibleBars, xAtTime } from "./common";
import type { IndicatorData, IndicatorDefinition, IndicatorParams } from "./types";

type Mode = "visible" | "day" | SessionId;

const DAY_MS = 86_400_000;
const LVN_RATIO = 0.35;
const FONT = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
const COLORS = {
  buy: "0, 255, 163",
  sell: "255, 45, 85",
  poc: "245, 197, 66",
  va: "148, 163, 184",
  lvn: "167, 139, 250",
};

interface Block {
  start: number; // ms
  end: number;
  from: number; // bar indices, inclusive
  to: number;
}

export const volumeProfileIndicator: IndicatorDefinition = {
  type: "volume-profile",
  name: "Volume Profile",
  description:
    "Volume at price with Point of Control (POC), Value Area (VAH/VAL) and Low Volume Nodes (LVN) — for the visible range, or one profile per day/session.",
  category: "Orderflow",
  placement: "overlay",
  params: [
    {
      key: "mode",
      label: "Range",
      type: "select",
      default: "visible",
      options: [
        { value: "visible", label: "Visible range" },
        { value: "day", label: "Each day (UTC)" },
        ...SESSIONS.map((s) => ({ value: s.id, label: `Each ${s.name} session` })),
      ],
    },
    { key: "rows", label: "Rows", type: "number", default: 60, min: 12, max: 200, step: 4 },
    { key: "valueArea", label: "Value area %", type: "number", default: 70, min: 50, max: 95, step: 5 },
    { key: "width", label: "Width % (visible range)", type: "number", default: 28, min: 10, max: 60, step: 2 },
    { key: "showPoc", label: "POC line", type: "boolean", default: true },
    { key: "showValueArea", label: "Value area lines", type: "boolean", default: true },
    { key: "showLvn", label: "Low volume nodes", type: "boolean", default: true },
  ],
  summary: (p) => {
    const mode = p.mode as Mode;
    const range = mode === "visible" ? "Visible" : mode === "day" ? "Daily" : SESSIONS.find((s) => s.id === mode)?.name;
    return `${range} · ${p.rows} rows · VA ${p.valueArea}%`;
  },

  create(ctx, initial) {
    let params: IndicatorParams = initial;
    let visible = true;
    let data: IndicatorData | null = null;
    /** Profile per block start, with the signature it was built from. */
    let cache = new Map<number, { sig: string; profile: VolumeProfile | null }>();
    /** Most recent profile on screen (visible range, or the latest visible day/session), for the legend. */
    let latest: VolumeProfile | null = null;
    /** Day / session mode on bars too long to profile those periods. */
    let hiddenByTimeframe = false;

    const profileFor = (d: IndicatorData, key: number, from: number, to: number): VolumeProfile | null => {
      const last = d.candles[to];
      const sig = `${from}:${to}:${d.candles.length}:${last?.close}:${last?.volume}`;
      const hit = cache.get(key);
      if (hit && hit.sig === sig) return hit.profile;
      const profile = buildProfile(d.candles, from, to, {
        rows: Number(params.rows),
        valueAreaPct: Number(params.valueArea),
        lvnRatio: LVN_RATIO,
      });
      cache.set(key, { sig, profile });
      return profile;
    };

    const blocksIn = (d: IndicatorData, fromMs: number, toMs: number): Block[] => {
      const mode = params.mode as Mode;
      const spans =
        mode === "day"
          ? Array.from({ length: Math.floor(toMs / DAY_MS) - Math.floor(fromMs / DAY_MS) + 1 }, (_, k) => {
              const start = (Math.floor(fromMs / DAY_MS) + k) * DAY_MS;
              return { start, end: start + DAY_MS };
            })
          : sessionWindows(fromMs, toMs, new Set([mode as SessionId]));
      const drawable = spans.filter(({ start, end }) => spansEnoughBars(end - start, d.intervalMs));
      hiddenByTimeframe = spans.length > 0 && drawable.length === 0;
      return drawable
        .map(({ start, end }) => ({
          start,
          end,
          from: firstIndexFrom(d, start / 1000),
          to: firstIndexFrom(d, end / 1000) - 1,
        }))
        .filter((b) => b.to >= b.from);
    };

    const paint = (scope: DrawScope) => {
      if (!visible || !data || data.candles.length === 0) return;
      const d = data;
      const bars = visibleBars(scope, d);
      if (!bars) return;
      scope.ctx.font = FONT;

      if (params.mode === "visible") {
        hiddenByTimeframe = false;
        const profile = profileFor(d, -1, bars.from, bars.to);
        latest = profile;
        if (!profile) return;
        const maxLen = (scope.width * Number(params.width)) / 100;
        drawProfile(scope, d, profile, { left: 0, right: scope.width, anchor: scope.width, maxLen, growLeft: true });
        return;
      }

      const fromMs = d.candles[bars.from].time * 1000;
      const toMs = d.candles[bars.to].time * 1000;
      latest = null;
      for (const block of blocksIn(d, fromMs, toMs)) {
        const profile = profileFor(d, block.start, block.from, block.to);
        if (!profile) continue;
        latest = profile; // blocks are chronological: the last one wins
        const x0 = xAtTime(scope, d, block.start);
        const x1 = xAtTime(scope, d, block.end);
        if (x0 === null || x1 === null || x1 < 0 || x0 > scope.width) continue;
        drawProfile(scope, d, profile, { left: x0, right: x1, anchor: x0, maxLen: (x1 - x0) * 0.85, growLeft: false });
      }
    };

    const drawProfile = (
      scope: DrawScope,
      d: IndicatorData,
      p: VolumeProfile,
      box: { left: number; right: number; anchor: number; maxLen: number; growLeft: boolean },
    ) => {
      const { ctx, series } = scope;
      const y = (price: number) => series.priceToCoordinate(price);
      const dir = box.growLeft ? -1 : 1;

      // Histogram rows.
      p.rows.forEach((row, r) => {
        const top = y(row.low + p.rowSize);
        const bottom = y(row.low);
        if (top === null || bottom === null) return;
        const h = Math.max(1, bottom - top - 1);
        const volume = row.buy + row.sell;
        if (volume <= 0) return;
        const len = (box.maxLen * volume) / p.maxVolume;
        const buyLen = (len * row.buy) / volume;
        const inArea = r >= p.vaLow && r <= p.vaHigh;
        if (r === p.poc && params.showPoc) {
          ctx.fillStyle = `rgba(${COLORS.poc}, 0.75)`;
          fillSpan(ctx, box.anchor, dir, 0, len, top, h);
          return;
        }
        const alpha = inArea ? 0.42 : 0.16;
        ctx.fillStyle = `rgba(${COLORS.buy}, ${alpha})`;
        fillSpan(ctx, box.anchor, dir, 0, buyLen, top, h);
        ctx.fillStyle = `rgba(${COLORS.sell}, ${alpha})`;
        fillSpan(ctx, box.anchor, dir, buyLen, len, top, h);
      });

      const mid = (r: number) => p.rows[r].low + p.rowSize / 2;
      const labelX = box.growLeft ? box.anchor - box.maxLen - 6 : box.left + 4;
      const align: CanvasTextAlign = box.growLeft ? "right" : "left";

      if (params.showLvn) {
        for (const zone of p.lvns) {
          const top = y(p.rows[zone.to].low + p.rowSize);
          const bottom = y(p.rows[zone.from].low);
          if (top === null || bottom === null) continue;
          ctx.fillStyle = `rgba(${COLORS.lvn}, 0.08)`;
          ctx.fillRect(box.left, top, box.right - box.left, bottom - top);
          ctx.strokeStyle = `rgba(${COLORS.lvn}, 0.45)`;
          ctx.setLineDash([2, 3]);
          hLine(ctx, box.left, box.right, top);
          hLine(ctx, box.left, box.right, bottom);
          ctx.setLineDash([]);
          label(ctx, "LVN", labelX, (top + bottom) / 2, align, `rgba(${COLORS.lvn}, 0.9)`);
        }
      }
      if (params.showValueArea) {
        ctx.strokeStyle = `rgba(${COLORS.va}, 0.5)`;
        for (const [r, name] of [[p.vaHigh, "VAH"], [p.vaLow, "VAL"]] as const) {
          const edge = name === "VAH" ? p.rows[r].low + p.rowSize : p.rows[r].low;
          const yy = y(edge);
          if (yy === null) continue;
          hLine(ctx, box.left, box.right, yy);
          label(ctx, `${name} ${formatPrice(edge, d.precision)}`, labelX, yy, align, `rgba(${COLORS.va}, 0.95)`);
        }
      }
      if (params.showPoc) {
        const yy = y(mid(p.poc));
        if (yy !== null) {
          ctx.strokeStyle = `rgba(${COLORS.poc}, 0.9)`;
          ctx.setLineDash([6, 4]);
          hLine(ctx, box.left, box.right, yy);
          ctx.setLineDash([]);
          label(ctx, `POC ${formatPrice(mid(p.poc), d.precision)}`, labelX, yy, align, `rgba(${COLORS.poc}, 1)`);
        }
      }
    };

    const primitive = new CanvasPrimitive(paint, "bottom");
    ctx.priceSeries.attachPrimitive(primitive);

    return {
      render(next) {
        data = next;
        cache = new Map();
        primitive.refresh();
      },
      update(next) {
        data = next;
        primitive.refresh();
      },
      setParams(next) {
        params = next;
        cache = new Map();
        primitive.refresh();
      },
      setVisible(next) {
        visible = next;
        primitive.refresh();
      },
      legend(d) {
        if (hiddenByTimeframe) return [HIDDEN_ON_TIMEFRAME];
        if (!latest) return [];
        const p = latest;
        const price = (v: number) => formatPrice(v, d.precision);
        return [
          { label: "POC", text: price(p.rows[p.poc].low + p.rowSize / 2), color: "#F5C542" },
          { label: "VAH", text: price(p.rows[p.vaHigh].low + p.rowSize), color: "#94A3B8" },
          { label: "VAL", text: price(p.rows[p.vaLow].low), color: "#94A3B8" },
        ];
      },
      destroy() {
        ctx.priceSeries.detachPrimitive(primitive);
      },
    };
  },
};

function fillSpan(ctx: CanvasRenderingContext2D, anchor: number, dir: 1 | -1, from: number, to: number, top: number, h: number) {
  if (to <= from) return;
  const a = anchor + dir * from;
  const b = anchor + dir * to;
  ctx.fillRect(Math.min(a, b), top, Math.abs(b - a), h);
}

function hLine(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x0, Math.round(y) + 0.5);
  ctx.lineTo(x1, Math.round(y) + 0.5);
  ctx.lineWidth = 1;
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign, color: string) {
  ctx.textAlign = align;
  ctx.textBaseline = "bottom";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y - 2);
}
