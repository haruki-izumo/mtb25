"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession, assertCanAccessProfile } from "@/lib/auth-helpers";

const ruleSchema = z.object({
  profileId: z.string().min(1),
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(24 * 60 - 1),
  endMinute: z.number().int().min(1).max(24 * 60),
});

export async function createAvailabilityRule(
  input: z.infer<typeof ruleSchema>,
) {
  const parsed = ruleSchema.parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }
  const session = await requireSession();
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    parsed.profileId,
  );
  await prisma.availabilityRule.create({ data: parsed });
  revalidatePath("/availability");
}

export async function updateAvailabilityRule(input: {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}) {
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

  const session = await requireSession();
  const rule = await prisma.availabilityRule.findUnique({
    where: { id: parsed.id },
  });
  if (!rule) throw new Error("Rule not found");
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    rule.profileId,
  );

  await prisma.availabilityRule.update({
    where: { id: parsed.id },
    data: {
      weekday: parsed.weekday,
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
    },
  });
  revalidatePath("/availability");
}

export async function deleteAvailabilityRule(id: string) {
  z.string().min(1).parse(id);
  const session = await requireSession();
  const rule = await prisma.availabilityRule.findUnique({ where: { id } });
  if (!rule) throw new Error("Rule not found");
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    rule.profileId,
  );
  await prisma.availabilityRule.delete({ where: { id } });
  revalidatePath("/availability");
}

const rangeSchema = z.object({
  profileId: z.string().min(1),
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

/** Add an OPEN block for a single day (click-drag on empty cells). */
export async function addOpenOverride(input: z.infer<typeof rangeSchema>) {
  const parsed = rangeSchema.parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }

  const session = await requireSession();
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    parsed.profileId,
  );

  const date = new Date(`${parsed.dateKey}T00:00:00.000Z`);
  const blockers = await prisma.availabilityOverride.findMany({
    where: { profileId: parsed.profileId, date, type: "BLOCK" },
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
      prisma.availabilityOverride.delete({ where: { id: o.id } }),
    ),
    prisma.availabilityOverride.create({
      data: {
        profileId: parsed.profileId,
        date,
        startMinute: parsed.startMinute,
        endMinute: parsed.endMinute,
        type: "OPEN",
      },
    }),
  ]);
  revalidatePath("/availability");
}

/** Block a time range for a day (drag on green cells to deselect). */
export async function addBlockOverride(input: z.infer<typeof rangeSchema>) {
  const parsed = rangeSchema.parse(input);
  if (parsed.endMinute <= parsed.startMinute) {
    throw new Error("End time must be after start time");
  }

  const session = await requireSession();
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    parsed.profileId,
  );

  await prisma.availabilityOverride.create({
    data: {
      profileId: parsed.profileId,
      date: new Date(`${parsed.dateKey}T00:00:00.000Z`),
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
      type: "BLOCK",
    },
  });
  revalidatePath("/availability");
}

export async function deleteAvailabilityOverride(id: string) {
  z.string().min(1).parse(id);
  const session = await requireSession();
  const row = await prisma.availabilityOverride.findUnique({ where: { id } });
  if (!row) throw new Error("Override not found");
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    row.profileId,
  );
  await prisma.availabilityOverride.delete({ where: { id } });
  revalidatePath("/availability");
}
