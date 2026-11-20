import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { listProfilesForUser } from "@/lib/rb5/profile-adapter";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    const profiles = await listProfilesForUser(user.uid, user.role);
    return jsonOk(profiles);
  } catch (err) {
    return jsonError(err, 401);
  }
}
