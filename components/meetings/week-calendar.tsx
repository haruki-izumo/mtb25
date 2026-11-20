"use client";

import { useMemo, useState } from "react";
import {
  addDays,
  addWeeks,
  format,
  isSameDay,
  startOfWeek,
  subWeeks,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { Check, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { ROUND_TYPE_CONFIG, roundEventStyle } from "@/lib/rounds";
import { countryFlag, DEFAULT_TIMEZONE, formatTimezoneLabel } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import type { RoundOutcome, RoundType } from "@prisma/client";

type MeetingRound = {
  id: string;
  type: RoundType;
  outcome: RoundOutcome;
  startAt: string;
  endAt: string;
  interviewerName: string;
  meetingLink: string | null;
  companyName: string;
  jobTitle: string;
  status: string;
  profile: {
    id: string;
    code: string;
    displayName: string;
    country: string;
  };
  owner: { id: string; name: string; avatarColor: string };
};

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 8–20

export function WeekCalendar({
  weekStartIso,
  rounds,
  profiles,
  members,
  mode,
}: {
  weekStartIso: string;
  rounds: MeetingRound[];
  profiles: { id: string; code: string; displayName: string; country: string }[];
  members: { id: string; name: string }[];
  mode: "week" | "day";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const weekStart = startOfWeek(new Date(weekStartIso), { weekStartsOn: 0 });
  const days =
    mode === "day"
      ? [new Date(searchParams.get("day") || weekStartIso)]
      : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const [selected, setSelected] = useState<MeetingRound | null>(null);
  const now = new Date();
  const tz = DEFAULT_TIMEZONE;

  const byDay = useMemo(() => {
    const map = new Map<string, MeetingRound[]>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map.set(
        key,
        rounds.filter((r) =>
          isSameDay(new Date(r.startAt), day),
        ),
      );
    }
    return map;
  }, [days, rounds]);

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    router.push(`/meetings?${params.toString()}`);
  }

  const hourHeight = 64;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white p-2"
            onClick={() =>
              navigate({
                week: subWeeks(weekStart, 1).toISOString(),
              })
            }
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white p-2"
            onClick={() =>
              navigate({
                week: addWeeks(weekStart, 1).toISOString(),
              })
            }
          >
            <ChevronRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold text-slate-900">
            {format(weekStart, "MMM d")} –{" "}
            {format(addDays(weekStart, 6), "MMM d, yyyy")}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => navigate({ mode: "week", day: null })}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium",
                mode === "week" ? "bg-white shadow-sm" : "text-slate-500",
              )}
            >
              Week
            </button>
            <button
              type="button"
              onClick={() =>
                navigate({
                  mode: "day",
                  day: format(now, "yyyy-MM-dd"),
                })
              }
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium",
                mode === "day" ? "bg-white shadow-sm" : "text-slate-500",
              )}
            >
              Day
            </button>
          </div>
          <span className="text-xs text-slate-500">
            {formatTimezoneLabel(tz)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={searchParams.get("memberId") ?? ""}
          onChange={(e) => navigate({ memberId: e.target.value || null })}
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All members</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select
          value={searchParams.get("profileId") ?? ""}
          onChange={(e) => navigate({ profileId: e.target.value || null })}
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All profiles</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {countryFlag(p.country)} {p.code}.{p.displayName}
            </option>
          ))}
        </select>
        {(
          [
            "HR_RECRUITER",
            "TECH",
            "ASSESSMENT",
            "SYSTEM_DESIGN",
            "BEHAVIORAL",
            "FINAL",
          ] as RoundType[]
        ).map((type) => {
          const active = (searchParams.get("types") || "")
            .split(",")
            .filter(Boolean)
            .includes(type);
          return (
            <button
              key={type}
              type="button"
              onClick={() => {
                const current = (searchParams.get("types") || "")
                  .split(",")
                  .filter(Boolean);
                const next = active
                  ? current.filter((t) => t !== type)
                  : [...current, type];
                navigate({ types: next.join(",") || null });
              }}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium",
                active
                  ? "border-blue-300 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600",
              )}
            >
              {ROUND_TYPE_CONFIG[type].label}
            </button>
          );
        })}
      </div>

      <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div
          className="grid min-w-[900px]"
          style={{
            gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))`,
          }}
        >
          <div className="border-b border-slate-100" />
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className="border-b border-l border-slate-100 px-2 py-3 text-center"
            >
              <p className="text-xs font-medium uppercase text-slate-400">
                {format(day, "EEE")}
              </p>
              <p
                className={cn(
                  "mt-0.5 text-sm font-semibold",
                  isSameDay(day, now)
                    ? "text-blue-600"
                    : "text-slate-800",
                )}
              >
                {format(day, "d")}
              </p>
            </div>
          ))}

          {HOURS.map((hour) => (
            <div key={hour} className="contents">
              <div
                className="border-b border-slate-50 pr-2 text-right text-[11px] text-slate-400"
                style={{ height: hourHeight }}
              >
                {format(new Date().setHours(hour, 0, 0, 0), "h a")}
              </div>
              {days.map((day) => {
                const key = format(day, "yyyy-MM-dd");
                const dayRounds = byDay.get(key) ?? [];
                const showNow =
                  isSameDay(day, now) &&
                  now.getHours() === hour;

                return (
                  <div
                    key={`${key}-${hour}`}
                    className="relative border-b border-l border-slate-50"
                    style={{ height: hourHeight }}
                  >
                    <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-slate-100" />
                    {showNow ? (
                      <div
                        className="absolute inset-x-0 z-20 border-t-2 border-red-500"
                        style={{
                          top: `${(now.getMinutes() / 60) * 100}%`,
                        }}
                      />
                    ) : null}
                    {dayRounds
                      .filter((r) => new Date(r.startAt).getHours() === hour)
                      .map((r, idx, arr) => {
                        const start = new Date(r.startAt);
                        const end = new Date(r.endAt);
                        const top = (start.getMinutes() / 60) * hourHeight;
                        const durationHrs =
                          (end.getTime() - start.getTime()) / 3_600_000;
                        const height = Math.max(durationHrs * hourHeight, 28);
                        const style = roundEventStyle(r.type, r.outcome);
                        const TypeIcon = ROUND_TYPE_CONFIG[r.type].icon;
                        const width = 100 / Math.max(arr.length, 1);
                        return (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => setSelected(r)}
                            className={cn(
                              "absolute z-10 overflow-hidden rounded-md border px-1.5 py-1 text-left shadow-sm",
                              style.bg,
                              style.text,
                              style.border,
                            )}
                            style={{
                              top,
                              height,
                              left: `${idx * width}%`,
                              width: `calc(${width}% - 2px)`,
                            }}
                          >
                            <div className="flex items-center gap-1 text-[10px] font-semibold">
                              <TypeIcon className="size-3 shrink-0" />
                              {formatInTimeZone(start, tz, "h:mm a")}
                              {r.outcome === "PASSED" ? (
                                <Check className="ml-auto size-3" />
                              ) : null}
                              {r.outcome === "RESCHEDULED" ? (
                                <RefreshCw className="ml-auto size-3" />
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] font-medium">
                              {r.companyName} | {r.jobTitle}
                            </p>
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {selected ? (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md border-l border-slate-200 bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">
                {ROUND_TYPE_CONFIG[selected.type].label}
              </p>
              <h3 className="text-lg font-semibold text-slate-900">
                {selected.companyName} | {selected.jobTitle}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
            >
              Close
            </button>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-xs uppercase text-slate-400">When</dt>
              <dd className="text-slate-800">
                {formatInTimeZone(
                  new Date(selected.startAt),
                  tz,
                  "EEE MMM d · h:mm a",
                )}{" "}
                –{" "}
                {formatInTimeZone(new Date(selected.endAt), tz, "h:mm a")}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Profile</dt>
              <dd>
                {countryFlag(selected.profile.country)} {selected.profile.code}.
                {selected.profile.displayName}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Interviewer</dt>
              <dd>{selected.interviewerName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Owner</dt>
              <dd>{selected.owner.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Outcome</dt>
              <dd>{selected.outcome}</dd>
            </div>
            {selected.meetingLink ? (
              <div>
                <dt className="text-xs uppercase text-slate-400">Meeting</dt>
                <dd>
                  <a
                    href={selected.meetingLink}
                    className="text-blue-600 underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Join link
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
