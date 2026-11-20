import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  Calendar,
  CalendarDays,
  MessageSquare,
  Minus,
  UserRound,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { AppShell } from "@/components/layout/app-shell";
import { LiveClock } from "@/components/home/live-clock";
import { CountdownCard } from "@/components/home/countdown-card";
import { requireSession } from "@/lib/auth-helpers";
import { getHomeDashboardData } from "@/lib/home-data";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";

const QUICK_LINKS = [
  { href: "/meetings", label: "Meetings", icon: CalendarDays, color: "bg-blue-50 text-blue-700" },
  { href: "/availability", label: "Availability", icon: Calendar, color: "bg-emerald-50 text-emerald-700" },
  { href: "/chat", label: "Chat", icon: MessageSquare, color: "bg-violet-50 text-violet-700" },
  { href: "/profiles", label: "Profile", icon: UserRound, color: "bg-amber-50 text-amber-700" },
  { href: "/interviews", label: "Interview", icon: Briefcase, color: "bg-cyan-50 text-cyan-700" },
] as const;

function DeltaArrow({ value }: { value: number | null }) {
  if (value == null || value === 0) {
    return <Minus className="size-3.5 text-slate-400" />;
  }
  if (value > 0) return <ArrowUp className="size-3.5 text-emerald-600" />;
  return <ArrowDown className="size-3.5 text-red-500" />;
}

export default async function HomePage() {
  const session = await requireSession();
  const timeZone = DEFAULT_TIMEZONE;
  const data = await getHomeDashboardData(
    session.user.id,
    session.user.role,
  );

  const progress =
    data.todayMeetings.total === 0
      ? 0
      : Math.round((data.todayMeetings.done / data.todayMeetings.total) * 100);

  return (
    <AppShell
      sidebar={
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Overview</h2>
            <p className="mt-1 text-xs text-slate-500">
              Signed in as {session.user.name}
            </p>
          </div>
          <div className="space-y-2">
            {[
              { label: "Needs update", value: data.stats.needsUpdateCount, tone: "text-red-600" },
              { label: "Upcoming", value: data.stats.upcomingCount, tone: "text-blue-600" },
              { label: "Follow-up", value: data.stats.followUpCount, tone: "text-amber-600" },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2.5"
              >
                <span className="text-sm text-slate-600">{item.label}</span>
                <span className={cn("text-sm font-semibold", item.tone)}>
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      }
    >
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <LiveClock timeZone={timeZone} />
          <CountdownCard
            nextRound={data.nextRound}
            displayTimeZone={timeZone}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {QUICK_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
              >
                <span
                  className={cn(
                    "inline-flex size-9 items-center justify-center rounded-xl",
                    link.color,
                  )}
                >
                  <Icon className="size-4.5" />
                </span>
                <p className="mt-3 text-sm font-semibold text-slate-900">
                  {link.label}
                </p>
              </Link>
            );
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { label: "Next step", value: data.stats.nextStepCount, color: "border-l-amber-400" },
            { label: "Follow-up", value: data.stats.followUpCount, color: "border-l-yellow-400" },
            { label: "Upcoming", value: data.stats.upcomingCount, color: "border-l-blue-500" },
          ].map((stat) => (
            <div
              key={stat.label}
              className={cn(
                "rounded-2xl border border-slate-200 border-l-4 bg-white p-5 shadow-sm",
                stat.color,
              )}
            >
              <p className="text-sm text-slate-500">{stat.label}</p>
              <p className="mt-2 text-3xl font-semibold text-slate-900">
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900">
              This week vs previous
            </h3>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-slate-500">Meetings</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl font-semibold text-slate-900">
                    {data.weekCompare.thisWeek.count}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-xs text-slate-500">
                    <DeltaArrow value={data.weekCompare.meetingDelta} />
                    {Math.abs(data.weekCompare.meetingDelta)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  Prev: {data.weekCompare.prevWeek.count}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Avg rating</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl font-semibold text-slate-900">
                    {data.weekCompare.thisWeek.avgRating?.toFixed(1) ?? "—"}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-xs text-slate-500">
                    <DeltaArrow value={data.weekCompare.ratingDelta} />
                    {data.weekCompare.ratingDelta != null
                      ? Math.abs(data.weekCompare.ratingDelta).toFixed(1)
                      : "0"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  Prev:{" "}
                  {data.weekCompare.prevWeek.avgRating?.toFixed(1) ?? "—"}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Today&apos;s meetings
              </h3>
              <span className="text-xs font-medium text-slate-500">
                {data.todayMeetings.done}/{data.todayMeetings.total} done
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <ul className="mt-4 space-y-2">
              {data.todayMeetings.items.length === 0 ? (
                <li className="text-sm text-slate-500">No meetings today</li>
              ) : (
                data.todayMeetings.items.map((item) => {
                  const done = [
                    "PASSED",
                    "FAILED",
                    "NO_SHOW",
                    "CANCELED",
                  ].includes(item.outcome);
                  return (
                    <li
                      key={item.id}
                      className="flex items-start gap-3 rounded-xl border border-slate-100 px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={done}
                        readOnly
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "truncate text-sm font-medium text-slate-900",
                            done && "text-slate-400 line-through",
                          )}
                        >
                          {item.companyName} · {item.jobTitle}
                        </p>
                        <p className="text-xs text-slate-500">
                          {item.profileLabel} ·{" "}
                          {formatInTimeZone(
                            new Date(item.startAt),
                            timeZone,
                            "h:mm a",
                          )}
                        </p>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Team updates</h3>
          <ul className="mt-4 space-y-3">
            {data.announcements.length === 0 ? (
              <li className="text-sm text-slate-500">No announcements yet</li>
            ) : (
              data.announcements.map((a) => (
                <li
                  key={a.id}
                  className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">
                      {a.title}
                    </p>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatDistanceToNow(new Date(a.createdAt), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{a.body}</p>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
