import { TickMarkType, type Time } from "lightweight-charts";

/**
 * lightweight-charts renders UTC by default. These format the time axis and the
 * crosshair label in the viewer's local time so the chart matches the trade feed.
 * `time` is always a UTCTimestamp (seconds) in this app.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const toDate = (time: Time) => new Date((time as number) * 1000);
const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export function localTickMark(time: Time, type: TickMarkType): string {
  const d = toDate(time);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return MONTHS[d.getMonth()];
    case TickMarkType.DayOfMonth:
      return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    case TickMarkType.TimeWithSeconds:
      return `${hhmm(d)}:${pad2(d.getSeconds())}`;
    case TickMarkType.Time:
      return hhmm(d);
  }
}

export function localCrosshairTime(time: Time): string {
  const d = toDate(time);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hhmm(d)}`;
}
