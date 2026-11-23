import type { Role } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { prisma } from "@/lib/prisma";
import { profileAccessWhere } from "@/lib/access";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";

export type ApplicationListState = "all" | "submitted" | "open";

const LIST_LIMIT = 500;

function safePdfUrl(url: string | null): string | null {
  if (!url || !url.startsWith("/uploads/applications/")) return null;
  return url;
}

export async function getApplicationsPageData(params: {
  userId: string;
  role: Role;
  profileId?: string;
  q?: string;
  state?: ApplicationListState;
}) {
  const access = profileAccessWhere(params.userId, params.role);
  const state = params.state ?? "all";
  const query = params.q?.trim() ?? "";

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

  const where = {
    ...scope,
    ...(state === "submitted" ? { submitted: true } : {}),
    ...(state === "open" ? { submitted: false } : {}),
    ...(query
      ? {
          OR: [
            { company: { contains: query, mode: "insensitive" as const } },
            { jobTitle: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, totalCount, submittedCount] = await Promise.all([
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
    prisma.application.count({ where: scope }),
    prisma.application.count({ where: { ...scope, submitted: true } }),
  ]);

  return {
    timeZone,
    profileId: profileId ?? null,
    state,
    query,
    totalCount,
    submittedCount,
    openCount: totalCount - submittedCount,
    truncated: totalCount > rows.length && state === "all" && !query,
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
      submitted: row.submitted,
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
