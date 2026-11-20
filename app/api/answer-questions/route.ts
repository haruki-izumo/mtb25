import { createRequire } from "module";
import path from "path";
import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { getPromptProfileForUser } from "@/lib/rb5/profile-adapter";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

const requireFrom = createRequire(
  path.join(process.cwd(), "lib", "rb5", "answers.cjs"),
);
const answersMod = requireFrom("./answers.cjs") as {
  // answers.js exports createAnswersRouter; also may export helpers — call heuristic inline
  [key: string]: unknown;
};

export function OPTIONS() {
  return optionsOk();
}

/** Lightweight heuristic answers (same spirit as rb5 answers.js). */
function heuristicAnswer(question: string, profileName: string) {
  const q = question.toLowerCase();
  if (q.includes("salary") || q.includes("compensation")) {
    return "Compensation is negotiable based on the full role scope and benefits.";
  }
  if (q.includes("authorize") || q.includes("eligible") || q.includes("visa")) {
    return "Yes — I am authorized to work and can start on a mutually agreed timeline.";
  }
  if (q.includes("relocat")) {
    return "I am open to discussing location and hybrid expectations for the right role.";
  }
  if (q.includes("why") && (q.includes("company") || q.includes("us"))) {
    return `I'm excited about this opportunity and how ${profileName}'s background maps to your team's needs.`;
  }
  return `Based on my experience as reflected in the tailored materials for ${profileName}, I am a strong fit for this requirement and can elaborate in interview.`;
}

export async function POST(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const body = (await req.json()) as {
      profileId?: string;
      questions?: string[];
    };
    void answersMod;
    let profileName = "the candidate";
    if (body.profileId) {
      const loaded = await getPromptProfileForUser(
        body.profileId,
        user.uid,
        user.role,
      );
      if (loaded) profileName = loaded.prompt.name;
    }
    const questions = Array.isArray(body.questions) ? body.questions : [];
    return jsonOk({
      answers: questions.map((question) => ({
        question,
        answer: heuristicAnswer(String(question || ""), profileName),
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
