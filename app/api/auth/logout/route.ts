import { jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function POST() {
  return jsonOk({ ok: true });
}
