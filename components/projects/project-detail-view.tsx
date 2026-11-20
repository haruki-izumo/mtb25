"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import {
  archiveProject,
  uploadProjectAttachment,
} from "@/app/actions/projects";
import { ChangeStatusDialog } from "@/components/projects/change-status-dialog";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { formatDateKey, formatMoney } from "@/lib/projects/format";
import { PROJECT_PRIORITIES } from "@/lib/projects/status";
import { countryFlag } from "@/lib/timezone";

type Detail = {
  id: string;
  projectCode: string;
  projectName: string;
  country: string;
  city: string | null;
  industry: string | null;
  description: string;
  scopeOfWork: string | null;
  budget: number;
  currency: string;
  contractValue: number | null;
  paymentTerms: string | null;
  dateSecured: string;
  startDate: string | null;
  expectedEndDate: string | null;
  actualEndDate: string | null;
  priority: string;
  progressPercent: number;
  tags: string[];
  notes: string | null;
  archivedAt: string | null;
  client: {
    id: string;
    name: string;
    country: string;
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
  };
  projectType: { id: string; name: string } | null;
  status: {
    id: string;
    key: string;
    name: string;
    color: string;
    isFinal: boolean;
  };
  projectManager: { id: string; name: string; email: string };
  teamMembers: { id: string; name: string; email: string }[];
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  attachments: {
    id: string;
    fileName: string;
    url: string;
    createdAt: string;
    uploadedBy: { id: string; name: string };
  }[];
  statusHistory: {
    id: string;
    changedAt: string;
    comment: string | null;
    fromStatus: { name: string; color: string } | null;
    toStatus: { name: string; color: string };
    changedBy: { id: string; name: string };
  }[];
  activities: {
    id: string;
    type: string;
    message: string;
    createdAt: string;
    user: { id: string; name: string };
  }[];
};

