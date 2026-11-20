import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { AvailabilityView } from "@/components/availability/availability-view";
import { requireSession } from "@/lib/auth-helpers";
import { getAvailabilityPageData } from "@/lib/availability-data";
import { countryFlag } from "@/lib/timezone";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const data = await getAvailabilityPageData({
    userId: session.user.id,
    role: session.user.role,
    profileId: first(sp.profileId),
    weekStart: first(sp.week),
  });

  const isInterviewerMode = data.mode === "interviewer";

  return (
    <AppShell
      sidebar={
        <div className="space-y-3">
          {isInterviewerMode ? (
            <>
              <h2 className="text-sm font-semibold text-slate-900">
                My availability
              </h2>
              <p className="text-xs text-slate-500">
                Set when you are free to take interviews. Times use your
                timezone.
              </p>
              {data.mode === "interviewer" && data.interviewer ? (
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
                  <p className="font-medium text-slate-900">
                    {data.interviewer.name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {data.interviewer.timezone}
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-slate-900">Profiles</h2>
              <p className="text-xs text-slate-500">
                Select a profile in the main panel to inspect weekly
                availability.
              </p>
              <ul className="space-y-1">
                {data.mode === "profile"
                  ? data.profiles.map((p) => (
                      <li
                        key={p.id}
                        className={`rounded-xl px-3 py-2 text-sm ${
                          data.profile?.id === p.id
                            ? "bg-white font-semibold shadow-sm ring-1 ring-slate-200"
                            : "text-slate-600"
                        }`}
                      >
                        {countryFlag(p.country)} {p.code}.{p.displayName}
                      </li>
                    ))
                  : null}
              </ul>
            </>
          )}
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="h-96 animate-pulse rounded-2xl bg-slate-100" />
        }
      >
        {data.mode === "interviewer" ? (
          <AvailabilityView
            mode="interviewer"
            profiles={[]}
            profile={null}
            interviewer={data.interviewer}
            weekStartIso={data.weekStart}
            days={data.days}
            textSummary={data.textSummary}
            isAdmin={session.user.role === "ADMIN"}
          />
        ) : (
          <AvailabilityView
            mode="profile"
            profiles={data.profiles}
            profile={data.profile}
            interviewer={null}
            weekStartIso={data.weekStart}
            days={data.days}
            textSummary={data.textSummary}
            isAdmin={session.user.role === "ADMIN"}
          />
        )}
      </Suspense>
    </AppShell>
  );
}
