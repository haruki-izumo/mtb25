"use server";

import { revalidatePath } from "next/cache";
import { unlink } from "fs/promises";
import path from "path";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  requireRole,
  assertCanAccessProfile,
} from "@/lib/auth-helpers";
import { normalizeProfileCertifications } from "@/lib/profiles-data";

const createProfileSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, "Code may only contain letters, numbers, and hyphens"),
  displayName: z.string().trim().min(1).max(80),
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  location: z.string().trim().max(120).optional().or(z.literal("")),
  zipCode: z.string().trim().max(20).optional().or(z.literal("")),
  country: z
    .string()
    .trim()
    .length(2, "Use a 2-letter country code")
    .transform((v) => v.toUpperCase()),
  timezone: z.string().trim().min(1).max(64),
  linkedinUrl: z.string().trim().optional(),
  githubUrl: z.string().trim().optional(),
  interviewerId: z.string().min(1).nullable().optional(),
  assignedMemberIds: z.array(z.string().min(1)).optional(),
}).superRefine((data, ctx) => {
  for (const key of ["linkedinUrl", "githubUrl"] as const) {
    const value = data[key]?.trim();
    if (!value) continue;
    if (!URL.canParse(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key === "linkedinUrl" ? "LinkedIn" : "GitHub"} must be a valid URL`,
      });
    }
  }
});

function splitFullName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { firstName: parts[0] || "", lastName: "" };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function emptyToNull(value: string | undefined) {
  const v = value?.trim();
  return v ? v : null;
}

async function tryRemoveLocalUpload(url: string | null | undefined) {
  if (!url || !url.startsWith("/uploads/")) return;
  try {
    await unlink(path.join(process.cwd(), "public", url.replace(/^\//, "")));
  } catch {
    /* best-effort — missing file is fine */
  }
}

export async function toggleProfileStar(profileId: string) {
  z.string().min(1).parse(profileId);
  const session = await requireSession();
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    profileId,
  );
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { starred: true },
  });
  if (!profile) throw new Error("Profile not found");
  await prisma.profile.update({
    where: { id: profileId },
    data: { starred: !profile.starred },
  });
  revalidatePath("/profiles");
}

/** Add a Free/Pro Gemini (or OpenAI) key for extension resume generation. */
export async function addProfileApiKey(input: {
  profileId: string;
  mode: "FREE" | "PRO";
  key: string;
  label?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const parsed = z
      .object({
        profileId: z.string().min(1),
        mode: z.enum(["FREE", "PRO"]),
        key: z.string().min(8),
        label: z.string().max(100).optional(),
      })
      .parse(input);

    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      parsed.profileId,
    );

    await prisma.profileApiKey.create({
      data: {
        profileId: parsed.profileId,
        mode: parsed.mode,
        key: parsed.key.trim(),
        label: parsed.label?.trim() || null,
      },
    });
    revalidatePath("/profiles");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to add API key",
    };
  }
}

export async function deleteProfileApiKey(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    z.string().min(1).parse(id);
    const row = await prisma.profileApiKey.findUnique({ where: { id } });
    if (!row) return { ok: false, error: "Key not found" };
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      row.profileId,
    );
    await prisma.profileApiKey.delete({ where: { id } });
    revalidatePath("/profiles");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete API key",
    };
  }
}

/** Admin creates a new candidate profile. */
export async function createProfile(
  input: z.infer<typeof createProfileSchema>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    await requireRole(["ADMIN"]);
    const parsed = createProfileSchema.parse(input);
    const { firstName, lastName } = splitFullName(parsed.fullName);

    if (parsed.interviewerId) {
      const interviewer = await prisma.user.findFirst({
        where: { id: parsed.interviewerId, role: "INTERVIEWER" },
        select: { id: true },
      });
      if (!interviewer) {
        return { ok: false, error: "Selected user is not an interviewer" };
      }
    }

    const memberIds = parsed.assignedMemberIds ?? [];
    if (memberIds.length) {
      const members = await prisma.user.findMany({
        where: {
          id: { in: memberIds },
          role: { in: ["ADMIN", "MEMBER"] },
        },
        select: { id: true },
      });
      if (members.length !== memberIds.length) {
        return { ok: false, error: "One or more assigned members are invalid" };
      }
    }

    const profile = await prisma.profile.create({
      data: {
        code: parsed.code.toUpperCase(),
        displayName: parsed.displayName,
        fullName: parsed.fullName,
        firstName: firstName || null,
        lastName: lastName || null,
        email: parsed.email.toLowerCase(),
        phone: emptyToNull(parsed.phone),
        location: emptyToNull(parsed.location),
        zipCode: emptyToNull(parsed.zipCode),
        country: parsed.country,
        timezone: parsed.timezone,
        linkedinUrl: emptyToNull(parsed.linkedinUrl),
        githubUrl: emptyToNull(parsed.githubUrl),
        interviewerId: parsed.interviewerId || null,
        assignedMembers: memberIds.length
          ? { connect: memberIds.map((id) => ({ id })) }
          : undefined,
      },
      select: { id: true },
    });

    revalidatePath("/profiles");
    revalidatePath("/availability");
    revalidatePath("/team");
    revalidatePath("/interviews");
    return { ok: true, id: profile.id };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_")
    ) {
      throw err;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A profile with that code already exists" };
    }
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues[0]?.message || "Invalid profile data" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create profile",
    };
  }
}

/** Admin permanently deletes a profile and cascaded related rows. */
export async function deleteProfile(
  profileId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireRole(["ADMIN"]);
    z.string().min(1).parse(profileId);

    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        resumeFileUrl: true,
        displayName: true,
        processes: { select: { resumeFileUrl: true } },
        applications: {
          select: { resumePdfUrl: true, coverPdfUrl: true },
        },
      },
    });
    if (!profile) return { ok: false, error: "Profile not found" };

    await prisma.profile.delete({ where: { id: profileId } });

    await tryRemoveLocalUpload(profile.resumeFileUrl);
    for (const process of profile.processes) {
      await tryRemoveLocalUpload(process.resumeFileUrl);
    }
    for (const app of profile.applications) {
      await tryRemoveLocalUpload(app.resumePdfUrl);
      await tryRemoveLocalUpload(app.coverPdfUrl);
    }

    revalidatePath("/profiles");
    revalidatePath("/interviews");
    revalidatePath("/availability");
    revalidatePath("/meetings");
    revalidatePath("/team");
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_")
    ) {
      throw err;
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete profile",
    };
  }
}

const experienceSchema = z.object({
  company: z.string().trim().min(1).max(120),
  location: z.string().trim().max(120).optional().or(z.literal("")),
  /** YYYY-MM */
  startMonth: z.string().regex(/^\d{4}-\d{2}$/, "Start month must be YYYY-MM"),
  /** YYYY-MM or empty for Present */
  endMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "End month must be YYYY-MM")
    .optional()
    .or(z.literal("")),
});

const certificationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  /** YYYY-MM */
  date: z.string().regex(/^\d{4}-\d{2}$/, "Date must be YYYY-MM"),
});

function monthToUtcDate(ym: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!match) throw new Error("Invalid month");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("Invalid month");
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Add a work experience row on a profile. */
export async function addProfileExperience(input: {
  profileId: string;
  company: string;
  location?: string;
  startMonth: string;
  endMonth?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const parsed = experienceSchema
      .extend({ profileId: z.string().min(1) })
      .parse(input);
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      parsed.profileId,
    );

    const startDate = monthToUtcDate(parsed.startMonth);
    const endDate = parsed.endMonth
      ? monthToUtcDate(parsed.endMonth)
      : null;
    if (endDate && endDate < startDate) {
      return { ok: false, error: "End month must be on or after start month" };
    }

    const row = await prisma.experience.create({
      data: {
        profileId: parsed.profileId,
        company: parsed.company,
        role: "",
        location: emptyToNull(parsed.location),
        startDate,
        endDate,
      },
      select: { id: true },
    });
    revalidatePath("/profiles");
    return { ok: true, id: row.id };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues[0]?.message || "Invalid experience" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to add experience",
    };
  }
}

/** Update an existing experience row. */
export async function updateProfileExperience(input: {
  id: string;
  company: string;
  location?: string;
  startMonth: string;
  endMonth?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const parsed = experienceSchema
      .extend({ id: z.string().min(1) })
      .parse(input);
    const existing = await prisma.experience.findUnique({
      where: { id: parsed.id },
      select: { profileId: true },
    });
    if (!existing) return { ok: false, error: "Experience not found" };
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      existing.profileId,
    );

    const startDate = monthToUtcDate(parsed.startMonth);
    const endDate = parsed.endMonth
      ? monthToUtcDate(parsed.endMonth)
      : null;
    if (endDate && endDate < startDate) {
      return { ok: false, error: "End month must be on or after start month" };
    }

    await prisma.experience.update({
      where: { id: parsed.id },
      data: {
        company: parsed.company,
        role: "",
        location: emptyToNull(parsed.location),
        startDate,
        endDate,
      },
    });
    revalidatePath("/profiles");
    return { ok: true };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues[0]?.message || "Invalid experience" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update experience",
    };
  }
}

/** Delete an experience row. */
export async function deleteProfileExperience(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    z.string().min(1).parse(id);
    const existing = await prisma.experience.findUnique({
      where: { id },
      select: { profileId: true },
    });
    if (!existing) return { ok: false, error: "Experience not found" };
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      existing.profileId,
    );
    await prisma.experience.delete({ where: { id } });
    revalidatePath("/profiles");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete experience",
    };
  }
}

/** Add a certification to a profile (JSON list). */
export async function addProfileCertification(input: {
  profileId: string;
  name: string;
  date: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const parsed = certificationSchema
      .extend({ profileId: z.string().min(1) })
      .parse(input);
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      parsed.profileId,
    );

    const profile = await prisma.profile.findUnique({
      where: { id: parsed.profileId },
      select: { certifications: true },
    });
    if (!profile) return { ok: false, error: "Profile not found" };

    const id = crypto.randomUUID();
    const next = [
      ...normalizeProfileCertifications(profile.certifications),
      { id, name: parsed.name, date: parsed.date },
    ];
    await prisma.profile.update({
      where: { id: parsed.profileId },
      data: { certifications: next },
    });
    revalidatePath("/profiles");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        ok: false,
        error: err.issues[0]?.message || "Invalid certification",
      };
    }
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to add certification",
    };
  }
}

/** Remove a certification by id from a profile. */
export async function deleteProfileCertification(input: {
  profileId: string;
  certificationId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireSession();
    const parsed = z
      .object({
        profileId: z.string().min(1),
        certificationId: z.string().min(1),
      })
      .parse(input);
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      parsed.profileId,
    );

    const profile = await prisma.profile.findUnique({
      where: { id: parsed.profileId },
      select: { certifications: true },
    });
    if (!profile) return { ok: false, error: "Profile not found" };

    const current = normalizeProfileCertifications(profile.certifications);
    const next = current.filter((c) => c.id !== parsed.certificationId);
    if (next.length === current.length) {
      return { ok: false, error: "Certification not found" };
    }

    await prisma.profile.update({
      where: { id: parsed.profileId },
      data: { certifications: next },
    });
    revalidatePath("/profiles");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to delete certification",
    };
  }
}

/** Admin assigns the single interviewer for a profile. */
export async function setProfileInterviewer(input: {
  profileId: string;
  interviewerId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireRole(["ADMIN"]);
    const parsed = z
      .object({
        profileId: z.string().min(1),
        interviewerId: z.string().min(1).nullable(),
      })
      .parse(input);

    if (parsed.interviewerId) {
      const interviewer = await prisma.user.findFirst({
        where: { id: parsed.interviewerId, role: "INTERVIEWER" },
        select: { id: true },
      });
      if (!interviewer) {
        return { ok: false, error: "Selected user is not an interviewer" };
      }
    }

    await prisma.profile.update({
      where: { id: parsed.profileId },
      data: { interviewerId: parsed.interviewerId },
    });

    revalidatePath("/profiles");
    revalidatePath("/interviews");
    revalidatePath("/availability");
    return { ok: true };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_")
    ) {
      throw err;
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to set interviewer",
    };
  }
}
