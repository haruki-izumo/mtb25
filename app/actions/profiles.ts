"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSession, assertCanAccessProfile } from "@/lib/auth-helpers";

export async function toggleProfileStar(profileId: string) {
  z.string().min(1).parse(profileId);
  const session = await requireSession();
  await assertCanAccessProfile(
    session.user.id,
    session.user.role,
    profileId,
  );
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { starred: true },
  });
  if (!profile) throw new Error("Profile not found");
  await prisma.profile.update({
    where: { id: profileId },
    data: { starred: !profile.starred },
  });
  revalidatePath("/profiles");
}