export function ProjectDetailView({
  project,
  statuses,
  transitions,
}: {
  project: Detail;
  statuses: {
    id: string;
    key: string;
    name: string;
    color: string;
    isFinal: boolean;
  }[];
  transitions: { fromStatusId: string; toStatusId: string }[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const priority =
    PROJECT_PRIORITIES.find((p) => p.value === project.priority)?.label ||
    project.priority;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/projects"
              className="text-sm text-slate-500 hover:text-slate-800"
            >
              Projects
            </Link>
            <span className="text-slate-300">/</span>
            <span className="font-mono text-sm text-slate-500">
              {project.projectCode}
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            {project.projectName}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ProjectStatusBadge
              name={project.status.name}
              color={project.status.color}
            />
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              {priority}
            </span>
            {project.archivedAt ? (
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                Archived
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!project.status.isFinal && !project.archivedAt ? (
            <button
              type="button"
              onClick={() => setStatusOpen(true)}
              className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Change status
            </button>
          ) : null}
          {!project.archivedAt ? (
            <Link
              href={`/projects/${project.id}/edit`}
              className="inline-flex h-9 items-center rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
            >
              Edit
            </Link>
          ) : null}
          {!project.archivedAt ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!confirm("Archive this project?")) return;
                setError(null);
                startTransition(async () => {
                  const result = await archiveProject(project.id);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  router.push("/projects");
                  router.refresh();
                });
              }}
              className="h-9 rounded-xl px-3 text-sm font-medium text-slate-500 hover:bg-slate-100"
            >
              Archive
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <Card title="Overview">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Item label="Client">
                {countryFlag(project.client.country)} {project.client.name}
              </Item>
              <Item label="Location">
                {countryFlag(project.country)} {project.country}
                {project.city ? ` · ${project.city}` : ""}
              </Item>
              <Item label="Type">{project.projectType?.name || "—"}</Item>
              <Item label="Industry">{project.industry || "—"}</Item>
              <Item label="Budget">
                {formatMoney(project.budget, project.currency)}
              </Item>
              <Item label="Contract value">
                {project.contractValue != null
                  ? formatMoney(project.contractValue, project.currency)
                  : "—"}
              </Item>
              <Item label="Payment terms">
                {project.paymentTerms || "—"}
              </Item>
              <Item label="Progress">{project.progressPercent}%</Item>
            </dl>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-blue-600"
                style={{ width: `${project.progressPercent}%` }}
              />
            </div>
          </Card>

          <Card title="Description">
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {project.description}
            </p>
            {project.scopeOfWork ? (
              <>
                <h3 className="mt-4 text-sm font-semibold text-slate-900">
                  Scope of work
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {project.scopeOfWork}
                </p>
              </>
            ) : null}
            {project.tags.length ? (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {project.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
            {project.notes ? (
              <>
                <h3 className="mt-4 text-sm font-semibold text-slate-900">
                  Internal notes
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
                  {project.notes}
                </p>
              </>
            ) : null}
          </Card>

          <Card title="Timeline">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Item label="Date secured">
                {formatDateKey(project.dateSecured)}
              </Item>
              <Item label="Start">{formatDateKey(project.startDate)}</Item>
              <Item label="Expected end">
                {formatDateKey(project.expectedEndDate)}
              </Item>
              <Item label="Actual end">
                {formatDateKey(project.actualEndDate)}
              </Item>
            </dl>
          </Card>

          <Card
            title="Attachments"
            action={
              !project.archivedAt ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setError(null);
                      const fd = new FormData();
                      fd.set("projectId", project.id);
                      fd.set("file", file);
                      startTransition(async () => {
                        const result = await uploadProjectAttachment(fd);
                        if (!result.ok) {
                          setError(result.error);
                          return;
                        }
                        router.refresh();
                      });
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => fileRef.current?.click()}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700"
                  >
                    Upload
                  </button>
                </>
              ) : null
            }
          >
            {project.attachments.length === 0 ? (
              <p className="text-sm text-slate-500">No attachments yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {project.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {a.fileName}
                    </a>
                    <span className="shrink-0 text-xs text-slate-400">
                      {a.uploadedBy.name} · {formatDateKey(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Team">
            <Item label="Project manager">{project.projectManager.name}</Item>
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Members
              </p>
              {project.teamMembers.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500">None assigned</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {project.teamMembers.map((m) => (
                    <li key={m.id} className="text-sm text-slate-700">
                      {m.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card title="Client contact">
            <dl className="space-y-2">
              <Item label="Contact">
                {project.client.contactPerson || "—"}
              </Item>
              <Item label="Email">{project.client.email || "—"}</Item>
              <Item label="Phone">{project.client.phone || "—"}</Item>
            </dl>
          </Card>

          <Card title="Status history">
            {project.statusHistory.length === 0 ? (
              <p className="text-sm text-slate-500">No history yet.</p>
            ) : (
              <ol className="space-y-3">
                {project.statusHistory.map((h) => (
                  <li key={h.id} className="relative pl-4 text-sm">
                    <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-slate-300" />
                    <p className="font-medium text-slate-800">
                      {h.fromStatus ? `${h.fromStatus.name} → ` : ""}
                      {h.toStatus.name}
                    </p>
                    {h.comment ? (
                      <p className="mt-0.5 text-slate-600">{h.comment}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-slate-400">
                      {h.changedBy.name} · {formatDateKey(h.changedAt)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Activity">
            {project.activities.length === 0 ? (
              <p className="text-sm text-slate-500">No activity yet.</p>
            ) : (
              <ul className="space-y-2">
                {project.activities.map((a) => (
                  <li key={a.id} className="text-sm">
                    <p className="text-slate-800">{a.message}</p>
                    <p className="text-xs text-slate-400">
                      {a.user.name} · {formatDateKey(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-xs text-slate-400">
            Created by {project.createdBy.name} ·{" "}
            {formatDateKey(project.createdAt)}
            {project.updatedBy
              ? ` · Updated by ${project.updatedBy.name}`
              : ""}
          </p>
        </div>
      </div>

      {statusOpen ? (
        <ChangeStatusDialog
          open
          projectId={project.id}
          currentStatusId={project.status.id}
          statuses={statuses}
          transitions={transitions}
          onClose={() => setStatusOpen(false)}
          onDone={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Item({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-slate-800">{children}</dd>
    </div>
  );
}
