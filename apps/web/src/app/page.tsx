import {
  CheckCircle2,
  ClipboardList,
  Workflow,
  XCircle,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { CustomersPanel } from "@/components/CustomersPanel";
import { QuickActionButton } from "@/components/QuickActionButton";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(elapsed / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function HomePage() {
  const api = getApiClient();
  let session: Awaited<ReturnType<typeof api.session>> | null = null;
  let health: Awaited<ReturnType<typeof api.health>> | null = null;
  let modules: Awaited<ReturnType<typeof api.listModules>> | null = null;
  let customers: Awaited<ReturnType<typeof api.listCustomers>>["items"] = [];
  let audit: Awaited<ReturnType<typeof api.listAudit>>["items"] = [];
  let workflows: Awaited<ReturnType<typeof api.listWorkflows>>["items"] = [];
  let error: string | null = null;

  try {
    [health, session, modules, customers, audit, workflows] = await Promise.all([
      api.health(),
      api.session(),
      api.listModules(),
      api.listCustomers().then((res) => res.items),
      api.listAudit().then((res) => res.items),
      api.listWorkflows().then((res) => res.items),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to reach API";
  }

  const moduleCount = modules?.registered.length ?? 0;
  const installedCount = modules?.installed.filter((item) => item.enabled).length ?? 0;

  return (
    <AppShell subtitle="Operational command center for AI-native business execution.">
      {error ? (
        <div className="card part-error">
          Cannot reach API. Start it with <span className="mono">pnpm --filter @chaste/api dev</span>. {error}
        </div>
      ) : null}

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="hero-console">
            <h2>Run the business from one governed command surface.</h2>
            <p>
              The workspace is live against the backend API: manual forms, quick actions, and the agent all route
              through validated HTTP endpoints and the command/query bus.
            </p>
            <div className="console-strip">
              <div className="console-cell">
                <span>Operator</span>
                <strong>{session?.displayName ?? "Offline"}</strong>
              </div>
              <div className="console-cell">
                <span>Organization</span>
                <strong>{session?.orgName ?? "Local org"}</strong>
              </div>
              <div className="console-cell">
                <span>Autonomy</span>
                <strong>{session?.autonomy ?? "unknown"}</strong>
              </div>
              <div className="console-cell">
                <span>API</span>
                <strong>{health?.service ?? "offline"}</strong>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h2>Quick actions</h2>
                <p className="muted">Prompts open in the agent and execute according to the current autonomy level.</p>
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
                <p className="muted">Registered workflow definitions from the workflow engine.</p>
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
                      <time>{workflow.stepCount} steps · {workflow.createdBy}</time>
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
                <p className="muted">Last audited command and query activity.</p>
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
                      <p className="mono">{event.action}</p>
                      <time>{relativeTime(event.at)} · {event.actorKind}</time>
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
