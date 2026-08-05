"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import type { Contact, Customer, Interaction } from "@chaste/api-client";
import { getApiClient } from "@/lib/api";
import { ContactsPanel } from "./ContactsPanel";
import { CustomerForm } from "./CustomerForm";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timeline } from "@/components/ui/Timeline";

const STATUS_OPTIONS = [
  "lead",
  "prospect",
  "qualified",
  "negotiable",
  "won",
  "active",
  "churned",
  "lost",
] as const;

export function CustomerDetail({
  initialCustomer,
  initialContacts,
  initialInteractions,
}: {
  initialCustomer: Customer;
  initialContacts: Contact[];
  initialInteractions: Interaction[];
}) {
  const api = getApiClient();
  const [customer, setCustomer] = useState(initialCustomer);
  const [contacts] = useState(initialContacts);
  const [interactions, setInteractions] = useState(initialInteractions);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteKind, setNoteKind] = useState<"note" | "email" | "call" | "meeting">("note");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function changeStatus(next: string) {
    if (next === customer.status) return;
    setStatusErr(null);
    try {
      const updated = await api.setCustomerStatus(customer.id, {
        status: next,
        note: statusNote || undefined,
      });
      setCustomer(updated);
      setStatusNote("");
      const res = await api.listInteractions(customer.id);
      setInteractions(res.items);
    } catch (e) {
      setStatusErr(e instanceof Error ? e.message : "Failed to change status");
    }
  }

  async function logNote(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setNoteBusy(true);
    setNoteErr(null);
    try {
      await api.logInteraction(customer.id, { kind: noteKind, summary: note.trim() });
      setNote("");
      const res = await api.listInteractions(customer.id);
      setInteractions(res.items);
    } catch (e) {
      setNoteErr(e instanceof Error ? e.message : "Failed to log activity");
    } finally {
      setNoteBusy(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.deleteCustomer(customer.id);
      window.location.href = "/crm";
    } catch (e) {
      setStatusErr(e instanceof Error ? e.message : "Failed to delete customer");
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack">
      <div className="crumb">
        <Link href="/crm">CRM</Link>
        <span>/</span>
        <span>{customer.name}</span>
      </div>

      <section className="card stack">
        <div className="detail-header">
          <div>
            <h1>{customer.name}</h1>
            <div className="detail-headline">
              {customer.city ? `${customer.city}` : null}
              {customer.city && customer.country ? ", " : null}
              {customer.country ?? null}
              {customer.email ? ` · ${customer.email}` : null}
            </div>
            <div style={{ marginTop: 8 }}>
              <StatusBadge status={customer.status ?? "lead"} />
            </div>
          </div>
          <div className="detail-actions">
            <button className="btn secondary btn-sm" type="button" onClick={() => setEditOpen(true)}>
              <Pencil size={14} /> Edit
            </button>
            <button className="btn danger btn-sm" type="button" onClick={() => setDeleteOpen(true)}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </div>

        <div className="info-grid">
          <div className="info-item">
            <div className="k">Email</div>
            <div className="v">{customer.email ?? <span className="placeholder">not set</span>}</div>
          </div>
          <div className="info-item">
            <div className="k">City</div>
            <div className="v">{customer.city ?? <span className="placeholder">not set</span>}</div>
          </div>
          <div className="info-item">
            <div className="k">Country</div>
            <div className="v">{customer.country ?? <span className="placeholder">not set</span>}</div>
          </div>
          <div className="info-item">
            <div className="k">Customer since</div>
            <div className="v">{new Date(customer.createdAt).toLocaleDateString()}</div>
          </div>
        </div>

        <div>
          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Pipeline status</h3>
          <div className="status-picker">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                className={`btn btn-sm${s === customer.status ? "" : " secondary"}`}
                type="button"
                onClick={() => changeStatus(s)}
              >
                {s.replace(/_/g, " ")}
              </button>
            ))}
          </div>
          <input
            className="search"
            style={{ marginTop: 8, maxWidth: 360 }}
            placeholder="Optional note for this transition"
            value={statusNote}
            onChange={(e) => setStatusNote(e.target.value)}
          />
          {statusErr ? <p className="error">{statusErr}</p> : null}
        </div>
      </section>

      <ContactsPanel customerId={customer.id} initialContacts={contacts} />

      <section className="card stack">
        <div className="section-head">
          <div>
            <h2>Activity</h2>
            <p className="muted">Timeline of interactions and changes.</p>
          </div>
        </div>
        <form className="stack" onSubmit={logNote} style={{ marginBottom: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <select
              className="search"
              style={{ width: "auto" }}
              value={noteKind}
              onChange={(e) => setNoteKind(e.target.value as typeof noteKind)}
            >
              <option value="note">Note</option>
              <option value="email">Email</option>
              <option value="call">Call</option>
              <option value="meeting">Meeting</option>
            </select>
            <input
              className="search"
              style={{ flex: 1 }}
              placeholder="Log an activity…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="btn btn-sm" type="submit" disabled={noteBusy || !note.trim()}>
              {noteBusy ? "Saving…" : "Log"}
            </button>
          </div>
          {noteErr ? <p className="error">{noteErr}</p> : null}
        </form>
        <Timeline items={interactions} />
      </section>

      <Link href="/crm" className="btn secondary btn-sm" style={{ width: "fit-content" }}>
        <ArrowLeft size={14} /> Back to CRM
      </Link>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit customer">
        <CustomerForm
          mode="edit"
          customer={customer}
          onDone={(c) => {
            setCustomer(c);
            setEditOpen(false);
          }}
          onCancel={() => setEditOpen(false)}
        />
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete customer"
        message={`Archive "${customer.name}"? History is preserved but the customer is hidden from lists.`}
        confirmLabel="Archive"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
