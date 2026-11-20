import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth-helpers";

export default async function AuthenticatedLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireSession();
  return children;
}
