"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { countryFlag } from "@/lib/timezone";

type NextRound = {
  startAt: string;
  companyName: string;
  jobTitle: string;
  profileCode: string;
  profileName: string;
  country: string;
  timeZone: string;
} | null;

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => n.toString().padStart(2, "0")).join(":");
}

export function CountdownCard({
  nextRound,
  displayTimeZone,
}: {
  nextRound: NextRound;
  displayTimeZone: string;
}) {
  // null until mount so SSR and the first client paint match (avoids
  // second-boundary hydration mismatches with Date.now()).
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!nextRound) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-slate-500 shadow-sm">
        <p className="text-sm font-medium">Next interview</p>
        <p className="mt-4 text-lg">No upcoming rounds scheduled</p>
      </div>
    );
  }

  const start = new Date(nextRound.startAt).getTime();
  const remaining =
    now == null ? "--:--:--" : formatRemaining(start - now);

  return (
    <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-6 shadow-sm">
      <p className="text-sm font-medium text-blue-700">Next interview</p>
      <p className="mt-3 font-mono text-4xl font-semibold tracking-tight text-slate-900 tabular-nums">
        {remaining}
      </p>
      <div className="mt-4 space-y-1">
        <p className="text-sm font-semibold text-slate-900">
          {countryFlag(nextRound.country)} {nextRound.profileCode}.
          {nextRound.profileName}
        </p>
        <p className="text-sm text-slate-600">
          {nextRound.companyName} · {nextRound.jobTitle}
        </p>
        <p className="text-sm text-slate-500">
          {formatInTimeZone(
            new Date(nextRound.startAt),
            displayTimeZone,
            "EEE MMM d · h:mm a",
          )}
        </p>
      </div>
    </div>
  );
}
