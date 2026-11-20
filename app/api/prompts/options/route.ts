import { requireExtensionUser } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function GET(req: Request) {
  try {
    await requireExtensionUser(req);
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") || "resume";
    return jsonOk([
      {
        id: "default",
        title: kind === "autofill" ? "Default autofill" : "Default resume",
        isDefault: true,
      },
    ]);
  } catch (err) {
    return jsonError(err, 401);
  }
}
