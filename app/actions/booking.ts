"use server";

import { revalidatePath } from "next/cache";
import { addMinutes } from "date-fns";
import { z } from "zod";
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

const bookSchema = z.object({
  profileId: z.string().min(1),
  processId: z.string().min(1).optional(),
  newProcess: z
    .object({
      companyName: z.string().min(1).max(200),
      jobTitle: z.string().min(1).max(200),
      jobUrl: z.string().url().optional().or(z.literal("")),
    })
    .optional(),
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
  interviewerName: z.string().max(200).optional(),
  meetingLink: z.string().url().optional().or(z.literal("")),
  overrideAvailability: z.boolean().optional(),
});

export type BookRoundInput = z.infer<typeof bookSchema>;

export type BookRoundResult =
  | { ok: true; roundId: string; processId: string }
  | { ok: false; error: string };

export async function bookRound(input: BookRoundInput): Promise<BookRoundResult> {
  const parsed = bookSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const session = await requireSession();
  const data = parsed.data;

  try {
    await assertCanAccessProfile(
      session.user.id,
      session.user.role,
      data.profileId,
    );
  } catch {
    return { ok: false, error: "Forbidden: profile is not assigned to you" };
  }

  if (data.overrideAvailability && session.user.role !== "ADMIN") {
    return { ok: false, error: "Only admins can override availability" };
  }

  if (!data.processId && !data.newProcess) {
    return { ok: false, error: "Select a process or create a new one" };
  }

  const startAt = new Date(data.startAt);
  const endAt = addMinutes(startAt, data.durationMinutes);

  try {
    if (session.user.role === "INTERVIEWER") {
      return { ok: false, error: "Interviewers cannot create bookings" };
    }

    const result = await prisma.$transaction(async (tx) => {
      const owner = await tx.user.findUnique({
        where: { id: session.user.id },
        select: { id: true, role: true },
      });
      if (!owner || owner.role === "INTERVIEWER") {
        throw new Error("Session expired — sign out and sign in again");
      }

      const profile = await tx.profile.findUnique({
        where: { id: data.profileId },
        include: {
          availabilityRules: true,
          availabilityOverrides: true,
          interviewer: { select: { id: true, name: true, role: true } },
        },
      });
      if (!profile) throw new Error("Profile not found");

      const interviewerName =
        data.interviewerName?.trim() ||
        profile.interviewer?.name ||
        "";
      if (!interviewerName) {
        throw new Error(
          "Assign an interviewer to this profile before booking",
        );
      }

      const overlapping = await tx.round.findMany({
        where: {
          outcome: { not: "CANCELED" },
          process: { profileId: data.profileId },
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
        select: { id: true, startAt: true, endAt: true },
      });

      if (
        overlapping.some((r) =>
          rangesOverlap(r.startAt, r.endAt, startAt, endAt),
        )
      ) {
        throw new Error("Time slot conflicts with an existing round");
      }

      // Block if the assigned interviewer already has a round at this time
      if (profile.interviewer) {
        const interviewerConflicts = await tx.round.findMany({
          where: {
            outcome: { not: "CANCELED" },
            interviewerName: profile.interviewer.name,
            startAt: { lt: endAt },
            endAt: { gt: startAt },
          },
          select: { id: true, startAt: true, endAt: true },
        });
        if (
          interviewerConflicts.some((r) =>
            rangesOverlap(r.startAt, r.endAt, startAt, endAt),
          )
        ) {
          throw new Error(
            "Assigned interviewer is already booked for this time",
          );
        }
      }

      if (!data.overrideAvailability) {
        const localDateKey = zonedDateKey(startAt, profile.timezone);
        const busy = await tx.round.findMany({
          where: {
            outcome: { not: "CANCELED" },
            process: { profileId: data.profileId },
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
        const allowed = slots.some((s) => s.getTime() === startAt.getTime());
        if (!allowed) {
          throw new Error(
            "Selected time is outside availability. Admins can enable override.",
          );
        }
      }

      let processId = data.processId;
      if (!processId && data.newProcess) {
        const created = await tx.interviewProcess.create({
          data: {
            profileId: data.profileId,
            companyName: data.newProcess.companyName,
            jobTitle: data.newProcess.jobTitle,
            jobUrl: data.newProcess.jobUrl || null,
            ownerMemberId: owner.id,
            status: "FIRST_STEP",
          },
        });
        processId = created.id;
      }

      if (!processId) throw new Error("Process required");

      const process = await tx.interviewProcess.findFirst({
        where: { id: processId, profileId: data.profileId },
        include: { rounds: { select: { roundNumber: true } } },
      });
      if (!process) throw new Error("Process not found for this profile");

      const nextNumber =
        process.rounds.reduce((max, r) => Math.max(max, r.roundNumber), 0) + 1;

      const round = await tx.round.create({
        data: {
          processId,
          roundNumber: nextNumber,
          type: data.type,
          startAt,
          endAt,
          interviewerName,
          meetingLink: data.meetingLink || null,
          bookedById: owner.id,
          outcome: "PENDING",
        },
      });

      return { roundId: round.id, processId };
    });

    revalidatePath("/availability");
    revalidatePath("/interviews");
    revalidatePath("/meetings");
    revalidatePath("/");

    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Booking failed",
    };
  }
}

export async function getProfileProcessesForBooking(profileId: string) {
  const session = await requireSession();
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    profileId,
  );
  return prisma.interviewProcess.findMany({
    where: {
      profileId,
      status: {
        notIn: [
          "CANCELED",
          "FAILED",
          "SKIPPED",
          "NOT_HANDLED",
          "NOT_RESCHEDULED",
        ],
      },
    },
    select: {
      id: true,
      companyName: true,
      jobTitle: true,
      status: true,
    },
    orderBy: { updatedAt: "desc" },
  });
}

/** Open bookable slots for a profile on a calendar day (profile TZ). */
export async function getOpenSlotsForProfileDay(input: {
  profileId: string;
  dateKey: string;
  durationMinutes: BookingDuration;
}) {
  const session = await requireSession();
  const parsed = z
    .object({
      profileId: z.string().min(1),
      dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      durationMinutes: z.number().refine((n): n is BookingDuration =>
        (BOOKING_DURATIONS as readonly number[]).includes(n),
      ),
    })
    .parse(input);

  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    parsed.profileId,
  );

  const profile = await prisma.profile.findUnique({
    where: { id: parsed.profileId },
    include: {
      availabilityRules: true,
      availabilityOverrides: true,
      interviewer: { select: { id: true, name: true } },
      processes: {
        select: {
          rounds: {
            where: { outcome: { not: "CANCELED" } },
            select: { startAt: true, endAt: true },
          },
        },
      },
    },
  });
  if (!profile) throw new Error("Profile not found");

  const busy = profile.processes.flatMap((p) => p.rounds);
  const open = getOpenIntervalsForDay({
    dateKey: parsed.dateKey,
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

  const slots = getBookableSlots(open, parsed.durationMinutes).map((d) =>
    d.toISOString(),
  );

  return {
    timeZone: profile.timezone,
    interviewer: profile.interviewer,
    openIntervals: open.map((iv) => ({
      startAt: iv.startAt.toISOString(),
      endAt: iv.endAt.toISOString(),
    })),
    slots,
  };
}
