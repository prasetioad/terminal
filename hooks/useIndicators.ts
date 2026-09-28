"use client";

import { useCallback, useEffect, useState } from "react";
import { indicatorDefinition } from "@/lib/indicators/registry";
import { defaultParams, type IndicatorConfig, type IndicatorParams } from "@/lib/indicators/types";
import { loadJson, saveJson } from "@/lib/storage";

const STORAGE_KEY = "orderflow-terminal:indicators:v1";
const DEFAULTS: IndicatorConfig[] = [{ uid: "volume", type: "volume", params: {}, visible: true }];

function isConfigList(value: unknown): value is IndicatorConfig[] {
  return (
    Array.isArray(value) &&
    value.every(
      (c) =>
        c &&
        typeof c.uid === "string" &&
        typeof c.type === "string" &&
        typeof c.visible === "boolean" &&
        c.params !== null &&
        typeof c.params === "object",
    )
  );
}

/** The user's indicator setup, persisted across reloads. */
export function useIndicators() {
  const [configs, setConfigs] = useState<IndicatorConfig[]>(() =>
    (loadJson(STORAGE_KEY, isConfigList) ?? DEFAULTS).filter((c) => indicatorDefinition(c.type)),
  );

  useEffect(() => saveJson(STORAGE_KEY, configs), [configs]);

  const add = useCallback((type: string) => {
    const def = indicatorDefinition(type);
    if (!def) return;
    setConfigs((prev) => [...prev, { uid: crypto.randomUUID(), type, params: defaultParams(def), visible: true }]);
  }, []);

  const remove = useCallback((uid: string) => setConfigs((prev) => prev.filter((c) => c.uid !== uid)), []);

  const updateParams = useCallback(
    (uid: string, params: IndicatorParams) => setConfigs((prev) => prev.map((c) => (c.uid === uid ? { ...c, params } : c))),
    [],
  );

  const toggleVisible = useCallback(
    (uid: string) => setConfigs((prev) => prev.map((c) => (c.uid === uid ? { ...c, visible: !c.visible } : c))),
    [],
  );

  return { configs, add, remove, updateParams, toggleVisible };
}
