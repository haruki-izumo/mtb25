import type { Role } from "@prisma/client";
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { prisma } from "@/lib/prisma";
import { profileAccessWhere } from "@/lib/access";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";

const LIST_LIMIT = 500;

export type ApplicationDateRange =
  | "all"
  | "today"
  | "week"
  | "month"
  | "custom";

const DATE_RANGES = new Set<ApplicationDateRange>([
  "all",
  "today",
  "week",
  "month",
  "custom",
]);

export function parseApplicationDateRange(
  value: string | undefined,
): ApplicationDateRange {
  if (value && DATE_RANGES.has(value as ApplicationDateRange)) {
    return value as ApplicationDateRange;
  }
  return "all";
}

function safePdfUrl(url: string | null): string | null {
  if (!url || !url.startsWith("/uploads/applications/")) return null;
  return url;
}

function dayStartInZone(dateKey: string, timeZone: string): Date {
  return fromZonedTime(`${dateKey}T00:00:00`, timeZone);
}

function dayEndInZone(dateKey: string, timeZone: string): Date {
  return fromZonedTime(`${dateKey}T23:59:59.999`, timeZone);
}

function rangeBounds(params: {
  range: ApplicationDateRange;
  from?: string;
  to?: string;
  timeZone: string;
}): { gte?: Date; lte?: Date } {
  const { range, from, to, timeZone } = params;
  const nowZoned = toZonedTime(new Date(), timeZone);

  switch (range) {
    case "today": {
      const start = startOfDay(nowZoned);
      const end = endOfDay(nowZoned);
      return {
        gte: fromZonedTime(start, timeZone),
        lte: fromZonedTime(end, timeZone),
      };
    }
    case "week": {
      const start = startOfWeek(nowZoned, { weekStartsOn: 0 });
      const end = endOfWeek(nowZoned, { weekStartsOn: 0 });
      return {
        gte: fromZonedTime(start, timeZone),
        lte: fromZonedTime(end, timeZone),
      };
    }
    case "month": {
      const start = startOfMonth(nowZoned);
      const end = endOfMonth(nowZoned);
      return {
        gte: fromZonedTime(start, timeZone),
        lte: fromZonedTime(end, timeZone),
      };
    }
    case "custom": {
      const gte =
        from && /^\d{4}-\d{2}-\d{2}$/.test(from)
          ? dayStartInZone(from, timeZone)
          : undefined;
      const lte =
        to && /^\d{4}-\d{2}-\d{2}$/.test(to)
          ? dayEndInZone(to, timeZone)
          : undefined;
      return { gte, lte };
    }
    case "all":
      return {};
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

export async function getApplicationsPageData(params: {
  userId: string;
  role: Role;
  profileId?: string;
  q?: string;
  range?: ApplicationDateRange;
  from?: string;
  to?: string;
}) {
  const access = profileAccessWhere(params.userId, params.role);
  const query = params.q?.trim() ?? "";
  const range = params.range ?? "all";

  const [profiles, user] = await Promise.all([
    prisma.profile.findMany({
      where: access ?? {},
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        displayName: true,
        country: true,
        _count: { select: { applications: true } },
      },
    }),
    prisma.user.findUnique({
      where: { id: params.userId },
      select: { timezone: true },
    }),
  ]);

  const timeZone = user?.timezone || DEFAULT_TIMEZONE;
  const allowed = new Set(profiles.map((p) => p.id));
  const profileId =
    params.profileId && allowed.has(params.profileId)
      ? params.profileId
      : undefined;

  const scope = {
    ...(access ? { profile: access } : {}),
    ...(profileId ? { profileId } : {}),
  };

  const bounds = rangeBounds({
    range,
    from: params.from,
    to: params.to,
    timeZone,
  });
  const createdAtFilter =
    bounds.gte || bounds.lte
      ? {
          createdAt: {
            ...(bounds.gte ? { gte: bounds.gte } : {}),
            ...(bounds.lte ? { lte: bounds.lte } : {}),
          },
        }
      : {};

  const where = {
    ...scope,
    ...createdAtFilter,
    ...(query
      ? {
          OR: [
            { company: { contains: query, mode: "insensitive" as const } },
            { jobTitle: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, totalCount] = await Promise.all([
    prisma.application.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      include: {
        profile: {
          select: {
            id: true,
            code: true,
            displayName: true,
            country: true,
          },
        },
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.application.count({ where }),
  ]);

  return {
    timeZone,
    profileId: profileId ?? null,
    range,
    from: params.from ?? null,
    to: params.to ?? null,
    query,
    totalCount,
    truncated: totalCount > rows.length,
    profiles: profiles.map((p) => ({
      id: p.id,
      code: p.code,
      displayName: p.displayName,
      country: p.country,
      applicationCount: p._count.applications,
    })),
    applications: rows.map((row) => ({
      id: row.id,
      company: row.company,
      jobTitle: row.jobTitle,
      url: row.url,
      status: row.status,
      mode: row.mode,
      resumeTemplate: row.resumeTemplate,
      resumePdfUrl: safePdfUrl(row.resumePdfUrl),
      coverPdfUrl: safePdfUrl(row.coverPdfUrl),
      whenLabel: formatInTimeZone(
        row.appliedAt ?? row.createdAt,
        timeZone,
        "MMM d, yyyy · h:mm a",
      ),
      profile: row.profile,
      ownerName: row.owner?.name ?? null,
    })),
  };
}
