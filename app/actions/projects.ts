"use server";

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { canManageProfiles } from "@/lib/roles";
import {
  changeStatusSchema,
  projectFormSchema,
} from "@/lib/projects/schema";
import { STATUSES_REQUIRING_COMMENT } from "@/lib/projects/status";

function emptyToNull(v: string | undefined | null) {
  const t = v?.trim();
  return t ? t : null;
}

function dateOrNull(v: string | undefined | null) {
  const t = v?.trim();
  if (!t) return null;
  return new Date(`${t}T00:00:00.000Z`);
}

async function nextProjectCode(tx: Prisma.TransactionClient) {
  const year = new Date().getUTCFullYear();
  const counter = await tx.projectCodeCounter.upsert({
    where: { year },
    create: { year, lastN: 1 },
    update: { lastN: { increment: 1 } },
  });
  const n = String(counter.lastN).padStart(4, "0");
  return `PRJ-${year}-${n}`;
}

async function requireProjectsUser() {
  const session = await requireSession();
  if (!canManageProfiles(session.user.role)) {
    throw new Error("Forbidden");
  }
  return session;
}

function revalidateProjects(id?: string) {
  revalidatePath("/projects");
  if (id) revalidatePath(`/projects/${id}`);
}

export async function createProject(input: unknown) {
  try {
    const session = await requireProjectsUser();
    const parsed = projectFormSchema.parse(input);

    const project = await prisma.$transaction(async (tx) => {
      const code = await nextProjectCode(tx);
      const secured = await tx.projectStatusDef.findUnique({
        where: { key: "SECURED" },
      });
      if (!secured) throw new Error("Project statuses are not seeded");

      const created = await tx.project.create({
        data: {
          projectCode: code,
          projectName: parsed.projectName,
          clientId: parsed.clientId,
          country: parsed.country,
          city: emptyToNull(parsed.city),
          industry: emptyToNull(parsed.industry),
          projectTypeId: emptyToNull(parsed.projectTypeId) || null,
          description: parsed.description,
          scopeOfWork: emptyToNull(parsed.scopeOfWork),
          budget: new Prisma.Decimal(parsed.budget),
          currency: parsed.currency,
          contractValue:
            parsed.contractValue != null && parsed.contractValue !== undefined
              ? new Prisma.Decimal(parsed.contractValue)
              : null,
          paymentTerms: emptyToNull(parsed.paymentTerms),
          dateSecured: new Date(`${parsed.dateSecured}T00:00:00.000Z`),
          startDate: dateOrNull(parsed.startDate),
          expectedEndDate: dateOrNull(parsed.expectedEndDate),
          actualEndDate: dateOrNull(parsed.actualEndDate),
          projectManagerId: parsed.projectManagerId,
          priority: parsed.priority,
          statusId: secured.id,
          progressPercent: parsed.progressPercent,
          tags: parsed.tags,
          notes: emptyToNull(parsed.notes),
          createdById: session.user.id,
          updatedById: session.user.id,
          teamMembers: {
            connect: parsed.teamMemberIds.map((id) => ({ id })),
          },
        },
      });

      await tx.projectStatusHistory.create({
        data: {
          projectId: created.id,
          fromStatusId: null,
          toStatusId: secured.id,
          changedById: session.user.id,
          comment: "Project created",
        },
      });
      await tx.projectActivity.create({
        data: {
          projectId: created.id,
          userId: session.user.id,
          type: "CREATED",
          message: `Created project ${code}`,
        },
      });
      return created;
    });

    revalidateProjects(project.id);
    return { ok: true as const, id: project.id };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Failed to create project",
    };
  }
}

export async function updateProject(projectId: string, input: unknown) {
  try {
    const session = await requireProjectsUser();
    const parsed = projectFormSchema.parse(input);

    const existing = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        projectManager: { select: { id: true, name: true } },
        teamMembers: { select: { id: true } },
      },
    });
    if (!existing || existing.archivedAt) {
      return { ok: false as const, error: "Project not found" };
    }

    const fieldChanges: Array<{ field: string; from: string; to: string }> = [];
    const budgetNext = Number(parsed.budget);
    if (Number(existing.budget) !== budgetNext) {
      fieldChanges.push({
        field: "budget",
        from: String(existing.budget),
        to: String(budgetNext),
      });
    }
    if (existing.projectManagerId !== parsed.projectManagerId) {
      fieldChanges.push({
        field: "projectManager",
        from: existing.projectManagerId,
        to: parsed.projectManagerId,
      });
    }
    const startPrev = existing.startDate?.toISOString().slice(0, 10) ?? "";
    const startNext = parsed.startDate?.trim() || "";
    if (startPrev !== startNext) {
      fieldChanges.push({ field: "startDate", from: startPrev, to: startNext });
    }
    const endPrev = existing.expectedEndDate?.toISOString().slice(0, 10) ?? "";
    const endNext = parsed.expectedEndDate?.trim() || "";
    if (endPrev !== endNext) {
      fieldChanges.push({
        field: "expectedEndDate",
        from: endPrev,
        to: endNext,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: {
          projectName: parsed.projectName,
          clientId: parsed.clientId,
          country: parsed.country,
          city: emptyToNull(parsed.city),
          industry: emptyToNull(parsed.industry),
          projectTypeId: emptyToNull(parsed.projectTypeId) || null,
          description: parsed.description,
          scopeOfWork: emptyToNull(parsed.scopeOfWork),
          budget: new Prisma.Decimal(parsed.budget),
          currency: parsed.currency,
          contractValue:
            parsed.contractValue != null
              ? new Prisma.Decimal(parsed.contractValue)
              : null,
          paymentTerms: emptyToNull(parsed.paymentTerms),
          dateSecured: new Date(`${parsed.dateSecured}T00:00:00.000Z`),
          startDate: dateOrNull(parsed.startDate),
          expectedEndDate: dateOrNull(parsed.expectedEndDate),
          actualEndDate: dateOrNull(parsed.actualEndDate),
          projectManagerId: parsed.projectManagerId,
          priority: parsed.priority,
          progressPercent: parsed.progressPercent,
          tags: parsed.tags,
          notes: emptyToNull(parsed.notes),
          updatedById: session.user.id,
          teamMembers: {
            set: parsed.teamMemberIds.map((id) => ({ id })),
          },
        },
      });

      for (const change of fieldChanges) {
        await tx.projectActivity.create({
          data: {
            projectId,
            userId: session.user.id,
            type: "FIELD_EDIT",
            message: `Updated ${change.field}`,
            meta: change,
          },
        });
      }
    });

    revalidateProjects(projectId);
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Failed to update project",
    };
  }
}

