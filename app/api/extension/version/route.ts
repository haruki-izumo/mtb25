import { jsonOk, optionsOk } from "@/lib/rb5/http";

export function OPTIONS() {
  return optionsOk();
}

export function GET() {
  return jsonOk({ version: "mtb25-1.0.0", notes: "Interview Manager backend" });
}
