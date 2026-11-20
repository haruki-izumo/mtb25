import { prisma } from "@/lib/prisma";

export async function getTeamPageData() {
  const team = await prisma.team.findFirst({
    include: {
      members: {
        orderBy: [{ role: "asc" }, { name: "asc" }],
        include: {
          assignedProfiles: {
            select: { id: true, code: true, country: true, displayName: true },
          },
        },
      },
    },
  });

  const allProfiles = await prisma.profile.findMany({
    select: { id: true, code: true, displayName: true, country: true },
    orderBy: { code: "asc" },
  });

  return {
    teamName: team?.name ?? "Team",
    members: (team?.members ?? []).map((m) => {
      const byCountry: Record<string, number> = {};
      for (const p of m.assignedProfiles) {
        byCountry[p.country] = (byCountry[p.country] ?? 0) + 1;
      }
      return {
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        avatarColor: m.avatarColor,
        timezone: m.timezone,
        profiles: m.assignedProfiles,
        byCountry,
      };
    }),
    allProfiles,
  };
}
