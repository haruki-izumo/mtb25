"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { STATUS_GROUPS, type StatusGroupId } from "@/lib/status";
import { cn } from "@/lib/utils";

export function StatusSidebar({
  counts,
}: {
  counts: Record<StatusGroupId, number>;
}) {
  const searchParams = useSearchParams();
  const active = (searchParams.get("group") as StatusGroupId) || "ALL";

  function hrefFor(group: StatusGroupId) {
    const params = new URLSearchParams(searchParams.toString());
    if (group === "ALL") params.delete("group");
    else params.set("group", group);
    const q = params.toString();
    return q ? `/interviews?${q}` : "/interviews";
  }

  return (
    <div className="space-y-1">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Interviews</h2>
      {STATUS_GROUPS.map((group) => {
        const isActive = active === group.id;
        const isNeeds = group.id === "NEEDS_UPDATE";
        const isDone = group.id === "DONE";
        return (
          <Link
            key={group.id}
            href={hrefFor(group.id)}
            className={cn(
              "flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition",
              isActive
                ? "bg-white font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                : "text-slate-600 hover:bg-white/70",
              isNeeds && "border border-red-200",
              isNeeds && isActive && "border-red-400 ring-red-200",
              isDone && "border border-emerald-200",
              isDone && isActive && "border-emerald-400 ring-emerald-200",
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: group.color ?? "#94a3b8" }}
              />
              {group.label}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-semibold",
                isNeeds
                  ? "bg-red-50 text-red-600"
                  : isDone
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-600",
              )}
            >
              {counts[group.id]}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
