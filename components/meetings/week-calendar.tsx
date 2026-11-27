"use client";

import { useMemo, useState } from "react";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
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

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

function zonedNoon(dateKey: string, timeZone: string) {
  return fromZonedTime(`${dateKey}T12:00:00`, timeZone);
}

export function WeekCalendar({
  weekStartIso,
  rounds,
  profiles,
  members,
  mode,
  timeZone = DEFAULT_TIMEZONE,
}: {
  weekStartIso: string;
  rounds: MeetingRound[];
  profiles: { id: string; code: string; displayName: string; country: string }[];
  members: { id: string; name: string }[];
  mode: "week" | "day";
  timeZone?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tz = timeZone;
  const weekStartKey = formatInTimeZone(new Date(weekStartIso), tz, "yyyy-MM-dd");
  const dayParam = searchParams.get("day");
  const dayKeys =
    mode === "day"
      ? [
          dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)
            ? dayParam
            : formatInTimeZone(new Date(), tz, "yyyy-MM-dd"),
        ]
      : Array.from({ length: 7 }, (_, i) => shiftDateKey(weekStartKey, i));
  const dayKeyList = dayKeys.join(",");
  const [selected, setSelected] = useState<MeetingRound | null>(null);
  const now = new Date();
  const nowKey = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const nowHour = Number(formatInTimeZone(now, tz, "H"));
  const nowMinute = Number(formatInTimeZone(now, tz, "m"));

  const byDay = useMemo(() => {
    const keys = dayKeyList.split(",").filter(Boolean);
    const map = new Map<string, MeetingRound[]>();
    for (const key of keys) map.set(key, []);
    for (const round of rounds) {
      const key = formatInTimeZone(new Date(round.startAt), tz, "yyyy-MM-dd");
      map.get(key)?.push(round);
    }
    return map;
  }, [dayKeyList, rounds, tz]);

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
                  week: shiftDateKey(weekStartKey, -7),
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
                  week: shiftDateKey(weekStartKey, 7),
                })
              }
          >
            <ChevronRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold text-slate-900">
            {formatInTimeZone(zonedNoon(dayKeys[0], tz), tz, "MMM d")} –{" "}
            {formatInTimeZone(
              zonedNoon(dayKeys[dayKeys.length - 1], tz),
              tz,
              "MMM d, yyyy",
            )}
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
                  day: nowKey,
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
            gridTemplateColumns: `64px repeat(${dayKeys.length}, minmax(0, 1fr))`,
          }}
        >
          <div className="border-b border-slate-100" />
          {dayKeys.map((key) => (
            <div
              key={key}
              className="border-b border-l border-slate-100 px-2 py-3 text-center"
            >
              <p className="text-xs font-medium uppercase text-slate-400">
                {formatInTimeZone(zonedNoon(key, tz), tz, "EEE")}
              </p>
              <p
                className={cn(
                  "mt-0.5 text-sm font-semibold",
                  key === nowKey ? "text-blue-600" : "text-slate-800",
                )}
              >
                {formatInTimeZone(zonedNoon(key, tz), tz, "d")}
              </p>
            </div>
          ))}

          {HOURS.map((hour) => (
            <div key={hour} className="contents">
              <div
                className="border-b border-slate-50 pr-2 text-right text-[11px] text-slate-400"
                style={{ height: hourHeight }}
              >
                {formatInTimeZone(
                  fromZonedTime(
                    `${weekStartKey}T${String(hour).padStart(2, "0")}:00:00`,
                    tz,
                  ),
                  tz,
                  "h a",
                )}
              </div>
              {dayKeys.map((key) => {
                const dayRounds = byDay.get(key) ?? [];
                const showNow = key === nowKey && nowHour === hour;

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
                          top: `${(nowMinute / 60) * 100}%`,
                        }}
                      />
                    ) : null}
                    {dayRounds
                      .filter(
                        (r) =>
                          Number(formatInTimeZone(new Date(r.startAt), tz, "H")) ===
                          hour,
                      )
                      .map((r, idx, arr) => {
                        const start = new Date(r.startAt);
                        const end = new Date(r.endAt);
                        const top =
                          (Number(formatInTimeZone(start, tz, "m")) / 60) *
                          hourHeight;
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
