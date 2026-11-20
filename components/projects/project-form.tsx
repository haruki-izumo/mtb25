"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/app/actions/clients";
import { createProject, updateProject } from "@/app/actions/projects";
import {
  PROJECT_COUNTRIES,
  PROJECT_CURRENCIES,
  PROJECT_INDUSTRIES,
  PROJECT_PRIORITIES,
} from "@/lib/projects/status";

type Options = {
  clients: {
    id: string;
    name: string;
    country: string;
  }[];
  types: { id: string; name: string }[];
  users: { id: string; name: string; email: string }[];
};

type Initial = {
  projectName: string;
  clientId: string;
  country: string;
  city: string;
  industry: string;
  projectTypeId: string;
  description: string;
  scopeOfWork: string;
  budget: string;
  currency: string;
  contractValue: string;
  paymentTerms: string;
  dateSecured: string;
  startDate: string;
  expectedEndDate: string;
  actualEndDate: string;
  projectManagerId: string;
  teamMemberIds: string[];
  priority: string;
  progressPercent: string;
  tags: string;
  notes: string;
};

const emptyInitial = (defaultManagerId: string): Initial => ({
  projectName: "",
  clientId: "",
  country: "US",
  city: "",
  industry: "",
  projectTypeId: "",
  description: "",
  scopeOfWork: "",
  budget: "0",
  currency: "USD",
  contractValue: "",
  paymentTerms: "",
  dateSecured: new Date().toISOString().slice(0, 10),
  startDate: "",
  expectedEndDate: "",
  actualEndDate: "",
  projectManagerId: defaultManagerId,
  teamMemberIds: [],
  priority: "MEDIUM",
  progressPercent: "0",
  tags: "",
  notes: "",
});

