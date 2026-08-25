"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardTitle,
  LoadingPage,
  ActionNotice,
  CopyButton,
  Notice,
  type ActionNoticeState,
  PageHeader,
} from "@/components/ui";
import { IconLink, IconPlus } from "@/components/icons";
import { postApi } from "@/lib/api";

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

export default function TeamPage() {
  const router = useRouter();
  const [data, setData] = useState<TeamData | null>(null);
  const [notice, setNotice] = useState<(ActionNoticeState & { inviteUrl?: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [editingPerms, setEditingPerms] = useState<{ roleId: string; selected: Set<string> } | null>(null);

  const load = useCallback(() => {
    fetch("/api/team")
      .then((r) => r.json())
      .then((d) => setData(d.error ? null : d));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(true);
    try {
      const res = await postApi<{ data?: { token?: string } }>("/api/team", payload);
      const json = res.data ?? {};
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} needs human approval, check the Approvals inbox.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else if (label === "Invite") {
        const acceptUrl = `${window.location.origin}/invite/${json.data?.token ?? ""}`;
        setNotice({ tone: "success", text: `Invite created for ${inviteEmail}. Share this link:`, inviteUrl: acceptUrl });
        await navigator.clipboard?.writeText(acceptUrl).catch(() => {});
        setInviteEmail("");
        setInviteRoleId("");
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <LoadingPage />;

  return (
    <div>
      <PageHeader
        title="Team & roles"
        description="Roles map to capability permissions. Role changes are identity-class actions: they always require a human approval before taking effect."
      />

      {notice && notice.tone !== "error" && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
          {notice.inviteUrl && (
            <span className="mt-2 flex items-center gap-2 rounded-md border border-emerald-200 bg-white px-2.5 py-1.5 font-mono text-xs break-all text-stone-600">
              <IconLink className="size-3.5 shrink-0 text-stone-400" />
              <span className="min-w-0 flex-1 truncate">{notice.inviteUrl}</span>
              <CopyButton text={notice.inviteUrl} label="Copy link" />
            </span>
          )}
        </Notice>
      )}
      {notice && notice.tone === "error" && (
        <ActionNotice state={notice} onDismiss={() => setNotice(null)} />
      )}

      <section className="grid gap-4 xl:grid-cols-[1fr_420px]">
        {/* Members */}
        <Card>
          <CardTitle right={<Badge>{data.members.length}</Badge>}>Members</CardTitle>
          <ul className="-mt-2 divide-y divide-stone-100">
            {data.members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 py-3">
                <Avatar name={m.name ?? m.email} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-stone-800">{m.name ?? m.email}</p>
                  <p className="truncate text-xs text-stone-400">{m.email}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {(m.roleKeys.length ? m.roleKeys : ["no role"]).map((k) => (
                    <Badge key={k} tone={k === "owner" ? "maroon" : "neutral"}>
                      {k}
                    </Badge>
                  ))}
                </div>
                {!m.roleKeys.includes("owner") && data.roles.length > 0 && (
                  <label className="shrink-0">
                    <span className="sr-only">Change role for {m.name ?? m.email}</span>
                    <select
                      defaultValue=""
                      disabled={busy}
                      onChange={(e) =>
                        e.target.value && post({ action: "assignRole", userId: m.userId, roleId: e.target.value }, "Role assignment")
                      }
                      className="select h-7 w-36 px-2 py-0 text-xs"
                    >
                      <option value="">change role…</option>
                      {data.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>

          {/* Invite */}
          <div className="mt-4 border-t border-stone-100 pt-4">
            <h3 className="mb-2.5 text-[13px] font-medium text-stone-700">Invite a member</h3>
            <div className="flex flex-wrap gap-2">
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="email@company.com"
                type="email"
                aria-label="Invite email address"
                className="input min-w-0 flex-1"
              />
              <label className="w-36">
                <span className="sr-only">Role for invite</span>
                <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)} className="select">
                  <option value="">role…</option>
                  {data.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                loading={busy}
                disabled={!inviteEmail || !inviteRoleId}
                onClick={() => post({ action: "invite", email: inviteEmail, roleId: inviteRoleId }, "Invite")}
              >
                Invite
              </Button>
            </div>
            <p className="mt-2 text-xs text-stone-400">The invite link lands on your clipboard; share it with the new member.</p>
          </div>
        </Card>

        {/* Roles */}
        <div className="space-y-4">
          <Card>
            <CardTitle>Roles</CardTitle>
            <ul className="-mt-2 divide-y divide-stone-100">
              {data.roles.map((r) => (
                <li key={r.id} className="flex items-center gap-2.5 py-2.5 text-sm">
                  <span className="font-mono text-xs text-stone-400">{r.key}</span>
                  <span className="font-medium text-stone-800">{r.name}</span>
                  <span className="ml-auto text-xs whitespace-nowrap text-stone-400">
                    {r.permissions.includes("*") ? "all powers" : `${r.permissions.length} permissions`}
                  </span>
                  {!r.isSystem && (
                    <Button
                      tone="ghost"
                      size="sm"
                      onClick={() => setEditingPerms({ roleId: r.id, selected: new Set(r.permissions) })}
                    >
                      Edit
                    </Button>
                  )}
                </li>
              ))}
            </ul>

            {editingPerms && (
              <div className="mt-4 rounded-lg border border-maroon-200 bg-maroon-50/40 p-3.5">
                <p className="mb-2.5 text-xs font-semibold tracking-wide text-maroon-800 uppercase">
                  Permissions · {data.roles.find((r) => r.id === editingPerms.roleId)?.name}
                </p>
                <div className="grid max-h-64 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                  {[...data.catalog, "*"].map((perm) => (
                    <label key={perm} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-white/70">
                      <input
                        type="checkbox"
                        checked={editingPerms.selected.has(perm)}
                        onChange={(e) => {
                          const next = new Set(editingPerms.selected);
                          if (e.target.checked) next.add(perm);
                          else next.delete(perm);
                          setEditingPerms({ ...editingPerms, selected: next });
                        }}
                        className="accent-maroon-700"
                      />
                      <span className="font-mono">{perm}{perm === "*" ? " (everything)" : ""}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button tone="secondary" size="sm" onClick={() => setEditingPerms(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    loading={busy}
                    onClick={() => {
                      post(
                        { action: "setPermissions", roleId: editingPerms.roleId, permissions: [...editingPerms.selected] },
                        "Permission update",
                      );
                      setEditingPerms(null);
                    }}
                  >
                    Save permissions
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const key = newRoleName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              if (!key) return;
              post({ action: "createRole", key, name: newRoleName }, "Create role");
              setNewRoleName("");
            }}
            className="flex items-end gap-2 rounded-xl border border-dashed border-stone-300 p-4"
          >
            <div className="flex-1">
              <label htmlFor="new-role-name" className="label">
                New role
              </label>
              <input
                id="new-role-name"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="e.g. Bookkeeper"
                className="input"
              />
            </div>
            <Button type="submit" loading={busy} disabled={!newRoleName.trim()}>
              <IconPlus className="size-3.5" />
              Create
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
