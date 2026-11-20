"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Copy, LayoutGrid, List, Pencil, Plus, Star, Trash2 } from "lucide-react";
import {
  addProfileApiKey,
  addProfileCertification,
  addProfileEducation,
  addProfileExperience,
  createProfile,
  deleteProfile,
  deleteProfileApiKey,
  deleteProfileCertification,
  deleteProfileEducation,
  deleteProfileExperience,
  setProfileInterviewer,
  toggleProfileStar,
  updateProfileEducation,
  updateProfileExperience,
} from "@/app/actions/profiles";
import { CountrySelect } from "@/components/profiles/country-select";
import { countryFlag, DEFAULT_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";

const PROFILE_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "UTC",
] as const;

const PROFILE_COUNTRIES = [
  { code: "AU", label: "Australia" },
  { code: "AT", label: "Austria" },
  { code: "BE", label: "Belgium" },
  { code: "BR", label: "Brazil" },
  { code: "BG", label: "Bulgaria" },
  { code: "CA", label: "Canada" },
  { code: "HR", label: "Croatia" },
  { code: "CY", label: "Cyprus" },
  { code: "CZ", label: "Czechia" },
  { code: "DK", label: "Denmark" },
  { code: "EE", label: "Estonia" },
  { code: "FI", label: "Finland" },
  { code: "FR", label: "France" },
  { code: "DE", label: "Germany" },
  { code: "GR", label: "Greece" },
  { code: "HU", label: "Hungary" },
  { code: "IN", label: "India" },
  { code: "IE", label: "Ireland" },
  { code: "IT", label: "Italy" },
  { code: "LV", label: "Latvia" },
  { code: "LT", label: "Lithuania" },
  { code: "LU", label: "Luxembourg" },
  { code: "MT", label: "Malta" },
  { code: "NL", label: "Netherlands" },
  { code: "PL", label: "Poland" },
  { code: "PT", label: "Portugal" },
  { code: "RO", label: "Romania" },
  { code: "SK", label: "Slovakia" },
  { code: "SI", label: "Slovenia" },
  { code: "ES", label: "Spain" },
  { code: "SE", label: "Sweden" },
  { code: "GB", label: "United Kingdom" },
  { code: "US", label: "United States" },
] as const;

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
    location: string | null;
    startDate: string;
    endDate: string | null;
  }[];
  education: {
    id: string;
    school: string;
    degree: string;
    start: string;
    end: string;
  }[];
  certifications: {
    id: string;
    name: string;
    date: string;
  }[];
  assignedMembers: { id: string; name: string; avatarColor: string }[];
  interviewer: { id: string; name: string; email: string } | null;
  apiKeys?: {
    id: string;
    mode: "FREE" | "PRO";
    label: string | null;
    createdAt: string | Date;
    keyPreview: string;
  }[];
  processes: {
    id: string;
    companyName: string;
    jobTitle: string;
    status: string;
    updatedAt: string;
    roundCount: number;
  }[];
} | null;

