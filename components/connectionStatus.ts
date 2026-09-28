import type { SourceStatuses } from "@/hooks/useMarketStreams";
import type { ConnectionStatus } from "@/lib/types";

export type StatusTone = "ok" | "pending" | "down";

export const TONE_STYLE: Record<StatusTone, { dot: string; text: string }> = {
  ok: { dot: "bg-[#00FFA3] shadow-[0_0_8px_#00FFA3]", text: "text-[#00FFA3]" },
  pending: { dot: "bg-amber-400 animate-pulse", text: "text-amber-400" },
  down: { dot: "bg-[#FF2D55] shadow-[0_0_8px_#FF2D55]", text: "text-[#FF2D55]" },
};

export const STATUS_INFO: Record<ConnectionStatus, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "ok" },
  connecting: { label: "Connecting", tone: "pending" },
  reconnecting: { label: "Reconnecting", tone: "pending" },
  disconnected: { label: "Disconnected", tone: "down" },
};

/** One line for the header: how many of the active feeds are live. */
export function summarizeFeeds(statuses: SourceStatuses): { label: string; tone: StatusTone } {
  const all = Object.values(statuses);
  const live = all.filter((s) => s === "connected").length;
  if (all.length === 0) return { label: "Connecting", tone: "pending" };
  if (live === all.length) return { label: `Live ${live}/${all.length}`, tone: "ok" };
  if (live === 0) {
    const waiting = all.some((s) => s === "connecting" || s === "reconnecting");
    return { label: waiting ? "Connecting" : "Disconnected", tone: waiting ? "pending" : "down" };
  }
  return { label: `Partial ${live}/${all.length}`, tone: "pending" };
}
