"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { addMinutes, format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  bookRound,
  getProfileProcessesForBooking,
} from "@/app/actions/booking";
import {
  BOOKING_DURATIONS,
  getBookableSlots,
  type BookingDuration,
} from "@/lib/availability";
import { ROUND_TYPE_CONFIG } from "@/lib/rounds";
import type { RoundType } from "@prisma/client";

type ProcessOption = {
  id: string;
  companyName: string;
  jobTitle: string;
  status: string;
};

type OpenInterval = { startAt: string; endAt: string };

export function BookingDialog({
  open,
  onClose,
  profileId,
  profileLabel,
  timeZone,
  dateKey,
  initialHour,
  openIntervals,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  profileId: string;
  profileLabel: string;
  timeZone: string;
  dateKey: string;
  initialHour: number;
  openIntervals: OpenInterval[];
  isAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [processes, setProcesses] = useState<ProcessOption[]>([]);
  const [processId, setProcessId] = useState("");
  const [createNew, setCreateNew] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [duration, setDuration] = useState<BookingDuration>(60);
  const [startAt, setStartAt] = useState("");
  const [type, setType] = useState<RoundType>("TECH");
  const [interviewerName, setInterviewerName] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [overrideAvailability, setOverrideAvailability] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots = useMemo(() => {
    const intervals = openIntervals.map((iv) => ({
      startAt: new Date(iv.startAt),
      endAt: new Date(iv.endAt),
    }));
    return getBookableSlots(intervals, duration).map((d) => d.toISOString());
  }, [openIntervals, duration]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOverrideAvailability(false);
    setCreateNew(false);
    setCompanyName("");
    setJobTitle("");
    setInterviewerName("");
    setMeetingLink("");

    startTransition(async () => {
      const list = await getProfileProcessesForBooking(profileId);
      setProcesses(list);
      setProcessId(list[0]?.id ?? "");
      setCreateNew(list.length === 0);
    });

    const preferred = slots.find((s) => {
      const h = Number(formatInTimeZone(new Date(s), timeZone, "H"));
      return h === initialHour;
    });
    setStartAt(preferred ?? slots[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when dialog opens
  }, [open, profileId, dateKey, duration]);

  useEffect(() => {
    if (!open) return;
    const preferred = slots.find((s) => {
      const h = Number(formatInTimeZone(new Date(s), timeZone, "H"));
      return h === initialHour;
    });
    setStartAt(preferred ?? slots[0] ?? "");
  }, [slots, open, initialHour, timeZone]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Book interview</h3>
            <p className="text-sm text-slate-500">
              {profileLabel} · {dateKey}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Duration</span>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) as BookingDuration)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
            >
              {BOOKING_DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} min
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Start time</span>
            <select
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              disabled={slots.length === 0 && !overrideAvailability}
            >
              {slots.length === 0 ? (
                <option value="">No open slots for this duration</option>
              ) : (
                slots.map((s) => (
                  <option key={s} value={s}>
                    {formatInTimeZone(new Date(s), timeZone, "h:mm a")} –{" "}
                    {formatInTimeZone(
                      addMinutes(new Date(s), duration),
                      timeZone,
                      "h:mm a",
                    )}
                  </option>
                ))
              )}
            </select>
          </label>

          {isAdmin ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={overrideAvailability}
                onChange={(e) => setOverrideAvailability(e.target.checked)}
              />
              Override availability (admin)
            </label>
          ) : null}

          {isAdmin && overrideAvailability ? (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                Custom start (ISO local wall clock)
              </span>
              <input
                type="datetime-local"
                className="h-10 w-full rounded-xl border border-slate-200 px-3"
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  // Interpret as profile-local by appending and converting via Date — user picks local machine time;
                  // for admin override we send UTC from the chosen value.
                  setStartAt(new Date(v).toISOString());
                }}
              />
            </label>
          ) : null}

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Round type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as RoundType)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
            >
              {Object.entries(ROUND_TYPE_CONFIG).map(([key, val]) => (
                <option key={key} value={key}>
                  {val.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Interviewer
            </span>
            <input
              value={interviewerName}
              onChange={(e) => setInterviewerName(e.target.value)}
              required
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              placeholder="Name"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Meeting link (optional)
            </span>
            <input
              value={meetingLink}
              onChange={(e) => setMeetingLink(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              placeholder="https://…"
            />
          </label>

          <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={createNew}
                onChange={(e) => setCreateNew(e.target.checked)}
              />
              Create new interview process
            </label>

            {createNew ? (
              <div className="mt-3 space-y-2">
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Company"
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
                />
                <input
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="Job title"
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
                />
              </div>
            ) : (
              <select
                value={processId}
                onChange={(e) => setProcessId(e.target.value)}
                className="mt-3 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
              >
                {processes.length === 0 ? (
                  <option value="">No open processes</option>
                ) : (
                  processes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.companyName} · {p.jobTitle}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-xl px-4 text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || (!startAt && !overrideAvailability)}
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={() => {
              setError(null);
              if (!interviewerName.trim()) {
                setError("Interviewer name is required");
                return;
              }
              if (!startAt) {
                setError("Pick a start time");
                return;
              }
              startTransition(async () => {
                const result = await bookRound({
                  profileId,
                  processId: createNew ? undefined : processId || undefined,
                  newProcess: createNew
                    ? { companyName, jobTitle, jobUrl: "" }
                    : undefined,
                  startAt,
                  durationMinutes: duration,
                  type,
                  interviewerName: interviewerName.trim(),
                  meetingLink: meetingLink.trim(),
                  overrideAvailability,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onClose();
              });
            }}
          >
            {pending ? "Booking…" : "Book"}
          </button>
        </div>

        {startAt ? (
          <p className="mt-3 text-xs text-slate-400">
            Stores as UTC · local{" "}
            {formatInTimeZone(new Date(startAt), timeZone, "MMM d, yyyy h:mm a")}{" "}
            ({format(new Date(startAt), "O")} machine offset shown in ISO)
          </p>
        ) : null}
      </div>
    </div>
  );
}
