import {
  addDays,
  endOfDay,
  endOfWeek,
  startOfDay,
  startOfWeek,
} from "date-fns";
import type { RoundType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { processAccessWhere } from "@/lib/access";

export async function getMeetingsWeek(params: {
  userId: string;
  role: "ADMIN" | "MEMBER";
  weekStart?: string;
  memberId?: string;
  profileId?: string;
  roundTypes?: RoundType[];
  mode?: "week" | "day";
  day?: string;
}) {
  const base = params.weekStart
    ? startOfDay(new Date(params.weekStart))
    : startOfWeek(new Date(), { weekStartsOn: 0 });
  const weekStart = startOfWeek(base, { weekStartsOn: 0 });
  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 0 });

  const rangeStart =
    params.mode === "day" && params.day
      ? startOfDay(new Date(params.day))
      : weekStart;
  const rangeEnd =
    params.mode === "day" && params.day
      ? endOfDay(new Date(params.day))
      : weekEnd;

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
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    days: Array.from({ length: 7 }, (_, i) =>
      addDays(weekStart, i).toISOString(),
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
