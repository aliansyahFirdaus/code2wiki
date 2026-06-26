import { format } from "date-fns";

const DATE_TIME_PATTERN = "yyyy-MM-dd HH:mm:ss";
const TIME_PATTERN = "HH:mm:ss";

export function formatDateTime(value: string | Date | null | undefined) {
  const date = toDate(value);
  return date ? format(date, DATE_TIME_PATTERN) : "not started";
}

export function formatClockTime(value: string | Date | null | undefined) {
  const date = toDate(value);
  return date ? format(date, TIME_PATTERN) : "not started";
}

function toDate(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
