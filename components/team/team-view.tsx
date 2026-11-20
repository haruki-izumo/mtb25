"use client";

import { useState, useTransition } from "react";
import { Pencil, Shield, Trash2, User } from "lucide-react";
import {
  inviteMember,
  removeMember,
  setMemberProfileAssignments,
  updateMember,
} from "@/app/actions/team";
import { AVATAR_COLORS } from "@/lib/team";
import { countryFlag } from "@/lib/timezone";
import { cn } from "@/lib/utils";

type Member = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  avatarColor: string;
  profiles: {
    id: string;
    code: string;
    country: string;
    displayName: string;
  }[];
  byCountry: Record<string, number>;
};

export function TeamView({
  teamName,
  members,
  allProfiles,
  isAdmin,
  currentUserId,
}: {
  teamName: string;
  members: Member[];
  allProfiles: {
    id: string;
    code: string;
    displayName: string;
    country: string;
  }[];
  isAdmin: boolean;
  currentUserId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [assigning, setAssigning] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={cn("space-y-4", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{teamName}</h1>
          <p className="text-sm text-slate-500">
            {members.length} member{members.length === 1 ? "" : "s"}
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowAdd(true);
            }}
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add member
          </button>
        ) : null}
      </div>

      {!isAdmin ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Only admins can add, edit, or remove members.
        </p>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Assigned profiles</th>
              {isAdmin ? <th className="px-4 py-3 text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const initials = m.name
                .split(" ")
                .map((p) => p[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();
              const isSelf = m.id === currentUserId;
              return (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span
                        className="inline-flex size-9 items-center justify-center rounded-full text-xs font-bold text-white"
                        style={{ backgroundColor: m.avatarColor }}
                      >
                        {initials}
                      </span>
                      <div>
                        <p className="font-medium text-slate-900">
                          {m.name}
                          {isSelf ? (
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              (you)
                            </span>
                          ) : null}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{m.email}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {m.role === "ADMIN" ? (
                        <Shield className="size-3.5" />
                      ) : (
                        <User className="size-3.5" />
                      )}
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {Object.keys(m.byCountry).length === 0 ? (
                        <span className="text-slate-400">None</span>
                      ) : (
                        Object.entries(m.byCountry).map(([country, count]) => (
                          <span
                            key={country}
                            className="rounded-full bg-slate-50 px-2 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200"
                          >
                            {countryFlag(country)} {count}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  {isAdmin ? (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          title="Assign profiles"
                          className="rounded-lg px-2 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                          onClick={() => setAssigning(m)}
                        >
                          Assign
                        </button>
                        <button
                          type="button"
                          title="Edit member"
                          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                          onClick={() => {
                            setError(null);
                            setEditing(m);
                          }}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          title={
                            isSelf
                              ? "You cannot remove yourself"
                              : "Remove member"
                          }
                          disabled={isSelf}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                          onClick={() => {
                            if (
                              !confirm(
                                `Remove ${m.name}? Their interview ownership will be reassigned to you.`,
                              )
                            ) {
                              return;
                            }
                            setError(null);
                            startTransition(async () => {
                              try {
                                await removeMember(m.id);
                              } catch (err) {
                                setError(
                                  err instanceof Error
                                    ? err.message
                                    : "Failed to remove",
                                );
                              }
                            });
                          }}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {showAdd ? (
        <MemberFormDialog
          title="Add member"
          submitLabel="Add member"
          requirePassword
          onClose={() => setShowAdd(false)}
          onSubmit={(values) => {
            setError(null);
            startTransition(async () => {
              try {
                await inviteMember({
                  name: values.name,
                  email: values.email,
                  role: values.role,
                  password: values.password,
                  avatarColor: values.avatarColor,
                });
                setShowAdd(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to add");
              }
            });
          }}
        />
      ) : null}

      {editing ? (
        <MemberFormDialog
          title={`Edit ${editing.name}`}
          submitLabel="Save changes"
          requirePassword={false}
          initial={{
            name: editing.name,
            email: editing.email,
            role: editing.role,
            avatarColor: editing.avatarColor,
          }}
          onClose={() => setEditing(null)}
          onSubmit={(values) => {
            setError(null);
            startTransition(async () => {
              try {
                await updateMember({
                  memberId: editing.id,
                  name: values.name,
                  email: values.email,
                  role: values.role,
                  avatarColor: values.avatarColor,
                  newPassword: values.password || "",
                });
                setEditing(null);
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Failed to update",
                );
              }
            });
          }}
        />
      ) : null}

      {assigning ? (
        <AssignDialog
          member={assigning}
          allProfiles={allProfiles}
          onClose={() => setAssigning(null)}
          onSave={(profileIds) => {
            startTransition(async () => {
              await setMemberProfileAssignments({
                memberId: assigning.id,
                profileIds,
              });
              setAssigning(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}

function MemberFormDialog({
  title,
  submitLabel,
  requirePassword,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  requirePassword: boolean;
  initial?: {
    name: string;
    email: string;
    role: "ADMIN" | "MEMBER";
    avatarColor: string;
  };
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    email: string;
    role: "ADMIN" | "MEMBER";
    avatarColor: string;
    password: string;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">(
    initial?.role ?? "MEMBER",
  );
  const [avatarColor, setAvatarColor] = useState(
    initial?.avatarColor ?? AVATAR_COLORS[0],
  );
  const [password, setPassword] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ name, email, role, avatarColor, password });
        }}
      >
        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
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

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "ADMIN" | "MEMBER")}
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          >
            <option value="MEMBER">MEMBER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </label>

        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Avatar color</p>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setAvatarColor(color)}
                className={cn(
                  "size-8 rounded-full ring-offset-2",
                  avatarColor === color && "ring-2 ring-slate-900",
                )}
                style={{ backgroundColor: color }}
                aria-label={color}
              />
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            {requirePassword
              ? "Temporary password"
              : "New password (optional)"}
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={requirePassword}
            minLength={requirePassword || password ? 8 : undefined}
            placeholder={
              requirePassword ? "Min 8 characters" : "Leave blank to keep"
            }
            className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
          />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-xl px-3 text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function AssignDialog({
  member,
  allProfiles,
  onClose,
  onSave,
}: {
  member: Member;
  allProfiles: {
    id: string;
    code: string;
    displayName: string;
    country: string;
  }[];
  onClose: () => void;
  onSave: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState(
    () => new Set(member.profiles.map((p) => p.id)),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-900">
          Assign profiles — {member.name}
        </h3>
        <ul className="mt-4 max-h-72 space-y-2 overflow-y-auto">
          {allProfiles.map((p) => {
            const checked = selected.has(p.id);
            return (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-100 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = new Set(selected);
                    if (checked) next.delete(p.id);
                    else next.add(p.id);
                    setSelected(next);
                  }}
                />
                <span>
                  {countryFlag(p.country)} {p.code}.{p.displayName}
                </span>
              </label>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-xl px-3 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave([...selected])}
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
