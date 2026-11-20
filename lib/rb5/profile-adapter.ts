import type { Profile, Experience, ProfileApiKey, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { profileAccessWhere } from "@/lib/access";
import type { Rb5Profile } from "@/lib/rb5/prompt";

function ym(d: Date | null | undefined) {
  if (!d) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function splitName(fullName: string, firstName?: string | null, lastName?: string | null) {
  if (firstName || lastName) {
    return {
      firstName: firstName || "",
      lastName: lastName || "",
    };
  }
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function toRb5Profile(
  profile: Profile & {
    experiences: Experience[];
    apiKeys?: ProfileApiKey[];
  },
  opts: { includeRawKeys?: boolean; ownerName?: string; ownerEmail?: string } = {},
) {
  const names = splitName(profile.fullName, profile.firstName, profile.lastName);
  const education = Array.isArray(profile.education)
    ? profile.education
    : [];
  const certifications = Array.isArray(profile.certifications)
    ? profile.certifications
    : [];

  const base = {
    _id: profile.id,
    id: profile.id,
    name: profile.displayName || profile.fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    email: profile.email,
    phone: profile.phone || "",
    location: profile.location || "",
    zipCode: profile.zipCode || "",
    country: profile.country || "",
    linkedin: profile.linkedinUrl || "",
    github: profile.githubUrl || "",
    experience: profile.experiences.map((e) => ({
      company: e.company,
      role: e.role,
      location: e.location || "",
      start: ym(e.startDate),
      end: e.endDate ? ym(e.endDate) : "",
    })),
    education,
    certifications,
    bulletMin: profile.bulletMin,
    bulletMax: profile.bulletMax,
    resumeTemplateId: profile.resumeTemplateId,
    promptId: profile.promptId || "default",
    autoFillPromptId: profile.autoFillPromptId || "default",
    autoFillPrefs: profile.autoFillPrefs || {},
    code: profile.code,
    timezone: profile.timezone,
    starred: profile.starred,
    ownerName: opts.ownerName || "",
    ownerEmail: opts.ownerEmail || "",
  };

  if (opts.includeRawKeys && profile.apiKeys) {
    return {
      ...base,
      apiKeys: {
        free: profile.apiKeys
          .filter((k) => k.mode === "FREE")
          .map((k) => ({
            id: k.id,
            key: k.key,
            label: k.label || "",
            createdAt: k.createdAt.toISOString(),
          })),
        pro: profile.apiKeys
          .filter((k) => k.mode === "PRO")
          .map((k) => ({
            id: k.id,
            key: k.key,
            label: k.label || "",
            createdAt: k.createdAt.toISOString(),
          })),
      },
    };
  }

  return base;
}

export function toPromptProfile(
  profile: Profile & { experiences: Experience[] },
): Rb5Profile {
  const mapped = toRb5Profile(profile);
  return {
    name: mapped.name,
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    email: mapped.email,
    phone: mapped.phone,
    location: mapped.location,
    zipCode: mapped.zipCode,
    country: mapped.country,
    linkedin: mapped.linkedin,
    github: mapped.github,
    experience: mapped.experience,
    education: mapped.education as unknown[],
    certifications: mapped.certifications as { name: string; date?: string }[],
    bulletMin: mapped.bulletMin,
    bulletMax: mapped.bulletMax,
    resumeTemplateId: mapped.resumeTemplateId,
  };
}

export async function listProfilesForUser(userId: string, role: Role) {
  const access = profileAccessWhere(userId, role);
  const profiles = await prisma.profile.findMany({
    where: access,
    include: {
      experiences: { orderBy: { startDate: "desc" } },
      assignedMembers: { select: { id: true, name: true, email: true } },
    },
    orderBy: { code: "asc" },
  });

  return profiles.map((p) => {
    const owner = p.assignedMembers[0];
    return toRb5Profile(p, {
      ownerName: owner?.name,
      ownerEmail: owner?.email,
    });
  });
}

export async function getProfileForUser(
  profileId: string,
  userId: string,
  role: Role,
  opts: { full?: boolean } = {},
) {
  const access = profileAccessWhere(userId, role);
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...access },
    include: {
      experiences: { orderBy: { startDate: "desc" } },
      apiKeys: opts.full ? true : false,
      assignedMembers: { select: { id: true, name: true, email: true } },
    },
  });
  if (!profile) return null;
  const owner = profile.assignedMembers[0];
  return toRb5Profile(profile, {
    includeRawKeys: Boolean(opts.full && role === "ADMIN"),
    ownerName: owner?.name,
    ownerEmail: owner?.email,
  });
}

export async function getPromptProfileForUser(
  profileId: string,
  userId: string,
  role: Role,
) {
  const access = profileAccessWhere(userId, role);
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...access },
    include: { experiences: { orderBy: { startDate: "desc" } } },
  });
  if (!profile) return null;
  return { db: profile, prompt: toPromptProfile(profile) };
}
