"use client";

import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

export function MiniMonth({
  weekStartIso,
  timeZone = DEFAULT_TIMEZONE,
}: {
  weekStartIso: string;
  timeZone?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const weekStartKey = formatInTimeZone(
    new Date(weekStartIso),
    timeZone,
    "yyyy-MM-dd",
  );
  const weekEndKey = shiftDateKey(weekStartKey, 6);
  const [cursor, setCursor] = useState(() =>
    startOfMonth(new Date(`${weekStartKey}T12:00:00`)),
  );

  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          {format(cursor, "MMMM yyyy")}
        </h2>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded-md p-1 hover:bg-white"
            onClick={() => setCursor(subMonths(cursor, 1))}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            className="rounded-md p-1 hover:bg-white"
            onClick={() => setCursor(addMonths(cursor, 1))}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase text-slate-400">
        {["S", "M", "T", "W", "T", "F", "S"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((day) => {
          const dayKey = format(day, "yyyy-MM-dd");
          const inSelected = dayKey >= weekStartKey && dayKey <= weekEndKey;
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.set(
                  "week",
                  format(startOfWeek(day, { weekStartsOn: 0 }), "yyyy-MM-dd"),
                );
                router.push(`/meetings?${params.toString()}`);
              }}
              className={cn(
                "rounded-lg py-1.5 text-xs",
                !isSameMonth(day, cursor) && "text-slate-300",
                inSelected && "bg-blue-100 font-semibold text-blue-700",
                !inSelected && isSameMonth(day, cursor) && "hover:bg-white",
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
