import { cvdIndicator } from "./cvd";
import { deltaIndicator } from "./delta";
import { liquidityHeatmapIndicator } from "./heatmap";
import { maxFlowIndicator } from "./maxflow";
import { maxFlowOFIndicator } from "./maxflowOF";
import { sessionsIndicator } from "./sessions";
import { setupV1Indicator } from "./setupV1";
import type { IndicatorDefinition } from "./types";
import { volumeIndicator } from "./volume";
import { volumeProfileIndicator } from "./volumeProfile";
import { vwapIndicator } from "./vwap";

/** Every indicator the picker offers. Add a module here to make it available. */
export const INDICATORS: readonly IndicatorDefinition[] = [
  volumeIndicator,
  deltaIndicator,
  cvdIndicator,
  volumeProfileIndicator,
  liquidityHeatmapIndicator,
  vwapIndicator,
  sessionsIndicator,
  maxFlowIndicator,
  maxFlowOFIndicator,
  setupV1Indicator,
];

const BY_TYPE = new Map(INDICATORS.map((d) => [d.type, d]));

export const indicatorDefinition = (type: string): IndicatorDefinition | undefined => BY_TYPE.get(type);
