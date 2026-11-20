"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  requireRole,
  assertCanAccessProfile,
} from "@/lib/auth-helpers";

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
