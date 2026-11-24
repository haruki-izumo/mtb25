"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, FileText } from "lucide-react";
import type { ApplicationStatus } from "@prisma/client";
import { updateApplicationStatus } from "@/app/actions/applications";
import {
  APPLICATION_STATUSES,
  applicationStatusStyle,
} from "@/lib/applications";
import { countryFlag } from "@/lib/timezone";
import { cn } from "@/lib/utils";

type ProfileOption = {
  id: string;
  code: string;
  displayName: string;
  country: string;
  applicationCount: number;
};

type ApplicationRow = {
  id: string;
  company: string;
  jobTitle: string;
  url: string | null;
  status: ApplicationStatus;
  mode: string | null;
  resumeTemplate: string | null;
  resumePdfUrl: string | null;
  coverPdfUrl: string | null;
  whenLabel: string;
  profile: {
    id: string;
    code: string;
    displayName: string;
    country: string;
  };
  ownerName: string | null;
};

export function ApplicationsView({
  applications,
  totalCount,
  truncated,
  readOnly,
}: {
  applications: ApplicationRow[];
  totalCount: number;
  truncated: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function push(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `/applications?${query}` : "/applications");
    });
  }

  function run(
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const range = searchParams.get("range") || "all";

  return (
    <div className={cn("space-y-4", pending && "opacity-70")}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Applications</h1>
          <p className="text-sm text-slate-500">
            {totalCount} from the resume extension
          </p>
        </div>
        <input
          type="search"
          placeholder="Search company or role…"
          defaultValue={searchParams.get("q") ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              push({ q: (e.target as HTMLInputElement).value || null });
            }
          }}
          className="h-9 min-w-[220px] rounded-xl border border-slate-200 bg-white px-3 text-sm"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          {(
            [
              ["all", "All time"],
              ["today", "Today"],
              ["week", "This week"],
              ["month", "This month"],
              ["custom", "Custom"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                push({
                  range: id === "all" ? null : id,
                  ...(id === "custom"
                    ? {}
                    : { from: null, to: null }),
                })
              }
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                range === id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {range === "custom" ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              From
              <input
                type="date"
                value={searchParams.get("from") ?? ""}
                onChange={(e) =>
                  push({
                    range: "custom",
                    from: e.target.value || null,
                  })
                }
                className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-sm text-slate-800"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              To
              <input
                type="date"
                value={searchParams.get("to") ?? ""}
                onChange={(e) =>
                  push({
                    range: "custom",
                    to: e.target.value || null,
                  })
                }
                className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-sm text-slate-800"
              />
            </label>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {truncated ? (
        <p className="text-xs text-slate-500">
          Showing the latest 500. Filter by profile or search to narrow the list.
        </p>
      ) : null}

      {applications.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">
          No applications match these filters. Generations from the resume
          extension show up here for each profile.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Profile</th>
                <th className="px-4 py-3">Company / role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Files</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((row) => {
                const style = applicationStatusStyle(row.status);
                return (
                  <tr key={row.id} className="border-t border-slate-100 align-top">
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                      <p>{row.whenLabel}</p>
                      {row.ownerName ? (
                        <p className="mt-1 text-xs text-slate-400">
                          {row.ownerName}
                        </p>
                      ) : null}
                      {row.mode ? (
                        <p className="mt-1 text-xs uppercase text-slate-400">
                          {row.mode}
                          {row.resumeTemplate ? ` · ${row.resumeTemplate}` : ""}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-800">
                      {countryFlag(row.profile.country)} {row.profile.code}.
                      {row.profile.displayName}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{row.company}</p>
                      <p className="text-slate-600">{row.jobTitle}</p>
                      {row.url ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                        >
                          <ExternalLink className="size-3" />
                          Job link
                        </a>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {readOnly ? (
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                            style.className,
                          )}
                        >
                          {style.label}
                        </span>
                      ) : (
                        <select
                          value={row.status}
                          disabled={pending}
                          onChange={(e) => {
                            const status = e.target.value as ApplicationStatus;
                            run(() =>
                              updateApplicationStatus({
                                applicationId: row.id,
                                status,
                              }),
                            );
                          }}
                          className={cn(
                            "h-8 rounded-full border border-slate-200 px-2 text-xs font-semibold",
                            style.className,
                          )}
                        >
                          {APPLICATION_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {applicationStatusStyle(status).label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        {row.resumePdfUrl ? (
                          <a
                            href={row.resumePdfUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                          >
                            <FileText className="size-3" />
                            Resume
                          </a>
                        ) : null}
                        {row.coverPdfUrl ? (
                          <a
                            href={row.coverPdfUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                          >
                            <FileText className="size-3" />
                            Cover letter
                          </a>
                        ) : null}
                        {!row.resumePdfUrl && !row.coverPdfUrl ? (
                          <span className="text-xs text-slate-400">None</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ApplicationsSidebar({
  profiles,
  selectedId,
}: {
  profiles: ProfileOption[];
  selectedId: string | null;
}) {
  const searchParams = useSearchParams();

  function href(profileId: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (profileId) params.set("profileId", profileId);
    else params.delete("profileId");
    const query = params.toString();
    return query ? `/applications?${query}` : "/applications";
  }

  const allCount = profiles.reduce(
    (sum, profile) => sum + profile.applicationCount,
    0,
  );
  const items = [
    { id: null as string | null, label: "All profiles", count: allCount },
    ...profiles.map((profile) => ({
      id: profile.id,
      label: `${countryFlag(profile.country)} ${profile.code}.${profile.displayName}`,
      count: profile.applicationCount,
    })),
  ];

  return (
    <div className="space-y-1">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">Profiles</h2>
      <p className="mb-3 text-xs text-slate-500">
        Applications created by the resume extension.
      </p>
      {items.map((item) => {
        const active = item.id === selectedId;
        return (
          <Link
            key={item.id ?? "all"}
            href={href(item.id)}
            className={cn(
              "flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition",
              active
                ? "bg-white font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                : "text-slate-600 hover:bg-white/70",
            )}
          >
            <span className="truncate">{item.label}</span>
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
              {item.count}
            </span>
          </Link>
        );
      })}
      {profiles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
          No profiles assigned to you
        </p>
      ) : null}
    </div>
  );
}
