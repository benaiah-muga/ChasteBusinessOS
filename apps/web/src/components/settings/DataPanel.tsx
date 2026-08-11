"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, Database, LockKeyhole, RotateCcw, ShieldCheck } from "lucide-react";
import { getApiClient } from "@/lib/api";
import type { BackupProviderStatus, BackupRow } from "@chaste/api-client";

const STATUS_PILL: Record<string, string> = {
  queued: "",
  running: "accent",
  success: "success",
  failed: "danger",
};

const STATUS_FILTERS = ["", "queued", "running", "success", "failed"] as const;

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DataPanel() {
  const [provider, setProvider] = useState<BackupProviderStatus | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const [providerRes, listRes] = await Promise.all([
      getApiClient().getBackupProviderStatus(),
      getApiClient().listBackups(status ? { status } : {}),
    ]);
    setProvider(providerRes);
    setBackups(listRes.backups);
  }, [status]);

  useEffect(() => {
    load().catch(() => setErr("Failed to load backups"));
  }, [load]);

  async function createBackup() {
    setErr("");
    setNotice("");
    setBusy(true);
    try {
      await getApiClient().createBackup();
      setNotice("Backup queued — the worker will snapshot, encrypt, and store it.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to enqueue backup");
    } finally {
      setBusy(false);
    }
  }

  async function restore(backupId: string) {
    if (!window.confirm("Restore this backup over the current organization data?")) return;
    setErr("");
    setNotice("");
    setBusy(true);
    try {
      const res = await getApiClient().restoreBackup(backupId);
      setNotice(
        `Restored ${res.data.rowCount} rows across ${res.data.restoredTables} tables.`,
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to restore backup");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Data &amp; backups</h2>
            <p className="muted">Snapshots are AES-256-GCM encrypted before storage.</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className={`badge ${provider ? STATUS_PILL[provider.provider] ?? "" : ""}`}>
              <Database size={14} /> {provider ? provider.provider : "…"}
            </span>
            <span className={`badge ${provider?.encryptionConfigured ? "success" : "danger"}`}>
              {provider?.encryptionConfigured ? <LockKeyhole size={14} /> : <ShieldCheck size={14} />}
              {provider?.encryptionConfigured ? "Encrypted" : "No encryption key"}
            </span>
          </div>
        </div>
        {provider?.provider === "none" ? (
          <p className="muted small">
            No object store configured — backups will fail until you set <code>CHASTE_S3_BUCKET</code> (with AWS
            credentials) or <code>CHASTE_BACKUP_DIR</code> (local filesystem). Set{" "}
            <code>CHASTE_BACKUP_KEY</code> to a 32-byte hex value to enable encryption.
          </p>
        ) : null}
        {!provider?.encryptionConfigured ? (
          <p className="muted small">
            Set <code>CHASTE_BACKUP_KEY</code> to a 32-byte hex value before creating backups. Restores refuse
            backups encrypted with a different key.
          </p>
        ) : null}
      </section>

      <section className="card stack">
        <div className="section-head">
          <div>
            <h3>Backups</h3>
            <p className="muted">{backups.length} jobs in the current filter.</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div className="segmented">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f || "all"}
                  className={status === f ? "selected" : ""}
                  type="button"
                  onClick={() => setStatus(f)}
                >
                  {f || "All"}
                </button>
              ))}
            </div>
            <button className="btn" type="button" onClick={createBackup} disabled={busy}>
              <Archive size={15} /> {busy ? "Working…" : "Create backup"}
            </button>
          </div>
        </div>
        {err ? <span className="error">{err}</span> : null}
        {notice ? <span className="muted small">{notice}</span> : null}
        {backups.length === 0 ? (
          <div className="empty-state">
            <Database size={26} />
            <p>No backups yet.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Size</th>
                  <th>Storage key</th>
                  <th>Created</th>
                  <th>Completed</th>
                  <th>Error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <span className={`badge ${STATUS_PILL[b.status] ?? ""}`}>{b.status}</span>
                    </td>
                    <td className="muted small">{b.provider ?? "—"}</td>
                    <td className="muted small">{fmtBytes(b.sizeBytes)}</td>
                    <td className="muted small" title={b.storageKey ?? undefined}>
                      {b.storageKey ? b.storageKey.slice(-40) : "—"}
                    </td>
                    <td className="muted small">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="muted small">{b.completedAt ? new Date(b.completedAt).toLocaleString() : "—"}</td>
                    <td className="muted small" title={b.error ?? undefined}>
                      {b.error ? b.error.slice(0, 40) : "—"}
                    </td>
                    <td>
                      {b.status === "success" ? (
                        <button className="btn secondary btn-sm" type="button" onClick={() => restore(b.id)}>
                          <RotateCcw size={14} /> Restore
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
