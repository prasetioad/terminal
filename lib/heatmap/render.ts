import type { HeatmapFrame } from "./frame";
import type { SourceId } from "../venues";

export interface HeatmapRegion {
  frames: readonly HeatmapFrame[];
  from: number; // frame indices, inclusive
  to: number;
  sources: readonly SourceId[];
  bucketLo: number; // bucket index range, inclusive
  bucketHi: number;
  merge: number; // buckets per row
  step: number; // price per bucket, to value cells in USD
  maxColumns: number; // usually the pane width in px
  scale: ColorScale;
}

/**
 * How resting liquidity (USD per cell) maps to colour. Auto: from 0 to a
 * contrast-dependent percentile of what's on screen. Manual: cells below `min` are
 * not drawn, cells at or above `max` get the brightest colour (CoinGlass-style).
 */
export type ColorScale = { mode: "auto"; contrast: number } | { mode: "manual"; min: number; max: number };

export interface HeatmapStats {
  /** Largest cell value on screen (USD). */
  dataMax: number;
  /** Range the colours were stretched over (USD). */
  min: number;
  max: number;
}

export interface HeatmapImage {
  canvas: HTMLCanvasElement;
  /** Time span of each image column, for placing it on the chart. */
  spans: { start: number; end: number }[];
  rows: number;
  stats: HeatmapStats;
}

/** Colour ramp for resting liquidity: transparent → deep blue → cyan → yellow → white. */
const STOPS: readonly [t: number, r: number, g: number, b: number, a: number][] = [
  [0.0, 10, 20, 70, 0],
  [0.12, 20, 50, 150, 0.55],
  [0.4, 0, 180, 230, 0.75],
  [0.72, 250, 215, 60, 0.85],
  [1.0, 255, 255, 255, 0.95],
];

/** Mild gamma: ordinary depth stays dim, walls stand out. */
const GAMMA = 0.75;

const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, r0, g0, b0, a0] = STOPS[k];
    const [t1, r1, g1, b1, a1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    lut.set([r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f, (a0 + (a1 - a0) * f) * 255], i * 4);
  }
  return lut;
})();

/**
 * Rasterise a region of the heatmap into a small bitmap: one column per group of
 * frames (at most `maxColumns`), one row per merged price bucket. A column takes the
 * maximum resting size seen within its frames, so short-lived walls stay visible when
 * zoomed out. Cells are valued in USD (size × price) and coloured by `region.scale`.
 */
export function rasterize(region: HeatmapRegion): HeatmapImage | null {
  const { frames, from, to, sources, bucketLo, bucketHi, merge, step } = region;
  const frameCount = to - from + 1;
  if (frameCount <= 0 || bucketHi < bucketLo) return null;
  const group = Math.max(1, Math.ceil(frameCount / Math.max(1, region.maxColumns)));
  const cols = Math.ceil(frameCount / group);
  const rows = Math.ceil((bucketHi - bucketLo + 1) / merge);

  const values = new Float32Array(cols * rows);
  const rowSums = new Float32Array(rows);
  const rowPrice = Float32Array.from({ length: rows }, (_, r) => (bucketLo + r * merge + merge / 2) * step);
  const spans: HeatmapImage["spans"] = [];

  for (let c = 0; c < cols; c++) {
    const first = from + c * group;
    const last = Math.min(to, first + group - 1);
    for (let f = first; f <= last; f++) {
      rowSums.fill(0);
      for (const source of sources) {
        const slice = frames[f].slices.get(source);
        if (!slice) continue;
        const b0 = Math.max(bucketLo, slice.base);
        const b1 = Math.min(bucketHi, slice.base + slice.sizes.length - 1);
        for (let b = b0; b <= b1; b++) rowSums[Math.floor((b - bucketLo) / merge)] += slice.sizes[b - slice.base];
      }
      const offset = c * rows;
      for (let r = 0; r < rows; r++) {
        const usd = rowSums[r] * rowPrice[r];
        if (usd > values[offset + r]) values[offset + r] = usd;
      }
    }
    // A column spans its frames' own durations (1 s live, 5 s history). A gap — a
    // throttled background tab, time the app was closed — stays empty rather than stretched.
    const start = frames[first].time;
    const end = frames[last].time + frames[last].duration;
    spans.push({ start, end: last + 1 < frames.length ? Math.min(end, frames[last + 1].time) : end });
  }

  let dataMax = 0;
  for (const v of values) if (v > dataMax) dataMax = v;
  const { scale } = region;
  const min = scale.mode === "manual" ? scale.min : 0;
  const max =
    scale.mode === "manual"
      ? scale.max
      : percentile(values, 0.995 - (Math.min(10, Math.max(1, scale.contrast)) - 1) * 0.012);
  if (!(max > min)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(cols, rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = values[c * rows + r];
      if (v <= min || v <= 0) continue;
      const lut = Math.round(intensity((v - min) / (max - min)) * 255) * 4;
      const px = ((rows - 1 - r) * cols + c) * 4; // row 0 = lowest price = bottom of the image
      image.data[px] = LUT[lut];
      image.data[px + 1] = LUT[lut + 1];
      image.data[px + 2] = LUT[lut + 2];
      image.data[px + 3] = LUT[lut + 3];
    }
  }
  ctx.putImageData(image, 0, 0);
  return { canvas, spans, rows, stats: { dataMax, min, max } };
}

/** Colour ramp position for a value's position between min (0) and max (1). */
const intensity = (fraction: number) => Math.pow(Math.min(1, Math.max(0, fraction)), GAMMA);

/**
 * CSS gradient of the value → colour mapping between min and max, for the scale legend.
 * Built from the same LUT and gamma as the heatmap, so the legend can't drift from it.
 */
export function scaleGradientCss(samples = 12): string {
  const stops: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const f = i / samples;
    const k = Math.round(intensity(f) * 255) * 4;
    // Transparent low end would vanish on the dark UI: show it at least faintly.
    const alpha = Math.max(0.18, LUT[k + 3] / 255);
    stops.push(`rgba(${LUT[k]}, ${LUT[k + 1]}, ${LUT[k + 2]}, ${alpha.toFixed(2)}) ${(f * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** Approximate percentile of the non-zero values (sampled for speed). */
function percentile(values: Float32Array, q: number): number {
  const nonZero: number[] = [];
  const stride = Math.max(1, Math.floor(values.length / 20_000));
  for (let i = 0; i < values.length; i += stride) if (values[i] > 0) nonZero.push(values[i]);
  if (nonZero.length === 0) return 0;
  nonZero.sort((a, b) => a - b);
  return nonZero[Math.min(nonZero.length - 1, Math.floor(q * nonZero.length))];
}
