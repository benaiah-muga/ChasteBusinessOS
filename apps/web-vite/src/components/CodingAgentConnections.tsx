import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, Cable, Check, ExternalLink, LoaderCircle, PlugZap, ShieldCheck, Unplug, X } from "lucide-react";
import {
  AgentConnectionsError,
  connectOpenCode,
  disconnectAgent,
  fetchAgentConnections,
  setDefaultAgentConnection,
  type AgentConnection,
} from "../api/ai-connections";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useToast } from "../ui/toast";
import "./coding-agent-settings.css";

function isAvailable(connection: AgentConnection): boolean {
  return connection.status === "connected" || connection.status === "ready" || connection.status === "healthy";
}

export function CodingAgentConnections() {
  const [connections, setConnections] = useState<AgentConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:4096");
  const [username, setUsername] = useState("opencode");
  const [password, setPassword] = useState("");
  const [modelId, setModelId] = useState("");
  const [useAsDefault, setUseAsDefault] = useState(true);
  const { toast } = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchAgentConnections(signal);
      if (signal?.aborted) return;
      setConnections(data.connections);
      setLoadError(null);
    } catch (error) {
      if (signal?.aborted) return;
      setConnections([]);
      setLoadError(error instanceof Error ? error.message : "Coding agent connections are unavailable.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await connectOpenCode({
        endpoint: endpoint.trim(),
        username: username.trim() || undefined,
        password,
        modelId: modelId.trim() || undefined,
        makeDefault: useAsDefault,
      });
      setPassword("");
      setOpen(false);
      await load();
      toast({ title: "OpenCode connected", description: "Chaste will use this runtime when a coding agent is needed.", tone: "success" });
    } catch (error) {
      setFormError(error instanceof AgentConnectionsError ? error.message : "Could not connect to OpenCode. Check the address and server password.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDefault(connection: AgentConnection) {
    setBusy(true);
    try {
      await setDefaultAgentConnection(connection.isDefault ? null : connection.id);
      await load();
    } catch (error) {
      toast({ title: "Could not change the default runtime", description: error instanceof Error ? error.message : "Try again.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(connection: AgentConnection) {
    setBusy(true);
    try {
      await disconnectAgent(connection.provider);
      await load();
      toast({ title: "Connection removed", description: "OpenCode can no longer use Chaste tools through this workspace.", tone: "success" });
    } catch (error) {
      toast({ title: "Could not disconnect", description: error instanceof Error ? error.message : "Try again.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="coding-agents" aria-labelledby="coding-agents-title">
      <div className="coding-agents-head">
        <div>
          <p className="coding-agents-eyebrow"><Cable size={12} aria-hidden="true" /> Agent runtime</p>
          <h2 id="coding-agents-title">OpenCode 2 connection</h2>
          <p>
            Connect a local OpenCode 2 server so a coding agent can plan and implement Creator proposals with your workspace tools.
            Chaste exposes governed MCP tools; approvals, identity changes, and destructive actions still stop for a person.
          </p>
        </div>
        <Button variant={open ? "ghost" : "secondary"} size="sm" onClick={() => setOpen((current) => !current)}>
          {open ? <><X size={13} aria-hidden="true" /> Cancel</> : <><PlugZap size={13} aria-hidden="true" /> Connect OpenCode</>}
        </Button>
      </div>

      {open && (
        <form className="coding-agent-form" onSubmit={(event) => void submit(event)}>
          <div className="coding-agent-form-grid">
            <label>
              <span>Server address</span>
              <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required placeholder="http://127.0.0.1:4096" spellCheck={false} />
              <small>OpenCode 2 exposes its local HTTP server from <code>opencode serve</code> or the desktop app.</small>
            </label>
            <label>
              <span>Server password</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="The password printed by OpenCode" autoComplete="new-password" />
            </label>
            <label>
              <span>Username <em>optional</em></span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="opencode" autoComplete="username" />
            </label>
            <label>
              <span>Preferred model <em>optional</em></span>
              <input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="provider/model" spellCheck={false} />
            </label>
          </div>
          <label className="coding-agent-check">
            <input type="checkbox" checked={useAsDefault} onChange={(event) => setUseAsDefault(event.target.checked)} />
            Use this runtime by default for Creator proposals
          </label>
          {formError && <p className="coding-agent-error" role="alert">{formError}</p>}
          <div className="coding-agent-form-actions">
            <Button type="submit" variant="primary" size="sm" disabled={busy || !endpoint.trim() || !password}>
              {busy ? <><LoaderCircle size={13} className="coding-agent-spin" aria-hidden="true" /> Checking server…</> : <><ShieldCheck size={13} aria-hidden="true" /> Connect securely</>}
            </Button>
            <a href="https://opencode.ai/v2/docs/" target="_blank" rel="noreferrer">OpenCode 2 docs <ExternalLink size={11} aria-hidden="true" /></a>
          </div>
        </form>
      )}

      {loadError && <p className="coding-agent-note" role="status">{loadError} You can still connect a runtime below.</p>}

      <div className="coding-agent-list">
        {connections === null ? (
          <p className="coding-agent-note" role="status"><LoaderCircle size={13} className="coding-agent-spin" aria-hidden="true" /> Checking connected runtimes…</p>
        ) : connections.length === 0 ? (
          <div className="coding-agent-empty">
            <span aria-hidden="true"><Cable size={16} /></span>
            <div>
              <strong>No coding agent connected</strong>
              <p>Creator mode can still propose capabilities from the built-in workmate. Connect OpenCode 2 when you want a coding agent to implement them.</p>
            </div>
          </div>
        ) : connections.map((connection) => (
          <article className="coding-agent-card" key={connection.id}>
            <span className={`coding-agent-status${isAvailable(connection) ? " is-ready" : ""}`} aria-hidden="true">
              {isAvailable(connection) ? <Check size={13} /> : <Unplug size={13} />}
            </span>
            <div className="coding-agent-card-copy">
              <div className="coding-agent-card-title">
                <strong>{connection.provider === "opencode" ? "OpenCode 2" : "Codex"}</strong>
                <Badge tone={isAvailable(connection) ? "success" : "warning"}>{isAvailable(connection) ? "Connected" : connection.status.replace(/_/g, " ")}</Badge>
                {connection.isDefault && <Badge tone="gold">Default</Badge>}
              </div>
              <p>{connection.endpoint ?? "Local runtime"} {connection.modelId ? `· ${connection.modelId}` : ""}</p>
              <small>{connection.runCount} run{connection.runCount === 1 ? "" : "s"} · {(connection.inputTokens + connection.outputTokens).toLocaleString()} tokens used</small>
            </div>
            <div className="coding-agent-card-actions">
              {isAvailable(connection) && (
                <Button variant="quiet" size="sm" disabled={busy} onClick={() => void toggleDefault(connection)}>
                  {connection.isDefault ? "Clear default" : "Make default"}
                </Button>
              )}
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void disconnect(connection)}>
                Disconnect <ArrowUpRight size={11} aria-hidden="true" />
              </Button>
            </div>
          </article>
        ))}
      </div>
      <p className="coding-agent-footnote">
        <ShieldCheck size={12} aria-hidden="true" />
        The server password is encrypted before storage and never returned to the browser. OpenCode can only call tools granted to the current workspace member.
      </p>
    </section>
  );
}
