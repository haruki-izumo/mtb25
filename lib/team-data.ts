import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const profileSelect = {
  id: true,
  code: true,
  country: true,
  displayName: true,
} as const;

export async function getTeamPageData(userId: string, role: Role) {
  const interviewerScope = role === "INTERVIEWER";
  const handledProfile = interviewerScope
    ? { interviewerId: userId }
    : undefined;

  const team = await prisma.team.findFirst({
    include: {
      members: {
        where: interviewerScope
          ? {
              OR: [
                { id: userId },
                { assignedProfiles: { some: handledProfile } },
                { ownedProcesses: { some: { profile: handledProfile } } },
              ],
            }
          : undefined,
        orderBy: [{ role: "asc" }, { name: "asc" }],
        include: {
          assignedProfiles: {
            where: handledProfile,
            select: profileSelect,
          },
          interviewingProfiles: {
            where: handledProfile,
            select: profileSelect,
          },
        },
      },
    },
  });

  const allProfiles = await prisma.profile.findMany({
    where: handledProfile,
    select: profileSelect,
    orderBy: { code: "asc" },
  });

  return {
    teamName: team?.name ?? "Team",
    members: (team?.members ?? []).map((m) => {
      const profilesById = new Map<
        string,
        { id: string; code: string; country: string; displayName: string }
      >();
      for (const p of m.assignedProfiles) profilesById.set(p.id, p);
      if (interviewerScope && m.id === userId) {
        for (const p of m.interviewingProfiles) profilesById.set(p.id, p);
      }
      const profiles = [...profilesById.values()];
      const byCountry: Record<string, number> = {};
      for (const p of profiles) {
        byCountry[p.country] = (byCountry[p.country] ?? 0) + 1;
      }
      return {
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        avatarColor: m.avatarColor,
        timezone: m.timezone,
        profiles,
        byCountry,
      };
    }),
    allProfiles,
  };
}
