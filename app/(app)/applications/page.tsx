import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import {
  ApplicationsSidebar,
  ApplicationsView,
} from "@/components/applications/applications-view";
import { requireSession } from "@/lib/auth-helpers";
import {
  getApplicationsPageData,
  parseApplicationDateRange,
} from "@/lib/applications-data";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const data = await getApplicationsPageData({
    userId: session.user.id,
    role: session.user.role,
    profileId: first(sp.profileId),
    q: first(sp.q),
    range: parseApplicationDateRange(first(sp.range)),
    from: first(sp.from),
    to: first(sp.to),
  });

  return (
    <AppShell
      sidebar={
        <Suspense fallback={null}>
          <ApplicationsSidebar
            profiles={data.profiles}
            selectedId={data.profileId}
          />
        </Suspense>
      }
    >
      <Suspense
        fallback={
          <div className="h-96 animate-pulse rounded-2xl bg-slate-200" />
        }
      >
        <ApplicationsView
          applications={data.applications}
          totalCount={data.totalCount}
          truncated={data.truncated}
          readOnly={session.user.role === "INTERVIEWER"}
        />
      </Suspense>
    </AppShell>
  );
}
