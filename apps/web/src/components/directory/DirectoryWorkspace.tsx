"use client";

import { useMemo, useState } from "react";
import { Building2, Mail, MapPin, Pencil, Phone, Plus, Trash2, User, Users } from "lucide-react";
import type { BusinessPartner } from "@chaste/api-client";
import { getApiClient } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Kpi } from "@/components/ui/Kpi";

type Props = { initialPartners: BusinessPartner[] };

export function DirectoryWorkspace({ initialPartners }: Props) {
  const [partners, setPartners] = useState(initialPartners);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BusinessPartner | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BusinessPartner | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await getApiClient().listBusinessPartners();
      setPartners(res.items);
    } catch {
      /* keep */
    }
  }

  const visible = useMemo(() => {
    let list = filter === "all" ? partners : partners.filter((p) => p.type === filter);
    if (q.trim()) {
      const term = q.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.email ?? "").toLowerCase().includes(term) ||
          (p.city ?? "").toLowerCase().includes(term) ||
          (p.country ?? "").toLowerCase().includes(term),
      );
    }
    return list;
  }, [partners, filter, q]);

  const peopleCount = partners.filter((p) => p.type === "person").length;
  const orgCount = partners.filter((p) => p.type === "organization").length;

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setErr(null);
    try {
      await getApiClient().deleteBusinessPartner(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to archive partner");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack">
      <div className="kpi-grid">
        <Kpi label="Business partners" value={partners.length} icon={Users} />
        <Kpi label="People" value={peopleCount} icon={User} />
        <Kpi label="Organizations" value={orgCount} icon={Building2} />
        <Kpi label="With email" value={partners.filter((p) => !!p.email).length} icon={Mail} />
      </div>

      <section className="card stack">
        <div className="toolbar">
          <div className="page-title-block" style={{ flex: 1 }}>
            <h2 style={{ margin: 0 }}>Directory</h2>
            <p className="muted">Customers, vendors, employees &amp; contacts</p>
          </div>
          <select
            className="search"
            style={{ width: "auto" }}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter by type"
          >
            <option value="all">All types</option>
            <option value="person">People</option>
            <option value="organization">Organizations</option>
          </select>
          <input
            className="search"
            type="search"
            placeholder="Search by name, email, location"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn secondary" type="button" onClick={refresh}>
            Refresh
          </button>
          <button className="btn" type="button" onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add
          </button>
        </div>

        {err ? <p className="error">{err}</p> : null}

        {visible.length === 0 ? (
          <div className="empty-state">
            <div className="icon"><Users size={20} /></div>
            <h3>No business partners yet</h3>
            <p>Add a person or organization to start linking customers, vendors, and employees.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Location</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      <span className="badge accent">
                        {p.type === "organization" ? (
                          <span className="row" style={{ gap: 4 }}>
                            <Building2 size={12} /> Org
                          </span>
                        ) : (
                          <span className="row" style={{ gap: 4 }}>
                            <User size={12} /> Person
                          </span>
                        )}
                      </span>
                    </td>
                    <td>
                      {p.email ? (
                        <span className="row" style={{ gap: 4 }}>
                          <Mail size={12} /> {p.email}
                        </span>
                      ) : (
                        <span className="placeholder">—</span>
                      )}
                    </td>
                    <td>
                      {p.phone ? (
                        <span className="row" style={{ gap: 4 }}>
                          <Phone size={12} /> {p.phone}
                        </span>
                      ) : (
                        <span className="placeholder">—</span>
                      )}
                    </td>
                    <td>
                      {p.city || p.country ? (
                        <span className="row" style={{ gap: 4 }}>
                          <MapPin size={12} /> {[p.city, p.country].filter(Boolean).join(", ")}
                        </span>
                      ) : (
                        <span className="placeholder">—</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-btn tip"
                          data-tip="Edit"
                          type="button"
                          aria-label="Edit partner"
                          onClick={() => setEditTarget(p)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-btn tip"
                          data-tip="Archive"
                          type="button"
                          aria-label="Archive partner"
                          onClick={() => setDeleteTarget(p)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add business partner">
        <BusinessPartnerForm
          onDone={async () => {
            await refresh();
            setAddOpen(false);
          }}
          onCancel={() => setAddOpen(false)}
        />
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit business partner">
        {editTarget ? (
          <BusinessPartnerForm
            partner={editTarget}
            onDone={async () => {
              await refresh();
              setEditTarget(null);
            }}
            onCancel={() => setEditTarget(null)}
          />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Archive business partner"
        message={`Archive "${deleteTarget?.name ?? ""}"? Linked role records (customer, vendor, employee) keep their history.`}
        confirmLabel="Archive"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function BusinessPartnerForm({
  partner,
  onDone,
  onCancel,
}: {
  partner?: BusinessPartner;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const api = getApiClient();
  const [type, setType] = useState<"person" | "organization">(partner?.type ?? "person");
  const [name, setName] = useState(partner?.name ?? "");
  const [email, setEmail] = useState(partner?.email ?? "");
  const [phone, setPhone] = useState(partner?.phone ?? "");
  const [city, setCity] = useState(partner?.city ?? "");
  const [country, setCountry] = useState(partner?.country ?? "");
  const [notes, setNotes] = useState(partner?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        name,
        email: email || undefined,
        phone: phone || undefined,
        city: city || undefined,
        country: country || undefined,
        notes: notes || undefined,
      };
      if (partner) {
        await api.updateBusinessPartner(partner.id, payload);
      } else {
        await api.createBusinessPartner({ type, ...payload });
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save partner");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {!partner ? (
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="person">Person (individual)</option>
            <option value="organization">Organization (company)</option>
          </select>
        </label>
      ) : null}
      <label className="field">
        <span>Name</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "organization" ? "Acme Ltd" : "Jane Smith"} />
      </label>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="field">
          <span>City</span>
          <input value={city} onChange={(e) => setCity(e.target.value)} />
        </label>
        <label className="field">
          <span>Country</span>
          <input value={country} onChange={(e) => setCountry(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {err ? <p className="error">{err}</p> : null}
      <div className="form-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : partner ? "Save changes" : "Create partner"}
        </button>
        {onCancel ? (
          <button className="btn secondary" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
