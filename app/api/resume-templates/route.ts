import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { RESUME_TEMPLATES } from "@/lib/rb5/pdf";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    await requireExtensionUser(req);
    return jsonOk({
      templates: RESUME_TEMPLATES,
      defaultId: "style2",
    });
  } catch (err) {
    return jsonError(err, 401);
  }
}