export function ProjectForm({
  mode,
  projectId,
  options,
  initial,
  currentUserId,
}: {
  mode: "create" | "edit";
  projectId?: string;
  options: Options;
  initial?: Partial<Initial>;
  currentUserId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Initial>({
    ...emptyInitial(currentUserId),
    ...initial,
  });
  const [clients, setClients] = useState(options.clients);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function setField<K extends keyof Initial>(key: K, value: Initial[K]) {
    setDirty(true);
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleMember(id: string) {
    setDirty(true);
    setValues((prev) => ({
      ...prev,
      teamMemberIds: prev.teamMemberIds.includes(id)
        ? prev.teamMemberIds.filter((x) => x !== id)
        : [...prev.teamMemberIds, id],
    }));
  }

  return (
    <>
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const payload = {
          ...values,
          budget: Number(values.budget),
          contractValue: values.contractValue
            ? Number(values.contractValue)
            : null,
          progressPercent: Number(values.progressPercent || 0),
          tags: values.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          teamMemberIds: values.teamMemberIds,
          projectTypeId: values.projectTypeId || null,
        };
        startTransition(async () => {
          if (mode === "create") {
            const result = await createProject(payload);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setDirty(false);
            router.push(`/projects/${result.id}`);
            router.refresh();
            return;
          }
          const result = await updateProject(projectId!, payload);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setDirty(false);
          router.push(`/projects/${projectId}`);
          router.refresh();
        });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">
          {mode === "create" ? "New project" : "Edit project"}
        </h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              if (dirty && !confirm("Discard unsaved changes?")) return;
              router.back();
            }}
            className="h-9 rounded-xl px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <Section title="Basic info">
        <Field label="Project name" required>
          <input
            required
            value={values.projectName}
            onChange={(e) => setField("projectName", e.target.value)}
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project type">
            <select
              value={values.projectTypeId}
              onChange={(e) => setField("projectTypeId", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              <option value="">Select…</option>
              {options.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              value={values.priority}
              onChange={(e) => setField("priority", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              {PROJECT_PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Industry">
            <select
              value={values.industry}
              onChange={(e) => setField("industry", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              <option value="">Select…</option>
              {PROJECT_INDUSTRIES.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Progress %">
            <input
              type="number"
              min={0}
              max={100}
              value={values.progressPercent}
              onChange={(e) => setField("progressPercent", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
        </div>
      </Section>

      <Section title="Client">
        <Field label="Client" required>
          <div className="flex gap-2">
            <select
              required
              value={values.clientId}
              onChange={(e) => setField("clientId", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.country})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowNewClient(true)}
              className="h-10 shrink-0 rounded-xl border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              New
            </button>
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Country" required>
            <select
              required
              value={values.country}
              onChange={(e) => setField("country", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              {PROJECT_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="City / location">
            <input
              value={values.city}
              onChange={(e) => setField("city", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
        </div>
      </Section>

      <Section title="Financials">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Budget" required>
            <input
              type="number"
              min={0}
              step="0.01"
              required
              value={values.budget}
              onChange={(e) => setField("budget", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
          <Field label="Currency" required>
            <select
              value={values.currency}
              onChange={(e) => setField("currency", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            >
              {PROJECT_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contract value">
            <input
              type="number"
              min={0}
              step="0.01"
              value={values.contractValue}
              onChange={(e) => setField("contractValue", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
        </div>
        <Field label="Payment terms">
          <input
            value={values.paymentTerms}
            onChange={(e) => setField("paymentTerms", e.target.value)}
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </Field>
      </Section>

      <Section title="Timeline">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date secured" required>
            <input
              type="date"
              required
              value={values.dateSecured}
              onChange={(e) => setField("dateSecured", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
          <Field label="Start date">
            <input
              type="date"
              value={values.startDate}
              onChange={(e) => setField("startDate", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
          <Field label="Expected end">
            <input
              type="date"
              value={values.expectedEndDate}
              onChange={(e) => setField("expectedEndDate", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
          <Field label="Actual end">
            <input
              type="date"
              value={values.actualEndDate}
              onChange={(e) => setField("actualEndDate", e.target.value)}
              className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
            />
          </Field>
        </div>
      </Section>

      <Section title="Team">
        <Field label="Project manager" required>
          <select
            required
            value={values.projectManagerId}
            onChange={(e) => setField("projectManagerId", e.target.value)}
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          >
            {options.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">
            Team members
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
            {options.users.map((u) => (
              <label
                key={u.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={values.teamMemberIds.includes(u.id)}
                  onChange={() => toggleMember(u.id)}
                />
                {u.name}
              </label>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Description & scope">
        <Field label="Description" required>
          <textarea
            required
            rows={4}
            value={values.description}
            onChange={(e) => setField("description", e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Scope of work">
          <textarea
            rows={3}
            value={values.scopeOfWork}
            onChange={(e) => setField("scopeOfWork", e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Tags (comma-separated)">
          <input
            value={values.tags}
            onChange={(e) => setField("tags", e.target.value)}
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </Field>
        <Field label="Internal notes">
          <textarea
            rows={3}
            value={values.notes}
            onChange={(e) => setField("notes", e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
      </Section>
    </form>

    {showNewClient ? (
      <NewClientDialog
        onClose={() => setShowNewClient(false)}
        onCreated={(client) => {
          setClients((prev) =>
            [...prev, client].sort((a, b) => a.name.localeCompare(b.name)),
          );
          setField("clientId", client.id);
          setField("country", client.country);
          setShowNewClient(false);
        }}
      />
    ) : null}
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">
        {label}
        {required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}

function NewClientDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (client: { id: string; name: string; country: string }) => void;
}) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("US");
  const [contactPerson, setContactPerson] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await createClient({
              name,
              country,
              contactPerson,
              email,
              phone,
            });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            onCreated(result.client);
          });
        }}
      >
        <h3 className="text-lg font-semibold text-slate-900">New client</h3>
        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <input
          required
          placeholder="Client name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
        />
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
        >
          {PROJECT_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Contact person"
          value={contactPerson}
          onChange={(e) => setContactPerson(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
        />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
        />
        <input
          placeholder="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl px-4 text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-60"
          >
            {pending ? "Saving…" : "Add client"}
          </button>
        </div>
      </form>
    </div>
  );
}
