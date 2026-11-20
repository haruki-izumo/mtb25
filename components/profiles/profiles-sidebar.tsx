"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { countryFlag } from "@/lib/timezone";
import { cn } from "@/lib/utils";

export function ProfilesSidebar({
  counts,
}: {
  counts: { all: number; starred: number; byCountry: Record<string, number> };
}) {
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") || "all";

  function href(nextFilter: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextFilter === "all") params.delete("filter");
    else params.set("filter", nextFilter);
    const q = params.toString();
    return q ? `/profiles?${q}` : "/profiles";
  }

  const items: { id: string; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "starred", label: "Starred", count: counts.starred },
    ...Object.entries(counts.byCountry)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, count]) => ({
        id: code,
        label: `${countryFlag(code)} ${code}`,
        count,
      })),
  ];

  return (
    <div className="space-y-1">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Profiles</h2>
      {items.map((item) => (
        <Link
          key={item.id}
          href={href(item.id)}
          className={cn(
            "flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition",
            filter === item.id
              ? "bg-white font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
              : "text-slate-600 hover:bg-white/70",
          )}
        >
          <span>{item.label}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
            {item.count}
          </span>
        </Link>
      ))}
    </div>
  );
}
