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
