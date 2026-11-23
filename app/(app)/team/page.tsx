import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { TeamView } from "@/components/team/team-view";
import { requireSession } from "@/lib/auth-helpers";
import { getTeamPageData } from "@/lib/team-data";

export default async function TeamPage() {
  const session = await requireSession();
  if (session.user.role === "INTERVIEWER") redirect("/");

  const data = await getTeamPageData(session.user.id, session.user.role);

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
