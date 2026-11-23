"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession, assertCanAccessProfile } from "@/lib/auth-helpers";
import { APPLICATION_STATUSES } from "@/lib/applications";

const statusSchema = z.object({
  applicationId: z.string().min(1),
  status: z.enum(APPLICATION_STATUSES),
});

const submittedSchema = z.object({
  applicationId: z.string().min(1),
  submitted: z.boolean(),
});

async function loadApplicationForUser(applicationId: string) {
  const session = await requireSession();
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, profileId: true, status: true, appliedAt: true },
  });
  if (!application) throw new Error("Application not found");
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    application.profileId,
  );
  return application;
}

export async function updateApplicationStatus(input: {
  applicationId: string;
  status: (typeof APPLICATION_STATUSES)[number];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const parsed = statusSchema.parse(input);
    await loadApplicationForUser(parsed.applicationId);
    await prisma.application.update({
      where: { id: parsed.applicationId },
      data: { status: parsed.status },
    });
    revalidatePath("/applications");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update status",
    };
  }
}

export async function setApplicationSubmitted(input: {
  applicationId: string;
  submitted: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const parsed = submittedSchema.parse(input);
    const existing = await loadApplicationForUser(parsed.applicationId);
    await prisma.application.update({
      where: { id: parsed.applicationId },
      data: {
        submitted: parsed.submitted,
        ...(parsed.submitted
          ? {
              applied: true,
              appliedAt: existing.appliedAt ?? new Date(),
              ...(existing.status === "SAVED" ? { status: "APPLIED" as const } : {}),
            }
          : {}),
      },
    });
    revalidatePath("/applications");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to update submission",
    };
  }
}
