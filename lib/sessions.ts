/**
 * Trading sessions defined in each market's own time zone, so daylight-saving
 * shifts are handled by the platform's IANA tz data rather than fixed UTC offsets.
 * Crypto trades 24/7, so sessions repeat every calendar day.
 */

export type SessionId = "asia" | "london" | "newyork";

export interface SessionDef {
  id: SessionId;
  name: string;
  timeZone: string;
  start: [hour: number, minute: number];
  end: [hour: number, minute: number];
  color: string; // rgb triplet, alpha applied by the renderer
}

export const SESSIONS: readonly SessionDef[] = [
  { id: "asia", name: "Asia", timeZone: "Asia/Tokyo", start: [9, 0], end: [15, 0], color: "167, 139, 250" },
  { id: "london", name: "London", timeZone: "Europe/London", start: [8, 0], end: [16, 30], color: "56, 189, 248" },
  { id: "newyork", name: "New York", timeZone: "America/New_York", start: [9, 30], end: [16, 0], color: "245, 197, 66" },
];

export interface SessionWindow {
  def: SessionDef;
  start: number; // ms
  end: number; // ms
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const windowCache = new Map<string, SessionWindow>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`. */
function zoneOffset(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(utcMs)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `timeZone` (second pass settles DST transitions). */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const wall = Date.UTC(y, m, d, hh, mm);
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

function windowOn(def: SessionDef, y: number, m: number, d: number): SessionWindow {
  const key = `${def.id}:${y}-${m}-${d}`;
  let w = windowCache.get(key);
  if (!w) {
    w = {
      def,
      start: zonedToUtc(y, m, d, def.start[0], def.start[1], def.timeZone),
      end: zonedToUtc(y, m, d, def.end[0], def.end[1], def.timeZone),
    };
    windowCache.set(key, w);
  }
  return w;
}

/** Every session window overlapping [fromMs, toMs], ordered by start. */
export function sessionWindows(fromMs: number, toMs: number, ids?: ReadonlySet<SessionId>): SessionWindow[] {
  const out: SessionWindow[] = [];
  // Session calendar days can differ from UTC days by up to a day either way.
  for (let day = Math.floor(fromMs / DAY_MS) - 1; day <= Math.floor(toMs / DAY_MS) + 1; day++) {
    const date = new Date(day * DAY_MS);
    for (const def of SESSIONS) {
      if (ids && !ids.has(def.id)) continue;
      const w = windowOn(def, date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      if (w.end > fromMs && w.start < toMs) out.push(w);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Where cumulative studies (VWAP, CVD) restart. */
export type AnchorKind = "none" | "day" | "week" | SessionId;

/** Start (ms) of the anchor period containing `timeMs`; days and weeks follow UTC, as crypto venues do. */
export function anchorStart(kind: AnchorKind, timeMs: number): number {
  switch (kind) {
    case "none":
      return Number.NEGATIVE_INFINITY;
    case "day":
      return Math.floor(timeMs / DAY_MS) * DAY_MS;
    case "week": {
      const day = Math.floor(timeMs / DAY_MS);
      const weekday = (day + 3) % 7; // 1970-01-01 was a Thursday; 0 = Monday
      return (day - weekday) * DAY_MS;
    }
    default: {
      // Latest start of that session at or before timeMs.
      const windows = sessionWindows(timeMs - 2 * DAY_MS, timeMs + 1, new Set([kind]));
      let start = Number.NEGATIVE_INFINITY;
      for (const w of windows) if (w.start <= timeMs) start = w.start;
      return start;
    }
  }
}

export const ANCHOR_OPTIONS: readonly { value: AnchorKind; label: string }[] = [
  { value: "none", label: "Never" },
  { value: "day", label: "Daily (UTC)" },
  { value: "week", label: "Weekly (UTC)" },
  { value: "asia", label: "Asia session" },
  { value: "london", label: "London session" },
  { value: "newyork", label: "New York session" },
];
