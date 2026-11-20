import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ProjectsListView } from "@/components/projects/projects-list-view";
import { requireSession } from "@/lib/auth-helpers";
import {
  getProjectFormOptions,
  getProjectsList,
  getProjectsSummary,
  type ProjectListFilters,
} from "@/lib/projects-data";
import { canManageProfiles } from "@/lib/roles";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  if (!canManageProfiles(session.user.role)) redirect("/");

  const sp = await searchParams;
  const view = (first(sp.view) === "kanban" ? "kanban" : "table") as
    | "table"
    | "kanban";
  const statusParam = first(sp.status);
  const filters: ProjectListFilters = {
    q: first(sp.q),
    statusIds: statusParam ? statusParam.split(",").filter(Boolean) : undefined,
    country: first(sp.country),
    projectManagerId: first(sp.pm),
    priority: first(sp.priority),
    dateSecuredFrom: first(sp.from),
    dateSecuredTo: first(sp.to),
    budgetMin: first(sp.bmin) ? Number(first(sp.bmin)) : undefined,
    budgetMax: first(sp.bmax) ? Number(first(sp.bmax)) : undefined,
    sort: first(sp.sort),
    page: first(sp.page) ? Number(first(sp.page)) : 1,
    pageSize: first(sp.pageSize) ? Number(first(sp.pageSize)) : 20,
    view,
    includeArchived: first(sp.archived) === "1",
  };

  const [list, summary, options] = await Promise.all([
    getProjectsList(session.user.role, filters),
    getProjectsSummary(session.user.role, filters),
    getProjectFormOptions(session.user.role),
  ]);

  return (
    <AppShell
      sidebar={
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Projects</h2>
          <p className="mt-1 text-xs text-slate-500">
            Pipeline, clients, and delivery status
          </p>
        </div>
      }
    >
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <ProjectsListView
          projects={list.projects}
          total={list.total}
          page={list.page}
          pageSize={list.pageSize}
          statuses={list.statuses}
          transitions={options.transitions}
          users={options.users.map((u) => ({ id: u.id, name: u.name }))}
          summary={summary}
        />
      </Suspense>
    </AppShell>
  );
}
