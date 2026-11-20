import { corsHeaders, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export async function PATCH() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
