"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

const TIMEZONE_COOKIE = "im_timezone";

export async function getPreferredTimezone(): Promise<string> {
  const jar = await cookies();
  return jar.get(TIMEZONE_COOKIE)?.value || "America/New_York";
}

export async function updateTimezone(timezone: string) {
  z.string().min(1).parse(timezone);
  await requireSession();
  const jar = await cookies();
  jar.set(TIMEZONE_COOKIE, timezone, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/settings");
  revalidatePath("/meetings");
  revalidatePath("/");
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}) {
  const session = await requireSession();
  const parsed = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(100),
    })
    .parse(input);

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });
  if (!user) throw new Error("User not found");

  const ok = await bcrypt.compare(parsed.currentPassword, user.passwordHash);
  if (!ok) throw new Error("Current password is incorrect");

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(parsed.newPassword, 10) },
  });
}
