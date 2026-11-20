import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { answerQuestions } from "@/lib/rb5/answers";
import { getPromptProfileForUser } from "@/lib/rb5/profile-adapter";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const body = (await req.json()) as {
      profileId?: string;
      questions?: unknown;
      job_data?: {
        company_name?: string;
        job_title?: string;
      };
      resume?: {
        contact?: {
          full_name?: string;
          email?: string;
          phone?: string;
          location?: string;
          linkedin?: string;
          github?: string;
        };
        summary?: string;
        headline_role?: string;
        experience?: { start?: string }[];
      };
    };

    let profile: Parameters<typeof answerQuestions>[0]["profile"] = null;
    if (body.profileId) {
      const loaded = await getPromptProfileForUser(
        body.profileId,
        user.uid,
        user.role,
      );
      if (loaded) {
        const p = loaded.prompt;
        const prefs = loaded.db.autoFillPrefs;
        profile = {
          name: p.name,
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
          phone: p.phone,
          location: p.location,
          zipCode: p.zipCode,
          country: p.country,
          linkedin: p.linkedin,
          github: p.github,
          experience: p.experience,
          autoFillPrefs:
            prefs && typeof prefs === "object" && !Array.isArray(prefs)
              ? (prefs as Record<string, unknown>)
              : {},
        };
      }
    }

    return jsonOk({
      answers: answerQuestions({
        questions: body.questions,
        profile,
        resume: body.resume ?? null,
        jobData: body.job_data ?? null,
      }),
    });
  } catch (err) {
    return jsonError(err);
  }
}
