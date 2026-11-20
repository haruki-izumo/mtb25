"use client";

import { useMemo, useState, useTransition } from "react";
import { addWeeks, format, subWeeks } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { ChevronLeft, ChevronRight, Copy, Pencil, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createAvailabilityRule,
  deleteAvailabilityRule,
  updateAvailabilityRule,
  addOpenOverride,
} from "@/app/actions/availability";
import {
  addInterviewerOpenOverride,
  createInterviewerAvailabilityRule,
  deleteInterviewerAvailabilityRule,
  updateInterviewerAvailabilityRule,
} from "@/app/actions/interviewer-availability";
import { BookingDialog } from "@/components/booking/booking-dialog";
import { countryFlag, formatTimezoneLabel } from "@/lib/timezone";
import { cn } from "@/lib/utils";

type DayBlock = {
  dateKey: string;
  dateIso: string;
  weekday: number;
  open: { startAt: string; endAt: string }[];
  blocked: {
    date: string;
    startMinute: number | null;
    endMinute: number | null;
    type: "BLOCK" | "OPEN";
  }[];
  booked: { startAt: string; endAt: string }[];
  bookedCount: number;
};

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type RuleRow = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export function AvailabilityView({
  mode = "profile",
  profiles,
  profile,
  interviewer,
  weekStartIso,
  days,
  textSummary,
  isAdmin = false,
}: {
  mode?: "profile" | "interviewer";
  profiles: {
    id: string;
    code: string;
    displayName: string;
    country: string;
    timezone: string;
  }[];
  profile: {
    id: string;
    code: string;
    displayName: string;
    country: string;
    timezone: string;
    rules: RuleRow[];
  } | null;
  interviewer?: {
    id: string;
    name: string;
    email: string;
    timezone: string;
    rules: RuleRow[];
  } | null;
  weekStartIso: string | null;
  days: DayBlock[];
  textSummary: string;
  isAdmin?: boolean;
}) {
  const isInterviewerMode = mode === "interviewer";
  const subjectTimezone =
    (isInterviewerMode ? interviewer?.timezone : profile?.timezone) || "UTC";
  const subjectRules: RuleRow[] = isInterviewerMode
    ? (interviewer?.rules ?? [])
    : (profile?.rules ?? []);
  const canEdit = isInterviewerMode ? !!interviewer : !!profile;
  const canBook = !isInterviewerMode && !!profile;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<"week" | "rules">("week");
  const [showText, setShowText] = useState(false);
  const [booking, setBooking] = useState<{
    dateKey: string;
    hour: number;
    open: { startAt: string; endAt: string }[];
  } | null>(null);
  const [drag, setDrag] = useState<{
    dateKey: string;
    startHour: number;
    endHour: number;
  } | null>(null);
  const [editingRule, setEditingRule] = useState<{
    id?: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weekStart = weekStartIso ? new Date(weekStartIso) : new Date();

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    router.push(`/availability?${params.toString()}`);
  }

  const cellMap = useMemo(() => {
    const tz = subjectTimezone;
    const map = new Map<string, "open" | "blocked" | "booked" | "empty">();

    function hourCovered(
      intervals: { startAt: string; endAt: string }[],
      hour: number,
    ) {
      return intervals.some((iv) => {
        const startH = Number(formatInTimeZone(new Date(iv.startAt), tz, "H"));
        const endH = Number(formatInTimeZone(new Date(iv.endAt), tz, "H"));
        const endM = Number(formatInTimeZone(new Date(iv.endAt), tz, "m"));
        const endExclusive = endM === 0 ? endH : endH + 1;
        return startH <= hour && hour < endExclusive;
      });
    }

    for (const day of days) {
      for (const hour of HOURS) {
        const key = `${day.dateKey}-${hour}`;
        if (
          day.blocked.some((b) => b.startMinute == null && b.endMinute == null)
        ) {
          map.set(key, "blocked");
        } else if (hourCovered(day.booked, hour)) {
          map.set(key, "booked");
        } else if (hourCovered(day.open, hour)) {
          map.set(key, "open");
        } else {
          map.set(key, "empty");
        }
      }
    }
    return map;
  }, [days, subjectTimezone]);

  if (!canEdit) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
        {isInterviewerMode
          ? "Interviewer account not found."
          : "No profiles available."}
      </div>
    );
  }

  function finishDrag() {
    if (!drag || !canEdit) return;
    const startHour = Math.min(drag.startHour, drag.endHour);
    const endHour = Math.max(drag.startHour, drag.endHour) + 1;
    const dateKey = drag.dateKey;
    setDrag(null);
    setError(null);
    startTransition(async () => {
      try {
        if (isInterviewerMode && interviewer) {
          await addInterviewerOpenOverride({
            dateKey,
            startMinute: startHour * 60,
            endMinute: endHour * 60,
          });
        } else if (profile) {
          await addOpenOverride({
            profileId: profile.id,
            dateKey,
            startMinute: startHour * 60,
            endMinute: endHour * 60,
          });
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to add availability",
        );
      }
    });
  }

  return (
    <div className={cn("space-y-4", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {isInterviewerMode ? "My availability" : "Availability"}
          </h1>
          <p className="text-sm text-slate-500">
            {formatTimezoneLabel(subjectTimezone)}
            {isInterviewerMode && interviewer
              ? ` · ${interviewer.name}`
              : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isInterviewerMode && profile ? (
            <select
              value={profile.id}
              onChange={(e) => navigate({ profileId: e.target.value })}
              className="h-9 min-w-[220px] rounded-xl border border-slate-200 bg-white px-3 text-sm"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {countryFlag(p.country)} {p.code}.{p.displayName}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            onClick={() => setShowText(true)}
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Get availability as Text
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        <button
          type="button"
          onClick={() => setTab("week")}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium",
            tab === "week" ? "bg-white shadow-sm" : "text-slate-500",
          )}
        >
          Week grid
        </button>
        <button
          type="button"
          onClick={() => setTab("rules")}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium",
            tab === "rules" ? "bg-white shadow-sm" : "text-slate-500",
          )}
        >
          Weekly rules
        </button>
      </div>

      {tab === "week" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white p-2"
                onClick={() =>
                  navigate({ week: subWeeks(weekStart, 1).toISOString() })
                }
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white p-2"
                onClick={() =>
                  navigate({ week: addWeeks(weekStart, 1).toISOString() })
                }
              >
                <ChevronRight className="size-4" />
              </button>
              <span className="text-sm font-medium text-slate-700">
                Week of {format(weekStart, "MMM d, yyyy")}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {canBook
                ? "Click green to book · drag empty cells to add open time"
                : "Drag empty cells to add open time · edit weekly rules in the Rules tab"}
            </p>
          </div>

          <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div
              className="grid min-w-[800px]"
              style={{ gridTemplateColumns: `64px repeat(7, minmax(0, 1fr))` }}
            >
              <div className="border-b border-slate-100" />
              {days.map((d) => (
                <div
                  key={d.dateKey}
                  className="border-b border-l border-slate-100 px-2 py-3 text-center"
                >
                  <p className="text-xs uppercase text-slate-400">
                    {format(new Date(d.dateIso), "EEE")}
                  </p>
                  <p className="text-sm font-semibold text-slate-800">
                    {format(new Date(d.dateIso), "d")}
                  </p>
                </div>
              ))}
              {HOURS.map((hour) => (
                <div key={hour} className="contents">
                  <div className="border-b border-slate-50 py-2 pr-2 text-right text-[11px] text-slate-400">
                    {format(new Date().setHours(hour, 0, 0, 0), "h a")}
                  </div>
                  {days.map((d) => {
                    const state = cellMap.get(`${d.dateKey}-${hour}`) ?? "empty";
                    const inDrag =
                      drag &&
                      drag.dateKey === d.dateKey &&
                      hour >= Math.min(drag.startHour, drag.endHour) &&
                      hour <= Math.max(drag.startHour, drag.endHour);

                    return (
                      <button
                        key={`${d.dateKey}-${hour}`}
                        type="button"
                        className={cn(
                          "h-10 border-b border-l border-slate-50",
                          state === "open" && "bg-emerald-200/80 hover:bg-emerald-300/80",
                          state === "blocked" &&
                            "bg-[repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0_6px,#cbd5e1_6px,#cbd5e1_12px)]",
                          state === "booked" &&
                            "bg-[repeating-linear-gradient(-45deg,#e2e8f0,#e2e8f0_6px,#94a3b8_6px,#94a3b8_12px)]",
                          state === "empty" && "hover:bg-slate-50",
                          inDrag && "bg-blue-200/70",
                        )}
                          title={
                          state === "open"
                            ? canBook
                              ? "Available — click to book"
                              : "Available"
                            : state === "empty"
                              ? "Drag to add open availability"
                              : state
                        }
                        onMouseDown={() => {
                          if (state === "empty") {
                            setDrag({
                              dateKey: d.dateKey,
                              startHour: hour,
                              endHour: hour,
                            });
                          }
                        }}
                        onMouseEnter={() => {
                          if (drag && drag.dateKey === d.dateKey) {
                            setDrag({ ...drag, endHour: hour });
                          }
                        }}
                        onMouseUp={() => {
                          if (drag) finishDrag();
                          else if (state === "open" && canBook) {
                            setBooking({
                              dateKey: d.dateKey,
                              hour,
                              open: d.open,
                            });
                          }
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-slate-500">
            <span className="inline-flex items-center gap-2">
              <span className="size-3 rounded-sm bg-emerald-200" /> Available
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-3 rounded-sm bg-[repeating-linear-gradient(45deg,#e2e8f0,#e2e8f0_4px,#94a3b8_4px,#94a3b8_8px)]" />{" "}
              Booked / blocked
            </span>
          </div>
        </>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Recurring weekly rules
            </h3>
            <button
              type="button"
              onClick={() =>
                setEditingRule({
                  weekday: 1,
                  startMinute: 10 * 60,
                  endMinute: 15 * 60,
                })
              }
              className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white"
            >
              Add rule
            </button>
          </div>
          <ul className="mt-4 space-y-2">
            {subjectRules.length === 0 ? (
              <li className="text-sm text-slate-500">No rules yet</li>
            ) : (
              subjectRules
                .slice()
                .sort(
                  (a, b) =>
                    a.weekday - b.weekday || a.startMinute - b.startMinute,
                )
                .map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2 text-sm"
                  >
                    <span className="font-medium text-slate-800">
                      {DAY_NAMES[r.weekday]}
                    </span>
                    <span className="text-slate-600">
                      {fmtMinute(r.startMinute)} – {fmtMinute(r.endMinute)}
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        onClick={() =>
                          setEditingRule({
                            id: r.id,
                            weekday: r.weekday,
                            startMinute: r.startMinute,
                            endMinute: r.endMinute,
                          })
                        }
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        onClick={() => {
                          if (!confirm("Delete this rule?")) return;
                          startTransition(async () => {
                            if (isInterviewerMode) {
                              await deleteInterviewerAvailabilityRule(r.id);
                            } else {
                              await deleteAvailabilityRule(r.id);
                            }
                          });
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </li>
                ))
            )}
          </ul>
        </div>
      )}

      {showText ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900">
                Availability (next 7 days)
              </h3>
              <button
                type="button"
                onClick={() => setShowText(false)}
                className="text-sm text-slate-500"
              >
                Close
              </button>
            </div>
            <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
              {textSummary}
            </pre>
            <button
              type="button"
              className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white"
              onClick={() => navigator.clipboard.writeText(textSummary)}
            >
              <Copy className="size-4" /> Copy
            </button>
          </div>
        </div>
      ) : null}

      {booking && profile && canBook ? (
        <BookingDialog
          open
          onClose={() => setBooking(null)}
          profileId={profile.id}
          profileLabel={`${countryFlag(profile.country)} ${profile.code}.${profile.displayName}`}
          timeZone={profile.timezone}
          dateKey={booking.dateKey}
          initialHour={booking.hour}
          openIntervals={booking.open}
          isAdmin={isAdmin}
        />
      ) : null}

      {editingRule ? (
        <RuleEditorDialog
          rule={editingRule}
          onClose={() => setEditingRule(null)}
          onSave={(data) => {
            setError(null);
            startTransition(async () => {
              try {
                if (isInterviewerMode) {
                  if (data.id) {
                    await updateInterviewerAvailabilityRule({
                      id: data.id,
                      weekday: data.weekday,
                      startMinute: data.startMinute,
                      endMinute: data.endMinute,
                    });
                  } else {
                    await createInterviewerAvailabilityRule({
                      weekday: data.weekday,
                      startMinute: data.startMinute,
                      endMinute: data.endMinute,
                    });
                  }
                } else if (profile) {
                  if (data.id) {
                    await updateAvailabilityRule({
                      id: data.id,
                      weekday: data.weekday,
                      startMinute: data.startMinute,
                      endMinute: data.endMinute,
                    });
                  } else {
                    await createAvailabilityRule({
                      profileId: profile.id,
                      weekday: data.weekday,
                      startMinute: data.startMinute,
                      endMinute: data.endMinute,
                    });
                  }
                }
                setEditingRule(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed");
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}

function RuleEditorDialog({
  rule,
  onClose,
  onSave,
}: {
  rule: {
    id?: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
  };
  onClose: () => void;
  onSave: (data: {
    id?: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
  }) => void;
}) {
  const [weekday, setWeekday] = useState(rule.weekday);
  const [startMinute, setStartMinute] = useState(rule.startMinute);
  const [endMinute, setEndMinute] = useState(rule.endMinute);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-900">
          {rule.id ? "Edit rule" : "Add rule"}
        </h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Weekday</span>
            <select
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              className="h-10 w-full rounded-xl border px-3"
            >
              {DAY_NAMES.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Start</span>
            <input
              type="time"
              value={minuteToTime(startMinute)}
              onChange={(e) => setStartMinute(timeToMinute(e.target.value))}
              className="h-10 w-full rounded-xl border px-3"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">End</span>
            <input
              type="time"
              value={minuteToTime(endMinute)}
              onChange={(e) => setEndMinute(timeToMinute(e.target.value))}
              className="h-10 w-full rounded-xl border px-3"
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-xl px-4 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onSave({ id: rule.id, weekday, startMinute, endMinute })
            }
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtMinute(m: number) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${min.toString().padStart(2, "0")}${ampm}`;
}

function minuteToTime(m: number) {
  return `${Math.floor(m / 60)
    .toString()
    .padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`;
}

function timeToMinute(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
