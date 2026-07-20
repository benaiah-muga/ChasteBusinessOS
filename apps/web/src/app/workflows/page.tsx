import { Play, Workflow } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getApiClient } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const api = getApiClient();
  let workflows: Awaited<ReturnType<typeof api.listWorkflows>>["items"] = [];
  let error: string | null = null;
  try {
    workflows = (await api.listWorkflows()).items;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load workflows";
  }

  return (
    <AppShell subtitle="Registered multi-step business workflows.">
      {error ? (
        <div className="card part-error">
          Cannot load workflows. {error}
        </div>
      ) : null}
      <section className="stack">
        <div className="section-head">
          <div>
            <h2>Workflow registry</h2>
            <p className="muted">
              Definitions returned by <span className="mono">GET /api/v1/workflows</span>.
            </p>
          </div>
          <span className="badge accent">{workflows.length} workflows</span>
        </div>
        <div className="grid">
          {workflows.length === 0 ? (
            <div className="empty-state">
              {error
                ? "Unavailable while API is offline."
                : "No workflows registered yet. Ask the agent to design one from a process."}
            </div>
          ) : (
            workflows.map((workflow) => (
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
                <button className="btn secondary" type="button" disabled>
                  <Play size={16} />
                  Execute from detail view
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
