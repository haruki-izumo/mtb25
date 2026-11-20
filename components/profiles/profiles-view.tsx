"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Copy, LayoutGrid, List, Star } from "lucide-react";
import { toggleProfileStar } from "@/app/actions/profiles";
import { countryFlag } from "@/lib/timezone";
import { cn } from "@/lib/utils";

type ProfileRow = {
  id: string;
  code: string;
  displayName: string;
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  zipCode: string | null;
  country: string;
  timezone: string;
  linkedinUrl: string | null;
  githubUrl: string | null;
  resumeFileUrl: string | null;
  starred: boolean;
  processCount: number;
  experienceCount: number;
};

type Detail = {
  id: string;
  code: string;
  displayName: string;
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  zipCode: string | null;
  country: string;
  timezone: string;
  linkedinUrl: string | null;
  githubUrl: string | null;
  resumeFileUrl: string | null;
  starred: boolean;
  experiences: {
    id: string;
    company: string;
    role: string;
    location: string | null;
    startDate: string;
    endDate: string | null;
  }[];
  assignedMembers: { id: string; name: string; avatarColor: string }[];
  processes: {
    id: string;
    companyName: string;
    jobTitle: string;
    status: string;
    updatedAt: string;
    roundCount: number;
  }[];
} | null;

function CopyField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {label}
        </p>
        <p className="truncate text-sm text-slate-800">{value}</p>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
        onClick={() => navigator.clipboard.writeText(value)}
        title="Copy"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

export function ProfilesView({
  profiles,
  counts,
  selected,
  detail,
}: {
  profiles: ProfileRow[];
  counts: { all: number; starred: number; byCountry: Record<string, number> };
  selected: string | null;
  detail: Detail;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const filter = searchParams.get("filter") || "all";
  const view = searchParams.get("view") || "list";
  const tab = searchParams.get("tab") || "profile";

  function push(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    startTransition(() => router.push(`/profiles?${params.toString()}`));
  }

  return (
    <div className={cn("flex gap-4", pending && "opacity-80")}>
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Search profiles…"
            defaultValue={searchParams.get("q") ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                push({ q: (e.target as HTMLInputElement).value || null });
              }
            }}
            className="h-9 min-w-[200px] flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm"
          />
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => push({ view: "list" })}
              className={cn(
                "rounded-lg p-1.5",
                view === "list" ? "bg-white shadow-sm" : "text-slate-400",
              )}
            >
              <List className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => push({ view: "grid" })}
              className={cn(
                "rounded-lg p-1.5",
                view === "grid" ? "bg-white shadow-sm" : "text-slate-400",
              )}
            >
              <LayoutGrid className="size-4" />
            </button>
          </div>
        </div>

        {profiles.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
            No profiles found.
          </div>
        ) : view === "grid" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {profiles.map((p) => (
              <Link
                key={p.id}
                href={`/profiles?${new URLSearchParams({
                  ...Object.fromEntries(searchParams.entries()),
                  id: p.id,
                }).toString()}`}
                className={cn(
                  "rounded-2xl border bg-white p-4 shadow-sm transition hover:border-slate-300",
                  selected === p.id ? "border-blue-400 ring-2 ring-blue-100" : "border-slate-200",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">
                      {countryFlag(p.country)} {p.fullName}
                    </p>
                    <p className="text-xs text-slate-500">{p.code}</p>
                  </div>
                  <Star
                    className={cn(
                      "size-4",
                      p.starred
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300",
                    )}
                  />
                </div>
                <p className="mt-2 truncate text-sm text-slate-600">{p.email}</p>
              </Link>
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3 text-center">Star</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr
                    key={p.id}
                    className={cn(
                      "cursor-pointer border-t border-slate-100 hover:bg-slate-50",
                      selected === p.id && "bg-blue-50/60",
                    )}
                    onClick={() => push({ id: p.id })}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {countryFlag(p.country)} {p.fullName}
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        {p.code}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{p.email}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startTransition(async () => {
                            await toggleProfileStar(p.id);
                          });
                        }}
                      >
                        <Star
                          className={cn(
                            "inline size-4",
                            p.starred
                              ? "fill-amber-400 text-amber-400"
                              : "text-slate-300",
                          )}
                        />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <aside className="hidden w-[360px] shrink-0 xl:block">
        {!detail ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            Select a profile to view details
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    {countryFlag(detail.country)} {detail.fullName}
                  </h2>
                  <p className="text-sm text-slate-500">{detail.code}</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await toggleProfileStar(detail.id);
                    })
                  }
                >
                  <Star
                    className={cn(
                      "size-5",
                      detail.starred
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300",
                    )}
                  />
                </button>
              </div>
              <div className="mt-3 flex gap-1 rounded-xl bg-slate-100 p-1">
                {["profile", "settings", "resume", "history"].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => push({ tab: t })}
                    className={cn(
                      "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium capitalize",
                      tab === t
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
              {tab === "profile" ? (
                <>
                  <CopyField label="Email" value={detail.email} />
                  <CopyField label="Phone" value={detail.phone} />
                  <CopyField label="Location" value={detail.location} />
                  <CopyField label="Zip" value={detail.zipCode} />
                  <CopyField label="Timezone" value={detail.timezone} />
                  <CopyField label="LinkedIn" value={detail.linkedinUrl} />
                  <CopyField label="GitHub" value={detail.githubUrl} />
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Experience
                    </p>
                    <ul className="space-y-2">
                      {detail.experiences.map((e) => (
                        <li
                          key={e.id}
                          className="rounded-xl border border-slate-100 px-3 py-2"
                        >
                          <p className="text-sm font-semibold text-slate-900">
                            {e.role}
                          </p>
                          <p className="text-xs text-slate-500">
                            {e.company}
                            {e.location ? ` · ${e.location}` : ""}
                          </p>
                          <p className="text-xs text-slate-400">
                            {new Date(e.startDate).getFullYear()} –{" "}
                            {e.endDate
                              ? new Date(e.endDate).getFullYear()
                              : "Present"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : null}

              {tab === "settings" ? (
                <div className="space-y-2 text-sm text-slate-600">
                  <p>
                    Assigned members:{" "}
                    {detail.assignedMembers.map((m) => m.name).join(", ") ||
                      "None"}
                  </p>
                  <p>Country: {detail.country}</p>
                  <p>Timezone: {detail.timezone}</p>
                </div>
              ) : null}

              {tab === "resume" ? (
                <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                  {detail.resumeFileUrl ? (
                    <a
                      href={detail.resumeFileUrl}
                      className="text-blue-600 underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open resume
                    </a>
                  ) : (
                    "No resume uploaded yet"
                  )}
                </div>
              ) : null}

              {tab === "history" ? (
                <ul className="space-y-2">
                  {detail.processes.length === 0 ? (
                    <li className="text-sm text-slate-500">No processes yet</li>
                  ) : (
                    detail.processes.map((p) => (
                      <li
                        key={p.id}
                        className="rounded-xl border border-slate-100 px-3 py-2"
                      >
                        <p className="text-sm font-semibold text-slate-900">
                          {p.companyName} · {p.jobTitle}
                        </p>
                        <p className="text-xs text-slate-500">
                          {p.status} · {p.roundCount} rounds
                        </p>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </div>
          </div>
        )}
      </aside>

      {/* keep counts used for sidebar parent - filter chips live in page sidebar */}
      <span className="hidden">{filter}{counts.all}</span>
    </div>
  );
}
