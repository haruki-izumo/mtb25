import { addDays, format, startOfWeek } from "date-fns";
import { prisma } from "@/lib/prisma";
import { profileAccessWhere } from "@/lib/access";
import {
  formatAvailabilityText,
  getOpenIntervalsForDay,
  localDayEndUtc,
  localMinutesToUtc,
  type BusyInterval,
} from "@/lib/availability";

export async function getAvailabilityPageData(params: {
  userId: string;
  role: "ADMIN" | "MEMBER";
  profileId?: string;
  weekStart?: string;
}) {
  const access = profileAccessWhere(params.userId, params.role);
  const profiles = await prisma.profile.findMany({
    where: access,
    select: {
      id: true,
      code: true,
      displayName: true,
      country: true,
      timezone: true,
    },
    orderBy: { code: "asc" },
  });

  const profileId = params.profileId || profiles[0]?.id;
  if (!profileId) {
    return {
      profiles,
      profile: null,
      weekStart: null,
      days: [] as never[],
      textSummary: "",
    };
  }

  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...access },
    include: {
      availabilityRules: true,
      availabilityOverrides: true,
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
      profiles,
      profile: null,
      weekStart: null,
      days: [] as never[],
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
    date: format(o.date, "yyyy-MM-dd"),
    startMinute: o.startMinute,
    endMinute: o.endMinute,
    type: o.type as "BLOCK" | "OPEN",
  }));

  const days = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(weekStart, i);
    const dateKey = format(day, "yyyy-MM-dd");
    const dayStart = localMinutesToUtc(dateKey, 0, profile.timezone);
    const dayEnd = localDayEndUtc(dateKey, profile.timezone);

    const open = getOpenIntervalsForDay({
      dateKey,
      timeZone: profile.timezone,
      rules,
      overrides,
      busy,
    });

    const blocked = overrides.filter(
      (o) => o.date === dateKey && o.type === "BLOCK",
    );

    const booked = busy.filter(
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
    };
  });

  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: profile.timezone,
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;

  const textSummary = formatAvailabilityText({
    fromDateKey: format(new Date(), "yyyy-MM-dd"),
    days: 7,
    timeZone: profile.timezone,
    timeZoneLabel: abbr ?? "local",
    rules,
    overrides,
    busy,
  });

  return {
    profiles,
    profile: {
      id: profile.id,
      code: profile.code,
      displayName: profile.displayName,
      country: profile.country,
      timezone: profile.timezone,
      rules: profile.availabilityRules,
    },
    weekStart: weekStart.toISOString(),
    days,
    textSummary,
  };
}
