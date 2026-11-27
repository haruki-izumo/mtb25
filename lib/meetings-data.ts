import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Role, RoundType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { memberDirectoryWhere, processAccessWhere } from "@/lib/access";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

/** Sunday–Saturday containing `anchor`, as instants in `timeZone`. */
function weekRangeInZone(anchor: Date, timeZone: string) {
  const anchorKey = formatInTimeZone(anchor, timeZone, "yyyy-MM-dd");
  // date-fns "i" is ISO weekday: Monday 1 … Sunday 7. Sunday starts the grid.
  const dow = Number(formatInTimeZone(anchor, timeZone, "i")) % 7;
  const weekStartKey = shiftDateKey(anchorKey, -dow);
  const weekEndKey = shiftDateKey(weekStartKey, 6);
  return {
    weekStartKey,
    start: fromZonedTime(`${weekStartKey}T00:00:00`, timeZone),
    end: fromZonedTime(`${weekEndKey}T23:59:59.999`, timeZone),
  };
}

function dayRangeInZone(day: string, timeZone: string) {
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day
    : formatInTimeZone(new Date(day), timeZone, "yyyy-MM-dd");
  return {
    start: fromZonedTime(`${dateKey}T00:00:00`, timeZone),
    end: fromZonedTime(`${dateKey}T23:59:59.999`, timeZone),
  };
}

export async function getMeetingsWeek(params: {
  userId: string;
  role: Role;
  weekStart?: string;
  memberId?: string;
  profileId?: string;
  roundTypes?: RoundType[];
  mode?: "week" | "day";
  day?: string;
}) {
  const viewer = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { timezone: true },
  });
  const timeZone = viewer?.timezone || DEFAULT_TIMEZONE;
  const anchor = !params.weekStart
    ? new Date()
    : /^\d{4}-\d{2}-\d{2}$/.test(params.weekStart)
      ? fromZonedTime(`${params.weekStart}T12:00:00`, timeZone)
      : new Date(params.weekStart);
  const week = weekRangeInZone(anchor, timeZone);
  const day =
    params.mode === "day" && params.day
      ? dayRangeInZone(params.day, timeZone)
      : null;
  const rangeStart = day?.start ?? week.start;
  const rangeEnd = day?.end ?? week.end;

  const rounds = await prisma.round.findMany({
    where: {
      startAt: { gte: rangeStart, lte: rangeEnd },
      process: {
        ...processAccessWhere(params.userId, params.role),
        ...(params.memberId ? { ownerMemberId: params.memberId } : {}),
        ...(params.profileId ? { profileId: params.profileId } : {}),
      },
      ...(params.roundTypes?.length
        ? { type: { in: params.roundTypes } }
        : {}),
    },
    include: {
      process: {
        include: {
          profile: {
            select: { id: true, code: true, displayName: true, country: true },
          },
          owner: { select: { id: true, name: true, avatarColor: true } },
        },
      },
    },
    orderBy: { startAt: "asc" },
  });

  const [profiles, members] = await Promise.all([
    prisma.profile.findMany({
      where: processAccessWhere(params.userId, params.role).profile,
      select: { id: true, code: true, displayName: true, country: true },
      orderBy: { code: "asc" },
    }),
    prisma.user.findMany({
      where: memberDirectoryWhere(params.userId, params.role),
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    timeZone,
    weekStart: week.start.toISOString(),
    weekEnd: week.end.toISOString(),
    days: Array.from({ length: 7 }, (_, i) =>
      fromZonedTime(
        `${shiftDateKey(week.weekStartKey, i)}T12:00:00`,
        timeZone,
      ).toISOString(),
    ),
    rounds: rounds.map((r) => ({
      id: r.id,
      type: r.type,
      outcome: r.outcome,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      interviewerName: r.interviewerName,
      meetingLink: r.meetingLink,
      companyName: r.process.companyName,
      jobTitle: r.process.jobTitle,
      status: r.process.status,
      profile: r.process.profile,
      owner: r.process.owner,
    })),
    profiles,
    members,
  };
}
