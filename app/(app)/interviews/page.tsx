import { Suspense } from "react";
import type { RoundType } from "@prisma/client";
import { AppShell } from "@/components/layout/app-shell";
import { StatusSidebar } from "@/components/interviews/status-sidebar";
import { InterviewToolbar } from "@/components/interviews/interview-toolbar";
import { CreateInterviewButton } from "@/components/interviews/create-interview-button";
import { ProcessCard } from "@/components/interviews/process-card";
import { requireSession } from "@/lib/auth-helpers";
import {
  getInterviewFilterOptions,
  getInterviewProcesses,
  getInterviewSidebarCounts,
  type InterviewFilters,
  type InterviewRange,
} from "@/lib/interviews-data";
import type { StatusGroupId } from "@/lib/status";
import { countryFlag } from "@/lib/timezone";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function InterviewsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const sp = await searchParams;

  const filters: InterviewFilters = {
    group: (first(sp.group) as StatusGroupId) || "ALL",
    range: (first(sp.range) as InterviewRange) || "all",
    from: first(sp.from),
    to: first(sp.to),
    q: first(sp.q),
    sort: first(sp.sort) === "asc" ? "asc" : "desc",
    profileId: first(sp.profileId),
    memberId: first(sp.memberId),
    roundType: first(sp.roundType) as RoundType | undefined,
  };

  const [counts, processes, options] = await Promise.all([
    getInterviewSidebarCounts(session.user.id, session.user.role),
    getInterviewProcesses(session.user.id, session.user.role, filters),
    getInterviewFilterOptions(session.user.id, session.user.role),
  ]);

  return (
    <AppShell
      sidebar={
        <Suspense fallback={<div className="h-40 animate-pulse rounded-xl bg-slate-200" />}>
          <StatusSidebar counts={counts} />
        </Suspense>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Interviews</h1>
            <p className="text-sm text-slate-500">
              {processes.length} process{processes.length === 1 ? "" : "es"}
            </p>
          </div>
          {session.user.role !== "INTERVIEWER" ? (
            <CreateInterviewButton
              isAdmin={session.user.role === "ADMIN"}
              profiles={options.profiles.map((p) => ({
                id: p.id,
                label: `${countryFlag(p.country)} ${p.code}.${p.displayName}`,
              }))}
            />
          ) : null}
        </div>

        <Suspense fallback={null}>
          <InterviewToolbar
            profiles={options.profiles.map((p) => ({
              id: p.id,
              label: `${countryFlag(p.country)} ${p.code}.${p.displayName}`,
            }))}
            members={options.members.map((m) => ({
              id: m.id,
              label: m.name,
            }))}
          />
        </Suspense>

        {processes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">
            No interview processes match these filters.
          </div>
        ) : (
          <div className="space-y-4">
            {processes.map((process) => (
              <ProcessCard
                key={process.id}
                process={process}
                isAdmin={session.user.role === "ADMIN"}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
