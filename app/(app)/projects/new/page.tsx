import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ProjectForm } from "@/components/projects/project-form";
import { requireSession } from "@/lib/auth-helpers";
import { getProjectFormOptions } from "@/lib/projects-data";
import { canManageProfiles } from "@/lib/roles";

export default async function NewProjectPage() {
  const session = await requireSession();
  if (!canManageProfiles(session.user.role)) redirect("/");

  const options = await getProjectFormOptions(session.user.role);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <ProjectForm
          mode="create"
          currentUserId={session.user.id}
          options={{
            clients: options.clients.map((c) => ({
              id: c.id,
              name: c.name,
              country: c.country,
            })),
            types: options.types.map((t) => ({ id: t.id, name: t.name })),
            users: options.users,
          }}
        />
      </div>
    </AppShell>
  );
}
