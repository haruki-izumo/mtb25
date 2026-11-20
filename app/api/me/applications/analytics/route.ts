import { createRequire } from "module";
import path from "path";
import { prisma } from "@/lib/prisma";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

const requireFrom = createRequire(
  path.join(process.cwd(), "lib", "rb5", "applications-analytics.cjs"),
);
const analytics = requireFrom("./applications-analytics.cjs") as {
  buildApplicationAnalytics: (
    apps: unknown[],
    profiles: unknown[],
    query?: Record<string, string>,
  ) => unknown;
};

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const url = new URL(req.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const apps = await prisma.application.findMany({
      where: user.role === "ADMIN" ? {} : { ownerId: user.uid },
      orderBy: { createdAt: "asc" },
    });
    const profiles = await prisma.profile.findMany({
      select: { id: true, displayName: true, code: true },
    });

    const mapped = apps.map((a) => ({
      id: a.id,
      profileId: a.profileId,
      company: a.company,
      role: a.jobTitle,
      applied: a.applied,
      submitted: a.submitted,
      appliedAt: a.appliedAt?.toISOString() || a.createdAt.toISOString(),
      createdAt: a.createdAt.toISOString(),
      ownerId: a.ownerId,
    }));

    const profileMeta = profiles.map((p) => ({
      _id: p.id,
      id: p.id,
      name: `${p.code}.${p.displayName}`,
    }));

    const report = analytics.buildApplicationAnalytics(
      mapped,
      profileMeta,
      query,
    );
    return jsonOk(report);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.name === "AnalyticsQueryError" || e.status === 400) {
      return jsonError(Object.assign(e, { status: e.status || 400 }));
    }
    return jsonError(err, 401);
  }
}
