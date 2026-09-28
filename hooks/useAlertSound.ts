"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TradeAlertSound } from "@/lib/audio";
import type { Trade } from "@/lib/types";

/**
 * Audio alerts for big trades. `play` is stable and cheap to call from the
 * stream hot path; it is a no-op while alerts are off.
 */
export function useAlertSound(threshold: number) {
  const [enabled, setEnabled] = useState(false);
  const soundRef = useRef<TradeAlertSound | null>(null);
  const enabledRef = useRef(enabled);
  const thresholdRef = useRef(threshold);

  useEffect(() => {
    enabledRef.current = enabled;
    thresholdRef.current = threshold;
  }, [enabled, threshold]);

  useEffect(() => {
    return () => {
      soundRef.current?.dispose();
      soundRef.current = null;
    };
  }, []);

  const toggle = useCallback(async () => {
    if (enabledRef.current) {
      setEnabled(false);
      return;
    }
    soundRef.current ??= new TradeAlertSound();
    try {
      await soundRef.current.unlock(); // browsers only allow audio after a user gesture
      setEnabled(true);
    } catch {
      setEnabled(false);
    }
  }, []);

  const play = useCallback((trade: Trade) => {
    if (enabledRef.current) soundRef.current?.play(trade.side, trade.usd, thresholdRef.current);
  }, []);

  return { enabled, toggle, play };
}
