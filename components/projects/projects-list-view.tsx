"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Download, LayoutGrid, List, Plus } from "lucide-react";
import { ChangeStatusDialog } from "@/components/projects/change-status-dialog";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { formatDateKey, formatMoney } from "@/lib/projects/format";
import { PROJECT_PRIORITIES } from "@/lib/projects/status";
import { countryFlag } from "@/lib/timezone";
import { cn } from "@/lib/utils";

type ProjectRow = {
  id: string;
  projectCode: string;
  projectName: string;
  clientName: string;
  country: string;
  budget: number;
  currency: string;
  priority: string;
  progressPercent: number;
  startDate: string | null;
  expectedEndDate: string | null;
  updatedAt: string;
  status: {
    id: string;
    key: string;
    name: string;
    color: string;
    isFinal: boolean;
  };
  projectManager: { id: string; name: string };
};

type Status = {
  id: string;
  key: string;
  name: string;
  color: string;
  isFinal: boolean;
  sortOrder: number;
};

export function ProjectsListView({
  projects,
  total,
  page,
  pageSize,
  statuses,
  transitions,
  users,
  summary,
}: {
  projects: ProjectRow[];
  total: number;
  page: number;
  pageSize: number;
  statuses: Status[];
  transitions: { fromStatusId: string; toStatusId: string }[];
  users: { id: string; name: string }[];
  summary: {
    activeCount: number;
    overdueCount: number;
    pipelineByCurrency: { currency: string; total: number }[];
    perStatus: { statusId: string; name: string; color: string; count: number }[];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const view = (searchParams.get("view") as "table" | "kanban") || "table";
  const [statusTarget, setStatusTarget] = useState<{
    projectId: string;
    statusId: string;
  } | null>(null);

  function push(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    startTransition(() => router.push(`/projects?${params.toString()}`));
  }

  const selectedStatuses = useMemo(
    () => (searchParams.get("status") || "").split(",").filter(Boolean),
    [searchParams],
  );

  function exportCsv() {
    const header = [
      "Code",
      "Name",
      "Client",
      "Country",
      "Budget",
      "Currency",
      "Status",
      "Priority",
      "Manager",
      "Start",
      "Expected End",
      "Progress",
      "Updated",
    ];
    const lines = projects.map((p) =>
      [
        p.projectCode,
        p.projectName,
        p.clientName,
        p.country,
        p.budget,
        p.currency,
        p.status.name,
        p.priority,
        p.projectManager.name,
        p.startDate ?? "",
        p.expectedEndDate ?? "",
        p.progressPercent,
        p.updatedAt,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "projects.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className={cn("space-y-4", pending && "opacity-80")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Projects</h1>
          <p className="text-sm text-slate-500">
            {total} project{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="size-4" />
            Export CSV
          </button>
          <Link
            href="/projects/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="size-4" />
            New Project
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Active projects" value={String(summary.activeCount)} />
        <SummaryCard
          label="Pipeline value"
          value={
            summary.pipelineByCurrency.length
              ? summary.pipelineByCurrency
                  .map((g) => formatMoney(g.total, g.currency))
                  .join(" · ")
              : "—"
          }
        />
        <SummaryCard
          label="By status"
          value={`${summary.perStatus.filter((s) => s.count > 0).length} statuses`}
        />
        <SummaryCard
          label="Overdue"
          value={String(summary.overdueCount)}
          tone={summary.overdueCount > 0 ? "text-red-600" : undefined}
        />
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="min-w-[180px] flex-1 text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Search
          </span>
          <input
            type="search"
            defaultValue={searchParams.get("q") ?? ""}
            placeholder="Name, code, client…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                push({ q: (e.target as HTMLInputElement).value || null, page: "1" });
              }
            }}
            className="h-9 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Manager
          </span>
          <select
            value={searchParams.get("pm") ?? ""}
            onChange={(e) => push({ pm: e.target.value || null, page: "1" })}
            className="h-9 rounded-xl border border-slate-200 px-3 text-sm"
          >
            <option value="">All</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Priority
          </span>
          <select
            value={searchParams.get("priority") ?? ""}
            onChange={(e) =>
              push({ priority: e.target.value || null, page: "1" })
            }
            className="h-9 rounded-xl border border-slate-200 px-3 text-sm"
          >
            <option value="">All</option>
            {PROJECT_PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Country
          </span>
          <input
            defaultValue={searchParams.get("country") ?? ""}
            maxLength={2}
            placeholder="US"
            onBlur={(e) =>
              push({
                country: e.target.value.trim().toUpperCase() || null,
                page: "1",
              })
            }
            className="h-9 w-20 rounded-xl border border-slate-200 px-3 text-sm uppercase"
          />
        </label>
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => push({ view: "table" })}
            className={cn(
              "rounded-lg p-1.5",
              view === "table" ? "bg-white shadow-sm" : "text-slate-400",
            )}
          >
            <List className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => push({ view: "kanban" })}
            className={cn(
              "rounded-lg p-1.5",
              view === "kanban" ? "bg-white shadow-sm" : "text-slate-400",
            )}
          >
            <LayoutGrid className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {statuses.map((s) => {
          const active = selectedStatuses.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                const next = active
                  ? selectedStatuses.filter((id) => id !== s.id)
                  : [...selectedStatuses, s.id];
                push({
                  status: next.length ? next.join(",") : null,
                  page: "1",
                });
              }}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium",
                active ? "text-white" : "bg-slate-100 text-slate-600",
              )}
              style={active ? { backgroundColor: s.color } : undefined}
            >
              {s.name}
            </button>
          );
        })}
      </div>

      {view === "kanban" ? (
        <KanbanBoard
          projects={projects}
          statuses={statuses}
          onDropStatus={(projectId, statusId) => {
            const current = projects.find((p) => p.id === projectId)?.status.id;
            if (!current || current === statusId) return;
            setStatusTarget({ projectId, statusId });
          }}
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-3">Code</th>
                <th className="px-3 py-3">Project</th>
                <th className="px-3 py-3">Client</th>
                <th className="px-3 py-3">Budget</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Priority</th>
                <th className="px-3 py-3">Manager</th>
                <th className="px-3 py-3">Dates</th>
                <th className="px-3 py-3">Progress</th>
              </tr>
            </thead>
            <tbody>
              {projects.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-10 text-center text-slate-500"
                  >
                    No projects match these filters.
                  </td>
                </tr>
              ) : (
                projects.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t border-slate-100 hover:bg-slate-50/80"
                  >
                    <td className="px-3 py-3 font-mono text-xs text-slate-500">
                      <Link
                        href={`/projects/${p.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {p.projectCode}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Link
                        href={`/projects/${p.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {p.projectName}
                      </Link>
                      <p className="text-xs text-slate-400">
                        {countryFlag(p.country)} {p.country}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-slate-700">{p.clientName}</td>
                    <td className="px-3 py-3 tabular-nums">
                      {formatMoney(p.budget, p.currency)}
                    </td>
                    <td className="px-3 py-3">
                      <ProjectStatusBadge
                        name={p.status.name}
                        color={p.status.color}
                      />
                    </td>
                    <td className="px-3 py-3 text-slate-600">{p.priority}</td>
                    <td className="px-3 py-3 text-slate-700">
                      {p.projectManager.name}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">
                      {formatDateKey(p.startDate)} →{" "}
                      {formatDateKey(p.expectedEndDate)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{ width: `${p.progressPercent}%` }}
                          />
                        </div>
                        <span className="text-xs text-slate-500">
                          {p.progressPercent}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === "table" ? (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => push({ page: String(page - 1) })}
              className="h-8 rounded-lg border border-slate-200 px-3 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= pageCount}
              onClick={() => push({ page: String(page + 1) })}
              className="h-8 rounded-lg border border-slate-200 px-3 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {statusTarget ? (
        <ChangeStatusDialog
          open
          projectId={statusTarget.projectId}
          currentStatusId={
            projects.find((p) => p.id === statusTarget.projectId)?.status.id ||
            ""
          }
          statuses={statuses}
          transitions={transitions}
          forcedToStatusId={statusTarget.statusId}
          onClose={() => setStatusTarget(null)}
          onDone={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className={cn("mt-1 text-lg font-semibold text-slate-900", tone)}>
        {value}
      </p>
    </div>
  );
}

function KanbanBoard({
  projects,
  statuses,
  onDropStatus,
}: {
  projects: ProjectRow[];
  statuses: Status[];
  onDropStatus: (projectId: string, statusId: string) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {statuses.map((status) => {
        const cards = projects.filter((p) => p.status.id === status.id);
        return (
          <div
            key={status.id}
            className="w-72 shrink-0 rounded-2xl border border-slate-200 bg-slate-50"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/project-id") || draggingId;
              if (id) onDropStatus(id, status.id);
              setDraggingId(null);
            }}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: status.color }}
                />
                <p className="text-sm font-semibold text-slate-800">
                  {status.name}
                </p>
              </div>
              <span className="text-xs text-slate-500">{cards.length}</span>
            </div>
            <div className="space-y-2 p-2">
              {cards.map((p) => (
                <div
                  key={p.id}
                  draggable
                  onDragStart={(e) => {
                    setDraggingId(p.id);
                    e.dataTransfer.setData("text/project-id", p.id);
                  }}
                  className="cursor-grab rounded-xl border border-slate-200 bg-white p-3 shadow-sm active:cursor-grabbing"
                >
                  <Link
                    href={`/projects/${p.id}`}
                    className="text-sm font-semibold text-slate-900 hover:underline"
                  >
                    {p.projectName}
                  </Link>
                  <p className="mt-1 text-xs text-slate-500">
                    {p.projectCode} · {p.clientName}
                  </p>
                  <p className="mt-2 text-xs font-medium text-slate-700">
                    {formatMoney(p.budget, p.currency)}
                  </p>
                </div>
              ))}
              {cards.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">
                  Drop here
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
