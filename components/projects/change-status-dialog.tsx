"use client";

import { useMemo, useState, useTransition } from "react";
import { changeProjectStatus } from "@/app/actions/projects";
import { STATUSES_REQUIRING_COMMENT } from "@/lib/projects/status";

type Status = {
  id: string;
  key: string;
  name: string;
  color: string;
};

export function ChangeStatusDialog({
  projectId,
  currentStatusId,
  statuses,
  transitions,
  open,
  onClose,
  onDone,
  forcedToStatusId,
}: {
  projectId: string;
  currentStatusId: string;
  statuses: Status[];
  transitions: { fromStatusId: string; toStatusId: string }[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** When set (e.g. Kanban drop), lock the target status. */
  forcedToStatusId?: string;
}) {
  const allowed = useMemo(() => {
    const ids = new Set(
      transitions
        .filter((t) => t.fromStatusId === currentStatusId)
        .map((t) => t.toStatusId),
    );
    const list = statuses.filter((s) => ids.has(s.id));
    if (forcedToStatusId) {
      return list.filter((s) => s.id === forcedToStatusId);
    }
    return list;
  }, [transitions, currentStatusId, statuses, forcedToStatusId]);

  const [toStatusId, setToStatusId] = useState(
    forcedToStatusId || allowed[0]?.id || "",
  );
  const [comment, setComment] = useState("");
  const [actualEndDate, setActualEndDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) return null;

  const selected = statuses.find((s) => s.id === toStatusId);
  const needsComment =
    selected &&
    STATUSES_REQUIRING_COMMENT.has(
      selected.key as "ON_HOLD" | "CANCELLED",
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await changeProjectStatus({
              projectId,
              toStatusId,
              comment,
              actualEndDate:
                selected?.key === "COMPLETED" ? actualEndDate : "",
            });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            onDone();
            onClose();
          });
        }}
      >
        <h3 className="text-lg font-semibold text-slate-900">Change status</h3>
        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {allowed.length === 0 ? (
          <p className="text-sm text-slate-500">No transitions available.</p>
        ) : (
          <>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                New status
              </span>
              <select
                value={toStatusId}
                onChange={(e) => setToStatusId(e.target.value)}
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              >
                {allowed.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {selected?.key === "COMPLETED" ? (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  Actual end date
                </span>
                <input
                  type="date"
                  value={actualEndDate}
                  onChange={(e) => setActualEndDate(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                />
              </label>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                Comment{needsComment ? " (required)" : " (optional)"}
              </span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                required={!!needsComment}
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
          </>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || allowed.length === 0}
            className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Saving…" : "Update status"}
          </button>
        </div>
      </form>
    </div>
  );
}
