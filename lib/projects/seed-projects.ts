import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_PROJECT_TYPES,
  PROJECT_STATUS_SEEDS,
  PROJECT_STATUS_TRANSITIONS,
} from "@/lib/projects/status";

/** Idempotent seed of project statuses, transitions, and types. */
export async function seedProjectWorkflow(prisma: PrismaClient) {
  for (const s of PROJECT_STATUS_SEEDS) {
    await prisma.projectStatusDef.upsert({
      where: { key: s.key },
      create: {
        key: s.key,
        name: s.name,
        color: s.color,
        sortOrder: s.sortOrder,
        isFinal: s.isFinal,
      },
      update: {
        name: s.name,
        color: s.color,
        sortOrder: s.sortOrder,
        isFinal: s.isFinal,
      },
    });
  }

  const statuses = await prisma.projectStatusDef.findMany();
  const byKey = Object.fromEntries(statuses.map((s) => [s.key, s]));

  for (const [fromKey, toKey] of PROJECT_STATUS_TRANSITIONS) {
    const from = byKey[fromKey];
    const to = byKey[toKey];
    if (!from || !to) continue;
    await prisma.projectStatusTransition.upsert({
      where: {
        fromStatusId_toStatusId: {
          fromStatusId: from.id,
          toStatusId: to.id,
        },
      },
      create: { fromStatusId: from.id, toStatusId: to.id },
      update: {},
    });
  }

  let order = 0;
  for (const name of DEFAULT_PROJECT_TYPES) {
    order += 1;
    const existing = await prisma.projectType.findUnique({ where: { name } });
    if (!existing) {
      await prisma.projectType.create({
        data: { name, sortOrder: order, active: true },
      });
    }
  }
}
