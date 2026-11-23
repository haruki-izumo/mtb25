"use client";

import { useEffect, useState, useTransition } from "react";
import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  bookRound,
  getOpenSlotsForProfileDay,
  getProfileProcessesForBooking,
} from "@/app/actions/booking";
import { uploadResumeFile } from "@/app/actions/uploads";
import {
  BOOKING_DURATIONS,
  type BookingDuration,
} from "@/lib/availability";
import {
  isPlainTextJobDescriptionFile,
  validateJobDescriptionText,
} from "@/lib/job-description";
import { ROUND_TYPE_CONFIG } from "@/lib/rounds";
import type { RoundType } from "@prisma/client";

type ProfileOption = {
  id: string;
  label: string;
};

type ProcessOption = {
  id: string;
  companyName: string;
  jobTitle: string;
  status: string;
};

export function CreateInterviewDialog({
  open,
  onClose,
  profiles,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  profiles: ProfileOption[];
  isAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [dateKey, setDateKey] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [duration, setDuration] = useState<BookingDuration>(60);
  const [slots, setSlots] = useState<string[]>([]);
  const [timeZone, setTimeZone] = useState("UTC");
  const [interviewerName, setInterviewerName] = useState<string | null>(null);
  const [clientInterviewerName, setClientInterviewerName] = useState("");
  const [clientInterviewerAbout, setClientInterviewerAbout] = useState("");
  const [startAt, setStartAt] = useState("");
  const [type, setType] = useState<RoundType>("TECH");
  const [meetingLink, setMeetingLink] = useState("");
  const [overrideAvailability, setOverrideAvailability] = useState(false);
  const [processes, setProcesses] = useState<ProcessOption[]>([]);
  const [processId, setProcessId] = useState("");
  const [createNew, setCreateNew] = useState(true);
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobDescriptionFileName, setJobDescriptionFileName] = useState<
    string | null
  >(null);
  const [resumeFileUrl, setResumeFileUrl] = useState("");
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOverrideAvailability(false);
    setMeetingLink("");
    setClientInterviewerName("");
    setClientInterviewerAbout("");
    setCompanyName("");
    setJobTitle("");
    setJobUrl("");
    setJobDescription("");
    setJobDescriptionFileName(null);
    setResumeFileUrl("");
    setResumeFileName(null);
    setCreateNew(true);
    if (!profileId && profiles[0]) setProfileId(profiles[0].id);
  }, [open, profiles, profileId]);

  useEffect(() => {
    if (!open || !profileId || !dateKey) return;
    let cancelled = false;
    setLoadingSlots(true);
    setError(null);

    startTransition(async () => {
      try {
        const [slotData, processList] = await Promise.all([
          getOpenSlotsForProfileDay({
            profileId,
            dateKey,
            durationMinutes: duration,
          }),
          getProfileProcessesForBooking(profileId),
        ]);
        if (cancelled) return;
        setSlots(slotData.slots);
        setTimeZone(slotData.timeZone);
        setInterviewerName(slotData.interviewer?.name ?? null);
        setStartAt(slotData.slots[0] ?? "");
        setProcesses(processList);
        setProcessId(processList[0]?.id ?? "");
        setCreateNew(processList.length === 0);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load slots",
          );
          setSlots([]);
          setStartAt("");
          setInterviewerName(null);
        }
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, profileId, dateKey, duration]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Create interview
            </h3>
            <p className="text-sm text-slate-500">
              Pick a profile, date, and time
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
            <span className="mb-1 block font-medium text-slate-700">
              Profile
            </span>
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
            >
              {profiles.length === 0 ? (
                <option value="">No profiles available</option>
              ) : (
                profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Date</span>
            <input
              type="date"
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Duration
            </span>
            <select
              value={duration}
              onChange={(e) =>
                setDuration(Number(e.target.value) as BookingDuration)
              }
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
            <span className="mb-1 block font-medium text-slate-700">
              Start time
              {timeZone ? (
                <span className="font-normal text-slate-400">
                  {" "}
                  · {timeZone}
                </span>
              ) : null}
            </span>
            <select
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              disabled={loadingSlots || (slots.length === 0 && !overrideAvailability)}
            >
              {loadingSlots ? (
                <option value="">Loading slots…</option>
              ) : slots.length === 0 ? (
                <option value="">No open slots for this day</option>
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
                Custom start
              </span>
              <input
                type="datetime-local"
                className="h-10 w-full rounded-xl border border-slate-200 px-3"
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  setStartAt(new Date(v).toISOString());
                }}
              />
            </label>
          ) : null}

          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-700">Our interviewer: </span>
            <span className="text-slate-600">
              {interviewerName ?? "None assigned — set one on the profile"}
            </span>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Client interviewer name
            </span>
            <input
              value={clientInterviewerName}
              onChange={(e) => setClientInterviewerName(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              placeholder="Name at the hiring company"
              required
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              About client interviewer
            </span>
            <textarea
              value={clientInterviewerAbout}
              onChange={(e) => setClientInterviewerAbout(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              placeholder="Role, background, what to expect…"
              required
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Round type
            </span>
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
                <input
                  value={jobUrl}
                  onChange={(e) => setJobUrl(e.target.value)}
                  placeholder="Job link (https://…)"
                  required
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
                />
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-600">
                    Job description (.txt)
                  </label>
                  <input
                    type="file"
                    accept=".txt,text/plain"
                    className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-200 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800"
                    onChange={(e) => {
                      const input = e.target;
                      const file = input.files?.[0];
                      if (!file) return;
                      setError(null);
                      if (!isPlainTextJobDescriptionFile(file)) {
                        setError(
                          "Job description must be a .txt file (not PDF/Word)",
                        );
                        setJobDescription("");
                        setJobDescriptionFileName(null);
                        input.value = "";
                        return;
                      }
                      startTransition(async () => {
                        const checked = validateJobDescriptionText(
                          await file.text(),
                        );
                        if (!checked.ok) {
                          setError(checked.error);
                          setJobDescription("");
                          setJobDescriptionFileName(null);
                          input.value = "";
                          return;
                        }
                        setJobDescription(checked.text);
                        setJobDescriptionFileName(file.name);
                      });
                    }}
                  />
                  {jobDescriptionFileName ? (
                    <p className="text-xs text-emerald-700">
                      Selected: {jobDescriptionFileName}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Required — upload a .txt job description (not PDF)
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-600">
                    Resume (PDF / Word)
                  </label>
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                    className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-200 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setError(null);
                      startTransition(async () => {
                        const fd = new FormData();
                        fd.set("file", file);
                        const result = await uploadResumeFile(fd);
                        if (!result.ok) {
                          setError(result.error);
                          setResumeFileUrl("");
                          setResumeFileName(null);
                          return;
                        }
                        setResumeFileUrl(result.url);
                        setResumeFileName(file.name);
                      });
                    }}
                  />
                  {resumeFileName ? (
                    <p className="text-xs text-emerald-700">
                      Uploaded: {resumeFileName}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400">Required for new interviews</p>
                  )}
                </div>
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
            disabled={
              pending ||
              !profileId ||
              (!startAt && !overrideAvailability) ||
              !interviewerName
            }
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={() => {
              setError(null);
              if (!interviewerName) {
                setError("Assign an interviewer to this profile first");
                return;
              }
              if (!clientInterviewerName.trim()) {
                setError("Client interviewer name is required");
                return;
              }
              if (clientInterviewerAbout.trim().length < 10) {
                setError("Add a short about for the client interviewer");
                return;
              }
              if (!startAt) {
                setError("Pick a start time");
                return;
              }
              if (createNew) {
                if (!companyName.trim() || !jobTitle.trim()) {
                  setError("Company and job title are required");
                  return;
                }
                if (!jobUrl.trim()) {
                  setError("Job link is required");
                  return;
                }
                if (!jobDescriptionFileName || jobDescription.trim().length < 20) {
                  setError("Select a .txt job description file");
                  return;
                }
                if (!resumeFileUrl) {
                  setError("Upload a resume before creating the interview");
                  return;
                }
              }
              startTransition(async () => {
                const result = await bookRound({
                  profileId,
                  processId: createNew ? undefined : processId || undefined,
                  newProcess: createNew
                    ? {
                        companyName: companyName.trim(),
                        jobTitle: jobTitle.trim(),
                        jobUrl: jobUrl.trim(),
                        jobDescription: jobDescription.trim(),
                        resumeFileUrl,
                      }
                    : undefined,
                  startAt,
                  durationMinutes: duration,
                  type,
                  interviewerName,
                  clientInterviewerName: clientInterviewerName.trim(),
                  clientInterviewerAbout: clientInterviewerAbout.trim(),
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
            {pending ? "Creating…" : "Create interview"}
          </button>
        </div>
      </div>
    </div>
  );
}
