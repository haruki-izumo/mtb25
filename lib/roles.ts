import type { Role } from "@prisma/client";

export const ALL_ROLES: Role[] = ["ADMIN", "MEMBER", "INTERVIEWER"];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Admin",
  MEMBER: "Member",
  INTERVIEWER: "Interviewer",
};

export function isAdmin(role: Role): boolean {
  return role === "ADMIN";
}

export function isInterviewer(role: Role): boolean {
  return role === "INTERVIEWER";
}

/** Roles that manage candidate profiles / booking */
export function canManageProfiles(role: Role): boolean {
  return role === "ADMIN" || role === "MEMBER";
}
