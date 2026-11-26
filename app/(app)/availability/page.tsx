import { Suspense } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import { AvailabilityView } from "@/components/availability/availability-view";
import { requireSession } from "@/lib/auth-helpers";
import { getAvailabilityPageData } from "@/lib/availability-data";
import { countryFlag } from "@/lib/timezone";
import { cn } from "@/lib/utils";

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
  const isInterviewer = session.user.role === "INTERVIEWER";
  const data = await getAvailabilityPageData({
    userId: session.user.id,
    role: session.user.role,
    profileId: first(sp.profileId),
    weekStart: first(sp.week),
  });

  return (
    <AppShell
      sidebar={
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">Profiles</h2>
          <p className="text-xs text-slate-500">
            Choose a profile to view and edit weekly availability.
          </p>
          <ul className="space-y-1">
            {data.profiles.map((p) => {
              const params = new URLSearchParams();
              params.set("profileId", p.id);
              const week = first(sp.week);
              if (week) params.set("week", week);
              return (
                <li key={p.id}>
                  <Link
                    href={`/availability?${params.toString()}`}
                    className={cn(
                      "block rounded-xl px-3 py-2 text-sm transition hover:bg-white hover:shadow-sm",
                      data.profile?.id === p.id
                        ? "bg-white font-semibold shadow-sm ring-1 ring-slate-200"
                        : "text-slate-600",
                    )}
                  >
                    {countryFlag(p.country)} {p.code}.{p.displayName}
                  </Link>
                </li>
              );
            })}
          </ul>
          {data.profiles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
              {isInterviewer ? "No profiles assigned to you" : "No profiles yet"}
            </p>
          ) : null}
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="h-96 animate-pulse rounded-2xl bg-slate-100" />
        }
      >
        <AvailabilityView
          mode="profile"
          profiles={data.profiles}
          profile={data.profile}
          interviewer={null}
          weekStartIso={data.weekStart}
          days={data.days}
          textSummary={data.textSummary}
          isAdmin={session.user.role === "ADMIN"}
          allowBooking={!isInterviewer}
        />
      </Suspense>
    </AppShell>
  );
}
