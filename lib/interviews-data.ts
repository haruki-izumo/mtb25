import type { ProcessStatus, RoundType } from "@prisma/client";
import {
  endOfDay,
  startOfDay,
  subDays,
  subYears,
} from "date-fns";
import { prisma } from "@/lib/prisma";
import { processAccessWhere } from "@/lib/access";
import {
  STATUS_GROUPS,
  type StatusGroupId,
  getStatusesInGroup,
} from "@/lib/status";

export type InterviewRange =
  | "all"
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "1y"
  | "custom";

export type InterviewFilters = {
  group?: StatusGroupId;
  range?: InterviewRange;
  from?: string;
  to?: string;
  q?: string;
  sort?: "asc" | "desc";
  profileId?: string;
  memberId?: string;
  roundType?: RoundType;
};

function rangeBounds(filters: InterviewFilters): { gte?: Date; lte?: Date } {
  const now = new Date();
  switch (filters.range ?? "all") {
    case "today":
      return { gte: startOfDay(now), lte: endOfDay(now) };
    case "7d":
      return { gte: subDays(now, 7) };
    case "30d":
      return { gte: subDays(now, 30) };
    case "90d":
      return { gte: subDays(now, 90) };
    case "1y":
      return { gte: subYears(now, 1) };
    case "custom": {
      const gte = filters.from ? startOfDay(new Date(filters.from)) : undefined;
      const lte = filters.to ? endOfDay(new Date(filters.to)) : undefined;
      return { gte, lte };
    }
    default:
      return {};
  }
}

export async function getInterviewSidebarCounts(
  userId: string,
  role: "ADMIN" | "MEMBER",
) {
  const now = new Date();
  const processes = await prisma.interviewProcess.findMany({
    where: processAccessWhere(userId, role),
    select: {
      id: true,
      status: true,
      rounds: { select: { endAt: true, outcome: true } },
    },
  });

  const counts: Record<StatusGroupId, number> = {
    ALL: processes.length,
    OFFER: 0,
    UPCOMING: 0,
    FOLLOW_UP: 0,
    NEEDS_UPDATE: 0,
    CLOSED: 0,
  };

  for (const p of processes) {
    for (const g of STATUS_GROUPS) {
      if (g.id === "ALL" || g.derived) continue;
      if (g.statuses.includes(p.status)) counts[g.id]++;
    }
    if (p.rounds.some((r) => r.outcome === "PENDING" && r.endAt < now)) {
      counts.NEEDS_UPDATE++;
    }
  }

  return counts;
}

export async function getInterviewProcesses(
  userId: string,
  role: "ADMIN" | "MEMBER",
  filters: InterviewFilters,
) {
  const now = new Date();
  const bounds = rangeBounds(filters);
  const group = filters.group ?? "ALL";

  const where = {
    ...processAccessWhere(userId, role),
    ...(filters.profileId ? { profileId: filters.profileId } : {}),
    ...(filters.memberId ? { ownerMemberId: filters.memberId } : {}),
    ...(filters.q
      ? {
          OR: [
            { companyName: { contains: filters.q, mode: "insensitive" as const } },
            { jobTitle: { contains: filters.q, mode: "insensitive" as const } },
            {
              profile: {
                OR: [
                  { code: { contains: filters.q, mode: "insensitive" as const } },
                  {
                    displayName: {
                      contains: filters.q,
                      mode: "insensitive" as const,
                    },
                  },
                ],
              },
            },
          ],
        }
      : {}),
    ...(bounds.gte || bounds.lte
      ? {
          rounds: {
            some: {
              startAt: {
                ...(bounds.gte ? { gte: bounds.gte } : {}),
                ...(bounds.lte ? { lte: bounds.lte } : {}),
              },
            },
          },
        }
      : {}),
    ...(filters.roundType
      ? { rounds: { some: { type: filters.roundType } } }
      : {}),
  };

  let processes = await prisma.interviewProcess.findMany({
    where,
    include: {
      profile: {
        select: {
          id: true,
          code: true,
          displayName: true,
          country: true,
        },
      },
      owner: { select: { id: true, name: true, avatarColor: true } },
      rounds: { orderBy: { roundNumber: "asc" } },
    },
    orderBy: { updatedAt: filters.sort === "asc" ? "asc" : "desc" },
  });

  if (group === "NEEDS_UPDATE") {
    processes = processes.filter((p) =>
      p.rounds.some((r) => r.outcome === "PENDING" && r.endAt < now),
    );
  } else if (group !== "ALL") {
    const statuses = new Set<ProcessStatus>(getStatusesInGroup(group));
    processes = processes.filter((p) => statuses.has(p.status));
  }

  return processes.map((p) => {
    const upcoming = p.rounds
      .filter((r) => r.outcome !== "CANCELED" && r.startAt >= now)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0];
    const next = upcoming ?? [...p.rounds].reverse()[0] ?? null;
    const daysUntil = upcoming
      ? Math.ceil((upcoming.startAt.getTime() - now.getTime()) / 86_400_000)
      : null;

    return {
      id: p.id,
      companyName: p.companyName,
      jobTitle: p.jobTitle,
      jobUrl: p.jobUrl,
      status: p.status,
      note: p.note,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      profileId: p.profileId,
      profile: p.profile,
      owner: p.owner,
      roundCount: p.rounds.length,
      nextRoundAt: next?.startAt.toISOString() ?? null,
      daysUntil,
      needsUpdate: p.rounds.some(
        (r) => r.outcome === "PENDING" && r.endAt < now,
      ),
      rounds: p.rounds.map((r) => ({
        id: r.id,
        roundNumber: r.roundNumber,
        type: r.type,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
        interviewerName: r.interviewerName,
        meetingLink: r.meetingLink,
        outcome: r.outcome,
        rating: r.rating,
        feedback: r.feedback,
      })),
    };
  });
}

export async function getInterviewFilterOptions(
  userId: string,
  role: "ADMIN" | "MEMBER",
) {
  const access = processAccessWhere(userId, role);
  const [profiles, members] = await Promise.all([
    prisma.profile.findMany({
      where: access.profile,
      select: { id: true, code: true, displayName: true, country: true },
      orderBy: { code: "asc" },
    }),
    prisma.user.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { profiles, members };
}
