"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { formatTimezoneLabel } from "@/lib/timezone";

export function LiveClock({ timeZone }: { timeZone: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-sm font-medium text-slate-500">
        {formatInTimeZone(now, timeZone, "EEEE, MMMM d, yyyy")}
      </p>
      <p className="mt-2 font-mono text-5xl font-semibold tracking-tight text-slate-900 tabular-nums md:text-6xl">
        {formatInTimeZone(now, timeZone, "HH:mm:ss")}
      </p>
      <p className="mt-3 text-sm text-slate-500">
        {formatTimezoneLabel(timeZone, now)}
      </p>
    </div>
  );
}
