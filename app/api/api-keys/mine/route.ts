import { prisma } from "@/lib/prisma";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";
import { profileAccessWhere } from "@/lib/access";

export function OPTIONS() {
  return optionsOk();
}

function preview(key: string) {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export async function GET(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const url = new URL(req.url);
    const profileId = url.searchParams.get("profileId");
    const mode =
      String(url.searchParams.get("mode") || "free").toLowerCase() === "pro"
        ? "PRO"
        : "FREE";
    if (!profileId) {
      return jsonError(Object.assign(new Error("profileId is required"), { status: 400 }));
    }
    const access = profileAccessWhere(user.uid, user.role);
    const profile = await prisma.profile.findFirst({
      where: { id: profileId, ...access },
      select: { id: true },
    });
    if (!profile) {
      return jsonError(Object.assign(new Error("Profile not found"), { status: 404 }));
    }
    const keys = await prisma.profileApiKey.findMany({
      where: { profileId, mode },
      orderBy: { createdAt: "asc" },
    });
    return jsonOk({
      profileId,
      mode: mode.toLowerCase(),
      keyPreview: keys[0] ? preview(keys[0].key) : null,
      isGroup: keys.length > 1,
      keyCount: keys.length,
      keyPreviews: keys.map((k) => preview(k.key)),
    });
  } catch (err) {
    return jsonError(err, 401);
  }
}