export async function changeProjectStatus(input: unknown) {
  try {
    const session = await requireProjectsUser();
    const parsed = changeStatusSchema.parse(input);

    const project = await prisma.project.findUnique({
      where: { id: parsed.projectId },
      include: { status: true },
    });
    if (!project || project.archivedAt) {
      return { ok: false as const, error: "Project not found" };
    }
    if (project.status.isFinal) {
      return { ok: false as const, error: "Final status cannot be changed" };
    }

    const toStatus = await prisma.projectStatusDef.findUnique({
      where: { id: parsed.toStatusId },
    });
    if (!toStatus) return { ok: false as const, error: "Invalid status" };

    const allowed = await prisma.projectStatusTransition.findUnique({
      where: {
        fromStatusId_toStatusId: {
          fromStatusId: project.statusId,
          toStatusId: toStatus.id,
        },
      },
    });
    if (!allowed) {
      return {
        ok: false as const,
        error: `Cannot move from ${project.status.name} to ${toStatus.name}`,
      };
    }

    const needsComment = STATUSES_REQUIRING_COMMENT.has(
      toStatus.key as "ON_HOLD" | "CANCELLED",
    );
    if (needsComment && !parsed.comment?.trim()) {
      return { ok: false as const, error: "A comment is required for this status" };
    }

    const data: Prisma.ProjectUpdateInput = {
      status: { connect: { id: toStatus.id } },
      updatedBy: { connect: { id: session.user.id } },
    };
    if (toStatus.key === "COMPLETED") {
      data.progressPercent = 100;
      data.actualEndDate = parsed.actualEndDate?.trim()
        ? new Date(`${parsed.actualEndDate}T00:00:00.000Z`)
        : new Date();
    }

    await prisma.$transaction([
      prisma.project.update({ where: { id: project.id }, data }),
      prisma.projectStatusHistory.create({
        data: {
          projectId: project.id,
          fromStatusId: project.statusId,
          toStatusId: toStatus.id,
          changedById: session.user.id,
          comment: emptyToNull(parsed.comment),
        },
      }),
      prisma.projectActivity.create({
        data: {
          projectId: project.id,
          userId: session.user.id,
          type: "STATUS_CHANGE",
          message: `${project.status.name} → ${toStatus.name}`,
          meta: {
            fromStatusId: project.statusId,
            toStatusId: toStatus.id,
            comment: parsed.comment || null,
          },
        },
      }),
    ]);

    revalidateProjects(project.id);
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Failed to change status",
    };
  }
}

export async function archiveProject(projectId: string) {
  try {
    const session = await requireProjectsUser();
    await prisma.project.update({
      where: { id: projectId },
      data: {
        archivedAt: new Date(),
        updatedById: session.user.id,
      },
    });
    await prisma.projectActivity.create({
      data: {
        projectId,
        userId: session.user.id,
        type: "FIELD_EDIT",
        message: "Archived project",
      },
    });
    revalidateProjects(projectId);
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Failed to archive",
    };
  }
}

export async function uploadProjectAttachment(formData: FormData) {
  try {
    const session = await requireProjectsUser();
    const projectId = String(formData.get("projectId") || "");
    if (!projectId) return { ok: false as const, error: "Missing project" };

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.archivedAt) {
      return { ok: false as const, error: "Project not found" };
    }

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false as const, error: "Choose a file" };
    }
    if (file.size > 12 * 1024 * 1024) {
      return { ok: false as const, error: "File must be 12 MB or smaller" };
    }

    const ext = path.extname(file.name) || "";
    const base =
      file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "file";
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${stamp}-${base}${ext ? "" : ""}`;
    const dir = path.join(process.cwd(), "public", "uploads", "projects");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, fileName),
      Buffer.from(await file.arrayBuffer()),
    );
    const url = `/uploads/projects/${fileName}`;

    await prisma.projectAttachment.create({
      data: {
        projectId,
        fileName: file.name,
        url,
        uploadedById: session.user.id,
      },
    });
    await prisma.projectActivity.create({
      data: {
        projectId,
        userId: session.user.id,
        type: "FILE_UPLOAD",
        message: `Uploaded ${file.name}`,
      },
    });

    revalidateProjects(projectId);
    return { ok: true as const, url };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Upload failed",
    };
  }
}
