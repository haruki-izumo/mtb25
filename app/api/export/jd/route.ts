import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { buildJdPdf } from "@/lib/rb5/pdf";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(req: Request) {
  try {
    await requireExtensionUser(req);
    const body = (await req.json()) as {
      job_description?: string;
      company?: string;
      role?: string;
      jobUrl?: string;
    };
    const file = await buildJdPdf(body);
    return jsonOk({ file });
  } catch (err) {
    return jsonError(err);
  }
}
