import { Suspense } from "react";
import type { RoundType } from "@prisma/client";
import { AppShell } from "@/components/layout/app-shell";
import { MiniMonth } from "@/components/meetings/mini-month";
import { WeekCalendar } from "@/components/meetings/week-calendar";
import { requireSession } from "@/lib/auth-helpers";
import { getMeetingsWeek } from "@/lib/meetings-data";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const mode = first(sp.mode) === "day" ? "day" : "week";
  const types = (first(sp.types) || "")
    .split(",")
    .filter(Boolean) as RoundType[];

  const data = await getMeetingsWeek({
    userId: session.user.id,
    role: session.user.role,
    weekStart: first(sp.week),
    memberId: first(sp.memberId),
    profileId: first(sp.profileId),
    roundTypes: types.length ? types : undefined,
    mode,
    day: first(sp.day),
  });

  return (
    <AppShell
      sidebar={
        <Suspense fallback={null}>
          <MiniMonth weekStartIso={data.weekStart} timeZone={data.timeZone} />
        </Suspense>
      }
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-slate-100" />}>
        <WeekCalendar
          weekStartIso={data.weekStart}
          rounds={data.rounds}
          profiles={data.profiles}
          members={data.members}
          mode={mode}
          timeZone={data.timeZone}
        />
      </Suspense>
    </AppShell>
  );
}
