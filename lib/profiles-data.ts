import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { profileAccessWhere } from "@/lib/access";

export type ProfileCertification = {
  id: string;
  name: string;
  date: string;
};

export type ProfileEducation = {
  id: string;
  school: string;
  degree: string;
  /** YYYY-MM */
  start: string;
  /** YYYY-MM or empty = Present */
  end: string;
};

export function normalizeProfileCertifications(
  raw: unknown,
): ProfileCertification[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileCertification[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const name = String(obj.name || "").trim();
    if (!name) return;
    out.push({
      id: String(obj.id || `legacy-${index}`),
      name,
      date: String(obj.date || "").trim(),
    });
  });
  return out;
}

export function normalizeProfileEducation(raw: unknown): ProfileEducation[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileEducation[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const school = String(obj.school || obj.institution || "").trim();
    const degree = String(obj.degree || "").trim();
    if (!school && !degree) return;
    out.push({
      id: String(obj.id || `legacy-${index}`),
      school,
      degree,
      start: String(obj.start || "").trim(),
      end: String(obj.end || "").trim(),
    });
  });
  return out;
}

export async function getProfilesList(
  userId: string,
  role: Role,
  opts: { filter?: string; q?: string } = {},
) {
  const access = profileAccessWhere(userId, role);
  const profiles = await prisma.profile.findMany({
    where: {
      ...access,
      ...(opts.filter === "starred" ? { starred: true } : {}),
      ...(opts.filter && opts.filter !== "all" && opts.filter !== "starred"
        ? { country: opts.filter }
        : {}),
      ...(opts.q
        ? {
            OR: [
              { fullName: { contains: opts.q, mode: "insensitive" } },
              { displayName: { contains: opts.q, mode: "insensitive" } },
              { email: { contains: opts.q, mode: "insensitive" } },
              { code: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ starred: "desc" }, { code: "asc" }],
    include: {
      _count: { select: { processes: true, experiences: true } },
    },
  });

  const allForCounts = await prisma.profile.findMany({
    where: access,
    select: { country: true, starred: true },
  });

  const byCountry: Record<string, number> = {};
  let starred = 0;
  for (const p of allForCounts) {
    byCountry[p.country] = (byCountry[p.country] ?? 0) + 1;
    if (p.starred) starred++;
  }

  return {
    profiles: profiles.map((p) => ({
      id: p.id,
      code: p.code,
      displayName: p.displayName,
      fullName: p.fullName,
      email: p.email,
      phone: p.phone,
      location: p.location,
      zipCode: p.zipCode,
      country: p.country,
      timezone: p.timezone,
      linkedinUrl: p.linkedinUrl,
      githubUrl: p.githubUrl,
      resumeFileUrl: p.resumeFileUrl,
      starred: p.starred,
      processCount: p._count.processes,
      experienceCount: p._count.experiences,
    })),
    counts: {
      all: allForCounts.length,
      starred,
      byCountry,
    },
  };
}

export async function getProfileDetail(
  userId: string,
  role: Role,
  profileId: string,
) {
  const access = profileAccessWhere(userId, role);
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...access },
    include: {
      experiences: { orderBy: { startDate: "desc" } },
      assignedMembers: { select: { id: true, name: true, avatarColor: true } },
      interviewer: { select: { id: true, name: true, email: true } },
      apiKeys: {
        select: { id: true, mode: true, label: true, createdAt: true, key: true },
        orderBy: { createdAt: "asc" },
      },
      processes: {
        orderBy: { updatedAt: "desc" },
        include: {
          rounds: { orderBy: { roundNumber: "asc" }, take: 1 },
          _count: { select: { rounds: true } },
        },
      },
    },
  });
  if (!profile) return null;
  return {
    ...profile,
    apiKeys: profile.apiKeys.map((k) => ({
      id: k.id,
      mode: k.mode,
      label: k.label,
      createdAt: k.createdAt,
      keyPreview:
        k.key.length > 8
          ? `${k.key.slice(0, 4)}…${k.key.slice(-4)}`
          : "****",
    })),
  };
}

export async function listInterviewers() {
  return prisma.user.findMany({
    where: { role: "INTERVIEWER" },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

/** Members/admins who can be assigned to profiles. */
export async function listAssignableMembers() {
  return prisma.user.findMany({
    where: { role: { in: ["ADMIN", "MEMBER"] } },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}
