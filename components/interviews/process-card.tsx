"use client";

import { useState, useTransition } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { ExternalLink, FileText, Star, Trash2 } from "lucide-react";
import {
  addRoundToProcess,
  deleteProcess,
  updateProcessNote,
  updateProcessStatus,
  updateRound,
} from "@/app/actions/interviews";
import { getStatusConfig, STATUS_CONFIG } from "@/lib/status";
import { ROUND_OUTCOME_CONFIG, ROUND_TYPE_CONFIG } from "@/lib/rounds";
import { BOOKING_DURATIONS, type BookingDuration } from "@/lib/availability";
import { countryFlag, DEFAULT_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import type { ProcessStatus, RoundOutcome, RoundType } from "@prisma/client";

type Round = {
  id: string;
  roundNumber: number;
  type: keyof typeof ROUND_TYPE_CONFIG;
  startAt: string;
  endAt: string;
  interviewerName: string;
  clientInterviewerName: string;
  clientInterviewerAbout: string | null;
  meetingLink: string | null;
  outcome: RoundOutcome;
  rating: number | null;
  feedback: string | null;
};

export type ProcessCardData = {
  id: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string | null;
  jobDescription: string | null;
  resumeFileUrl: string | null;
  status: ProcessStatus;
  note: string | null;
  profileId: string;
  profile: {
    code: string;
    displayName: string;
    country: string;
  };
  roundCount: number;
  nextRoundAt: string | null;
  daysUntil: number | null;
  needsUpdate: boolean;
  rounds: Round[];
};

export function ProcessCard({
  process,
  isAdmin = false,
}: {
  process: ProcessCardData;
  isAdmin?: boolean;
}) {
  const config = getStatusConfig(process.status);
  const Icon = config.icon;
  const [note, setNote] = useState(process.note ?? "");
  const [pending, startTransition] = useTransition();
  const [editingRound, setEditingRound] = useState<Round | null>(null);
  const [addingRound, setAddingRound] = useState(false);

  return (
    <article
      className={cn(
        "rounded-2xl border bg-white p-4 shadow-sm",
        process.needsUpdate ? "border-red-300" : "border-slate-200",
        pending && "opacity-70",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${config.color}22`, color: config.color }}
        >
          <Icon className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-slate-900">
            {process.companyName} · {process.jobTitle}
          </h3>
          <p className="mt-0.5 text-sm text-slate-500">
            {countryFlag(process.profile.country)} {process.profile.code}.
            {process.profile.displayName} · {process.roundCount} rounds
            {process.nextRoundAt
              ? ` · Next: ${formatInTimeZone(new Date(process.nextRoundAt), DEFAULT_TIMEZONE, "MMM d, h:mm a")}`
              : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {process.jobUrl ? (
              <a
                href={process.jobUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 font-medium text-slate-700 hover:bg-slate-200"
              >
                <ExternalLink className="size-3" /> Job link
              </a>
            ) : null}
            {process.resumeFileUrl ? (
              <a
                href={process.resumeFileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 font-medium text-slate-700 hover:bg-slate-200"
              >
                <FileText className="size-3" /> Resume
              </a>
            ) : null}
          </div>
          {process.jobDescription ? (
            <details className="mt-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-slate-600">
                Job description
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-xs text-slate-600">
                {process.jobDescription}
              </p>
            </details>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {process.daysUntil != null && process.daysUntil >= 0 ? (
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              in {process.daysUntil} day{process.daysUntil === 1 ? "" : "s"}
            </span>
          ) : null}

          <select
            value={process.status}
            onChange={(e) => {
              const status = e.target.value as ProcessStatus;
              startTransition(async () => {
                await updateProcessStatus({ processId: process.id, status });
              });
            }}
            className="h-8 rounded-full border border-slate-200 px-3 text-xs font-semibold"
            style={{ color: config.color }}
          >
            {Object.values(STATUS_CONFIG).map((s) => (
              <option key={s.status} value={s.status}>
                {s.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            title="Delete process"
            className="inline-flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
            onClick={() => {
              if (!confirm(`Delete ${process.companyName} process?`)) return;
              startTransition(async () => {
                await deleteProcess(process.id);
              });
            }}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note === (process.note ?? "")) return;
          startTransition(async () => {
            await updateProcessNote({ processId: process.id, note });
          });
        }}
        placeholder="Add a note…"
        className="mt-3 h-9 w-full rounded-xl border border-slate-100 bg-slate-50 px-3 text-sm outline-none focus:border-slate-200 focus:bg-white"
      />

      <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
        {process.rounds.map((round) => {
          const type = ROUND_TYPE_CONFIG[round.type];
          const outcome = ROUND_OUTCOME_CONFIG[round.outcome];
          const TypeIcon = type.icon;
          const OutcomeIcon = outcome.icon;
          return (
            <button
              key={round.id}
              type="button"
              onClick={() => setEditingRound(round)}
              className="w-56 shrink-0 rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-left transition hover:border-slate-300 hover:bg-white"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">
                  {round.roundNumber}
                </span>
                <OutcomeIcon className="size-4" style={{ color: outcome.color }} />
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                <TypeIcon className="size-3.5" style={{ color: type.color }} />
                {type.label}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {formatInTimeZone(
                  new Date(round.startAt),
                  DEFAULT_TIMEZONE,
                  "MMM d · h:mm a",
                )}
                {" – "}
                {formatInTimeZone(
                  new Date(round.endAt),
                  DEFAULT_TIMEZONE,
                  "h:mm a",
                )}
              </p>
              <p className="mt-1 truncate text-xs text-slate-600">
                Ours: {round.interviewerName}
              </p>
              {round.clientInterviewerName ? (
                <p
                  className="mt-0.5 truncate text-xs text-slate-500"
                  title={round.clientInterviewerAbout ?? undefined}
                >
                  Client: {round.clientInterviewerName}
                </p>
              ) : null}
              <div className="mt-2 flex gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    className={cn(
                      "size-3.5",
                      round.rating && n <= round.rating
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300",
                    )}
                  />
                ))}
              </div>
              {round.feedback ? (
                <p className="mt-2 line-clamp-2 text-xs text-slate-500">
                  {round.feedback}
                </p>
              ) : null}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setAddingRound(true)}
          className="flex w-40 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-sm text-slate-500 transition hover:border-blue-300 hover:text-blue-600"
        >
          + Add round
        </button>
      </div>

      {editingRound ? (
        <RoundEditDialog
          round={editingRound}
          onClose={() => setEditingRound(null)}
          onSave={(data) => {
            startTransition(async () => {
              await updateRound(data);
              setEditingRound(null);
            });
          }}
        />
      ) : null}

      {addingRound ? (
        <AddRoundDialog
          processId={process.id}
          isAdmin={isAdmin}
          onClose={() => setAddingRound(false)}
          onSaved={() => setAddingRound(false)}
        />
      ) : null}
    </article>
  );
}

function AddRoundDialog({
  processId,
  isAdmin,
  onClose,
  onSaved,
}: {
  processId: string;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<RoundType>("TECH");
  const [duration, setDuration] = useState<BookingDuration>(60);
  const [localStart, setLocalStart] = useState("");
  const [interviewerName, setInterviewerName] = useState("");
  const [clientInterviewerName, setClientInterviewerName] = useState("");
  const [clientInterviewerAbout, setClientInterviewerAbout] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [overrideAvailability, setOverrideAvailability] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <h4 className="text-lg font-semibold text-slate-900">Add round</h4>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Type</span>
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
              Start (local)
            </span>
            <input
              type="datetime-local"
              value={localStart}
              onChange={(e) => setLocalStart(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Duration</span>
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
              Our interviewer
            </span>
            <input
              value={interviewerName}
              onChange={(e) => setInterviewerName(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              required
            />
          </label>
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
              Meeting link
            </span>
            <input
              value={meetingLink}
              onChange={(e) => setMeetingLink(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
              placeholder="https://…"
            />
          </label>
          {isAdmin ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={overrideAvailability}
                onChange={(e) => setOverrideAvailability(e.target.checked)}
              />
              Override availability
            </label>
          ) : null}
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
            disabled={pending}
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => {
              setError(null);
              if (!localStart || !interviewerName.trim()) {
                setError("Start time and our interviewer are required");
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
              startTransition(async () => {
                const result = await addRoundToProcess({
                  processId,
                  startAt: new Date(localStart).toISOString(),
                  durationMinutes: duration,
                  type,
                  interviewerName: interviewerName.trim(),
                  clientInterviewerName: clientInterviewerName.trim(),
                  clientInterviewerAbout: clientInterviewerAbout.trim(),
                  meetingLink: meetingLink.trim(),
                  overrideAvailability,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onSaved();
              });
            }}
          >
            {pending ? "Saving…" : "Add round"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoundEditDialog({
  round,
  onClose,
  onSave,
}: {
  round: Round;
  onClose: () => void;
  onSave: (data: {
    roundId: string;
    outcome: RoundOutcome;
    rating: number | null;
    feedback: string | null;
  }) => void;
}) {
  const [outcome, setOutcome] = useState(round.outcome);
  const [rating, setRating] = useState<number | null>(round.rating);
  const [feedback, setFeedback] = useState(round.feedback ?? "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h4 className="text-lg font-semibold text-slate-900">
          Edit round {round.roundNumber}
        </h4>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Outcome</span>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as RoundOutcome)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3"
            >
              {Object.entries(ROUND_OUTCOME_CONFIG).map(([key, val]) => (
                <option key={key} value={key}>
                  {val.label}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Rating
            </span>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(rating === n ? null : n)}
                >
                  <Star
                    className={cn(
                      "size-6",
                      rating && n <= rating
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300",
                    )}
                  />
                </button>
              ))}
            </div>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Feedback
            </span>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={4}
              className="w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
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
            onClick={() =>
              onSave({
                roundId: round.id,
                outcome,
                rating,
                feedback: feedback || null,
              })
            }
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
