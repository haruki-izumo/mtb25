import { prisma } from "@/lib/prisma";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { fileToBase64Payload } from "@/lib/rb5/generate";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireExtensionUser(req);
    const { id } = await ctx.params;
    const app = await prisma.application.findFirst({
      where: {
        id,
        ...(user.role === "ADMIN" ? {} : { ownerId: user.uid }),
      },
    });
    if (!app) {
      return jsonError(Object.assign(new Error("Not found"), { status: 404 }));
    }
    const resume = await fileToBase64Payload(app.resumePdfUrl);
    const cover = await fileToBase64Payload(app.coverPdfUrl);
    const resultInfo = (app.resultInfo || {}) as {
      resume?: unknown;
      cover_letter?: string;
    };
    return jsonOk({
      application: {
        id: app.id,
        profileId: app.profileId,
        company: app.company,
        role: app.jobTitle,
        jd_url: app.url || "",
        applied: app.applied,
        submitted: app.submitted,
        resultInfo: app.resultInfo,
        resume: resultInfo.resume,
        cover_letter: resultInfo.cover_letter,
        pdfBase64: resume?.file || null,
        resultFiles: [resume, cover].filter(Boolean),
      },
    });
  } catch (err) {
    return jsonError(err, 401);
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireExtensionUser(req);
    const { id } = await ctx.params;
    const body = (await req.json()) as { company?: string; role?: string };
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
      data: {
        ...(body.company != null ? { company: String(body.company) } : {}),
        ...(body.role != null ? { jobTitle: String(body.role) } : {}),
      },
    });
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(err, 401);
  }
}
