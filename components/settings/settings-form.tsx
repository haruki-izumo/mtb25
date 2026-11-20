"use client";

import { useState, useTransition } from "react";
import { changePassword, updateTimezone } from "@/app/actions/settings";
import { signOut } from "next-auth/react";

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "UTC",
];

export function SettingsForm({
  email,
  name,
  timezone,
}: {
  email: string;
  name: string;
  timezone: string;
}) {
  const [pending, startTransition] = useTransition();
  const [tz, setTz] = useState(timezone);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">
          {name} · {email}
        </p>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Timezone</h2>
        <p className="mt-1 text-xs text-slate-500">
          Used for calendar and home displays.
        </p>
        <div className="mt-3 flex gap-2">
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="h-10 flex-1 rounded-xl border border-slate-200 px-3 text-sm"
          >
            {TIMEZONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending}
            className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white"
            onClick={() => {
              setMessage(null);
              startTransition(async () => {
                await updateTimezone(tz);
                setMessage("Timezone saved");
              });
            }}
          >
            Save
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Password</h2>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setMessage(null);
            const fd = new FormData(e.currentTarget);
            startTransition(async () => {
              try {
                await changePassword({
                  currentPassword: String(fd.get("currentPassword")),
                  newPassword: String(fd.get("newPassword")),
                });
                setMessage("Password updated");
                e.currentTarget.reset();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed");
              }
            });
          }}
        >
          <input
            name="currentPassword"
            type="password"
            required
            placeholder="Current password"
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
          <input
            name="newPassword"
            type="password"
            required
            minLength={8}
            placeholder="New password (min 8)"
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white"
          >
            Update password
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Theme</h2>
        <p className="mt-1 text-sm text-slate-500">
          Light theme is active. Dark mode can be added later.
        </p>
      </section>

      {(message || error) && (
        <p className={error ? "text-sm text-red-600" : "text-sm text-emerald-600"}>
          {error || message}
        </p>
      )}

      <button
        type="button"
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        Sign out
      </button>
    </div>
  );
}
