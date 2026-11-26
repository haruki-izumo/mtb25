import { addDays, format, startOfWeek } from "date-fns";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { profileAccessWhere } from "@/lib/access";
import {
  calendarDateKey,
  formatAvailabilityText,
  getOpenIntervalsForDay,
  localDayEndUtc,
  localMinutesToUtc,
  type BusyInterval,
} from "@/lib/availability";

export type AvailabilityDay = {
  dateKey: string;
  dateIso: string;
  weekday: number;
  open: { startAt: string; endAt: string }[];
  blocked: {
    date: string;
    startMinute: number | null;
    endMinute: number | null;
    type: "BLOCK" | "OPEN";
  }[];
  booked: { startAt: string; endAt: string }[];
  bookedCount: number;
};

function buildWeekDays(params: {
  weekStart: Date;
  timeZone: string;
  rules: { weekday: number; startMinute: number; endMinute: number }[];
  overrides: {
    date: string;
    startMinute: number | null;
    endMinute: number | null;
    type: "BLOCK" | "OPEN";
  }[];
  busy: BusyInterval[];
}) {
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(params.weekStart, i);
    const dateKey = format(day, "yyyy-MM-dd");
    const dayStart = localMinutesToUtc(dateKey, 0, params.timeZone);
    const dayEnd = localDayEndUtc(dateKey, params.timeZone);

    const open = getOpenIntervalsForDay({
      dateKey,
      timeZone: params.timeZone,
      rules: params.rules,
      overrides: params.overrides,
      busy: params.busy,
    });

    const blocked = params.overrides.filter(
      (o) => o.date === dateKey && o.type === "BLOCK",
    );

    const booked = params.busy.filter(
      (b) => b.startAt < dayEnd && b.endAt > dayStart,
    );

    return {
      dateKey,
      dateIso: day.toISOString(),
      weekday: day.getDay(),
      open: open.map((iv) => ({
        startAt: iv.startAt.toISOString(),
        endAt: iv.endAt.toISOString(),
      })),
      blocked,
      booked: booked.map((b) => ({
        startAt: b.startAt.toISOString(),
        endAt: b.endAt.toISOString(),
      })),
      bookedCount: booked.length,
    } satisfies AvailabilityDay;
  });
}

function textSummaryFor(
  timeZone: string,
  rules: { weekday: number; startMinute: number; endMinute: number }[],
  overrides: {
    date: string;
    startMinute: number | null;
    endMinute: number | null;
    type: "BLOCK" | "OPEN";
  }[],
  busy: BusyInterval[],
) {
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;

  return formatAvailabilityText({
    fromDateKey: format(new Date(), "yyyy-MM-dd"),
    days: 7,
    timeZone,
    timeZoneLabel: abbr ?? "local",
    rules,
    overrides,
    busy,
  });
}

export async function getInterviewerAvailabilityData(params: {
  userId: string;
  weekStart?: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    include: {
      availabilityRules: true,
      availabilityOverrides: true,
      bookedRounds: {
        where: { outcome: { not: "CANCELED" } },
        select: { startAt: true, endAt: true },
      },
    },
  });

  if (!user) {
    return {
      mode: "interviewer" as const,
      interviewer: null,
      weekStart: null,
      days: [] as AvailabilityDay[],
      textSummary: "",
    };
  }

  const weekStart = startOfWeek(
    params.weekStart ? new Date(params.weekStart) : new Date(),
    { weekStartsOn: 0 },
  );

  const rules = user.availabilityRules.map((r) => ({
    weekday: r.weekday,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
  }));
  const overrides = user.availabilityOverrides.map((o) => ({
    date: calendarDateKey(o.date),
    startMinute: o.startMinute,
    endMinute: o.endMinute,
    type: o.type as "BLOCK" | "OPEN",
  }));
  const busy: BusyInterval[] = user.bookedRounds.map((r) => ({
    startAt: r.startAt,
    endAt: r.endAt,
  }));

  const days = buildWeekDays({
    weekStart,
    timeZone: user.timezone,
    rules,
    overrides,
    busy,
  });

  return {
    mode: "interviewer" as const,
    interviewer: {
      id: user.id,
      name: user.name,
      email: user.email,
      timezone: user.timezone,
      rules: user.availabilityRules,
    },
    weekStart: weekStart.toISOString(),
    days,
    textSummary: textSummaryFor(user.timezone, rules, overrides, busy),
  };
}

export async function getAvailabilityPageData(params: {
  userId: string;
  role: Role;
  profileId?: string;
  weekStart?: string;
  /** Sidebar list only. Used when an interviewer is editing their own hours. */
  listOnly?: boolean;
}) {
  const access = profileAccessWhere(params.userId, params.role);
  const profiles = await prisma.profile.findMany({
    where: access ?? {},
    select: {
      id: true,
      code: true,
      displayName: true,
      country: true,
      timezone: true,
    },
    orderBy: { code: "asc" },
  });

  if (params.listOnly) {
    return {
      mode: "profile" as const,
      profiles,
      profile: null,
      weekStart: null,
      days: [] as AvailabilityDay[],
      textSummary: "",
    };
  }

  const requestedId = params.profileId;
  const fallbackId = profiles[0]?.id;
  const preferredId =
    requestedId && profiles.some((p) => p.id === requestedId)
      ? requestedId
      : fallbackId;

  if (!preferredId) {
    return {
      mode: "profile" as const,
      profiles,
      profile: null,
      weekStart: null,
      days: [] as AvailabilityDay[],
      textSummary: "",
    };
  }

  const profile = await prisma.profile.findFirst({
    where: { id: preferredId, ...(access ?? {}) },
    include: {
      availabilityRules: true,
      availabilityOverrides: true,
      interviewer: { select: { name: true } },
      processes: {
        select: {
          rounds: {
            where: { outcome: { not: "CANCELED" } },
            select: { startAt: true, endAt: true },
          },
        },
      },
    },
  });

  if (!profile) {
    return {
      mode: "profile" as const,
      profiles,
      profile: null,
      weekStart: null,
      days: [] as AvailabilityDay[],
      textSummary: "",
    };
  }

  const weekStart = startOfWeek(
    params.weekStart ? new Date(params.weekStart) : new Date(),
    { weekStartsOn: 0 },
  );

  const busy: BusyInterval[] = profile.processes.flatMap((p) =>
    p.rounds.map((r) => ({ startAt: r.startAt, endAt: r.endAt })),
  );

  const rules = profile.availabilityRules.map((r) => ({
    weekday: r.weekday,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
  }));

  const overrides = profile.availabilityOverrides.map((o) => ({
    date: calendarDateKey(o.date),
    startMinute: o.startMinute,
    endMinute: o.endMinute,
    type: o.type as "BLOCK" | "OPEN",
  }));

  const days = buildWeekDays({
    weekStart,
    timeZone: profile.timezone,
    rules,
    overrides,
    busy,
  });

  return {
    mode: "profile" as const,
    profiles,
    profile: {
      id: profile.id,
      code: profile.code,
      displayName: profile.displayName,
      country: profile.country,
      timezone: profile.timezone,
      rules: profile.availabilityRules,
      interviewerName: profile.interviewer?.name ?? null,
    },
    weekStart: weekStart.toISOString(),
    days,
    textSummary: textSummaryFor(profile.timezone, rules, overrides, busy),
  };
}
