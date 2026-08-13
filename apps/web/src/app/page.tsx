"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Workflow,
  XCircle,
  Sparkles,
  Zap,
  Users,
  Package,
  TrendingUp,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { CustomersPanel } from "@/components/CustomersPanel";
import { DashboardCharts } from "@/components/dashboard/DashboardCharts";
import { QuickActionButton } from "@/components/QuickActionButton";
import { getApiClient } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
        <div className="bg-[var(--danger-soft)] border border-[var(--danger-muted)] text-[var(--danger-primary)] rounded-lg p-4 mb-6">
          <strong>Cannot reach API.</strong> Start it with{" "}
          <code className="bg-black/10 px-2 py-0.5 rounded text-sm font-mono">pnpm --filter @chaste/api dev</code>.{" "}
          {error}
        </div>
      ) : null}

      <div className="dashboard-grid">
        <div className="dashboard-main">
          {/* Hero Section */}
          <section className="mb-8">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-primary-hover)] p-8 text-white shadow-xl">
              <div className="absolute top-0 right-0 -mt-8 -mr-8 h-48 w-48 rounded-full bg-white/10 blur-3xl" />
              <div className="absolute bottom-0 left-0 -mb-8 -ml-8 h-48 w-48 rounded-full bg-white/10 blur-3xl" />
              
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles size={20} className="text-white/80" />
                  <span className="text-sm font-medium text-white/80">Welcome back</span>
                </div>
                
                <h2 className="text-2xl md:text-3xl font-bold mb-3">
                  Run your business from one governed surface.
                </h2>
                <p className="text-white/80 max-w-2xl mb-6">
                  Forms, quick actions, and the agent all work through the same validated workspace.
                </p>
                
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-white/20">
                    <div className="text-xs text-white/70 mb-1">Operator</div>
                    <div className="font-semibold truncate">{session?.displayName ?? "Offline"}</div>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-white/20">
                    <div className="text-xs text-white/70 mb-1">Workspace</div>
                    <div className="font-semibold truncate">{session?.orgName ?? "Local workspace"}</div>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-white/20">
                    <div className="text-xs text-white/70 mb-1">Autonomy</div>
                    <div className="font-semibold truncate">{session?.autonomy ?? "standard"}</div>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4 border border-white/20">
                    <div className="text-xs text-white/70 mb-1">System</div>
                    <div className="font-semibold truncate">{health?.version ? `v${health.version}` : "offline"}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Quick Actions */}
          <section className="mb-8">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Quick actions</CardTitle>
                  <CardDescription>
                    Prompts open in the assistant and run within the current autonomy level.
                  </CardDescription>
                </div>
                <Badge variant="accent" dot>AI Powered</Badge>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>
          </section>

          <DashboardCharts
            customersByMonth={customersByMonth}
            modulesByState={modulesByState}
            activityByDay={activityByDay}
          />

          <CustomersPanel initialCustomers={customers} compact />
        </div>

        {/* Sidebar */}
        <div className="dashboard-sidebar space-y-6">
          {/* System Status */}
          <Card>
            <CardHeader>
              <CardTitle>System status</CardTitle>
              <Badge variant="success" dot>{health?.version ?? "dev"}</Badge>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center p-3 rounded-lg bg-[var(--bg-subtle)]">
                  <div className="text-2xl font-bold text-[var(--text-primary)]">{moduleCount}</div>
                  <div className="text-xs text-[var(--text-secondary)] mt-1">Modules</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-[var(--bg-subtle)]">
                  <div className="text-2xl font-bold text-[var(--text-primary)]">{installedCount}</div>
                  <div className="text-xs text-[var(--text-secondary)] mt-1">Enabled</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-[var(--bg-subtle)]">
                  <div className="text-2xl font-bold text-[var(--text-primary)]">{customers.length}</div>
                  <div className="text-xs text-[var(--text-secondary)] mt-1">Customers</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Active Workflows */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Workflow size={18} className="text-[var(--text-tertiary)]" />
                <CardTitle>Active workflows</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="timeline">
                {workflows.length === 0 ? (
                  <div className="text-center py-8 text-[var(--text-tertiary)]">
                    <Workflow size={32} className="mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No workflows registered yet.</p>
                  </div>
                ) : (
                  workflows.slice(0, 5).map((workflow) => (
                    <div key={workflow.id} className="timeline-item">
                      <div className="timeline-dot">
                        <Workflow size={15} />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{workflow.name}</p>
                        <time className="text-xs text-[var(--text-tertiary)]">
                          {workflow.stepCount} steps · {workflow.createdBy}
                        </time>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ClipboardList size={18} className="text-[var(--text-tertiary)]" />
                <CardTitle>Recent activity</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="timeline">
                {audit.length === 0 ? (
                  <div className="text-center py-8 text-[var(--text-tertiary)]">
                    <ClipboardList size={32} className="mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No audit events yet.</p>
                  </div>
                ) : (
                  audit.slice(0, 8).map((event) => (
                    <div key={event.id} className="timeline-item">
                      <div className={event.success ? "timeline-dot" : "timeline-dot failed"}>
                        {event.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                      </div>
                      <div>
                        <p className="font-medium text-sm">{humanizeAction(event.action)}</p>
                        <time className="text-xs text-[var(--text-tertiary)]">
                          {relativeTime(event.at)} · {event.actorKind}
                        </time>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}