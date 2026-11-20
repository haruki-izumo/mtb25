import { prisma } from "@/lib/prisma";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireExtensionUser(req);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { submitted?: boolean };
    const app = await prisma.application.findFirst({
      where: {
        id,
        ...(user.role === "ADMIN" ? {} : { ownerId: user.uid }),
      },
    });
    if (!app) {
      return jsonError(Object.assign(new Error("Not found"), { status: 404 }));
    }
    await prisma.application.update({
      where: { id },
      data: { submitted: Boolean(body.submitted) },
    });
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(err, 401);
  }
}
