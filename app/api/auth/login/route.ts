import { loginWithPassword } from "@/lib/rb5/auth-jwt";
import { jsonError, jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { email?: string; password?: string };
    const result = await loginWithPassword(
      String(body.email || ""),
      String(body.password || ""),
    );
    if (!result) {
      return jsonError(Object.assign(new Error("Invalid credentials"), { status: 401 }));
    }
    return jsonOk(result);
  } catch (err) {
    return jsonError(err);
  }
}
