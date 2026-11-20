import { jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export function GET() {
  return jsonOk({ version: 0 });
}
