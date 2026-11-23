import type { Role } from "@prisma/client";
import { Prisma } from "@prisma/client";

/**
 * Prisma filter for profile rows.
 * Admins see every profile. Members see profiles assigned to them.
 * Interviewers see only profiles they are designated to handle.
 */
export function profileAccessWhere(
  userId: string,
  role: Role,
): Prisma.ProfileWhereInput | undefined {
  if (role === "ADMIN") return undefined;
  if (role === "INTERVIEWER") return { interviewerId: userId };
  return { assignedMembers: { some: { id: userId } } };
}

export function processAccessWhere(
  userId: string,
  role: Role,
): Prisma.InterviewProcessWhereInput {
  const profile = profileAccessWhere(userId, role);
  return profile ? { profile } : {};
}

/**
 * Users an interviewer may see in member filters: people who own or are
 * assigned to a profile that interviewer handles. Other roles are unscoped.
 */
export function memberDirectoryWhere(
  userId: string,
  role: Role,
): Prisma.UserWhereInput | undefined {
  if (role !== "INTERVIEWER") return undefined;
  return {
    OR: [
      { assignedProfiles: { some: { interviewerId: userId } } },
      {
        ownedProcesses: {
          some: { profile: { interviewerId: userId } },
        },
      },
    ],
  };
}
