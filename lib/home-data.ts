import {
  endOfDay,
  endOfWeek,
  startOfDay,
  startOfWeek,
  subWeeks,
} from "date-fns";
import { prisma } from "@/lib/prisma";
import { getStatusesInGroup } from "@/lib/status";

export async function getHomeDashboardData(userId: string, role: string) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const thisWeekStart = startOfWeek(now, { weekStartsOn: 0 });
  const thisWeekEnd = endOfWeek(now, { weekStartsOn: 0 });
  const prevWeekStart = subWeeks(thisWeekStart, 1);
  const prevWeekEnd = endOfWeek(prevWeekStart, { weekStartsOn: 0 });

  const profileFilter =
    role === "ADMIN"
      ? undefined
      : { assignedMembers: { some: { id: userId } } };

  const processWhere = profileFilter ? { profile: profileFilter } : {};

  const [
    processes,
    nextRound,
    todayRounds,
    thisWeekRounds,
    prevWeekRounds,
    announcements,
  ] = await Promise.all([
    prisma.interviewProcess.findMany({
      where: processWhere,
      select: {
        id: true,
        status: true,
        rounds: {
          select: { endAt: true, outcome: true },
        },
      },
    }),
    prisma.round.findFirst({
      where: {
        startAt: { gte: now },
        outcome: { notIn: ["CANCELED"] },
        process: processWhere,
      },
      orderBy: { startAt: "asc" },
      include: {
        process: {
          include: {
            profile: {
              select: {
                code: true,
                displayName: true,
                country: true,
                timezone: true,
              },
            },
          },
        },
      },
    }),
    prisma.round.findMany({
      where: {
        startAt: { gte: todayStart, lte: todayEnd },
        process: processWhere,
      },
      orderBy: { startAt: "asc" },
      include: {
        process: {
          select: {
            companyName: true,
            jobTitle: true,
            profile: { select: { code: true, displayName: true } },
          },
        },
      },
    }),
    prisma.round.findMany({
      where: {
        startAt: { gte: thisWeekStart, lte: thisWeekEnd },
        outcome: { not: "CANCELED" },
        process: processWhere,
      },
      select: { rating: true },
    }),
    prisma.round.findMany({
      where: {
        startAt: { gte: prevWeekStart, lte: prevWeekEnd },
        outcome: { not: "CANCELED" },
        process: processWhere,
      },
      select: { rating: true },
    }),
    prisma.announcement.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const upcomingStatuses = new Set(getStatusesInGroup("UPCOMING"));
  const followUpStatuses = new Set(getStatusesInGroup("FOLLOW_UP"));
  const nextStepStatuses = new Set(["NEXT_STEP"] as const);

  let upcomingCount = 0;
  let followUpCount = 0;
  let nextStepCount = 0;
  let needsUpdateCount = 0;

  for (const p of processes) {
    if (upcomingStatuses.has(p.status)) upcomingCount++;
    if (followUpStatuses.has(p.status)) followUpCount++;
    if (nextStepStatuses.has(p.status as "NEXT_STEP")) nextStepCount++;
    if (
      p.rounds.some((r) => r.outcome === "PENDING" && r.endAt < now)
    ) {
      needsUpdateCount++;
    }
  }

  function weekStats(rounds: { rating: number | null }[]) {
    const ratings = rounds
      .map((r) => r.rating)
      .filter((r): r is number => r != null);
    const avg =
      ratings.length === 0
        ? null
        : ratings.reduce((a, b) => a + b, 0) / ratings.length;
    return { count: rounds.length, avgRating: avg };
  }

  const thisWeek = weekStats(thisWeekRounds);
  const prevWeek = weekStats(prevWeekRounds);

  const todayDone = todayRounds.filter((r) =>
    ["PASSED", "FAILED", "NO_SHOW", "CANCELED"].includes(r.outcome),
  ).length;

  return {
    stats: {
      nextStepCount,
      followUpCount,
      upcomingCount,
      needsUpdateCount,
    },
    nextRound: nextRound
      ? {
          startAt: nextRound.startAt.toISOString(),
          companyName: nextRound.process.companyName,
          jobTitle: nextRound.process.jobTitle,
          profileCode: nextRound.process.profile.code,
          profileName: nextRound.process.profile.displayName,
          country: nextRound.process.profile.country,
          timeZone: nextRound.process.profile.timezone,
        }
      : null,
    weekCompare: {
      thisWeek,
      prevWeek,
      meetingDelta: thisWeek.count - prevWeek.count,
      ratingDelta:
        thisWeek.avgRating != null && prevWeek.avgRating != null
          ? thisWeek.avgRating - prevWeek.avgRating
          : null,
    },
    todayMeetings: {
      total: todayRounds.length,
      done: todayDone,
      items: todayRounds.map((r) => ({
        id: r.id,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
        outcome: r.outcome,
        companyName: r.process.companyName,
        jobTitle: r.process.jobTitle,
        profileLabel: `${r.process.profile.code}.${r.process.profile.displayName}`,
      })),
    },
    announcements: announcements.map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
