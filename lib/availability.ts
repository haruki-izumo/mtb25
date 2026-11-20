import { addDays, addMinutes, format, parseISO } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

export const SLOT_MINUTES = 15;
export const BOOKING_DURATIONS = [15, 30, 45, 60, 90] as const;
export type BookingDuration = (typeof BOOKING_DURATIONS)[number];

export type AvailabilityRuleInput = {
  weekday: number; // 0=Sun .. 6=Sat in the profile's timezone
  startMinute: number;
  endMinute: number;
};

export type AvailabilityOverrideInput = {
  /** Calendar date in profile timezone as YYYY-MM-DD */
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  type: "BLOCK" | "OPEN";
};

export type BusyInterval = {
  startAt: Date;
  endAt: Date;
};

export type UtcInterval = {
  startAt: Date;
  endAt: Date;
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Local calendar YYYY-MM-DD for an instant in a timezone. */
export function zonedDateKey(date: Date, timeZone: string): string {
  const zoned = toZonedTime(date, timeZone);
  return format(zoned, "yyyy-MM-dd");
}

/** Weekday 0–6 for an instant in a timezone. */
export function zonedWeekday(date: Date, timeZone: string): number {
  return toZonedTime(date, timeZone).getDay();
}

/**
 * Convert a local wall-clock on a calendar date in `timeZone` to a UTC Date.
 * Handles DST by using date-fns-tz fromZonedTime.
 */
export function localMinutesToUtc(
  dateKey: string,
  minuteOfDay: number,
  timeZone: string,
): Date {
  // 24:00 on a date is midnight of the next calendar day
  if (minuteOfDay >= 24 * 60) {
    const nextKey = format(addDays(parseISO(dateKey), 1), "yyyy-MM-dd");
    return localMinutesToUtc(nextKey, minuteOfDay - 24 * 60, timeZone);
  }
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const localIso = `${dateKey}T${pad2(hours)}:${pad2(minutes)}:00`;
  return fromZonedTime(localIso, timeZone);
}

/** Exclusive end of a local calendar day in UTC. */
export function localDayEndUtc(dateKey: string, timeZone: string): Date {
  const nextKey = format(addDays(parseISO(dateKey), 1), "yyyy-MM-dd");
  return localMinutesToUtc(nextKey, 0, timeZone);
}

function intervalsOverlap(a: UtcInterval, b: UtcInterval): boolean {
  return a.startAt < b.endAt && a.endAt > b.startAt;
}

function subtractInterval(
  base: UtcInterval,
  cut: UtcInterval,
): UtcInterval[] {
  if (!intervalsOverlap(base, cut)) return [base];
  const result: UtcInterval[] = [];
  if (cut.startAt > base.startAt) {
    result.push({ startAt: base.startAt, endAt: cut.startAt });
  }
  if (cut.endAt < base.endAt) {
    result.push({ startAt: cut.endAt, endAt: base.endAt });
  }
  return result.filter((i) => i.endAt > i.startAt);
}

function subtractAll(
  bases: UtcInterval[],
  cuts: UtcInterval[],
): UtcInterval[] {
  let current = bases;
  for (const cut of cuts) {
    current = current.flatMap((b) => subtractInterval(b, cut));
  }
  return current;
}

function mergeIntervals(intervals: UtcInterval[]): UtcInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );
  const merged: UtcInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const next = sorted[i];
    if (next.startAt <= last.endAt) {
      if (next.endAt > last.endAt) last.endAt = next.endAt;
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

/**
 * Build open UTC intervals for a single local calendar day in the profile timezone.
 * Formula: recurring rules + OPEN overrides − BLOCK overrides − busy (booked) intervals.
 */
export function getOpenIntervalsForDay(params: {
  dateKey: string;
  timeZone: string;
  rules: AvailabilityRuleInput[];
  overrides: AvailabilityOverrideInput[];
  busy: BusyInterval[];
}): UtcInterval[] {
  const { dateKey, timeZone, rules, overrides, busy } = params;
  const noonUtc = fromZonedTime(`${dateKey}T12:00:00`, timeZone);
  const weekday = zonedWeekday(noonUtc, timeZone);

  const dayOverrides = overrides.filter((o) => o.date === dateKey);
  const hasFullDayBlock = dayOverrides.some(
    (o) =>
      o.type === "BLOCK" && o.startMinute == null && o.endMinute == null,
  );

  let open: UtcInterval[] = [];

  if (!hasFullDayBlock) {
    for (const rule of rules.filter((r) => r.weekday === weekday)) {
      if (rule.endMinute <= rule.startMinute) continue;
      open.push({
        startAt: localMinutesToUtc(dateKey, rule.startMinute, timeZone),
        endAt: localMinutesToUtc(dateKey, rule.endMinute, timeZone),
      });
    }

    for (const o of dayOverrides.filter((x) => x.type === "OPEN")) {
      const start = o.startMinute ?? 0;
      const end = o.endMinute ?? 24 * 60;
      if (end <= start) continue;
      open.push({
        startAt: localMinutesToUtc(dateKey, start, timeZone),
        endAt: localMinutesToUtc(dateKey, end, timeZone),
      });
    }
  }

  open = mergeIntervals(open);

  const blocks: UtcInterval[] = [];
  for (const o of dayOverrides.filter((x) => x.type === "BLOCK")) {
    if (o.startMinute == null && o.endMinute == null) continue;
    const start = o.startMinute ?? 0;
    const end = o.endMinute ?? 24 * 60;
    if (end <= start) continue;
    blocks.push({
      startAt: localMinutesToUtc(dateKey, start, timeZone),
      endAt: localMinutesToUtc(dateKey, end, timeZone),
    });
  }

  const dayStart = localMinutesToUtc(dateKey, 0, timeZone);
  const dayEnd = localDayEndUtc(dateKey, timeZone);
  const busyOnDay = busy
    .filter((b) => b.startAt < dayEnd && b.endAt > dayStart)
    .map((b) => ({
      startAt: b.startAt < dayStart ? dayStart : b.startAt,
      endAt: b.endAt > dayEnd ? dayEnd : b.endAt,
    }));

  return subtractAll(open, [...blocks, ...busyOnDay]);
}

/** Split open intervals into bookable start times for a given duration. */
export function getBookableSlots(
  openIntervals: UtcInterval[],
  durationMinutes: BookingDuration,
  slotMinutes: number = SLOT_MINUTES,
): Date[] {
  const slots: Date[] = [];
  for (const interval of openIntervals) {
    let cursor = interval.startAt;
    while (addMinutes(cursor, durationMinutes) <= interval.endAt) {
      slots.push(cursor);
      cursor = addMinutes(cursor, slotMinutes);
    }
  }
  return slots;
}

export function rangesOverlap(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): boolean {
  return startA < endB && endA > startB;
}

/** Plain-text availability summary for N days starting at `fromDateKey`. */
export function formatAvailabilityText(params: {
  fromDateKey: string;
  days: number;
  timeZone: string;
  timeZoneLabel: string;
  rules: AvailabilityRuleInput[];
  overrides: AvailabilityOverrideInput[];
  busy: BusyInterval[];
}): string {
  const lines: string[] = [];
  const start = fromZonedTime(`${params.fromDateKey}T12:00:00`, params.timeZone);

  for (let i = 0; i < params.days; i++) {
    const day = addDays(start, i);
    const dateKey = zonedDateKey(day, params.timeZone);
    const open = getOpenIntervalsForDay({
      dateKey,
      timeZone: params.timeZone,
      rules: params.rules,
      overrides: params.overrides,
      busy: params.busy,
    });

    const label = format(toZonedTime(day, params.timeZone), "EEE MMM d");
    if (open.length === 0) {
      lines.push(`${label}: unavailable`);
      continue;
    }

    const ranges = open
      .map((iv) => {
        const s = toZonedTime(iv.startAt, params.timeZone);
        const e = toZonedTime(iv.endAt, params.timeZone);
        return `${format(s, "h:mma").toLowerCase()}–${format(e, "h:mma").toLowerCase()}`;
      })
      .join(", ");
    lines.push(`${label}: ${ranges} ${params.timeZoneLabel}`);
  }

  return lines.join("\n");
}
