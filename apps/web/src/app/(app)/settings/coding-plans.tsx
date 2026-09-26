"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ConfirmDialog } from "@/components/ui";
import { callApi, postApi } from "@/lib/api";

type Provider = "codex" | "opencode";

interface Connection {
  id: string;
  provider: Provider;
  endpoint: string | null;
  modelId: string | null;
  status: string;
  isDefault: boolean;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt: string | null;
  connectedAt: string;
}

interface CodexLogin {
  connected: boolean;
  message: string;
  waitingForPrompt?: boolean;
  verificationUrl?: string | null;
  userCode?: string | null;
  connection?: Connection;
}

function providerLabel(provider: Provider): string {
  return provider === "codex" ? "Codex plan" : "OpenCode";
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function CodingPlansCard() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [codexAvailable, setCodexAvailable] = useState(false);
  const [codexVersion, setCodexVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginActive, setLoginActive] = useState(false);
  const [login, setLogin] = useState<CodexLogin | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<Provider | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("opencode");
  const [password, setPassword] = useState("");
  const [modelId, setModelId] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi<{ connections?: Connection[]; codexRuntime?: { available?: boolean; version?: string | null } }>("/api/ai-connections");
    if (!res.ok) {
      setError(res.error?.title ?? "Coding-plan connections could not load.");
    } else {
      setError(null);
      setConnections(res.data?.connections ?? []);
      setCodexAvailable(Boolean(res.data?.codexRuntime?.available));
      setCodexVersion(res.data?.codexRuntime?.version ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!loginActive) return;
    let stopped = false;
    const poll = async () => {
      const res = await postApi<{ login?: CodexLogin }>("/api/ai-connections", { action: "poll_codex_login", makeDefault: true });
      if (stopped || !res.data?.login) return;
      setLogin(res.data.login);
      if (res.data.login.connected) {
        setLoginActive(false);
        setNotice("Codex is connected. Your assistant can now use this plan for runs you start.");
        await load();
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [loginActive, load]);

  async function startCodexLogin() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await postApi<{ login?: { verificationUrl: string | null; userCode: string | null; waitingForPrompt: boolean } }>("/api/ai-connections", { action: "start_codex_login" });
    setBusy(false);
    if (!res.ok || !res.data?.login) {
      setError(res.error?.title ?? "Codex sign-in could not start.");
      return;
    }
    setLogin({ connected: false, message: "Waiting for you to finish sign-in in the browser.", ...res.data.login });
    setLoginActive(true);
  }

  async function connectOpenCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await postApi<{ connection?: Connection }>("/api/ai-connections", {
      action: "connect_opencode",
      endpoint,
      username,
      password,
      ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
      makeDefault: makeDefault || connections.length === 0,
    });
    setBusy(false);
    if (!res.ok || !res.data?.connection) {
      setError(res.error?.title ?? "OpenCode could not connect.");
      return;
    }
    setConnections((current) => {
      const rows = current.filter((row) => row.id !== res.data!.connection!.id);
      if (res.data!.connection!.isDefault) return [...rows.map((row) => ({ ...row, isDefault: false })), res.data!.connection!];
      return [...rows, res.data!.connection!];
    });
    setPassword("");
    setNotice("OpenCode is connected. Its provider login will be used for runs you start.");
  }

  async function setDefault(connectionId: string | null) {
    setBusy(true);
    setError(null);
    const res = await postApi<{ connections?: Connection[] }>("/api/ai-connections", { action: "set_default", connectionId });
    setBusy(false);
    if (!res.ok) setError(res.error?.title ?? "The default model connection could not be changed.");
    else {
      setConnections(res.data?.connections ?? []);
      setNotice(connectionId ? "Your assistant now uses this coding plan for runs you start." : "Your assistant now uses the workspace model provider.");
    }
  }

  async function disconnect() {
    if (!disconnectTarget) return;
    setBusy(true);
    setError(null);
    const provider = disconnectTarget;
    const res = await postApi<{ connections?: Connection[] }>("/api/ai-connections", { action: "disconnect", provider });
    setBusy(false);
    setDisconnectTarget(null);
    if (!res.ok) setError(res.error?.title ?? `${providerLabel(provider)} could not be disconnected.`);
    else {
      setConnections(res.data?.connections ?? []);
      setLoginActive(false);
      setLogin(null);
      setNotice(`${providerLabel(provider)} disconnected. New runs use the next selected provider.`);
    }
  }

  return (
    <section className="mt-5" aria-labelledby="coding-plan-heading">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="coding-plan-heading" className="section-title">Coding-plan connections</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-500">
              Connect a plan you already use in Codex or OpenCode. Set one as your personal default to use it in Buzz, CRM assistance, document drafting, and other runs you start.
            </p>
          </div>
          {!loading && connections.some((connection) => connection.isDefault && connection.status === "connected")
            ? <Badge tone="green">Personal default active</Badge>
            : <Badge tone="neutral">Workspace provider active</Badge>}
        </div>

        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm leading-relaxed text-blue-950">
          Runs you start use your selected plan. Scheduled and background work continues to use the workspace provider, so your personal plan is not charged without you starting the run. Chaste sends the relevant workspace context to the connected coding agent. Business actions still pass through workspace permissions, approval, and audit controls.
        </div>

        {loading ? <p className="mt-4 text-sm text-stone-400" role="status">Loading connected plans…</p> : (
          <div className="mt-4 space-y-2">
            {connections.filter((connection) => connection.status !== "disconnected").map((connection) => (
              <article key={connection.id} className="rounded-lg border border-stone-200 bg-white p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-stone-900">{providerLabel(connection.provider)}</h3>
                      <Badge tone={connection.status === "connected" ? "green" : "amber"}>{connection.status === "connected" ? "Connected" : "Needs attention"}</Badge>
                      {connection.isDefault && <Badge tone="blue">Your default</Badge>}
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-stone-500">{connection.provider === "codex" ? "Signed in with ChatGPT plan" : connection.endpoint}</p>
                    <p className="mt-1 text-xs text-stone-500">Model: {connection.modelId || "Agent default"} · {formatTokens(connection.runCount)} runs · {formatTokens(connection.inputTokens)} prompt tokens · {formatTokens(connection.outputTokens)} reply tokens</p>
                    {connection.lastUsedAt && <p className="mt-1 text-xs text-stone-400">Last used {new Date(connection.lastUsedAt).toLocaleString()}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {!connection.isDefault && connection.status === "connected" && <Button tone="secondary" size="sm" disabled={busy} onClick={() => void setDefault(connection.id)}>Use for my runs</Button>}
                    <Button tone="ghost" size="sm" disabled={busy} onClick={() => setDisconnectTarget(connection.provider)}>Disconnect</Button>
                  </div>
                </div>
              </article>
            ))}
            {connections.filter((connection) => connection.status !== "disconnected").length === 0 && (
              <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-3 py-4 text-sm text-stone-500">No personal coding plan is connected. Your assistants will keep using the workspace model provider.</p>
            )}
          </div>
        )}

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-stone-200 p-3 sm:p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-stone-900">Sign in with Codex</h3>
                <p className="mt-1 text-xs leading-relaxed text-stone-500">Uses the Codex CLI's device sign-in and its own account storage. No plan token is shown in Chaste.</p>
              </div>
              <Badge tone={codexAvailable ? "green" : "neutral"}>{codexAvailable ? codexVersion ?? "Ready" : "Server setup needed"}</Badge>
            </div>
            <Button className="mt-3" size="sm" loading={busy && !loginActive} disabled={!codexAvailable || loginActive} onClick={() => void startCodexLogin()}>
              {loginActive ? "Waiting for sign-in…" : "Connect Codex plan"}
            </Button>
            {!codexAvailable && <p className="mt-2 text-xs text-stone-500">Ask your administrator to install Codex CLI and configure persistent coding-plan storage for this server.</p>}
            {loginActive && login && (
              <div className="mt-3 rounded-lg bg-stone-50 p-3 text-sm" role="status" aria-live="polite">
                <p className="font-medium text-stone-800">{login.message}</p>
                {login.verificationUrl && <a className="mt-2 inline-block font-medium text-gold-800 underline underline-offset-2" href={login.verificationUrl} target="_blank" rel="noreferrer">Open Codex device sign-in</a>}
                {login.userCode && <p className="mt-2 text-stone-600">Enter this code: <code className="rounded bg-white px-2 py-1 font-mono font-bold tracking-wider text-stone-900">{login.userCode}</code></p>}
                {login.waitingForPrompt && <p className="mt-2 text-xs text-stone-500">Preparing the sign-in code…</p>}
              </div>
            )}
          </div>

          <form className="rounded-lg border border-stone-200 p-3 sm:p-4" onSubmit={(event) => void connectOpenCode(event)}>
            <h3 className="text-sm font-semibold text-stone-900">Connect OpenCode</h3>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">Sign in to your plan in OpenCode, then connect its protected HTTPS server. Use a dedicated server for this workspace.</p>
            <label className="mt-3 block text-xs font-medium text-stone-600">
              OpenCode server address
              <input className="input mt-1 w-full" type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://opencode.yourcompany.com" required autoComplete="url" />
            </label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-medium text-stone-600">
                Server username
                <input className="input mt-1 w-full" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
              </label>
              <label className="text-xs font-medium text-stone-600">
                Server password
                <input className="input mt-1 w-full" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
              </label>
            </div>
            <label className="mt-2 block text-xs font-medium text-stone-600">
              Model ID <span className="font-normal text-stone-400">(optional)</span>
              <input className="input mt-1 w-full font-mono" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="Leave blank to use OpenCode's default" autoComplete="off" />
            </label>
            <label className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-stone-600">
              <input className="mt-0.5 size-4 accent-gold-700" type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
              Use this plan for my assistant runs after connecting
            </label>
            <Button className="mt-3" type="submit" size="sm" loading={busy} disabled={!endpoint.trim() || !password}>Connect OpenCode</Button>
          </form>
        </div>

        {(error || notice) && <p className={`mt-3 text-sm ${error ? "text-red-700" : "text-emerald-700"}`} role={error ? "alert" : "status"}>{error ?? notice}</p>}
        <p className="mt-3 text-xs leading-relaxed text-stone-400">Usage shows provider-reported token counts and requests when available. Coding plans control their own limits and do not expose an API-style price or remaining quota here.</p>
      </Card>

      <ConfirmDialog
        open={disconnectTarget != null}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={() => void disconnect()}
        title={`Disconnect ${disconnectTarget ? providerLabel(disconnectTarget) : "coding plan"}?`}
        body={disconnectTarget === "codex" ? "This removes the Codex account from this server profile and ends its use by your assistant. You can reconnect later." : "This removes the encrypted OpenCode server credential and revokes Chaste's access to its tool bridge. You can reconnect later."}
        confirmLabel="Disconnect plan"
        busy={busy}
      />
    </section>
  );
}
