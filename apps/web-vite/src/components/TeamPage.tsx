import { useCallback, useEffect, useState } from "react";
import { fetchTeam, submitTeamAction, TeamApiError, type TeamAction, type TeamData } from "../api/team";
import "./TeamPage.css";

type PageState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; data: TeamData };

type Notice = { tone: "success" | "pending" | "error"; message: string; inviteUrl?: string };

function errorMessage(error: unknown): string {
  if (error instanceof TeamApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The team service took too long. Try again.";
  return "Could not reach the team service. Check your connection and try again.";
}

function memberInitial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || "?";
}

async function copyInviteUrl(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Keep the invite URL visible so it can be copied manually.
  }
}

export function TeamPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [editingPermissions, setEditingPermissions] = useState<{ roleId: string; selected: Set<string> } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const data = await fetchTeam(signal);
      if (!signal?.aborted) setState({ status: "ready", data });
    } catch (error) {
      if (!signal?.aborted) setState({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function post(action: TeamAction, label: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitTeamAction(action);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", message: `${label} needs human approval, check the Approvals inbox.` });
      } else if (action.action === "invite") {
        const inviteUrl = `${window.location.origin}/invite/${typeof result.data.token === "string" ? result.data.token : ""}`;
        setNotice({ tone: "success", message: `Invite created for ${inviteEmail}. Share this link:`, inviteUrl });
        await copyInviteUrl(inviteUrl);
        setInviteEmail("");
        setInviteRoleId("");
      } else {
        setNotice({ tone: "success", message: `${label} done.` });
      }
      void load();
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return <main className="team-page"><p className="team-loading" role="status">Loading team and roles…</p></main>;
  }
  if (state.status === "failed") {
    return (
      <main className="team-page">
        <section className="team-error" role="alert" aria-labelledby="team-error-title">
          <div>
            <p className="team-eyebrow">Workspace access</p>
            <h1 id="team-error-title">Could not load team and roles</h1>
            <p>{state.message}</p>
          </div>
          <button className="team-secondary-button" type="button" onClick={() => void load()}>Try again</button>
        </section>
      </main>
    );
  }

  const { data } = state;
  const activeRole = editingPermissions && data.roles.find((role) => role.id === editingPermissions.roleId);

  return (
    <main className="team-page">
      <header className="team-page-header">
        <div>
          <p className="team-eyebrow">Workspace access</p>
          <h1>Team &amp; roles</h1>
          <p>Roles map to capability permissions. Role changes are identity-class actions: they always require a human approval before taking effect.</p>
        </div>
      </header>

      {notice && (
        <section className={`team-notice team-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <div>
            <p>{notice.message}</p>
            {notice.inviteUrl && (
              <div className="team-invite-link">
                <a href={notice.inviteUrl}>{notice.inviteUrl}</a>
                <button type="button" onClick={() => void copyInviteUrl(notice.inviteUrl!)}>
                  Copy link
                </button>
              </div>
            )}
          </div>
          <button className="team-dismiss" type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button>
        </section>
      )}

      <div className="team-grid">
        <section className="team-card" aria-labelledby="team-members-title">
          <div className="team-card-heading">
            <h2 id="team-members-title">Members</h2>
            <span className="team-count">{data.members.length}</span>
          </div>
          {data.members.length === 0 ? (
            <p className="team-empty">No members were returned for this workspace.</p>
          ) : (
            <ul className="team-members">
              {data.members.map((member) => (
                <li key={member.userId} className="team-member">
                  <span className="team-avatar" aria-hidden="true">{memberInitial(member.name ?? member.email)}</span>
                  <div className="team-member-copy">
                    <strong>{member.name ?? member.email}</strong>
                    <span>{member.email}</span>
                  </div>
                  <div className="team-role-badges" aria-label={`Roles for ${member.name ?? member.email}`}>
                    {(member.roleKeys.length ? member.roleKeys : ["no role"]).map((key) => (
                      <span className={`team-role-badge${key === "owner" ? " team-role-owner" : ""}`} key={key}>{key}</span>
                    ))}
                  </div>
                  {!member.roleKeys.includes("owner") && data.roles.length > 0 && (
                    <label className="team-role-select">
                      <span className="visually-hidden">Change role for {member.name ?? member.email}</span>
                      <select
                        aria-label={`Change role for ${member.name ?? member.email}`}
                        defaultValue=""
                        disabled={busy}
                        onChange={(event) => {
                          if (event.currentTarget.value) {
                            void post({ action: "assignRole", userId: member.userId, roleId: event.currentTarget.value }, "Role assignment");
                            event.currentTarget.value = "";
                          }
                        }}
                      >
                        <option value="">change role…</option>
                        {data.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                      </select>
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form
            className="team-invite-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (inviteEmail && inviteRoleId) void post({ action: "invite", email: inviteEmail, roleId: inviteRoleId }, "Invite");
            }}
          >
            <h3>Invite a member</h3>
            <div className="team-form-row">
              <label className="visually-hidden" htmlFor="team-invite-email">Invite email address</label>
              <input id="team-invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.currentTarget.value)} placeholder="email@company.com" required />
              <label className="visually-hidden" htmlFor="team-invite-role">Role for invite</label>
              <select id="team-invite-role" value={inviteRoleId} onChange={(event) => setInviteRoleId(event.currentTarget.value)} required>
                <option value="">role…</option>
                {data.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select>
              <button className="team-primary-button" type="submit" disabled={busy || !inviteEmail || !inviteRoleId}>{busy ? "Working…" : "Invite"}</button>
            </div>
            <p>The invite link lands on your clipboard; share it with the new member.</p>
          </form>
        </section>

        <div className="team-role-column">
          <section className="team-card" aria-labelledby="team-roles-title">
            <div className="team-card-heading"><h2 id="team-roles-title">Roles</h2></div>
            {data.roles.length === 0 ? (
              <p className="team-empty">No roles were returned for this workspace.</p>
            ) : (
              <ul className="team-roles">
                {data.roles.map((role) => (
                  <li key={role.id}>
                    <span className="team-role-key">{role.key}</span>
                    <strong>{role.name}</strong>
                    <span className="team-role-permission-count">{role.permissions.includes("*") ? "all powers" : `${role.permissions.length} permissions`}</span>
                    {!role.isSystem && (
                      <button className="team-text-button" type="button" disabled={busy} onClick={() => setEditingPermissions({ roleId: role.id, selected: new Set(role.permissions) })}>Edit</button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editingPermissions && activeRole && (
              <section className="team-permissions-editor" aria-labelledby="team-permissions-title">
                <h3 id="team-permissions-title">Permissions · {activeRole.name}</h3>
                <div className="team-permission-list">
                  {[...data.catalog, "*"].map((permission) => (
                    <label key={permission}>
                      <input
                        type="checkbox"
                        checked={editingPermissions.selected.has(permission)}
                        disabled={busy}
                        onChange={(event) => {
                          const selected = new Set(editingPermissions.selected);
                          if (event.currentTarget.checked) selected.add(permission);
                          else selected.delete(permission);
                          setEditingPermissions({ ...editingPermissions, selected });
                        }}
                      />
                      <span>{permission}{permission === "*" ? " (everything)" : ""}</span>
                    </label>
                  ))}
                </div>
                <div className="team-editor-actions">
                  <button className="team-secondary-button" type="button" disabled={busy} onClick={() => setEditingPermissions(null)}>Cancel</button>
                  <button
                    className="team-primary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void post({ action: "setPermissions", roleId: editingPermissions.roleId, permissions: [...editingPermissions.selected] }, "Permission update");
                      setEditingPermissions(null);
                    }}
                  >Save permissions</button>
                </div>
              </section>
            )}
          </section>

          <form
            className="team-create-role"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newRoleName.trim();
              const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              if (!key) return;
              void post({ action: "createRole", key, name }, "Create role");
              setNewRoleName("");
            }}
          >
            <label htmlFor="team-new-role">New role</label>
            <div className="team-form-row">
              <input id="team-new-role" value={newRoleName} onChange={(event) => setNewRoleName(event.currentTarget.value)} placeholder="e.g. Bookkeeper" maxLength={60} />
              <button className="team-primary-button" type="submit" disabled={busy || !newRoleName.trim()}>{busy ? "Working…" : "＋ Create"}</button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
