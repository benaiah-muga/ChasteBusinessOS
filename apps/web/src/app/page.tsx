"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Workflow,
  XCircle,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { CustomersPanel } from "@/components/CustomersPanel";
import { DashboardCharts } from "@/components/dashboard/DashboardCharts";
import { QuickActionButton } from "@/components/QuickActionButton";
import { getApiClient } from "@/lib/api";

const api = getApiClient();

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(elapsed / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function humanizeAction(action: string): string {
  const parts = action.split(".");
  if (parts.length < 2) return action;
  const modulePart = parts[0];
  const verb = parts[parts.length - 1];
  const middle = parts.slice(1, -1).join(" ");
  const nice = `${verb[0]?.toUpperCase()}${verb.slice(1)} ${middle} (${modulePart})`;
  return nice.replace(/\s+/g, " ").trim();
}

function buildCustomerMonths(
  customers: { createdAt: string }[],
): { month: string; signups: number }[] {
  const now = new Date();
  const buckets = new Map<string, number>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toLocaleString("en", { month: "short" });
    buckets.set(key, 0);
  }
  const keys = Array.from(buckets.keys());
  for (const c of customers) {
    const created = new Date(c.createdAt);
    const monthsBack =
      (now.getFullYear() - created.getFullYear()) * 12 + (now.getMonth() - created.getMonth());
    if (monthsBack >= 0 && monthsBack < 6) {
      const key = keys[5 - monthsBack];
      if (key) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  return keys.map((month) => ({ month, signups: buckets.get(month) ?? 0 }));
}

function buildActivityDays(
  audit: { at: string }[],
): { day: string; events: number }[] {
  const now = new Date();
  const days: { day: string; events: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toLocaleDateString("en", { weekday: "short" });
    const count = audit.filter((e) => {
      const at = new Date(e.at);
      return (
        at.getFullYear() === d.getFullYear() &&
        at.getMonth() === d.getMonth() &&
        at.getDate() === d.getDate()
      );
    }).length;
    days.push({ day: key, events: count });
  }
  return days;
}

export default function HomePage() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof api.session>> | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [modules, setModules] = useState<Awaited<ReturnType<typeof api.listModules>> | null>(null);
  const [customers, setCustomers] = useState<
    Awaited<ReturnType<typeof api.listCustomers>>["items"]
  >([]);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.listAudit>>["items"]>([]);
  const [workflows, setWorkflows] = useState<
    Awaited<ReturnType<typeof api.listWorkflows>>["items"]
  >([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, s, m, cs, a, ws] = await Promise.all([
          api.health(),
          api.session(),
          api.listModules(),
          api.listCustomers().then((res) => res.items),
          api.listAudit().then((res) => res.items),
          api.listWorkflows().then((res) => res.items),
        ]);
        if (cancelled) return;
        setHealth(h);
        setSession(s);
        setModules(m);
        setCustomers(cs);
        setAudit(a);
        setWorkflows(ws);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to reach API");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const moduleCount = modules?.registered.length ?? 0;
  const installedCount = modules?.installed.filter((item) => item.enabled).length ?? 0;
  const disabledCount = modules?.installed.filter((item) => !item.enabled).length ?? 0;

  const customersByMonth = buildCustomerMonths(customers);
  const modulesByState = [
    { name: "Enabled", value: installedCount || 0.01 },
    { name: "Disabled", value: disabledCount || 0.01 },
    { name: "Registered", value: Math.max(moduleCount - installedCount, 0) || 0.01 },
  ];
  const activityByDay = buildActivityDays(audit);

  return (
    <AppShell subtitle="Your operational command center.">
      {error ? (
        <div className="card part-error">
          Cannot reach API. Start it with <span className="mono">pnpm --filter @chaste/api dev</span>.{" "}
          {error}
        </div>
      ) : null}

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="hero-console with-strip">
            <h2>Run your business from one governed surface.</h2>
            <p>Forms, quick actions, and the agent all work through the same validated workspace.</p>
            <div className="console-strip">
              <div className="console-cell">
                <span>Operator</span>
                <strong>{session?.displayName ?? "Offline"}</strong>
              </div>
              <div className="console-cell">
                <span>Workspace</span>
                <strong>{session?.orgName ?? "Local workspace"}</strong>
              </div>
              <div className="console-cell">
                <span>Autonomy</span>
                <strong>{session?.autonomy ?? "standard"}</strong>
              </div>
              <div className="console-cell">
                <span>System</span>
                <strong>{health?.version ? `v${health.version}` : "offline"}</strong>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h2>Quick actions</h2>
                <p className="muted">
                  Prompts open in the assistant and run within the current autonomy level.
                </p>
              </div>
            </div>
            <div className="quick-grid">
              <QuickActionButton
                icon="customer"
                title="Create customer"
                subtitle="CRM account record"
                prompt="Create customer Acme Ltd in Nairobi with email ops@acme.example"
              />
              <QuickActionButton
                icon="invoice"
                title="Create invoice"
                subtitle="Draft accounting invoice"
                prompt="Create invoice INV-1001 for 2500 USD"
              />
              <QuickActionButton
                icon="payroll"
                title="Prepare payroll"
                subtitle="Current employee base pay"
                prompt="Prepare payroll for July 2026"
              />
              <QuickActionButton
                icon="vendor"
                title="Create vendor"
                subtitle="Purchasing supplier"
                prompt="Create vendor Northline Supplies with email finance@northline.example"
              />
            </div>
          </section>

          <DashboardCharts
            customersByMonth={customersByMonth}
            modulesByState={modulesByState}
            activityByDay={activityByDay}
          />

          <CustomersPanel initialCustomers={customers} compact />
        </div>

        <div className="dashboard-main">
          <section className="card">
            <div className="section-head">
              <h2>System status</h2>
              <span className="badge accent">{health?.version ?? "dev"}</span>
            </div>
            <div className="metric-row">
              <div className="metric-card">
                <span>Registered modules</span>
                <strong>{moduleCount}</strong>
              </div>
              <div className="metric-card">
                <span>Enabled modules</span>
                <strong>{installedCount}</strong>
              </div>
              <div className="metric-card">
                <span>Customers</span>
                <strong>{customers.length}</strong>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h2>Active workflows</h2>
                <p className="muted">Registered multi-step processes you can run.</p>
              </div>
              <Workflow size={18} />
            </div>
            <div className="timeline">
              {workflows.length === 0 ? (
                <p className="empty-state">No workflows registered yet.</p>
              ) : (
                workflows.slice(0, 5).map((workflow) => (
                  <div key={workflow.id} className="timeline-item">
                    <div className="timeline-dot">
                      <Workflow size={15} />
                    </div>
                    <div>
                      <p>{workflow.name}</p>
                      <time>
                        {workflow.stepCount} steps · {workflow.createdBy}
                      </time>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h2>Recent activity</h2>
                <p className="muted">The latest actions recorded across this workspace.</p>
              </div>
              <ClipboardList size={18} />
            </div>
            <div className="timeline">
              {audit.length === 0 ? (
                <p className="empty-state">No audit events yet.</p>
              ) : (
                audit.slice(0, 8).map((event) => (
                  <div key={event.id} className="timeline-item">
                    <div className={event.success ? "timeline-dot" : "timeline-dot failed"}>
                      {event.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                    </div>
                    <div>
                      <p>{humanizeAction(event.action)}</p>
                      <time>
                        {relativeTime(event.at)} · {event.actorKind}
                      </time>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}