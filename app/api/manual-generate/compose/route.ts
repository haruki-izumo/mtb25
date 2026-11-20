import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { composeResumePrompt } from "@/lib/rb5/generate";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const body = (await req.json()) as {
      profileId?: string;
      job_description?: string;
      company?: string;
      role?: string;
      bulletMin?: number;
      bulletMax?: number;
      fit?: unknown;
    };
    if (!body.profileId) {
      return jsonError(Object.assign(new Error("profileId is required"), { status: 400 }));
    }
    if (!String(body.job_description || "").trim()) {
      return jsonError(
        Object.assign(new Error("job_description is required"), { status: 400 }),
      );
    }
    const promptText = await composeResumePrompt({
      userId: user.uid,
      role: user.role,
      profileId: body.profileId,
      job_description: String(body.job_description),
      company: body.company,
      roleTitle: body.role,
      bulletMin: body.bulletMin,
      bulletMax: body.bulletMax,
      fit: body.fit,
    });
    return jsonOk({ promptText });
  } catch (err) {
    return jsonError(err);
  }
}
