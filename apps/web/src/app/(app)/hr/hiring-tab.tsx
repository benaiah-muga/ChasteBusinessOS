"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, CardTitle, ConfirmDialog, Dialog, EmptyState } from "@/components/ui";
import { IconUsers } from "@/components/icons";
import { formatMoney, statusTone } from "@/lib/format";

export interface OpeningRow {
  id: string;
  title: string;
  department: string | null;
  note: string | null;
  status: string;
  createdAt: string;
}
export interface ApplicantRow {
  id: string;
  openingId: string;
  name: string;
  stage: string;
  note: string | null;
}

const STAGES = ["applied", "screening", "interview", "offer"] as const;
const stageTone: Record<string, "neutral" | "amber" | "blue" | "violet" | "green" | "red"> = {
  applied: "neutral",
  screening: "amber",
  interview: "blue",
  offer: "violet",
  hired: "green",
  rejected: "red",
};

interface HiringTabProps {
  openings: OpeningRow[];
  applicants: ApplicantRow[];
  busy: boolean;
  post: (payload: Record<string, unknown>, label: string) => Promise<boolean>;
  onChanged: () => Promise<unknown>;
}

export function HiringTab({ openings, applicants, busy, post, onChanged }: HiringTabProps) {
  const [openingForm, setOpeningForm] = useState({ title: "", department: "", note: "" });
  const [applicantForm, setApplicantForm] = useState({ openingId: "", name: "", email: "", note: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [closeTarget, setCloseTarget] = useState<OpeningRow | null>(null);
  const [hireTarget, setHireTarget] = useState<ApplicantRow | null>(null);
  const [hireForm, setHireForm] = useState({ salary: "", leaveDays: "21" });
  const [rejectTarget, setRejectTarget] = useState<ApplicantRow | null>(null);

  const openOpenings = openings.filter((o) => o.status === "open");
  const activeId = selected ?? openOpenings[0]?.id ?? openings[0]?.id ?? null;
  const pipeline = useMemo(() => applicants.filter((a) => a.openingId === activeId), [applicants, activeId]);
  const countFor = (id: string) => applicants.filter((a) => a.openingId === id).length;

  async function createOpening(): Promise<void> {
    if (!openingForm.title.trim()) return;
    const ok = await post(
      { action: "createOpening", title: openingForm.title.trim(), department: openingForm.department.trim() || undefined, note: openingForm.note.trim() || undefined },
      `Open role "${openingForm.title.trim()}"`,
    );
    if (ok) {
      setOpeningForm({ title: "", department: "", note: "" });
      await onChanged();
    }
  }

  async function addApplicant(): Promise<void> {
    if (!applicantForm.openingId || !applicantForm.name.trim()) return;
    const ok = await post(
      {
        action: "addApplicant",
        openingId: applicantForm.openingId,
        name: applicantForm.name.trim(),
        email: applicantForm.email.trim() || undefined,
        note: applicantForm.note.trim() || undefined,
      },
      `Add ${applicantForm.name.trim()} to pipeline`,
    );
    if (ok) {
      setApplicantForm({ openingId: "", name: "", email: "", note: "" });
      await onChanged();
    }
  }

  async function moveStage(applicant: ApplicantRow, stage: string): Promise<void> {
    const ok = await post({ action: "moveApplicant", applicantId: applicant.id, stage }, `Move ${applicant.name} to ${stage}`);
    if (ok) await onChanged();
  }

  async function hire(): Promise<void> {
    if (!hireTarget || !hireForm.salary) return;
    const ok = await post(
      {
        action: "hireApplicant",
        applicantId: hireTarget.id,
        monthlySalaryMinor: Math.round(Number(hireForm.salary || "0") * 100),
        annualLeaveDays: Number(hireForm.leaveDays) > 0 ? Number(hireForm.leaveDays) : undefined,
      },
      `Hire ${hireTarget.name}`,
    );
    setHireTarget(null);
    if (ok) await onChanged();
  }

  return (
    <>
      <Card>
        <CardTitle>Open a role</CardTitle>
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void createOpening();
          }}
        >
          <div className="min-w-40 flex-1">
            <label htmlFor="opening-title" className="label">
              Role
            </label>
            <input
              id="opening-title"
              className="input"
              placeholder="e.g. Warehouse associate"
              value={openingForm.title}
              onChange={(e) => setOpeningForm({ ...openingForm, title: e.target.value })}
            />
          </div>
          <div className="min-w-36 flex-1">
            <label htmlFor="opening-dept" className="label">
              Department <span className="opacity-50">(optional)</span>
            </label>
            <input
              id="opening-dept"
              className="input"
              value={openingForm.department}
              onChange={(e) => setOpeningForm({ ...openingForm, department: e.target.value })}
            />
          </div>
          <div className="min-w-36 flex-1">
            <label htmlFor="opening-note" className="label">
              Note <span className="opacity-50">(optional)</span>
            </label>
            <input
              id="opening-note"
              className="input"
              value={openingForm.note}
              onChange={(e) => setOpeningForm({ ...openingForm, note: e.target.value })}
            />
          </div>
          <Button type="submit" loading={busy} disabled={!openingForm.title.trim()}>
            Open role
          </Button>
        </form>
      </Card>

      <Card>
        <CardTitle right={<span className="text-xs text-stone-500">{openOpenings.length} open</span>}>Openings</CardTitle>
        {openings.length === 0 ? (
          <EmptyState icon={<IconUsers />} title="No openings yet" hint="Open your first role above to start a pipeline." />
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Department</th>
                  <th className="text-right">Candidates</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {openings.map((o) => (
                  <tr key={o.id} className={o.id === activeId ? "bg-maroon-50/50" : undefined}>
                    <td className="font-medium text-stone-900">
                      <button type="button" className="cursor-pointer text-left hover:underline" onClick={() => setSelected(o.id)}>
                        {o.title}
                      </button>
                    </td>
                    <td className="text-stone-500">{o.department ?? "—"}</td>
                    <td className="tnum text-right">{countFor(o.id)}</td>
                    <td>
                      <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                    </td>
                    <td className="text-right">
                      {o.status === "open" && (
                        <Button tone="ghost" size="sm" disabled={busy} onClick={() => setCloseTarget(o)}>
                          Close
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {activeId && (
        <Card>
          <CardTitle>Pipeline — {openings.find((o) => o.id === activeId)?.title ?? "opening"}</CardTitle>
          <form
            className="mb-4 flex flex-wrap items-end gap-2 border-b border-stone-100 pb-4 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void addApplicant();
            }}
          >
            <div className="w-44">
              <label htmlFor="applicant-opening" className="label">
                Opening
              </label>
              <select
                id="applicant-opening"
                className="select"
                value={applicantForm.openingId || activeId}
                onChange={(e) => setApplicantForm({ ...applicantForm, openingId: e.target.value })}
              >
                {openOpenings.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-36 flex-1">
              <label htmlFor="applicant-name" className="label">
                Candidate
              </label>
              <input
                id="applicant-name"
                className="input"
                placeholder="Full name"
                value={applicantForm.name}
                onChange={(e) => setApplicantForm({ ...applicantForm, name: e.target.value })}
              />
            </div>
            <div className="min-w-36 flex-1">
              <label htmlFor="applicant-email" className="label">
                Email <span className="opacity-50">(optional)</span>
              </label>
              <input
                id="applicant-email"
                type="email"
                className="input"
                value={applicantForm.email}
                onChange={(e) => setApplicantForm({ ...applicantForm, email: e.target.value })}
              />
            </div>
            <Button type="submit" loading={busy} disabled={!applicantForm.name.trim()}>
              Add candidate
            </Button>
          </form>

          {pipeline.length === 0 ? (
            <EmptyState icon={<IconUsers />} title="No candidates yet" hint="Add candidates above; they advance through screening, interview, then offer." />
          ) : (
            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Stage</th>
                    <th>Added</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {pipeline.map((a) => {
                    const stageIdx = STAGES.indexOf(a.stage as (typeof STAGES)[number]);
                    const nextStage = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;
                    const active = a.stage !== "hired" && a.stage !== "rejected";
                    return (
                      <tr key={a.id}>
                        <td className="font-medium text-stone-900">{a.name}</td>
                        <td>
                          <Badge tone={stageTone[a.stage] ?? "neutral"}>{a.stage}</Badge>
                        </td>
                        <td className="text-stone-500">{a.note ?? "—"}</td>
                        <td className="whitespace-nowrap text-right">
                          {active && (
                            <span className="inline-flex gap-1.5">
                              {nextStage && (
                                <Button size="sm" tone="secondary" disabled={busy} onClick={() => void moveStage(a, nextStage)}>
                                  → {nextStage}
                                </Button>
                              )}
                              <Button size="sm" disabled={busy} onClick={() => setHireTarget(a)}>
                                Hire
                              </Button>
                              <Button
                                size="sm"
                                tone="ghost"
                                disabled={busy}
                                aria-label={`Reject ${a.name}`}
                                onClick={() => setRejectTarget(a)}
                              >
                                Reject
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-stone-400">Hiring converts the candidate into an employee with the role's department carried over.</p>
        </Card>
      )}

      <ConfirmDialog
        open={closeTarget !== null}
        onClose={() => setCloseTarget(null)}
        onConfirm={async () => {
          if (!closeTarget) return;
          const ok = await post({ action: "closeOpening", openingId: closeTarget.id }, `Close role "${closeTarget.title}"`);
          setCloseTarget(null);
          if (ok) await onChanged();
        }}
        title={`Close "${closeTarget?.title ?? ""}"?`}
        body="The role stops collecting applicants. Existing candidates stay in the pipeline."
        confirmLabel="Close role"
        busy={busy}
      />

      <ConfirmDialog
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        onConfirm={async () => {
          if (!rejectTarget) return;
          const ok = await post({ action: "moveApplicant", applicantId: rejectTarget.id, stage: "rejected" }, `Reject ${rejectTarget.name}`);
          setRejectTarget(null);
          if (ok) await onChanged();
        }}
        title={`Reject ${rejectTarget?.name ?? ""}?`}
        body="Rejected candidates leave the pipeline. Reversing isn't possible — start a fresh application instead."
        confirmLabel="Reject"
        busy={busy}
      />

      <Dialog
        open={hireTarget !== null}
        onClose={() => setHireTarget(null)}
        title={`Hire ${hireTarget?.name ?? ""}`}
        description="Creates a real employee on the same path as a direct hire, with the role's department carried over."
        footer={
          <>
            <Button tone="secondary" onClick={() => setHireTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void hire()} loading={busy} disabled={!hireForm.salary}>
              Hire
            </Button>
          </>
        }
      >
        <div className="flex items-end gap-2 text-sm">
          <div className="flex-1">
            <label htmlFor="hire-salary-minor" className="label">
              Monthly salary
            </label>
            <input
              id="hire-salary-minor"
              inputMode="decimal"
              className="input tnum"
              placeholder="4500.00"
              value={hireForm.salary}
              onChange={(e) => setHireForm({ ...hireForm, salary: e.target.value })}
            />
          </div>
          <div className="w-32">
            <label htmlFor="hire-leave-days" className="label">
              Leave days/yr
            </label>
            <input
              id="hire-leave-days"
              inputMode="numeric"
              className="input tnum"
              value={hireForm.leaveDays}
              onChange={(e) => setHireForm({ ...hireForm, leaveDays: e.target.value })}
            />
          </div>
        </div>
        {Number(hireForm.salary) > 0 && (
          <p className="mt-2 text-xs text-stone-500">
            {formatMoney(Math.round(Number(hireForm.salary) * 100))} per month · {hireForm.leaveDays} paid leave days
          </p>
        )}
      </Dialog>
    </>
  );
}
