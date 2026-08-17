import type { BucketSize } from "./contracts";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function selectAutomaticBucket(fromMs: number, toMs: number): BucketSize {
  const durationMs = Math.max(0, toMs - fromMs);
  if (durationMs <= 6 * 60 * 60 * 1_000) {
    return "minute";
  }
  if (durationMs <= 90 * 24 * 60 * 60 * 1_000) {
    return "hour";
  }
  if (durationMs <= 2 * 365 * 24 * 60 * 60 * 1_000) {
    return "day";
  }
  return "week";
}

export function fixedBucketDurationMs(bucket: BucketSize): number | null {
  if (bucket === "minute") return 60_000;
  if (bucket === "hour") return 3_600_000;
  return null;
}

export function bucketTimestampMs(
  timestampMs: number,
  bucket: BucketSize,
  timeZone: string,
): number {
  const fixedDuration = fixedBucketDurationMs(bucket);
  if (fixedDuration !== null) {
    return Math.floor(timestampMs / fixedDuration) * fixedDuration;
  }

  const localDate = zonedDateParts(timestampMs, timeZone);
  if (bucket === "week") {
    const calendarDate = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day));
    const daysSinceMonday = (calendarDate.getUTCDay() + 6) % 7;
    calendarDate.setUTCDate(calendarDate.getUTCDate() - daysSinceMonday);
    return zonedDateTimeToUtcMs(
      calendarDate.getUTCFullYear(),
      calendarDate.getUTCMonth() + 1,
      calendarDate.getUTCDate(),
      timeZone,
    );
  }

  return zonedDateTimeToUtcMs(localDate.year, localDate.month, localDate.day, timeZone);
}

export function zonedDayKey(timestampMs: number, timeZone: string): string {
  const { day, month, year } = zonedDateParts(timestampMs, timeZone);
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
}

export function assertValidTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }
}

function zonedDateParts(timestampMs: number, timeZone: string) {
  const formatter = getFormatter(timeZone);
  const values = new Map(
    formatter
      .formatToParts(timestampMs)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    day: values.get("day") ?? 1,
    month: values.get("month") ?? 1,
    year: values.get("year") ?? 1970,
  };
}

function zonedDateTimeParts(timestampMs: number, timeZone: string) {
  const formatter = getFormatter(timeZone);
  const values = new Map(
    formatter
      .formatToParts(timestampMs)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    day: values.get("day") ?? 1,
    hour: values.get("hour") === 24 ? 0 : (values.get("hour") ?? 0),
    minute: values.get("minute") ?? 0,
    month: values.get("month") ?? 1,
    second: values.get("second") ?? 0,
    year: values.get("year") ?? 1970,
  };
}

function zonedDateTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedDateTimeParts(guess, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = targetAsUtc - actualAsUtc;
    guess += correction;
    if (correction === 0) {
      break;
    }
  }
  return guess;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cachedFormatter = formatterCache.get(timeZone);
  if (cachedFormatter !== undefined) {
    return cachedFormatter;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}
