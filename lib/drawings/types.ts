export type DrawingTool =
  | "trendline"
  | "hline"
  | "rectangle"
  | "fib"
  | "profile"
  | "flowProfile"
  | "longPosition"
  | "shortPosition";

/** A point anchored in market terms, so drawings survive zoom, scroll and timeframe changes. */
export interface Anchor {
  time: number; // ms
  price: number;
}

/** Tool-specific settings (e.g. a profile's row count or volume mode). */
export type DrawingOptionValue = number | boolean | string;
export type DrawingOptions = Record<string, DrawingOptionValue>;

export interface Drawing {
  id: string;
  tool: DrawingTool;
  points: Anchor[]; // 1 for hline, 3 for positions (entry, target, stop), 2 otherwise
  color: string;
  /** Stroke width in px; absent = DEFAULT_LINE_WIDTH (drawings saved before it existed). */
  lineWidth?: number;
  options?: DrawingOptions;
}

export const LINE_WIDTHS = [1, 2, 3, 4] as const;
export const DEFAULT_LINE_WIDTH = 1;

export const lineWidthOf = (d: Drawing): number => d.lineWidth ?? DEFAULT_LINE_WIDTH;

export interface ToolDef {
  tool: DrawingTool;
  label: string;
  points: 1 | 2 | 3;
  /** "click": one click places the whole drawing; "drag": press, then drag or click the end point. */
  place: "click" | "drag";
  shortcut: string;
  /** Tools of one group share a toolbar button with a menu, as in TradingView. */
  group?: "position";
}

export const TOOLS: readonly ToolDef[] = [
  { tool: "trendline", label: "Trend line", points: 2, place: "drag", shortcut: "T" },
  { tool: "hline", label: "Horizontal line", points: 1, place: "click", shortcut: "H" },
  { tool: "rectangle", label: "Rectangle / zone", points: 2, place: "drag", shortcut: "R" },
  { tool: "fib", label: "Fib retracement", points: 2, place: "drag", shortcut: "F" },
  { tool: "profile", label: "Fixed range volume profile", points: 2, place: "drag", shortcut: "V" },
  { tool: "flowProfile", label: "Orderflow profile (Fabio-style)", points: 2, place: "drag", shortcut: "O" },
  { tool: "longPosition", label: "Long position", points: 3, place: "click", shortcut: "L", group: "position" },
  { tool: "shortPosition", label: "Short position", points: 3, place: "click", shortcut: "S", group: "position" },
];

export const toolDef = (tool: DrawingTool): ToolDef => TOOLS.find((t) => t.tool === tool) ?? TOOLS[0];

/** The measure tool is armed like a drawing tool but produces a temporary, unsaved measurement. */
export type ActiveTool = DrawingTool | "measure";

export const MEASURE_TOOL = { label: "Measure", shortcut: "M" } as const;

export const pointsFor = (tool: DrawingTool) => toolDef(tool).points;

/** One setting of a drawing, rendered generically by the settings panel. */
export type SettingField = {
  key: string;
  label: string;
  /** Shown only when this returns true for the current values (e.g. risk vs quantity sizing). */
  when?: (values: DrawingOptions) => boolean;
} & (
  | { type: "number"; min: number; max: number; step: number; suffix?: string }
  | { type: "select"; options: readonly { value: string; label: string }[] }
  | { type: "boolean" }
);

/** A computed figure shown in the settings panel (e.g. POC, or a position's quantity). */
export interface StatRow {
  label: string;
  value: string;
  tone?: "up" | "down";
}

export const DRAWING_COLORS = ["#00E5FF", "#F5C542", "#FF2D55", "#00FFA3", "#A78BFA", "#E2E8F0"] as const;

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** UI-facing state; replaced (not mutated) on every change so React can subscribe to it. */
export interface DrawingsSnapshot {
  tool: ActiveTool | null;
  selectedId: string | null;
  selectedTool: DrawingTool | null;
  selectedColor: string | null;
  selectedLineWidth: number | null;
  selectedOptions: DrawingOptions | null;
  /** Settings of the selected drawing, if it has any. */
  selectedFields: readonly SettingField[] | null;
  /** Computed figures for the selected drawing; null while its data is loading. */
  selectedStats: readonly StatRow[] | null;
  magnet: boolean;
  hidden: boolean;
  count: number;
  canUndo: boolean;
  canRedo: boolean;
}

export function isDrawingList(value: unknown): value is Drawing[] {
  return (
    Array.isArray(value) &&
    value.every(
      (d) =>
        d &&
        typeof d.id === "string" &&
        TOOLS.some((t) => t.tool === d.tool) &&
        typeof d.color === "string" &&
        Array.isArray(d.points) &&
        d.points.length === pointsFor(d.tool) &&
        d.points.every((p: Anchor) => Number.isFinite(p?.time) && Number.isFinite(p?.price)) &&
        (d.lineWidth === undefined || LINE_WIDTHS.includes(d.lineWidth)) &&
        (d.options === undefined ||
          (typeof d.options === "object" &&
            d.options !== null &&
            Object.values(d.options).every((v) => typeof v === "number" || typeof v === "boolean" || typeof v === "string"))),
    )
  );
}
