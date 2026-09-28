import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { formatUsdCompact } from "@/lib/format";
import { isVisible, type TradeFilter } from "@/lib/tradeLog";
import type { Trade } from "@/lib/types";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface DrawnBubble {
  x: number;
  y: number;
  r: number;
  trade: Trade;
}

const COLORS = {
  BUY: { fill: "rgba(0, 255, 163, 0.22)", stroke: "rgba(0, 255, 163, 0.95)", glow: "rgba(0, 255, 163, 0.55)" },
  SELL: { fill: "rgba(255, 45, 85, 0.22)", stroke: "rgba(255, 45, 85, 0.95)", glow: "rgba(255, 45, 85, 0.55)" },
} as const;

const MIN_RADIUS = 3;
const MAX_RADIUS = 64;

/**
 * Bubble radius grows with sqrt(USD) so that bubble *area* is proportional to
 * notional size: a $1M print covers ~10x the area of a $100K print.
 * Independent of the threshold, so bubbles don't jump when the filter moves.
 */
export function bubbleRadius(usd: number, scale: number): number {
  const r = (2.5 + Math.sqrt(usd) / 40) * scale;
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, r));
}

/** First index whose trade time is >= t (trades are chronological). */
function lowerBound(trades: readonly Trade[], t: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class BubblesRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: BubblesPrimitive) {}

  draw(target: DrawTarget): void {
    const src = this.source;
    const chart = src.chart;
    const series = src.series;
    const drawn: DrawnBubble[] = [];
    src.drawn = drawn;
    if (!chart || !series || src.trades.length === 0) return;

    const timeScale = chart.timeScale();
    const visible = timeScale.getVisibleRange();
    if (!visible) return;

    const intervalMs = src.intervalMs;
    const fromMs = (visible.from as number) * 1000;
    const toMs = (visible.to as number) * 1000 + intervalMs;

    // Current bar width in px, so intra-bar timestamps can be placed precisely.
    const x0 = timeScale.logicalToCoordinate(0 as Logical);
    const x1 = timeScale.logicalToCoordinate(1 as Logical);
    const barSpacing = x0 !== null && x1 !== null ? x1 - x0 : 6;

    const trades = src.trades;
    for (let i = lowerBound(trades, fromMs); i < trades.length; i++) {
      const t = trades[i];
      if (t.time > toMs) break;
      if (!isVisible(t, src.filter)) continue;

      const bucketMs = Math.floor(t.time / intervalMs) * intervalMs;
      const barX = timeScale.timeToCoordinate((bucketMs / 1000) as UTCTimestamp);
      const y = series.priceToCoordinate(t.price);
      if (barX === null || y === null) continue;

      // Offset within the candle by the trade's exact timestamp.
      const frac = (t.time - bucketMs) / intervalMs;
      const x = barX + (frac - 0.5) * barSpacing;
      drawn.push({ x, y, r: bubbleRadius(t.usd, src.scale), trade: t });
    }
    if (drawn.length === 0) return;

    // Largest first so small bubbles stay visible on top.
    drawn.sort((a, b) => b.r - a.r);

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      for (const b of drawn) {
        if (b.x + b.r < 0 || b.x - b.r > mediaSize.width) continue;
        const c = COLORS[b.trade.side];

        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = c.fill;
        ctx.shadowColor = c.glow;
        ctx.shadowBlur = b.r > 14 ? 14 : 6;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = b.r > 20 ? 2 : 1.25;
        ctx.strokeStyle = c.stroke;
        ctx.stroke();

        if (b.r >= 18) {
          ctx.font = `600 ${Math.min(13, Math.round(b.r / 2.4))}px ui-monospace, "JetBrains Mono", monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.fillText(formatUsdCompact(b.trade.usd), b.x, b.y);
        }
      }
      ctx.restore();
    });
  }
}

class BubblesPaneView implements IPrimitivePaneView {
  private readonly rendererInstance: BubblesRenderer;

  constructor(source: BubblesPrimitive) {
    this.rendererInstance = new BubblesRenderer(source);
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.rendererInstance;
  }
}

/**
 * Series primitive that renders "big trade" bubbles over the candlestick pane.
 * Reads straight from the shared trades buffer (no copies); call `refresh()`
 * after mutating it to schedule a repaint.
 */
export class BubblesPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  trades: readonly Trade[] = [];
  filter: TradeFilter = { minUsd: Number.POSITIVE_INFINITY, hiddenSources: new Set() };
  scale = 1;
  intervalMs = 60_000;
  /** Bubbles painted on the last frame, used for hover hit-testing. */
  drawn: DrawnBubble[] = [];

  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new BubblesPaneView(this)];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.drawn = [];
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  refresh(): void {
    this.requestUpdate?.();
  }

  /** Top-most (smallest) bubble under the cursor, if any. */
  bubbleAt(x: number, y: number): DrawnBubble | null {
    // `drawn` is sorted largest-first, so walk backwards to hit the top-most bubble.
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const b = this.drawn[i];
      const dx = x - b.x;
      const dy = y - b.y;
      if (dx * dx + dy * dy <= b.r * b.r) return b;
    }
    return null;
  }
}
