"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Member {
  userId: string;
  name: string | null;
  email: string;
  roleKeys: string[];
}
interface Role {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}
interface TeamData {
  members: Member[];
  roles: Role[];
  catalog: string[];
}

const usdless = (k: string) => k;

export default function TeamPage() {
  const router = useRouter();
  const [data, setData] = useState<TeamData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [editingPerms, setEditingPerms] = useState<{ roleId: string; selected: Set<string> } | null>(null);

  const load = useCallback(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then((d) => {
        setData(d.error ? null : d);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (res.status === 202) {
        setNotice(`${label} needs human approval — check the Approvals inbox.`);
      } else if (!res.ok) {
        setNotice(`${label} failed: ${json.error}`);
      } else if (label === "Invite") {
        const acceptUrl = `${window.location.origin}/invite/${json.data.token}`;
        setNotice(`Invite created. Share this link: ${acceptUrl}`);
        await navigator.clipboard?.writeText(acceptUrl).catch(() => {});
      } else {
        setNotice(`${label} done.`);
      }
      load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-neutral-400">Loading…</p>;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Team</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Roles map to capability permissions. Role changes are identity-class actions: they always
        require a human approval before taking effect.
      </p>

      {notice && (
        <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm break-all text-emerald-800">{notice}</p>
      )}

      <section className="mb-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 font-medium">Members</h2>
          <table className="w-full text-left text-sm">
            <tbody>
              {data.members.map((m) => (
                <tr key={m.userId} className="border-b border-neutral-100 last:border-0">
                  <td className="py-2">
                    <p className="font-medium">{m.name ?? m.email}</p>
                    <p className="text-xs text-neutral-400">{m.email}</p>
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-neutral-500">
                    {m.roleKeys.join(", ") || "no role"}
                  </td>
                  <td className="py-2 pl-3 text-right">
                    {!m.roleKeys.includes("owner") && data.roles.length > 0 && (
                      <select
                        defaultValue=""
                        disabled={busy}
                        onChange={(e) =>
                          e.target.value &&
                          post(
                            { action: "assignRole", userId: m.userId, roleId: e.target.value },
                            "Role assignment",
                          )
                        }
                        className="rounded border border-neutral-300 px-1.5 py-1 text-xs"
                      >
                        <option value="">change role…</option>
                        {data.roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-medium">Invite</h2>
            <div className="flex gap-2">
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="email@company.com"
                type="email"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              />
              <select
                value={inviteRoleId}
                onChange={(e) => setInviteRoleId(e.target.value)}
                className="rounded-lg border border-neutral-300 px-2 py-2 text-sm"
              >
                <option value="">role…</option>
                {data.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => post({ action: "invite", email: inviteEmail, roleId: inviteRoleId }, "Invite")}
                disabled={busy || !inviteEmail || !inviteRoleId}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
              >
                Invite
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 font-medium">Roles</h2>
            <ul className="space-y-2">
              {data.roles.map((r) => (
                <li key={r.id} className="flex items-center gap-3 text-sm">
                  <span className="font-mono text-xs text-neutral-400">{usdless(r.key)}</span>
                  <span>{r.name}</span>
                  <span className="text-xs text-neutral-400">
                    {r.permissions.includes("*") ? "all powers" : `${r.permissions.length} permissions`}
                  </span>
                  {!r.isSystem && (
                    <button
                      onClick={() =>
                        setEditingPerms({ roleId: r.id, selected: new Set(r.permissions) })
                      }
                      className="ml-auto text-xs text-emerald-700 underline underline-offset-2"
                    >
                      edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editingPerms && (
              <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 p-3">
                <p className="mb-2 font-mono text-xs uppercase tracking-wide text-neutral-500">
                  permissions for this role
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {data.catalog.map((perm) => (
                    <label key={perm} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={editingPerms.selected.has(perm)}
                        onChange={(e) => {
                          const next = new Set(editingPerms.selected);
                          if (e.target.checked) next.add(perm);
                          else next.delete(perm);
                          setEditingPerms({ ...editingPerms, selected: next });
                        }}
                      />
                      <span className="font-mono">{perm}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={editingPerms.selected.has("*")}
                      onChange={(e) => {
                        const next = new Set(editingPerms.selected);
                        if (e.target.checked) next.add("*");
                        else next.delete("*");
                        setEditingPerms({ ...editingPerms, selected: next });
                      }}
                    />
                    <span className="font-mono">* (everything)</span>
                  </label>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => {
                      post(
                        {
                          action: "setPermissions",
                          roleId: editingPerms.roleId,
                          permissions: [...editingPerms.selected],
                        },
                        "Permission update",
                      );
                      setEditingPerms(null);
                    }}
                    disabled={busy}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingPerms(null)}
                    className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const key = newRoleName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              if (!key) return;
              post({ action: "createRole", key, name: newRoleName }, "Create role");
              setNewRoleName("");
            }}
            className="flex gap-2 rounded-xl border border-dashed border-neutral-300 p-4"
          >
            <input
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="New role name…"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !newRoleName.trim()}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
            >
              Create
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
