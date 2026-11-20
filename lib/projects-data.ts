import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canManageProfiles } from "@/lib/roles";

export type ProjectListFilters = {
  q?: string;
  statusIds?: string[];
  country?: string;
  projectManagerId?: string;
  priority?: string;
  dateSecuredFrom?: string;
  dateSecuredTo?: string;
  budgetMin?: number;
  budgetMax?: number;
  sort?: string;
  page?: number;
  pageSize?: number;
  view?: "table" | "kanban";
  includeArchived?: boolean;
};

function assertProjectsAccess(role: Role) {
  if (!canManageProfiles(role)) {
    throw new Error("Forbidden");
  }
}

function buildWhere(filters: ProjectListFilters): Prisma.ProjectWhereInput {
  const where: Prisma.ProjectWhereInput = {};
  if (!filters.includeArchived) where.archivedAt = null;

  if (filters.q?.trim()) {
    const q = filters.q.trim();
    where.OR = [
      { projectName: { contains: q, mode: "insensitive" } },
      { projectCode: { contains: q, mode: "insensitive" } },
      { client: { name: { contains: q, mode: "insensitive" } } },
    ];
  }
  if (filters.statusIds?.length) where.statusId = { in: filters.statusIds };
  if (filters.country) where.country = filters.country.toUpperCase();
  if (filters.projectManagerId) {
    where.projectManagerId = filters.projectManagerId;
  }
  if (filters.priority) {
    where.priority = filters.priority as Prisma.EnumProjectPriorityFilter["equals"];
  }
  if (filters.dateSecuredFrom || filters.dateSecuredTo) {
    where.dateSecured = {};
    if (filters.dateSecuredFrom) {
      where.dateSecured.gte = new Date(`${filters.dateSecuredFrom}T00:00:00.000Z`);
    }
    if (filters.dateSecuredTo) {
      where.dateSecured.lte = new Date(`${filters.dateSecuredTo}T00:00:00.000Z`);
    }
  }
  if (filters.budgetMin != null || filters.budgetMax != null) {
    where.budget = {};
    if (filters.budgetMin != null) where.budget.gte = filters.budgetMin;
    if (filters.budgetMax != null) where.budget.lte = filters.budgetMax;
  }
  return where;
}

function orderBy(
  sort?: string,
): Prisma.ProjectOrderByWithRelationInput | Prisma.ProjectOrderByWithRelationInput[] {
  switch (sort) {
    case "name":
      return { projectName: "asc" };
    case "name_desc":
      return { projectName: "desc" };
    case "budget":
      return { budget: "asc" };
    case "budget_desc":
      return { budget: "desc" };
    case "start":
      return { startDate: "asc" };
    case "start_desc":
      return { startDate: "desc" };
    case "code":
      return { projectCode: "asc" };
    case "updated":
      return { updatedAt: "asc" };
    default:
      return { updatedAt: "desc" };
  }
}

export async function getProjectFormOptions(role: Role) {
  assertProjectsAccess(role);
  const [statuses, types, clients, users] = await Promise.all([
    prisma.projectStatusDef.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.projectType.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.client.findMany({ orderBy: { name: "asc" }, take: 500 }),
    prisma.user.findMany({
      where: { role: { in: ["ADMIN", "MEMBER"] } },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const transitions = await prisma.projectStatusTransition.findMany({
    select: { fromStatusId: true, toStatusId: true },
  });
  return { statuses, types, clients, users, transitions };
}

export async function getProjectsList(role: Role, filters: ProjectListFilters) {
  assertProjectsAccess(role);
  const page = Math.max(1, filters.page || 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize || 20));
  const where = buildWhere(filters);

  const [total, rows, statuses] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: orderBy(filters.sort),
      skip: (page - 1) * pageSize,
      take: filters.view === "kanban" ? 500 : pageSize,
      include: {
        client: { select: { id: true, name: true } },
        status: true,
        projectManager: { select: { id: true, name: true } },
      },
    }),
    prisma.projectStatusDef.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);

  return {
    total,
    page,
    pageSize,
    statuses,
    projects: rows.map((p) => ({
      id: p.id,
      projectCode: p.projectCode,
      projectName: p.projectName,
      clientName: p.client.name,
      country: p.country,
      budget: Number(p.budget),
      currency: p.currency,
      priority: p.priority,
      progressPercent: p.progressPercent,
      startDate: p.startDate?.toISOString().slice(0, 10) ?? null,
      expectedEndDate: p.expectedEndDate?.toISOString().slice(0, 10) ?? null,
      updatedAt: p.updatedAt.toISOString(),
      status: {
        id: p.status.id,
        key: p.status.key,
        name: p.status.name,
        color: p.status.color,
        isFinal: p.status.isFinal,
      },
      projectManager: p.projectManager,
    })),
  };
}

export async function getProjectsSummary(role: Role, filters: ProjectListFilters) {
  assertProjectsAccess(role);
  const where = buildWhere(filters);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [activeCount, byStatus, currencyGroups, overdueCount] =
    await Promise.all([
      prisma.project.count({
        where: {
          ...where,
          status: { isFinal: false },
        },
      }),
      prisma.project.groupBy({
        by: ["statusId"],
        where,
        _count: { _all: true },
      }),
      prisma.project.groupBy({
        by: ["currency"],
        where: { ...where, status: { isFinal: false } },
        _sum: { budget: true },
      }),
      prisma.project.count({
        where: {
          ...where,
          expectedEndDate: { lt: today },
          status: { isFinal: false },
        },
      }),
    ]);

  const statuses = await prisma.projectStatusDef.findMany({
    orderBy: { sortOrder: "asc" },
  });
  const statusName = Object.fromEntries(statuses.map((s) => [s.id, s]));

  return {
    activeCount,
    overdueCount,
    pipelineByCurrency: currencyGroups.map((g) => ({
      currency: g.currency,
      total: Number(g._sum.budget ?? 0),
    })),
    perStatus: byStatus.map((g) => ({
      statusId: g.statusId,
      name: statusName[g.statusId]?.name ?? g.statusId,
      color: statusName[g.statusId]?.color ?? "#64748b",
      count: g._count._all,
    })),
  };
}

export async function getProjectDetail(role: Role, projectId: string) {
  assertProjectsAccess(role);
  const project = await prisma.project.findFirst({
    where: { id: projectId },
    include: {
      client: true,
      projectType: true,
      status: true,
      projectManager: { select: { id: true, name: true, email: true } },
      teamMembers: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true } },
      updatedBy: { select: { id: true, name: true } },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: {
          uploadedBy: { select: { id: true, name: true } },
        },
      },
      statusHistory: {
        orderBy: { changedAt: "desc" },
        take: 50,
        include: {
          fromStatus: true,
          toStatus: true,
          changedBy: { select: { id: true, name: true } },
        },
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 80,
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });
  return project;
}

export async function listClientsForSelect(role: Role, q?: string) {
  assertProjectsAccess(role);
  return prisma.client.findMany({
    where: q?.trim()
      ? { name: { contains: q.trim(), mode: "insensitive" } }
      : undefined,
    orderBy: { name: "asc" },
    take: 50,
  });
}
