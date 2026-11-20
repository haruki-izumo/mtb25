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

async function assertProfile(userId: string, role: "ADMIN" | "MEMBER" | "INTERVIEWER", profileId: string) {
  const access = profileAccessWhere(userId, role);
  return prisma.profile.findFirst({
    where: { id: profileId, ...access },
    select: { id: true },
  });
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
    if (!(await assertProfile(user.uid, user.role, profileId))) {
      return jsonError(Object.assign(new Error("Profile not found"), { status: 404 }));
    }
    const keys = await prisma.profileApiKey.findMany({
      where: { profileId, mode },
      orderBy: { createdAt: "asc" },
    });
    return jsonOk({
      profileId,
      mode: mode.toLowerCase(),
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label || "",
        keyPreview: preview(k.key),
        createdAt: k.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return jsonError(err, 401);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const url = new URL(req.url);
    const profileId = url.searchParams.get("profileId");
    const body = (await req.json()) as {
      mode?: string;
      key?: string;
      label?: string;
    };
    if (!profileId) {
      return jsonError(Object.assign(new Error("profileId is required"), { status: 400 }));
    }
    if (!(await assertProfile(user.uid, user.role, profileId))) {
      return jsonError(Object.assign(new Error("Profile not found"), { status: 404 }));
    }
    const mode =
      String(body.mode || "free").toLowerCase() === "pro" ? "PRO" : "FREE";
    const key = String(body.key || "").trim();
    if (!key) {
      return jsonError(Object.assign(new Error("key is required"), { status: 400 }));
    }
    const created = await prisma.profileApiKey.create({
      data: {
        profileId,
        mode,
        key,
        label: body.label?.trim() || null,
      },
    });
    return jsonOk(
      {
        id: created.id,
        label: created.label || "",
        keyPreview: preview(created.key),
        createdAt: created.createdAt.toISOString(),
      },
      201,
    );
  } catch (err) {
    return jsonError(err, 401);
  }
}
