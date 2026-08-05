"use client";

import { useState } from "react";
import { Mail, Phone, Plus, Trash2, User } from "lucide-react";
import type { Contact } from "@chaste/api-client";
import { getApiClient } from "@/lib/api";

export function ContactsPanel({
  customerId,
  initialContacts,
}: {
  customerId: string;
  initialContacts: Contact[];
}) {
  const api = getApiClient();
  const [contacts, setContacts] = useState(initialContacts);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createContact(customerId, {
        name,
        role: role || undefined,
        email: email || undefined,
        phone: phone || undefined,
      });
      setContacts((prev) => [created, ...prev]);
      setName("");
      setRole("");
      setEmail("");
      setPhone("");
      setAdding(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add contact");
    } finally {
      setBusy(false);
    }
  }

  async function removeContact(id: string, label: string) {
    if (!confirm(`Remove contact "${label}"?`)) return;
    try {
      await api.deleteContact(id);
      setContacts((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to remove contact");
    }
  }

  return (
    <section className="card stack">
      <div className="section-head">
        <div>
          <h2>Contacts</h2>
          <p className="muted">People at this account.</p>
        </div>
        {!adding ? (
          <button className="btn secondary btn-sm" type="button" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add contact
          </button>
        ) : null}
      </div>

      {adding ? (
        <form className="stack" onSubmit={addContact}>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="field">
              <span>Name</span>
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Role</span>
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Procurement" />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Phone</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>
          {err ? <p className="error">{err}</p> : null}
          <div className="form-actions">
            <button className="btn btn-sm" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add"}
            </button>
            <button className="btn secondary btn-sm" type="button" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {contacts.length === 0 && !adding ? (
        <div className="empty-state">
          <div className="icon"><User size={20} /></div>
          <h3>No contacts</h3>
          <p>Add the people you talk to at this account.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Phone</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.role ?? <span className="placeholder">—</span>}</td>
                  <td>
                    {c.email ? (
                      <span className="row" style={{ gap: 4 }}>
                        <Mail size={12} /> {c.email}
                      </span>
                    ) : (
                      <span className="placeholder">—</span>
                    )}
                  </td>
                  <td>
                    {c.phone ? (
                      <span className="row" style={{ gap: 4 }}>
                        <Phone size={12} /> {c.phone}
                      </span>
                    ) : (
                      <span className="placeholder">—</span>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-btn tip"
                        data-tip="Remove"
                        type="button"
                        aria-label="Remove contact"
                        onClick={() => removeContact(c.id, c.name)}
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
  );
}
