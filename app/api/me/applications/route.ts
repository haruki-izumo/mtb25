import { prisma } from "@/lib/prisma";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const url = new URL(req.url);
    const profileId = url.searchParams.get("profileId") || undefined;
    const applied = url.searchParams.get("applied");

    const items = await prisma.application.findMany({
      where: {
        ...(user.role === "ADMIN" ? {} : { ownerId: user.uid }),
        ...(profileId ? { profileId } : {}),
        ...(applied === "1" ? { applied: true } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        profileId: true,
        company: true,
        jobTitle: true,
        url: true,
        applied: true,
        submitted: true,
        appliedAt: true,
        createdAt: true,
        updatedAt: true,
        mode: true,
        resumeTemplate: true,
      },
    });

    return jsonOk({
      items: items.map((a) => ({
        id: a.id,
        profileId: a.profileId,
        company: a.company,
        role: a.jobTitle,
        jd_url: a.url || "",
        applied: a.applied,
        submitted: a.submitted,
        appliedAt: a.appliedAt?.toISOString() || null,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        mode: a.mode,
        resumeTemplate: a.resumeTemplate,
      })),
      total: items.length,
    });
  } catch (err) {
    return jsonError(err, 401);
  }
}
