"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/utils";

const RANGES = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "1y", label: "1y" },
] as const;

type Option = { id: string; label: string };

export function InterviewToolbar({
  profiles,
  members,
}: {
  profiles: Option[];
  members: Option[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const range = searchParams.get("range") || "all";
  const sort = searchParams.get("sort") || "desc";

  function update(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) params.delete(k);
      else params.set(k, v);
    }
    startTransition(() => {
      router.push(`/interviews?${params.toString()}`);
    });
  }

  return (
    <div className={cn("space-y-3", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => update({ range: r.id === "all" ? null : r.id })}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                range === r.id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        <input
          type="search"
          placeholder="Search company, job, profile…"
          defaultValue={searchParams.get("q") ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              update({ q: (e.target as HTMLInputElement).value || null });
            }
          }}
          className="h-9 min-w-[220px] flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none ring-blue-600/20 focus:ring-2"
        />

        <select
          value={sort}
          onChange={(e) => update({ sort: e.target.value })}
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="desc">Date desc</option>
          <option value="asc">Date asc</option>
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={searchParams.get("profileId") ?? ""}
          onChange={(e) => update({ profileId: e.target.value || null })}
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All profiles</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={searchParams.get("memberId") ?? ""}
          onChange={(e) => update({ memberId: e.target.value || null })}
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All members</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={searchParams.get("roundType") ?? ""}
          onChange={(e) => update({ roundType: e.target.value || null })}
          className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All round types</option>
          <option value="HR_RECRUITER">Recruiter</option>
          <option value="TECH">Technical</option>
          <option value="ASSESSMENT">Assessment</option>
          <option value="SYSTEM_DESIGN">System design</option>
          <option value="BEHAVIORAL">Behavioral</option>
          <option value="FINAL">Final</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
    </div>
  );
}
