"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

async function requireInterviewerSelf() {
  const session = await requireSession();
  if (session.user.role !== "INTERVIEWER" && session.user.role !== "ADMIN") {
    throw new Error("Only interviewers can edit personal availability");
  }
  return session;
}

/** Interviewers always edit themselves; admins may pass userId. */
function targetUserId(
  session: { user: { id: string; role: string } },
  userId?: string,
) {
  if (session.user.role === "ADMIN" && userId) return userId;
  return session.user.id;
}

const ruleSchema = z.object({
  userId: z.string().min(1).optional(),
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(24 * 60 - 1),
  endMinute: z.number().int().min(1).max(24 * 60),
});

export async function createInterviewerAvailabilityRule(
  input: z.infer<typeof ruleSchema>,
) {
  const session = await requireInterviewerSelf();
  const parsed = ruleSchema.parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }
  const userId = targetUserId(session, parsed.userId);
  if (session.user.role === "INTERVIEWER" && userId !== session.user.id) {
    throw new Error("Forbidden");
  }

  await prisma.userAvailabilityRule.create({
    data: {
      userId,
      weekday: parsed.weekday,
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
    },
  });
  revalidatePath("/availability");
}

export async function updateInterviewerAvailabilityRule(input: {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}) {
  const session = await requireInterviewerSelf();
  const parsed = z
    .object({
      id: z.string().min(1),
      weekday: z.number().int().min(0).max(6),
      startMinute: z.number().int().min(0).max(24 * 60 - 1),
      endMinute: z.number().int().min(1).max(24 * 60),
    })
    .parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }

  const rule = await prisma.userAvailabilityRule.findUnique({
    where: { id: parsed.id },
  });
  if (!rule) throw new Error("Rule not found");
  if (session.user.role === "INTERVIEWER" && rule.userId !== session.user.id) {
    throw new Error("Forbidden");
  }

  await prisma.userAvailabilityRule.update({
    where: { id: parsed.id },
    data: {
      weekday: parsed.weekday,
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
    },
  });
  revalidatePath("/availability");
}

export async function deleteInterviewerAvailabilityRule(id: string) {
  z.string().min(1).parse(id);
  const session = await requireInterviewerSelf();
  const rule = await prisma.userAvailabilityRule.findUnique({ where: { id } });
  if (!rule) throw new Error("Rule not found");
  if (session.user.role === "INTERVIEWER" && rule.userId !== session.user.id) {
    throw new Error("Forbidden");
  }
  await prisma.userAvailabilityRule.delete({ where: { id } });
  revalidatePath("/availability");
}

const interviewerRangeSchema = z.object({
  userId: z.string().min(1).optional(),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMinute: z.number().int().min(0),
  endMinute: z.number().int().min(1),
});

function minutesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number | null,
  bEnd: number | null,
) {
  const start = bStart ?? 0;
  const end = bEnd ?? 24 * 60;
  return aStart < end && aEnd > start;
}

export async function addInterviewerOpenOverride(
  input: z.infer<typeof interviewerRangeSchema>,
) {
  const session = await requireInterviewerSelf();
  const parsed = interviewerRangeSchema.parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }

  const userId = targetUserId(session, parsed.userId);
  if (session.user.role === "INTERVIEWER" && userId !== session.user.id) {
    throw new Error("Forbidden");
  }

  const date = new Date(`${parsed.dateKey}T00:00:00.000Z`);
  const blockers = await prisma.userAvailabilityOverride.findMany({
    where: { userId, date, type: "BLOCK" },
  });
  const overlapping = blockers.filter((o) =>
    minutesOverlap(
      parsed.startMinute,
      parsed.endMinute,
      o.startMinute,
      o.endMinute,
    ),
  );

  await prisma.$transaction([
    ...overlapping.map((o) =>
      prisma.userAvailabilityOverride.delete({ where: { id: o.id } }),
    ),
    prisma.userAvailabilityOverride.create({
      data: {
        userId,
        date,
        startMinute: parsed.startMinute,
        endMinute: parsed.endMinute,
        type: "OPEN",
      },
    }),
  ]);
  revalidatePath("/availability");
}

/** Block a time range (drag on green cells to deselect). */
export async function addInterviewerBlockOverride(
  input: z.infer<typeof interviewerRangeSchema>,
) {
  const session = await requireInterviewerSelf();
  const parsed = interviewerRangeSchema.parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }

  const userId = targetUserId(session, parsed.userId);
  if (session.user.role === "INTERVIEWER" && userId !== session.user.id) {
    throw new Error("Forbidden");
  }

  await prisma.userAvailabilityOverride.create({
    data: {
      userId,
      date: new Date(`${parsed.dateKey}T00:00:00.000Z`),
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
      type: "BLOCK",
    },
  });
  revalidatePath("/availability");
}

export async function updateInterviewerTimezone(timezone: string) {
  const session = await requireInterviewerSelf();
  z.string().min(1).parse(timezone);
  await prisma.user.update({
    where: { id: session.user.id },
    data: { timezone },
  });
  revalidatePath("/availability");
  revalidatePath("/settings");
}
