import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

export interface DrawScope {
  ctx: CanvasRenderingContext2D;
  width: number; // media (CSS) pixels
  height: number;
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/**
 * Where the paint lands: "background" goes beneath every series and every other
 * primitive (used by the heatmap); the z-orders place it relative to the series.
 */
export type CanvasLayer = "background" | PrimitivePaneViewZOrder;

/**
 * A series primitive that paints with a plain callback in CSS-pixel space. Keeps
 * overlay indicators and drawings free of lightweight-charts plugin boilerplate.
 */
export class CanvasPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(paint: (scope: DrawScope) => void, layer: CanvasLayer) {
    const run = (target: DrawTarget) => {
      const { chart, series } = this;
      if (!chart || !series) return;
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        paint({ ctx: context, width: mediaSize.width, height: mediaSize.height, chart, series });
        context.restore();
      });
    };
    const renderer: IPrimitivePaneRenderer =
      layer === "background" ? { draw: () => {}, drawBackground: run } : { draw: run };
    const zOrder: PrimitivePaneViewZOrder = layer === "background" ? "bottom" : layer;
    this.views = [{ zOrder: () => zOrder, renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Schedule a repaint. */
  refresh(): void {
    this.requestUpdate?.();
  }
}
