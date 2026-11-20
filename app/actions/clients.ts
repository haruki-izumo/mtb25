"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { canManageProfiles } from "@/lib/roles";
import { createClientSchema } from "@/lib/projects/schema";

export async function createClient(input: unknown) {
  const session = await requireSession();
  if (!canManageProfiles(session.user.role)) {
    return { ok: false as const, error: "Forbidden" };
  }
  try {
    const parsed = createClientSchema.parse(input);
    const client = await prisma.client.create({
      data: {
        name: parsed.name,
        country: parsed.country,
        contactPerson: parsed.contactPerson?.trim() || null,
        email: parsed.email?.trim() || null,
        phone: parsed.phone?.trim() || null,
      },
    });
    revalidatePath("/projects");
    return { ok: true as const, client };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Failed to create client",
    };
  }
}
