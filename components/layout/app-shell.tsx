import type { ReactNode } from "react";
import { IconRail } from "@/components/layout/icon-rail";
import { requireSession } from "@/lib/auth-helpers";

export async function AppShell({
  sidebar,
  children,
}: {
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  const session = await requireSession();
  return (
    <div className="min-h-screen bg-slate-100">
      <IconRail role={session.user.role} />
      <div className="pl-20">
        <div className="flex min-h-screen">
          {sidebar ? (
            <aside className="sticky top-0 h-screen w-[280px] shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50/80 p-4">
              {sidebar}
            </aside>
          ) : null}
          <main className="min-w-0 flex-1 p-5 md:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
