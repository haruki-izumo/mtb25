import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  return session;
}

export async function requireRole(roles: Role[]) {
  const session = await requireSession();
  if (!roles.includes(session.user.role)) {
    redirect("/");
  }
  return session;
}

/** Members may only mutate profiles they are assigned to; admins can mutate all. */
export async function assertCanAccessProfile(
  userId: string,
  role: Role,
  profileId: string,
): Promise<void> {
  if (role === "ADMIN") return;

  const assignment = await prisma.profile.findFirst({
    where: {
      id: profileId,
      assignedMembers: { some: { id: userId } },
    },
    select: { id: true },
  });

  if (!assignment) {
    throw new Error("Forbidden: profile is not assigned to this member");
  }
}

/**
 * Availability edits: admins, assigned members, and the interviewer
 * designated on the profile (`Profile.interviewerId`).
 */
export async function assertCanEditAvailability(
  userId: string,
  role: Role,
  profileId: string,
): Promise<void> {
  if (role === "ADMIN") return;

  if (role === "INTERVIEWER") {
    const handled = await prisma.profile.findFirst({
      where: { id: profileId, interviewerId: userId },
      select: { id: true },
    });
    if (!handled) {
      throw new Error("Forbidden: profile is not assigned to this interviewer");
    }
    return;
  }

  await assertCanAccessProfile(userId, role, profileId);
}
