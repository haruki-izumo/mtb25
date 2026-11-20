import { requireExtensionUser, toPublicUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    const user = await requireExtensionUser(req);
    return jsonOk({
      user: toPublicUser({
        id: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
      }),
    });
  } catch (err) {
    return jsonError(err, 401);
  }
}
