export type DrawingTool = "trendline" | "hline" | "rectangle" | "fib" | "profile" | "flowProfile";

/** A point anchored in market terms, so drawings survive zoom, scroll and timeframe changes. */
export interface Anchor {
  time: number; // ms
  price: number;
}

/** Tool-specific settings (e.g. a profile's row count). */
export type DrawingOptions = Record<string, number | boolean>;

export interface Drawing {
  id: string;
  tool: DrawingTool;
  points: Anchor[]; // 1 for hline, 2 otherwise
  color: string;
  options?: DrawingOptions;
}

export const TOOLS: readonly { tool: DrawingTool; label: string; points: 1 | 2; shortcut: string }[] = [
  { tool: "trendline", label: "Trend line", points: 2, shortcut: "T" },
  { tool: "hline", label: "Horizontal line", points: 1, shortcut: "H" },
  { tool: "rectangle", label: "Rectangle / zone", points: 2, shortcut: "R" },
  { tool: "fib", label: "Fib retracement", points: 2, shortcut: "F" },
  { tool: "profile", label: "Fixed range volume profile", points: 2, shortcut: "V" },
  { tool: "flowProfile", label: "Orderflow profile (Fabio-style)", points: 2, shortcut: "O" },
];

/** The measure tool is armed like a drawing tool but produces a temporary, unsaved measurement. */
export type ActiveTool = DrawingTool | "measure";

export const MEASURE_TOOL = { label: "Measure", shortcut: "M" } as const;

export const pointsFor = (tool: DrawingTool) => TOOLS.find((t) => t.tool === tool)?.points ?? 2;

export const DRAWING_COLORS = ["#00E5FF", "#F5C542", "#FF2D55", "#00FFA3", "#A78BFA", "#E2E8F0"] as const;

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** UI-facing state; replaced (not mutated) on every change so React can subscribe to it. */
export interface DrawingsSnapshot {
  tool: ActiveTool | null;
  selectedId: string | null;
  selectedTool: DrawingTool | null;
  selectedColor: string | null;
  selectedOptions: DrawingOptions | null;
  magnet: boolean;
  hidden: boolean;
  count: number;
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
        (d.options === undefined ||
          (typeof d.options === "object" &&
            d.options !== null &&
            Object.values(d.options).every((v) => typeof v === "number" || typeof v === "boolean"))),
    )
  );
}
