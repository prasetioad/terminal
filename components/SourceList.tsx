"use client";

import VenueTag from "./VenueTag";
import { STATUS_INFO, TONE_STYLE } from "./connectionStatus";
import type { SourceStatuses } from "@/hooks/useMarketStreams";
import { ALL_SOURCES, CHART_SOURCE, type Listing, type SourceId } from "@/lib/venues";

export interface SourceListProps {
  listings: readonly Listing[];
  statuses: SourceStatuses;
  /** Sources whose instrument list the server could not load. */
  unavailable: readonly SourceId[];
  hidden: ReadonlySet<SourceId>;
  onToggle: (source: SourceId) => void;
}

type RowState =
  | { kind: "listed"; symbol: string }
  | { kind: "unlisted" }
  | { kind: "unavailable" };

function rowState(source: SourceId, props: SourceListProps): RowState {
  const listing = props.listings.find((l) => l.source === source);
  if (listing) return { kind: "listed", symbol: listing.symbol };
  return props.unavailable.includes(source) ? { kind: "unavailable" } : { kind: "unlisted" };
}

/** Every venue/market with its connection state and a show/hide toggle for its bubbles. */
export default function SourceList(props: SourceListProps) {
  return (
    <ul className="flex flex-col gap-1">
      {ALL_SOURCES.map((source) => {
        const state = rowState(source, props);
        const listed = state.kind === "listed";
        const visible = listed && !props.hidden.has(source);
        return (
          <li key={source}>
            <label
              className={`flex items-center gap-2 rounded border border-[#1E2631] bg-[#0B0E11] px-2 py-1.5 text-[11px] ${
                listed ? "cursor-pointer hover:border-slate-600" : "opacity-45"
              }`}
              title={listed ? state.symbol : undefined}
            >
              <input
                type="checkbox"
                className="h-3 w-3 accent-[#00E5FF]"
                checked={visible}
                disabled={!listed}
                onChange={() => props.onToggle(source)}
                aria-label={`Show ${source} trades`}
              />
              <VenueTag source={source} withName />
              {source === CHART_SOURCE && <span className="text-[9px] uppercase tracking-wider text-slate-500">chart</span>}
              <span className="ml-auto">
                <SourceState state={state} status={props.statuses[source]} />
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function SourceState({ state, status }: { state: RowState; status: SourceStatuses[SourceId] }) {
  if (state.kind === "unlisted") return <span className="text-[10px] text-slate-500">Not listed</span>;
  if (state.kind === "unavailable") {
    return (
      <span className="text-[10px] text-amber-400" title="Instrument list could not be loaded (network or DNS block?)">
        Unreachable
      </span>
    );
  }
  const info = STATUS_INFO[status ?? "connecting"];
  const tone = TONE_STYLE[info.tone];
  return (
    <span className="flex items-center gap-1.5" title={info.label}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      <span className={`text-[10px] ${tone.text}`}>{info.label}</span>
    </span>
  );
}
