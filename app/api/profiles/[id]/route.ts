import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { getProfileForUser } from "@/lib/rb5/profile-adapter";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireExtensionUser(req);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const full = url.searchParams.get("full") === "1";
    const profile = await getProfileForUser(id, user.uid, user.role, { full });
    if (!profile) {
      return jsonError(Object.assign(new Error("Profile not found"), { status: 404 }));
    }
    return jsonOk(profile);
  } catch (err) {
    return jsonError(err, 401);
  }
}
