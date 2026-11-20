import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { finishManualGenerate } from "@/lib/rb5/generate";
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
      jd_url?: string;
      resumeTemplate?: string;
      aiResponseText?: string;
    };
    if (!body.profileId) {
      return jsonError(Object.assign(new Error("profileId is required"), { status: 400 }));
    }
    const result = await finishManualGenerate({
      userId: user.uid,
      role: user.role,
      profileId: body.profileId,
      job_description: body.job_description,
      company: body.company,
      roleTitle: body.role,
      jd_url: body.jd_url,
      resumeTemplate: body.resumeTemplate,
      aiResponseText: String(body.aiResponseText || ""),
    });
    return jsonOk(result);
  } catch (err) {
    return jsonError(err);
  }
}
