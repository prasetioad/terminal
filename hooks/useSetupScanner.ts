"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScanResult, ScanRow } from "@/lib/server/scanner";
import type { StochPreset } from "@/lib/setups/setupV1";
import { formatPrice } from "@/lib/format";
import { loadJson, saveJson } from "@/lib/storage";

const POLL_MS = 5 * 60_000;
const SEEN_KEY = "orderflow-terminal:scanner-seen:v1";
const NOTIFY_KEY = "orderflow-terminal:scanner-notify:v1";
const MAX_SEEN = 2_000;

export type ScannerStatus = "loading" | "ready" | "error";

const entryKey = (r: ScanRow) => `${r.symbol}|${r.entryTime}`;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Polls the Setup v1 scanner (the server rescans once per closed 4h bar). Entries the
 * viewer hasn't looked at yet are "unseen"; with notifications on, each new one raises
 * a browser notification once.
 */
export function useSetupScanner(stoch: StochPreset) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [status, setStatus] = useState<ScannerStatus>("loading");
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(loadJson(SEEN_KEY, isStringArray) ?? []));
  const [notify, setNotify] = useState(() => loadJson(NOTIFY_KEY, (v): v is boolean => typeof v === "boolean") ?? false);
  const notified = useRef(new Set<string>());

  useEffect(() => saveJson(SEEN_KEY, [...seen].slice(-MAX_SEEN)), [seen]);
  useEffect(() => saveJson(NOTIFY_KEY, notify), [notify]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/setups/scan?stoch=${encodeURIComponent(stoch)}`, { signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setResult((await res.json()) as ScanResult);
        setStatus("ready");
      } catch {
        if (!signal?.aborted) setStatus((s) => (s === "ready" ? s : "error"));
      }
    },
    [stoch],
  );

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    void load(controller.signal);
    const id = setInterval(() => void load(controller.signal), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load(controller.signal);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const unseen = useMemo(() => (result?.rows ?? []).filter((r) => r.status === "entry" && !seen.has(entryKey(r))), [result, seen]);

  // One browser notification per new entry.
  useEffect(() => {
    if (!notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const r of unseen) {
      const key = entryKey(r);
      if (notified.current.has(key)) continue;
      notified.current.add(key);
      new Notification(`Setup v1 · ${r.base}/USDT long`, {
        body: `Entry ${formatPrice(r.entryPrice, r.precision)} · stop ${formatPrice(r.stopPrice, r.precision)} (−15%) · 4h close`,
        tag: key,
      });
    }
  }, [unseen, notify]);

  /** Mark every current entry as seen (the viewer opened the scanner). */
  const acknowledge = useCallback(() => {
    setSeen((prev) => {
      const entries = (result?.rows ?? []).filter((r) => r.status === "entry").map(entryKey);
      if (entries.every((k) => prev.has(k))) return prev;
      return new Set([...prev, ...entries]);
    });
  }, [result]);

  const toggleNotify = useCallback(async () => {
    if (notify) {
      setNotify(false);
      return;
    }
    if (typeof Notification === "undefined") return;
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setNotify(permission === "granted");
  }, [notify]);

  return { result, status, unseen, acknowledge, notify, toggleNotify, reload: () => void load() };
}
