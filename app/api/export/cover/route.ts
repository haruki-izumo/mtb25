import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { buildCoverPdf } from "@/lib/rb5/pdf";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(req: Request) {
  try {
    await requireExtensionUser(req);
    const body = (await req.json()) as {
      cover_letter?: string;
      job_data?: unknown;
      resume?: unknown;
    };
    const file = await buildCoverPdf(
      String(body.cover_letter || ""),
      body.job_data,
      body.resume,
    );
    return jsonOk({ file });
  } catch (err) {
    return jsonError(err);
  }
}
