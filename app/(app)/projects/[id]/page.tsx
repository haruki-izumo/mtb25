import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ProjectDetailView } from "@/components/projects/project-detail-view";
import { requireSession } from "@/lib/auth-helpers";
import {
  getProjectDetail,
  getProjectFormOptions,
} from "@/lib/projects-data";
import { canManageProfiles } from "@/lib/roles";

export default async function ProjectDetailPage({
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
  if (!project) notFound();

  return (
    <AppShell>
      <ProjectDetailView
        project={{
          id: project.id,
          projectCode: project.projectCode,
          projectName: project.projectName,
          country: project.country,
          city: project.city,
          industry: project.industry,
          description: project.description,
          scopeOfWork: project.scopeOfWork,
          budget: Number(project.budget),
          currency: project.currency,
          contractValue:
            project.contractValue != null ? Number(project.contractValue) : null,
          paymentTerms: project.paymentTerms,
          dateSecured: project.dateSecured.toISOString().slice(0, 10),
          startDate: project.startDate?.toISOString().slice(0, 10) ?? null,
          expectedEndDate:
            project.expectedEndDate?.toISOString().slice(0, 10) ?? null,
          actualEndDate:
            project.actualEndDate?.toISOString().slice(0, 10) ?? null,
          priority: project.priority,
          progressPercent: project.progressPercent,
          tags: project.tags,
          notes: project.notes,
          archivedAt: project.archivedAt?.toISOString() ?? null,
          client: {
            id: project.client.id,
            name: project.client.name,
            country: project.client.country,
            contactPerson: project.client.contactPerson,
            email: project.client.email,
            phone: project.client.phone,
          },
          projectType: project.projectType
            ? { id: project.projectType.id, name: project.projectType.name }
            : null,
          status: {
            id: project.status.id,
            key: project.status.key,
            name: project.status.name,
            color: project.status.color,
            isFinal: project.status.isFinal,
          },
          projectManager: project.projectManager,
          teamMembers: project.teamMembers,
          createdBy: project.createdBy,
          updatedBy: project.updatedBy,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
          attachments: project.attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            url: a.url,
            createdAt: a.createdAt.toISOString(),
            uploadedBy: a.uploadedBy,
          })),
          statusHistory: project.statusHistory.map((h) => ({
            id: h.id,
            changedAt: h.changedAt.toISOString(),
            comment: h.comment,
            fromStatus: h.fromStatus
              ? { name: h.fromStatus.name, color: h.fromStatus.color }
              : null,
            toStatus: {
              name: h.toStatus.name,
              color: h.toStatus.color,
            },
            changedBy: h.changedBy,
          })),
          activities: project.activities.map((a) => ({
            id: a.id,
            type: a.type,
            message: a.message,
            createdAt: a.createdAt.toISOString(),
            user: a.user,
          })),
        }}
        statuses={options.statuses}
        transitions={options.transitions}
      />
    </AppShell>
  );
}
