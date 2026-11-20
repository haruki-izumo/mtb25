import { prisma } from "@/lib/prisma";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { chatCompletion } from "@/lib/rb5/gemini";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";
import { profileAccessWhere } from "@/lib/access";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as {
      profileId?: string;
      mode?: string;
      keyIndex?: number;
    };
    const profileId =
      body.profileId || url.searchParams.get("profileId") || "";
    const mode =
      String(body.mode || url.searchParams.get("mode") || "free").toLowerCase() ===
      "pro"
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
    const key = keys[Number(body.keyIndex) || 0] || keys[0];
    if (!key) {
      return jsonError(
        Object.assign(new Error("No API key to test"), { status: 400 }),
      );
    }
    await chatCompletion({
      apiKey: key.key,
      prompt: 'Reply with exactly: {"ok":true}',
    });
    return jsonOk({ ok: true, message: "Key works" });
  } catch (err) {
    return jsonError(err);
  }
}
