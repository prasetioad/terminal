"use client";

import { useEffect, useRef, useState } from "react";
import { ManagedSocket, type MarketEvent, type StreamSpec } from "@/lib/streams";
import type { SourceId } from "@/lib/venues";
import type { ConnectionStatus } from "@/lib/types";

export type SourceStatuses = Partial<Record<SourceId, ConnectionStatus>>;

/**
 * Keeps one ManagedSocket per spec. Specs are diffed by key, so a changed list
 * only opens/closes the feeds that actually changed. The event handler is read
 * through a ref, so re-renders never reconnect anything.
 */
export function useMarketStreams(
  specs: readonly StreamSpec[],
  onEvent: (event: MarketEvent) => void,
): SourceStatuses {
  const [statuses, setStatuses] = useState<SourceStatuses>({});
  const onEventRef = useRef(onEvent);
  const socketsRef = useRef(new Map<string, { source: SourceId; socket: ManagedSocket }>());

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const sockets = socketsRef.current;
    const wanted = new Map(specs.map((spec) => [spec.key, spec]));

    for (const [key, { source, socket }] of sockets) {
      if (wanted.has(key)) continue;
      socket.stop();
      sockets.delete(key);
      setStatuses(({ [source]: _removed, ...rest }) => rest);
    }

    for (const [key, spec] of wanted) {
      if (sockets.has(key)) continue;
      const socket = new ManagedSocket({
        spec,
        onEvent: (event) => onEventRef.current(event),
        onStatus: (status) => {
          // Ignore late status reports from a socket that has since been replaced.
          if (sockets.get(key)?.socket !== socket) return;
          setStatuses((prev) => (prev[spec.source] === status ? prev : { ...prev, [spec.source]: status }));
        },
      });
      sockets.set(key, { source: spec.source, socket });
      socket.start();
    }
  }, [specs]);

  // Close everything on unmount.
  useEffect(() => {
    const sockets = socketsRef.current;
    return () => {
      for (const { socket } of sockets.values()) socket.stop();
      sockets.clear();
    };
  }, []);

  return statuses;
}
