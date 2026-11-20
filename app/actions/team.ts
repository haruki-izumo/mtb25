"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth-helpers";
import { AVATAR_COLORS } from "@/lib/team";

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  role: z.enum(["ADMIN", "MEMBER", "INTERVIEWER"]),
  password: z.string().min(8).max(100),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().min(1).optional(),
});

const updateSchema = z.object({
  memberId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  role: z.enum(["ADMIN", "MEMBER", "INTERVIEWER"]),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  timezone: z.string().min(1).optional(),
  newPassword: z.string().max(100).optional(),
});

function friendlyPrismaError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      throw new Error("A member with that email already exists");
    }
  }
  throw err instanceof Error ? err : new Error("Request failed");
}

export async function inviteMember(input: z.infer<typeof inviteSchema>) {
  await requireRole(["ADMIN"]);
  const parsed = inviteSchema.parse(input);
  const team = await prisma.team.findFirst();
  const passwordHash = await bcrypt.hash(parsed.password, 10);
  const avatarColor =
    parsed.avatarColor ??
    AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  try {
    await prisma.user.create({
      data: {
        name: parsed.name,
        email: parsed.email.toLowerCase(),
        role: parsed.role,
        passwordHash,
        teamId: team?.id,
        avatarColor,
        timezone: parsed.timezone ?? "America/New_York",
      },
    });
  } catch (err) {
    friendlyPrismaError(err);
  }

  revalidatePath("/team");
}

export async function updateMember(input: z.infer<typeof updateSchema>) {
  const session = await requireRole(["ADMIN"]);
  const parsed = updateSchema.parse(input);

  const target = await prisma.user.findUnique({
    where: { id: parsed.memberId },
  });
  if (!target) throw new Error("Member not found");

  // Prevent demoting yourself if you're the last admin
  if (
    target.id === session.user.id &&
    target.role === "ADMIN" &&
    parsed.role !== "ADMIN"
  ) {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      throw new Error("You are the last admin and cannot demote yourself");
    }
  }

  // Prevent demoting the last admin (even if editing someone else)
  if (target.role === "ADMIN" && parsed.role !== "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      throw new Error("Cannot demote the last admin");
    }
  }

  const data: Prisma.UserUpdateInput = {
    name: parsed.name,
    email: parsed.email.toLowerCase(),
    role: parsed.role,
    avatarColor: parsed.avatarColor,
    ...(parsed.timezone ? { timezone: parsed.timezone } : {}),
  };

  if (parsed.newPassword) {
    if (parsed.newPassword.length < 8) {
      throw new Error("New password must be at least 8 characters");
    }
    data.passwordHash = await bcrypt.hash(parsed.newPassword, 10);
  }

  try {
    await prisma.user.update({
      where: { id: parsed.memberId },
      data,
    });
  } catch (err) {
    friendlyPrismaError(err);
  }

  revalidatePath("/team");
  revalidatePath("/settings");
}

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; error: string };

export async function removeMember(
  memberId: string,
): Promise<RemoveMemberResult> {
  try {
    const session = await requireRole(["ADMIN"]);
    z.string().min(1).parse(memberId);

    if (memberId === session.user.id) {
      return { ok: false, error: "You cannot remove yourself" };
    }

    const target = await prisma.user.findUnique({
      where: { id: memberId },
    });
    if (!target) return { ok: false, error: "Member not found" };

    if (target.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return { ok: false, error: "Cannot remove the last admin" };
      }
    }

    // Reassign ownership / bookings, clear relations, then delete
    await prisma.$transaction(async (tx) => {
      await tx.interviewProcess.updateMany({
        where: { ownerMemberId: memberId },
        data: { ownerMemberId: session.user.id },
      });
      await tx.round.updateMany({
        where: { bookedById: memberId },
        data: { bookedById: session.user.id },
      });
      await tx.userAvailabilityRule.deleteMany({ where: { userId: memberId } });
      await tx.userAvailabilityOverride.deleteMany({
        where: { userId: memberId },
      });
      await tx.user.update({
        where: { id: memberId },
        data: { assignedProfiles: { set: [] }, teamId: null },
      });
      await tx.user.delete({ where: { id: memberId } });
    });

    revalidatePath("/team");
    revalidatePath("/interviews");
    revalidatePath("/meetings");
    revalidatePath("/profiles");
    revalidatePath("/availability");
    return { ok: true };
  } catch (err) {
    // Don't swallow Next.js control-flow errors (e.g. redirect from requireRole)
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_")
    ) {
      throw err;
    }
    console.error("removeMember failed", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to remove member",
    };
  }
}

export async function setMemberProfileAssignments(input: {
  memberId: string;
  profileIds: string[];
}) {
  await requireRole(["ADMIN"]);
  const memberId = z.string().min(1).parse(input.memberId);
  const profileIds = z.array(z.string()).parse(input.profileIds);
  await prisma.user.update({
    where: { id: memberId },
    data: {
      assignedProfiles: {
        set: profileIds.map((id) => ({ id })),
      },
    },
  });
  revalidatePath("/team");
  revalidatePath("/profiles");
}
