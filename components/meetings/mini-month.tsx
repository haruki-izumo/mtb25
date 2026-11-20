"use client";

import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isWithinInterval,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function MiniMonth({ weekStartIso }: { weekStartIso: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedWeekStart = startOfWeek(new Date(weekStartIso), {
    weekStartsOn: 0,
  });
  const selectedWeekEnd = endOfWeek(selectedWeekStart, { weekStartsOn: 0 });
  const [cursor, setCursor] = useState(startOfMonth(selectedWeekStart));

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
          const inSelected = isWithinInterval(day, {
            start: selectedWeekStart,
            end: selectedWeekEnd,
          });
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.set(
                  "week",
                  startOfWeek(day, { weekStartsOn: 0 }).toISOString(),
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
