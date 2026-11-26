import { Suspense } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import { AvailabilityView } from "@/components/availability/availability-view";
import { requireSession } from "@/lib/auth-helpers";
import {
  getAvailabilityPageData,
  getInterviewerAvailabilityData,
} from "@/lib/availability-data";
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
  const profileId = first(sp.profileId);
  const week = first(sp.week);
  const isInterviewer = session.user.role === "INTERVIEWER";
  const editingOwn = isInterviewer && !profileId;

  const [data, own] = await Promise.all([
    getAvailabilityPageData({
      userId: session.user.id,
      role: session.user.role,
      profileId: editingOwn ? undefined : profileId,
      weekStart: week,
      listOnly: editingOwn,
    }),
    editingOwn
      ? getInterviewerAvailabilityData({
          userId: session.user.id,
          weekStart: week,
        })
      : Promise.resolve(null),
  ]);

  const readOnly = isInterviewer && !editingOwn;

  function hrefFor(nextProfileId?: string) {
    const params = new URLSearchParams();
    if (nextProfileId) params.set("profileId", nextProfileId);
    if (week) params.set("week", week);
    const q = params.toString();
    return q ? `/availability?${q}` : "/availability";
  }

  return (
    <AppShell
      sidebar={
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">
            {isInterviewer ? "Availability" : "Profiles"}
          </h2>
          <p className="text-xs text-slate-500">
            {isInterviewer
              ? "Set your own hours. Assigned profiles are view only."
              : "Choose a profile to view and edit weekly availability."}
          </p>
          {isInterviewer ? (
            <Link
              href={hrefFor()}
              className={cn(
                "block rounded-xl px-3 py-2 text-sm transition hover:bg-white hover:shadow-sm",
                editingOwn
                  ? "bg-white font-semibold shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600",
              )}
            >
              My availability
            </Link>
          ) : null}
          <ul className="space-y-1">
            {data.profiles.map((p) => (
              <li key={p.id}>
                <Link
                  href={hrefFor(p.id)}
                  className={cn(
                    "block rounded-xl px-3 py-2 text-sm transition hover:bg-white hover:shadow-sm",
                    !editingOwn && data.profile?.id === p.id
                      ? "bg-white font-semibold shadow-sm ring-1 ring-slate-200"
                      : "text-slate-600",
                  )}
                >
                  {countryFlag(p.country)} {p.code}.{p.displayName}
                </Link>
              </li>
            ))}
          </ul>
          {data.profiles.length === 0 && !isInterviewer ? (
            <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
              No profiles yet
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
          mode={editingOwn ? "interviewer" : "profile"}
          profiles={data.profiles}
          profile={editingOwn ? null : data.profile}
          interviewer={own?.interviewer ?? null}
          weekStartIso={editingOwn ? (own?.weekStart ?? null) : data.weekStart}
          days={editingOwn ? (own?.days ?? []) : data.days}
          textSummary={editingOwn ? (own?.textSummary ?? "") : data.textSummary}
          isAdmin={session.user.role === "ADMIN"}
          readOnly={readOnly}
        />
      </Suspense>
    </AppShell>
  );
}
