import { AppShell } from "@/components/layout/app-shell";
import { TeamView } from "@/components/team/team-view";
import { requireSession } from "@/lib/auth-helpers";
import { getTeamPageData } from "@/lib/team-data";

export default async function TeamPage() {
  const session = await requireSession();
  const data = await getTeamPageData();

  return (
    <AppShell
      sidebar={
        <div>
          <h2 className="text-sm font-semibold text-slate-900">My Team</h2>
          <p className="mt-1 text-xs text-slate-500">
            Members and profile assignments
          </p>
        </div>
      }
    >
      <TeamView
        teamName={data.teamName}
        members={data.members}
        allProfiles={data.allProfiles}
        isAdmin={session.user.role === "ADMIN"}
        currentUserId={session.user.id}
      />
    </AppShell>
  );
}
