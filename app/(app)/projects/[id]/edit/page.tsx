import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ProjectForm } from "@/components/projects/project-form";
import { requireSession } from "@/lib/auth-helpers";
import {
  getProjectDetail,
  getProjectFormOptions,
} from "@/lib/projects-data";
import { canManageProfiles } from "@/lib/roles";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!canManageProfiles(session.user.role)) redirect("/");

  const { id } = await params;
  const [project, options] = await Promise.all([
    getProjectDetail(session.user.role, id),
    getProjectFormOptions(session.user.role),
  ]);
  if (!project || project.archivedAt) notFound();

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <ProjectForm
          mode="edit"
          projectId={project.id}
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
          initial={{
            projectName: project.projectName,
            clientId: project.clientId,
            country: project.country,
            city: project.city ?? "",
            industry: project.industry ?? "",
            projectTypeId: project.projectTypeId ?? "",
            description: project.description,
            scopeOfWork: project.scopeOfWork ?? "",
            budget: String(Number(project.budget)),
            currency: project.currency,
            contractValue:
              project.contractValue != null
                ? String(Number(project.contractValue))
                : "",
            paymentTerms: project.paymentTerms ?? "",
            dateSecured: project.dateSecured.toISOString().slice(0, 10),
            startDate: project.startDate?.toISOString().slice(0, 10) ?? "",
            expectedEndDate:
              project.expectedEndDate?.toISOString().slice(0, 10) ?? "",
            actualEndDate:
              project.actualEndDate?.toISOString().slice(0, 10) ?? "",
            projectManagerId: project.projectManagerId,
            teamMemberIds: project.teamMembers.map((m) => m.id),
            priority: project.priority,
            progressPercent: String(project.progressPercent),
            tags: project.tags.join(", "),
            notes: project.notes ?? "",
          }}
        />
      </div>
    </AppShell>
  );
}
