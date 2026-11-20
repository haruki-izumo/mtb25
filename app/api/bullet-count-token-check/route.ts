import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    await requireExtensionUser(req);
    return jsonOk({ present: true });
  } catch (err) {
    return jsonError(err, 401);
  }
}