type InterviewerOption = { id: string; name: string; email: string };
type MemberOption = { id: string; name: string; email: string };

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
  interviewers = [],
  assignableMembers = [],
  isAdmin = false,
}: {
  profiles: ProfileRow[];
  counts: { all: number; starred: number; byCountry: Record<string, number> };
  selected: string | null;
  detail: Detail;
  interviewers?: InterviewerOption[];
  assignableMembers?: MemberOption[];
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
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
          {isAdmin ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setShowAdd(true);
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="size-4" />
              Add profile
            </button>
          ) : null}
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
                <div className="flex items-center gap-1">
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
                  {isAdmin ? (
                    <button
                      type="button"
                      title="Delete profile"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      onClick={() => {
                        if (
                          !confirm(
                            `Delete ${detail.fullName} (${detail.code})? This removes their interviews, availability, applications, and API keys.`,
                          )
                        ) {
                          return;
                        }
                        setError(null);
                        startTransition(async () => {
                          const result = await deleteProfile(detail.id);
                          if (!result.ok) {
                            setError(result.error);
                            return;
                          }
                          router.push("/profiles");
                          router.refresh();
                        });
                      }}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  ) : null}
                </div>
              </div>
              {error ? (
                <p className="mt-2 text-xs text-red-600">{error}</p>
              ) : null}
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
                  <ExperienceEditor
                    profileId={detail.id}
                    experiences={detail.experiences}
                    pending={pending}
                    startTransition={startTransition}
                    onDone={() => router.refresh()}
                  />
                  <EducationEditor
                    profileId={detail.id}
                    education={detail.education}
                    pending={pending}
                    startTransition={startTransition}
                    onDone={() => router.refresh()}
                  />
                  <CertificationsEditor
                    profileId={detail.id}
                    certifications={detail.certifications}
                    pending={pending}
                    startTransition={startTransition}
                    onDone={() => router.refresh()}
                  />
                </>
              ) : null}

              {tab === "settings" ? (
                <div className="space-y-3 text-sm text-slate-600">
                  <ApiKeysEditor
                    profileId={detail.id}
                    keys={detail.apiKeys || []}
                    pending={pending}
                    startTransition={startTransition}
                    onDone={() => router.refresh()}
                  />
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Interviewer
                    </p>
                    {isAdmin ? (
                      <select
                        value={detail.interviewer?.id ?? ""}
                        disabled={pending}
                        onChange={(e) => {
                          const interviewerId = e.target.value || null;
                          startTransition(async () => {
                            const result = await setProfileInterviewer({
                              profileId: detail.id,
                              interviewerId,
                            });
                            if (!result.ok) {
                              window.alert(result.error);
                              return;
                            }
                            router.refresh();
                          });
                        }}
                        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"
                      >
                        <option value="">No interviewer</option>
                        {interviewers.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-slate-800">
                        {detail.interviewer?.name ?? "None assigned"}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-slate-400">
                      One interviewer per profile; used when booking interviews.
                    </p>
                  </div>
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

      {showAdd ? (
        <CreateProfileDialog
          interviewers={interviewers}
          members={assignableMembers}
          pending={pending}
          error={error}
          onClose={() => {
            setShowAdd(false);
            setError(null);
          }}
          onSubmit={(values) => {
            setError(null);
            startTransition(async () => {
              const result = await createProfile(values);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setShowAdd(false);
              router.push(`/profiles?id=${result.id}`);
              router.refresh();
            });
          }}
        />
      ) : null}
    </div>
  );
}

function CreateProfileDialog({
  interviewers,
  members,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  interviewers: InterviewerOption[];
  members: MemberOption[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: {
    code: string;
    displayName: string;
    fullName: string;
    email: string;
    phone?: string;
    location?: string;
    zipCode?: string;
    country: string;
    timezone: string;
    linkedinUrl?: string;
    githubUrl?: string;
    interviewerId: string | null;
    assignedMemberIds: string[];
  }) => void;
}) {
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [country, setCountry] = useState("US");
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [interviewerId, setInterviewerId] = useState("");
  const [assignedMemberIds, setAssignedMemberIds] = useState<string[]>([]);

  function toggleMember(id: string) {
    setAssignedMemberIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            code,
            displayName,
            fullName,
            email,
            phone,
            location,
            zipCode,
            country,
            timezone,
            linkedinUrl,
            githubUrl,
            interviewerId: interviewerId || null,
            assignedMemberIds,
          });
        }}
      >
        <h3 className="text-lg font-semibold text-slate-900">Add profile</h3>
        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="US-07"
              required
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Display name
            </span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alex"
              required
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Full name</span>
          <input
            value={fullName}
            onChange={(e) => {
              const next = e.target.value;
              setFullName(next);
              if (!displayName.trim()) {
                setDisplayName(next.trim().split(/\s+/)[0] || "");
              }
            }}
            required
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Phone</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Zip</span>
            <input
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Location</span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="New York, NY"
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Country</span>
            <CountrySelect
              value={country}
              onChange={setCountry}
              countries={PROFILE_COUNTRIES}
            />
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Timezone
            </span>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              {PROFILE_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              LinkedIn URL
            </span>
            <input
              type="url"
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              placeholder="https://linkedin.com/in/…"
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              GitHub URL
            </span>
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/…"
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Interviewer
          </span>
          <select
            value={interviewerId}
            onChange={(e) => setInterviewerId(e.target.value)}
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          >
            <option value="">None</option>
            {interviewers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>

        {members.length ? (
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">
              Assigned members
            </p>
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
              {members.map((m) => (
                <label
                  key={m.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={assignedMemberIds.includes(m.id)}
                    onChange={() => toggleMember(m.id)}
                  />
                  <span className="min-w-0 truncate">
                    {m.name}
                    <span className="text-slate-400"> · {m.email}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create profile"}
          </button>
        </div>
      </form>
    </div>
  );
}

function toMonthValue(iso: string) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function formatExperienceRange(startIso: string, endIso: string | null) {
  const start = toMonthValue(startIso);
  const end = endIso ? toMonthValue(endIso) : "Present";
  return `${start} – ${end}`;
}

function ExperienceEditor({
  profileId,
  experiences,
  pending,
  startTransition,
  onDone,
}: {
  profileId: string;
  experiences: {
    id: string;
    company: string;
    location: string | null;
    startDate: string;
    endDate: string | null;
  }[];
  pending: boolean;
  startTransition: (fn: () => void) => void;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState<{
    id?: string;
    company: string;
    location: string;
    startMonth: string;
    endMonth: string;
    current: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openCreate() {
    setError(null);
    setEditing({
      company: "",
      location: "",
      startMonth: "",
      endMonth: "",
      current: true,
    });
  }

  function openEdit(e: {
    id: string;
    company: string;
    location: string | null;
    startDate: string;
    endDate: string | null;
  }) {
    setError(null);
    setEditing({
      id: e.id,
      company: e.company,
      location: e.location || "",
      startMonth: toMonthValue(e.startDate),
      endMonth: e.endDate ? toMonthValue(e.endDate) : "",
      current: !e.endDate,
    });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Experience
        </p>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
        >
          <Plus className="size-3.5" />
          Add
        </button>
      </div>

      {experiences.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-500">
          No experience yet
        </p>
      ) : (
        <ul className="space-y-2">
          {experiences.map((e) => (
            <li
              key={e.id}
              className="rounded-xl border border-slate-100 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {e.company}
                  </p>
                  {e.location ? (
                    <p className="text-xs text-slate-500">{e.location}</p>
                  ) : null}
                  <p className="text-xs text-slate-400">
                    {formatExperienceRange(e.startDate, e.endDate)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    title="Edit"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => openEdit(e)}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={() => {
                      if (!confirm(`Delete experience at ${e.company}?`)) return;
                      setError(null);
                      startTransition(async () => {
                        const result = await deleteProfileExperience(e.id);
                        if (!result.ok) {
                          setError(result.error);
                          return;
                        }
                        onDone();
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      ) : null}

      {editing ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form
            className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault();
              const payload = {
                company: editing.company,
                location: editing.location,
                startMonth: editing.startMonth,
                endMonth: editing.current ? "" : editing.endMonth,
              };
              setError(null);
              startTransition(async () => {
                const result = editing.id
                  ? await updateProfileExperience({ id: editing.id, ...payload })
                  : await addProfileExperience({ profileId, ...payload });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setEditing(null);
                onDone();
              });
            }}
          >
            <h3 className="text-lg font-semibold text-slate-900">
              {editing.id ? "Edit experience" : "Add experience"}
            </h3>
            {error ? (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            ) : null}

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                Company
              </span>
              <input
                value={editing.company}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev ? { ...prev, company: e.target.value } : prev,
                  )
                }
                required
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                Location
              </span>
              <input
                value={editing.location}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev ? { ...prev, location: e.target.value } : prev,
                  )
                }
                placeholder="Remote / New York, NY"
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  Start
                </span>
                <input
                  type="month"
                  value={editing.startMonth}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, startMonth: e.target.value } : prev,
                    )
                  }
                  required
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  End
                </span>
                <input
                  type="month"
                  value={editing.endMonth}
                  disabled={editing.current}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, endMonth: e.target.value } : prev,
                    )
                  }
                  required={!editing.current}
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={editing.current}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev
                      ? {
                          ...prev,
                          current: e.target.checked,
                          endMonth: e.target.checked ? "" : prev.endMonth,
                        }
                      : prev,
                  )
                }
              />
              Currently working here
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
                className="h-10 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {pending ? "Saving…" : editing.id ? "Save" : "Add"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function formatEducationRange(start: string, end: string) {
  if (!start) return end || "—";
  return `${start} – ${end || "Present"}`;
}

function EducationEditor({
  profileId,
  education,
  pending,
  startTransition,
  onDone,
}: {
  profileId: string;
  education: {
    id: string;
    school: string;
    degree: string;
    start: string;
    end: string;
  }[];
  pending: boolean;
  startTransition: (fn: () => void) => void;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState<{
    id?: string;
    school: string;
    degree: string;
    startMonth: string;
    endMonth: string;
    current: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openCreate() {
    setError(null);
    setEditing({
      school: "",
      degree: "",
      startMonth: "",
      endMonth: "",
      current: false,
    });
  }

  function openEdit(e: {
    id: string;
    school: string;
    degree: string;
    start: string;
    end: string;
  }) {
    setError(null);
    setEditing({
      id: e.id,
      school: e.school,
      degree: e.degree,
      startMonth: e.start,
      endMonth: e.end,
      current: !e.end,
    });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Education
        </p>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
        >
          <Plus className="size-3.5" />
          Add
        </button>
      </div>

      {education.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-500">
          No education yet
        </p>
      ) : (
        <ul className="space-y-2">
          {education.map((e) => (
            <li
              key={e.id}
              className="rounded-xl border border-slate-100 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {e.school}
                  </p>
                  {e.degree ? (
                    <p className="text-xs text-slate-500">{e.degree}</p>
                  ) : null}
                  <p className="text-xs text-slate-400">
                    {formatEducationRange(e.start, e.end)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    title="Edit"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    onClick={() => openEdit(e)}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={() => {
                      if (!confirm(`Delete education at ${e.school}?`)) return;
                      setError(null);
                      startTransition(async () => {
                        const result = await deleteProfileEducation({
                          profileId,
                          educationId: e.id,
                        });
                        if (!result.ok) {
                          setError(result.error);
                          return;
                        }
                        onDone();
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      ) : null}

      {editing ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form
            className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault();
              const payload = {
                school: editing.school,
                degree: editing.degree,
                startMonth: editing.startMonth,
                endMonth: editing.current ? "" : editing.endMonth,
              };
              setError(null);
              startTransition(async () => {
                const result = editing.id
                  ? await updateProfileEducation({
                      profileId,
                      educationId: editing.id,
                      ...payload,
                    })
                  : await addProfileEducation({ profileId, ...payload });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setEditing(null);
                onDone();
              });
            }}
          >
            <h3 className="text-lg font-semibold text-slate-900">
              {editing.id ? "Edit education" : "Add education"}
            </h3>
            {error ? (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            ) : null}

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                School
              </span>
              <input
                value={editing.school}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev ? { ...prev, school: e.target.value } : prev,
                  )
                }
                required
                placeholder="UMFST-UMCH University"
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                Degree
              </span>
              <input
                value={editing.degree}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev ? { ...prev, degree: e.target.value } : prev,
                  )
                }
                placeholder="B.Sc. Computer Science"
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  Start
                </span>
                <input
                  type="month"
                  value={editing.startMonth}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, startMonth: e.target.value } : prev,
                    )
                  }
                  required
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  End
                </span>
                <input
                  type="month"
                  value={editing.endMonth}
                  disabled={editing.current}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, endMonth: e.target.value } : prev,
                    )
                  }
                  required={!editing.current}
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={editing.current}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev
                      ? {
                          ...prev,
                          current: e.target.checked,
                          endMonth: e.target.checked ? "" : prev.endMonth,
                        }
                      : prev,
                  )
                }
              />
              Currently studying here
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
                className="h-10 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {pending ? "Saving…" : editing.id ? "Save" : "Add"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function CertificationsEditor({
  profileId,
  certifications,
  pending,
  startTransition,
  onDone,
}: {
  profileId: string;
  certifications: { id: string; name: string; date: string }[];
  pending: boolean;
  startTransition: (fn: () => void) => void;
  onDone: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Certifications
        </p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setName("");
            setDate("");
            setAdding(true);
          }}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
        >
          <Plus className="size-3.5" />
          Add
        </button>
      </div>

      {certifications.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-500">
          No certifications yet
        </p>
      ) : (
        <ul className="space-y-2">
          {certifications.map((c) => (
            <li
              key={c.id}
              className="flex items-start justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{c.name}</p>
                <p className="text-xs text-slate-400">{c.date || "—"}</p>
              </div>
              <button
                type="button"
                title="Remove"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                onClick={() => {
                  if (!confirm(`Remove certification “${c.name}”?`)) return;
                  setError(null);
                  startTransition(async () => {
                    const result = await deleteProfileCertification({
                      profileId,
                      certificationId: c.id,
                    });
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    onDone();
                  });
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && !adding ? (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      ) : null}

      {adding ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form
            className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                const result = await addProfileCertification({
                  profileId,
                  name,
                  date,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setAdding(false);
                onDone();
              });
            }}
          >
            <h3 className="text-lg font-semibold text-slate-900">
              Add certification
            </h3>
            {error ? (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="AWS Solutions Architect"
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">Date</span>
              <input
                type="month"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
                className="h-10 rounded-xl px-4 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {pending ? "Saving…" : "Add"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function ApiKeysEditor({
  profileId,
  keys,
  pending,
  startTransition,
  onDone,
}: {
  profileId: string;
  keys: {
    id: string;
    mode: "FREE" | "PRO";
    label: string | null;
    keyPreview: string;
  }[];
  pending: boolean;
  startTransition: (fn: () => void) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"FREE" | "PRO">("FREE");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        Extension API keys
      </p>
      <p className="text-xs text-slate-400">
        Free/Pro keys used by the Chrome extension for resume generation.
      </p>
      <ul className="space-y-1">
        {keys.length === 0 ? (
          <li className="text-xs text-slate-500">No keys yet</li>
        ) : (
          keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2 py-1.5 text-xs"
            >
              <span>
                <span className="font-semibold text-slate-700">{k.mode}</span>
                {k.label ? ` · ${k.label}` : ""} · {k.keyPreview}
              </span>
              <button
                type="button"
                disabled={pending}
                className="text-red-600 hover:underline"
                onClick={() => {
                  startTransition(async () => {
                    const result = await deleteProfileApiKey(k.id);
                    if (!result.ok) setError(result.error);
                    else onDone();
                  });
                }}
              >
                Remove
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50 p-2">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "FREE" | "PRO")}
          className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs"
        >
          <option value="FREE">Free</option>
          <option value="PRO">Pro</option>
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs"
        />
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="API key"
          className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs"
        />
        <button
          type="button"
          disabled={pending || key.trim().length < 8}
          className="h-8 w-full rounded-lg bg-slate-900 text-xs font-medium text-white disabled:opacity-50"
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await addProfileApiKey({
                profileId,
                mode,
                key: key.trim(),
                label: label.trim() || undefined,
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setKey("");
              setLabel("");
              onDone();
            });
          }}
        >
          Add key
        </button>
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </div>
    </div>
  );
}
