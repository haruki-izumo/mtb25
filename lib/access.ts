import type { Role } from "@prisma/client";
import { Prisma } from "@prisma/client";

/** Prisma filter: members only see assigned profiles; admins see all. */
export function profileAccessWhere(
  userId: string,
  role: Role,
): Prisma.ProfileWhereInput | undefined {
  if (role === "ADMIN") return undefined;
  return { assignedMembers: { some: { id: userId } } };
}

export function processAccessWhere(
  userId: string,
  role: Role,
): Prisma.InterviewProcessWhereInput {
  const profile = profileAccessWhere(userId, role);
  return profile ? { profile } : {};
}
