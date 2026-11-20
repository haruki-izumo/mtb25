"use server";

import { revalidatePath } from "next/cache";
import { addMinutes } from "date-fns";
import { z } from "zod";
import type { ProcessStatus, RoundOutcome, RoundType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession, assertCanAccessProfile } from "@/lib/auth-helpers";
import {
  BOOKING_DURATIONS,
  calendarDateKey,
  getBookableSlots,
  getOpenIntervalsForDay,
  rangesOverlap,
  zonedDateKey,
  type BookingDuration,
} from "@/lib/availability";

const statusSchema = z.object({
  processId: z.string().min(1),
  status: z.enum([
    "OFFER",
    "FIRST_STEP",
    "NEXT_ROUND",
    "NEXT_STEP",
    "ASSESSMENT",
    "DONE",
    "RESCHEDULE",
    "SKIPPED",
    "FAILED",
    "CANCELED",
    "NOT_HANDLED",
    "NOT_RESCHEDULED",
  ]),
});

const noteSchema = z.object({
  processId: z.string().min(1),
  note: z.string().max(2000),
});

const roundSchema = z.object({
  roundId: z.string().min(1),
  outcome: z.enum([
    "PENDING",
    "PASSED",
    "FAILED",
    "RESCHEDULED",
    "CANCELED",
    "NO_SHOW",
  ]),
  rating: z.number().int().min(1).max(5).nullable(),
  feedback: z.string().max(4000).nullable(),
});

const addRoundSchema = z.object({
  processId: z.string().min(1),
  startAt: z.string().datetime(),
  durationMinutes: z.number().refine((n): n is BookingDuration =>
    (BOOKING_DURATIONS as readonly number[]).includes(n),
  ),
  type: z.enum([
    "HR_RECRUITER",
    "TECH",
    "ASSESSMENT",
    "SYSTEM_DESIGN",
    "BEHAVIORAL",
    "FINAL",
    "OTHER",
  ]),
  interviewerName: z.string().min(1).max(200),
  clientInterviewerName: z
    .string()
    .min(1, "Client interviewer name is required")
    .max(200),
  clientInterviewerAbout: z
    .string()
    .min(10, "Add a short about for the client interviewer")
    .max(10000),
  meetingLink: z.string().url().optional().or(z.literal("")),
  overrideAvailability: z.boolean().optional(),
});

async function loadProcessForUser(processId: string) {
  const session = await requireSession();
  const process = await prisma.interviewProcess.findUnique({
    where: { id: processId },
    select: { id: true, profileId: true },
  });
  if (!process) throw new Error("Process not found");
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    process.profileId,
  );
  return { session, process };
}

export async function updateProcessStatus(input: {
  processId: string;
  status: ProcessStatus;
}) {
  const parsed = statusSchema.parse(input);
  await loadProcessForUser(parsed.processId);
  await prisma.interviewProcess.update({
    where: { id: parsed.processId },
    data: { status: parsed.status },
  });
  revalidatePath("/interviews");
  revalidatePath("/");
}

export async function updateProcessNote(input: {
  processId: string;
  note: string;
}) {
  const parsed = noteSchema.parse(input);
  await loadProcessForUser(parsed.processId);
  await prisma.interviewProcess.update({
    where: { id: parsed.processId },
    data: { note: parsed.note || null },
  });
  revalidatePath("/interviews");
}

export async function deleteProcess(processId: string) {
  z.string().min(1).parse(processId);
  await loadProcessForUser(processId);
  await prisma.interviewProcess.delete({ where: { id: processId } });
  revalidatePath("/interviews");
  revalidatePath("/");
}

export async function updateRound(input: {
  roundId: string;
  outcome: RoundOutcome;
  rating: number | null;
  feedback: string | null;
}) {
  const parsed = roundSchema.parse(input);
  const session = await requireSession();
  const round = await prisma.round.findUnique({
    where: { id: parsed.roundId },
    include: { process: { select: { profileId: true } } },
  });
  if (!round) throw new Error("Round not found");
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    round.process.profileId,
  );
  await prisma.round.update({
    where: { id: parsed.roundId },
    data: {
      outcome: parsed.outcome,
      rating: parsed.rating,
      feedback: parsed.feedback,
    },
  });
  revalidatePath("/interviews");
  revalidatePath("/meetings");
  revalidatePath("/");
}

export type AddRoundResult =
  | { ok: true; roundId: string }
  | { ok: false; error: string };

export async function addRoundToProcess(
  input: z.infer<typeof addRoundSchema>,
): Promise<AddRoundResult> {
  const parsed = addRoundSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const session = await requireSession();
  const data = parsed.data;

  if (data.overrideAvailability && session.user.role !== "ADMIN") {
    return { ok: false, error: "Only admins can override availability" };
  }

  const startAt = new Date(data.startAt);
  const endAt = addMinutes(startAt, data.durationMinutes);

  try {
    const { process } = await loadProcessForUser(data.processId);

    const roundId = await prisma.$transaction(async (tx) => {
      const profile = await tx.profile.findUnique({
        where: { id: process.profileId },
        include: {
          availabilityRules: true,
          availabilityOverrides: true,
        },
      });
      if (!profile) throw new Error("Profile not found");

      const overlapping = await tx.round.findMany({
        where: {
          outcome: { not: "CANCELED" },
          process: { profileId: process.profileId },
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
        select: { startAt: true, endAt: true },
      });
      if (
        overlapping.some((r) =>
          rangesOverlap(r.startAt, r.endAt, startAt, endAt),
        )
      ) {
        throw new Error("Time slot conflicts with an existing round");
      }

      if (!data.overrideAvailability) {
        const localDateKey = zonedDateKey(startAt, profile.timezone);
        const busy = await tx.round.findMany({
          where: {
            outcome: { not: "CANCELED" },
            process: { profileId: process.profileId },
          },
          select: { startAt: true, endAt: true },
        });
        const open = getOpenIntervalsForDay({
          dateKey: localDateKey,
          timeZone: profile.timezone,
          rules: profile.availabilityRules.map((r) => ({
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          })),
          overrides: profile.availabilityOverrides.map((o) => ({
            date: calendarDateKey(o.date),
            startMinute: o.startMinute,
            endMinute: o.endMinute,
            type: o.type,
          })),
          busy,
        });
        const slots = getBookableSlots(open, data.durationMinutes);
        if (!slots.some((s) => s.getTime() === startAt.getTime())) {
          throw new Error(
            "Selected time is outside availability. Admins can enable override.",
          );
        }
      }

      const existingRounds = await tx.round.findMany({
        where: { processId: data.processId },
        select: { roundNumber: true },
      });
      const nextNumber =
        existingRounds.reduce((max, r) => Math.max(max, r.roundNumber), 0) + 1;

      const round = await tx.round.create({
        data: {
          processId: data.processId,
          roundNumber: nextNumber,
          type: data.type as RoundType,
          startAt,
          endAt,
          interviewerName: data.interviewerName,
          clientInterviewerName: data.clientInterviewerName.trim(),
          clientInterviewerAbout: data.clientInterviewerAbout.trim(),
          meetingLink: data.meetingLink || null,
          bookedById: session.user.id,
          outcome: "PENDING",
        },
      });
      return round.id;
    });

    revalidatePath("/interviews");
    revalidatePath("/meetings");
    revalidatePath("/availability");
    revalidatePath("/");
    return { ok: true, roundId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to add round",
    };
  }
}
