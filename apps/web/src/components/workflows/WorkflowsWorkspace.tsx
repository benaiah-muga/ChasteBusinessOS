"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  LayoutDashboard,
  Loader2,
  Play,
  Plus,
  Workflow,
  XCircle,
} from "lucide-react";
import { BarSeries, ChartCard } from "@/components/ui/Chart";
import { Kpi } from "@/components/ui/Kpi";
import { Tab, TabPanel, Tabs } from "@/components/ui/Tabs";
import { getApiClient } from "@/lib/api";

type WorkflowSummary = {
  id: string;
  name: string;
  description: string;
  trigger: unknown;
  createdBy: string;
  stepCount: number;
};

type RunResult = {
  success?: boolean;
  runId?: string;
  status?: string;
  stepResults?: { stepId: string; status: string; error?: string }[];
  error?: string;
  pendingApproval?: { stepId: string; description: string };
};

export function WorkflowsWorkspace({ initialWorkflows }: { initialWorkflows: WorkflowSummary[] }) {
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [tab, setTab] = useState("overview");
  const [selectedId, setSelectedId] = useState<string | null>(initialWorkflows[0]?.id ?? null);
  const [detail, setDetail] = useState<{
    id: string;
    name: string;
    description: string;
    steps: { id: string; type: string; command?: string; description?: string }[];
  } | null>(null);
  const [buildText, setBuildText] = useState(
    "When a new customer is created, create a draft invoice and notify sales for approval",
  );
  const [runInput, setRunInput] = useState("{}");
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await getApiClient().listWorkflows();
      setWorkflows(res.items);
    } catch {
      /* keep */
    }
  }

  async function loadDetail(id: string) {
    setSelectedId(id);
    setMsg(null);
    try {
      const wf = await getApiClient().getWorkflow(id);
      setDetail({
        id: wf.id,
        name: wf.name,
        description: wf.description,
        steps: (wf.steps as { id: string; type: string; command?: string; description?: string }[]) ?? [],
      });
      setTab("detail");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to load workflow");
    }
  }

  async function buildWorkflow() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await getApiClient().buildWorkflowFromText(buildText);
      if (res.error) {
        setMsg(String(res.error));
        return;
      }
      const wf = res.workflow ?? (res.id ? { id: res.id } : null);
      if (!wf?.id) {
        setMsg("Builder returned no workflow");
        return;
      }
      setMsg(`Workflow built: ${wf.id}`);
      await refresh();
      await loadDetail(wf.id);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to build workflow");
    } finally {
      setBusy(false);
    }
  }

  async function runSelected() {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    setLastRun(null);
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(runInput || "{}") as Record<string, unknown>;
    } catch {
      setMsg("Run input must be valid JSON");
      setBusy(false);
      return;
    }
    try {
      const res = await getApiClient().runWorkflow(selectedId, input);
      setLastRun(res as RunResult);
      setMsg(res.status === "completed" || (res as RunResult).success ? "Run completed" : "Run finished with status");
      setTab("runs");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to execute workflow");
    } finally {
      setBusy(false);
    }
  }

  // seed a deterministic sample workflow without AI when empty
  async function createSample() {
    setBusy(true);
    setMsg(null);
    try {
      const def = {
        id: `wf_sample_${Date.now().toString(36)}`,
        name: "Customer onboarding sample",
        description: "Create a customer, then draft an invoice in one run",
        trigger: "manual" as const,
        createdBy: "user" as const,
        createdAt: new Date().toISOString(),
        steps: [
          {
            id: "create_customer",
            type: "command" as const,
            command: "crm.customer.create",
            description: "Create customer from input",
            input: {
              name: "${customerName}",
              email: "${email}",
              city: "${city}",
            },
            onError: "bail" as const,
          },
          {
            id: "create_invoice",
            type: "command" as const,
            command: "acc.invoice.create",
            description: "Create draft invoice",
            input: {
              number: "${invoiceNumber}",
              total: "${total}",
              currency: "USD",
            },
            onError: "bail" as const,
          },
        ],
      };
      await getApiClient().saveWorkflow(def);
      setMsg("Sample workflow saved");
      setRunInput(
        JSON.stringify(
          {
            customerName: "Acme Sample Ltd",
            email: "ops@acme-sample.example",
            city: "Nairobi",
            invoiceNumber: `INV-S-${Date.now().toString().slice(-4)}`,
            total: 1500,
          },
          null,
          2,
        ),
      );
      await refresh();
      await loadDetail(def.id);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to save sample");
    } finally {
      setBusy(false);
    }
  }

  const byCreator = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of workflows) m.set(String(w.createdBy), (m.get(String(w.createdBy)) ?? 0) + 1);
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [workflows]);

  const stepTotals = useMemo(
    () => workflows.map((w) => ({ name: w.name.slice(0, 18), steps: w.stepCount })),
    [workflows],
  );

  return (
    <Tabs defaultValue="overview" value={tab} onValueChange={setTab}>
      <Tab label="Overview" icon={LayoutDashboard} value="overview" />
      <Tab label="Registry" icon={Workflow} value="registry" count={workflows.length} />
      <Tab label="Builder" icon={Plus} value="builder" />
      <Tab label="Detail" icon={Workflow} value="detail" />
      <Tab label="Runs" icon={Play} value="runs" />

      <TabPanel value="overview">
        <div className="stack">
          {msg ? <p className="muted">{msg}</p> : null}
          <div className="kpi-grid">
            <Kpi label="Workflows" value={workflows.length} icon={Workflow} />
            <Kpi
              label="Total steps"
              value={workflows.reduce((s, w) => s + w.stepCount, 0)}
              icon={CheckCircle2}
            />
            <Kpi label="AI built" value={workflows.filter((w) => w.createdBy === "ai").length} icon={Workflow} />
            <Kpi label="Manual" value={workflows.filter((w) => w.createdBy === "user").length} icon={Plus} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <ChartCard title="Steps per workflow" height={260}>
              <BarSeries
                data={stepTotals.length ? stepTotals : [{ name: "None", steps: 0 }]}
                xKey="name"
                keys={[{ key: "steps", label: "Steps" }]}
              />
            </ChartCard>
            <ChartCard title="By creator" height={260}>
              <BarSeries
                data={byCreator.length ? byCreator : [{ name: "None", value: 0 }]}
                xKey="name"
                keys={[{ key: "value", label: "Workflows" }]}
              />
            </ChartCard>
          </div>
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={createSample}>
              <Plus size={15} />
              Create sample workflow
            </button>
            <button className="btn secondary" type="button" onClick={refresh}>
              Refresh
            </button>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="registry">
        <div className="stack">
          {workflows.length === 0 ? (
            <div className="empty-state">
              <div className="icon">
                <Workflow size={20} />
              </div>
              <h3>No workflows yet</h3>
              <p>Build one from a process description or create the sample workflow.</p>
            </div>
          ) : (
            <div className="grid">
              {workflows.map((workflow) => (
                <article key={workflow.id} className="card stack">
                  <div className="section-head">
                    <div>
                      <h2>{workflow.name}</h2>
                      <p className="muted">{workflow.description}</p>
                    </div>
                    <Workflow size={20} />
                  </div>
                  <div className="metric-row">
                    <div className="metric-card">
                      <span>Steps</span>
                      <strong>{workflow.stepCount}</strong>
                    </div>
                    <div className="metric-card">
                      <span>Creator</span>
                      <strong style={{ fontSize: "1rem" }}>{workflow.createdBy}</strong>
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn secondary" type="button" onClick={() => loadDetail(workflow.id)}>
                      Open detail
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setSelectedId(workflow.id);
                        await loadDetail(workflow.id);
                        await runSelected();
                      }}
                    >
                      <Play size={15} />
                      Run
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </TabPanel>

      <TabPanel value="builder">
        <section className="card stack">
          <h2>Build from description</h2>
          <p className="muted">
            Describe a multi-step process. When AI is configured, the builder generates a runnable workflow. You can also
            save a sample workflow without AI.
          </p>
          <label>
            Process description
            <textarea
              rows={5}
              value={buildText}
              onChange={(e) => setBuildText(e.target.value)}
              style={{ minHeight: 120, padding: 12, resize: "vertical" }}
            />
          </label>
          <div className="row">
            <button className="btn" type="button" disabled={busy || !buildText.trim()} onClick={buildWorkflow}>
              {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              Build with AI
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={createSample}>
              Save sample workflow
            </button>
          </div>
          {msg ? <p className={msg.toLowerCase().includes("fail") ? "error" : "muted"}>{msg}</p> : null}
        </section>
      </TabPanel>

      <TabPanel value="detail">
        {!detail ? (
          <div className="empty-state">
            <div className="icon">
              <Workflow size={20} />
            </div>
            <h3>Select a workflow</h3>
            <p>Open one from the registry to inspect steps and run it.</p>
          </div>
        ) : (
          <section className="card stack">
            <div className="section-head">
              <div>
                <h2>{detail.name}</h2>
                <p className="muted">{detail.description}</p>
              </div>
              <span className="badge accent">{detail.steps.length} steps</span>
            </div>
            <div className="timeline">
              {detail.steps.map((step, idx) => (
                <div key={step.id} className="timeline-item">
                  <div className="timeline-dot">
                    <span style={{ fontSize: 11, fontWeight: 800 }}>{idx + 1}</span>
                  </div>
                  <div>
                    <p>
                      <strong>{step.description ?? step.id}</strong>
                    </p>
                    <time>
                      {step.type}
                      {step.command ? ` · ${step.command}` : ""}
                    </time>
                  </div>
                </div>
              ))}
            </div>
            <label>
              Run input (JSON)
              <textarea
                rows={6}
                value={runInput}
                onChange={(e) => setRunInput(e.target.value)}
                style={{ minHeight: 120, padding: 12, fontFamily: "var(--mono)", fontSize: "0.85rem" }}
              />
            </label>
            <button className="btn" type="button" disabled={busy} onClick={runSelected}>
              {busy ? <Loader2 size={15} /> : <Play size={15} />}
              Execute workflow
            </button>
            {msg ? <p className="muted">{msg}</p> : null}
          </section>
        )}
      </TabPanel>

      <TabPanel value="runs">
        <section className="card stack">
          <h2>Last run result</h2>
          {!lastRun ? (
            <div className="empty-state">
              <div className="icon">
                <Play size={20} />
              </div>
              <h3>No runs yet</h3>
              <p>Execute a workflow from the detail tab to see step results here.</p>
            </div>
          ) : (
            <>
              <div className="row">
                <span className={`badge ${lastRun.success === false ? "danger" : "accent"}`}>
                  {lastRun.success === false ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                  {lastRun.status ?? (lastRun.success ? "completed" : "finished")}
                </span>
                {lastRun.runId ? <span className="muted">Run {lastRun.runId}</span> : null}
              </div>
              {lastRun.error ? <p className="error">{lastRun.error}</p> : null}
              {lastRun.pendingApproval ? (
                <p className="muted">
                  Pending approval on step {lastRun.pendingApproval.stepId}: {lastRun.pendingApproval.description}
                </p>
              ) : null}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Status</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(lastRun.stepResults ?? []).map((s) => (
                      <tr key={s.stepId}>
                        <td>{s.stepId}</td>
                        <td>{s.status}</td>
                        <td>{s.error ?? <span className="placeholder">none</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </TabPanel>
    </Tabs>
  );
}
