import { TickMarkType, type Time } from "lightweight-charts";

/**
 * lightweight-charts renders UTC by default. Intraday timeframes format the time axis
 * and the crosshair label in the viewer's local time so the chart matches the trade
 * feed. Daily bars open at 00:00 UTC, as on the exchanges: they are labelled by their
 * UTC date, which local time would shift (to 07:00, or to the previous day west of UTC).
 * `time` is always a UTCTimestamp (seconds) in this app.
 */

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

interface DateParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function partsOf(time: Time, utc: boolean): DateParts {
  const d = new Date((time as number) * 1000);
  return utc
    ? { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds() }
    : { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds() };
}

export interface TimeFormats {
  tickMarkFormatter: (time: Time, type: TickMarkType) => string;
  timeFormatter: (time: Time) => string;
  /** Whether the axis shows times of day at all. */
  timeVisible: boolean;
}

export function timeFormatsFor(intervalMs: number): TimeFormats {
  const daily = intervalMs >= DAY_MS;
  return {
    timeVisible: !daily,
    tickMarkFormatter(time, type) {
      const p = partsOf(time, daily);
      switch (type) {
        case TickMarkType.Year:
          return String(p.year);
        case TickMarkType.Month:
          return MONTHS[p.month];
        case TickMarkType.DayOfMonth:
          return `${p.day} ${MONTHS[p.month]}`;
        case TickMarkType.TimeWithSeconds:
          return `${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}`;
        case TickMarkType.Time:
          return `${pad2(p.hours)}:${pad2(p.minutes)}`;
      }
    },
    timeFormatter(time) {
      const p = partsOf(time, daily);
      const date = `${p.day} ${MONTHS[p.month]}`;
      return daily ? `${date} '${String(p.year).slice(2)}` : `${date} ${pad2(p.hours)}:${pad2(p.minutes)}`;
    },
  };
}
