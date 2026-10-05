import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./SettingsPage.css";
import {
  AI_PROVIDER_OPTIONS,
  DEFAULT_AI_MODELS,
  POLICY_RISKS,
  PROTECTED_MODULE_IDS,
  fetchAgentSoul,
  fetchAiConfig,
  fetchBranding,
  fetchCompositions,
  fetchEmailStatus,
  fetchMemory,
  fetchModuleSettings,
  fetchModuleSwitchboard,
  fetchPolicy,
  fetchRoutines,
  isAiProviderId,
  isProtectedModule,
  saveAgentSoul,
  saveAiConfig,
  sendEmailTest,
  submitGoverned,
  SettingsApiError,
  type AiConfig,
  type AiModels,
  type AiProviderId,
  type Branding,
  type CompositionRow,
  type EmailStatus,
  type MemoryEntry,
  type ModuleSwitchboard,
  type Policy,
  type Routine,
} from "../api/settings";
import { fetchOrganizations } from "../api/organizations";
import { legacyUrl } from "../legacy";
import "./SettingsPage.css";

/* ------------------------------------------------------------- styling ---- */

const INK = "#26352c";
const MUTED = "#73766d";
const LINE = "#e5e3da";
const SURFACE = "#fffefa";
const GOLD = "#8a6f38";

const ui = {
  page: { width: "min(100% - 48px, 1080px)", margin: "0 auto", padding: "clamp(28px, 4vw, 52px) 0 72px" } as CSSProperties,
  header: { marginBottom: "24px" } as CSSProperties,
  eyebrow: { margin: "0 0 9px", color: GOLD, fontSize: "10px", fontWeight: 700, letterSpacing: ".15em", textTransform: "uppercase" } as CSSProperties,
  title: { margin: "0 0 10px", color: INK, fontFamily: 'Georgia, "Times New Roman", serif', fontSize: "clamp(30px, 4.5vw, 44px)", fontWeight: 500, letterSpacing: "-.05em", lineHeight: 1.05 } as CSSProperties,
  lede: { maxWidth: "760px", margin: 0, color: MUTED, fontSize: "13px", lineHeight: 1.65 } as CSSProperties,
  tablist: { display: "flex", flexWrap: "wrap", gap: "4px", margin: "0 0 24px", borderBottom: "1px solid " + LINE, paddingBottom: "2px" } as CSSProperties,
  tab: { minHeight: "33px", border: "0", borderRadius: "6px 6px 0 0", padding: "0 11px", background: "transparent", color: "#6e726a", cursor: "pointer", fontSize: "11px", fontWeight: 600 } as CSSProperties,
  tabActive: { background: "#eef0e9", color: INK } as CSSProperties,
  section: { marginBottom: "30px" } as CSSProperties,
  sectionTitle: { margin: "0 0 5px", color: "#303a32", fontSize: "14px", fontWeight: 650 } as CSSProperties,
  sectionHint: { maxWidth: "720px", margin: "0 0 14px", color: MUTED, fontSize: "12px", lineHeight: 1.6 } as CSSProperties,
  card: { minWidth: 0, border: "1px solid " + LINE, borderRadius: "12px", padding: "18px", background: SURFACE, boxShadow: "0 9px 28px rgb(48 45 36 / 4%)" } as CSSProperties,
  stack: { display: "grid", gap: "14px" } as CSSProperties,
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "10px" } as CSSProperties,
  label: { display: "grid", gap: "5px", color: "#4c5149", fontSize: "11px", fontWeight: 600 } as CSSProperties,
  hint: { color: "#8d8f86", fontSize: "10px", fontWeight: 400, lineHeight: 1.5 } as CSSProperties,
  field: { minHeight: "35px", width: "100%", minWidth: 0, border: "1px solid #dddbd2", borderRadius: "6px", padding: "0 9px", background: "#fffefa", color: "#434940", font: "inherit", fontSize: "12px" } as CSSProperties,
  textarea: { minHeight: "70px", width: "100%", minWidth: 0, border: "1px solid #dddbd2", borderRadius: "6px", padding: "9px", background: "#fffefa", color: "#434940", font: "inherit", fontSize: "12px", lineHeight: 1.6, resize: "vertical" } as CSSProperties,
  monoField: { minHeight: "35px", width: "100%", minWidth: 0, border: "1px solid #dddbd2", borderRadius: "6px", padding: "0 9px", background: "#fffefa", color: "#434940", font: "inherit", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px" } as CSSProperties,
  primary: { minHeight: "35px", border: "1px solid #264437", borderRadius: "6px", padding: "0 13px", background: "#28473a", color: "#fffefa", cursor: "pointer", font: "inherit", fontSize: "11px", fontWeight: 650 } as CSSProperties,
  secondary: { minHeight: "35px", border: "1px solid #d9d7cd", borderRadius: "6px", padding: "0 12px", background: "#f7f6f0", color: "#354238", cursor: "pointer", font: "inherit", fontSize: "11px", fontWeight: 650 } as CSSProperties,
  link: { color: "#4b6b56", fontSize: "11px", fontWeight: 650 } as CSSProperties,
  chip: { minHeight: "30px", border: "1px solid #e3e1d8", borderRadius: "99px", padding: "0 11px", background: "#f7f6f0", color: "#63655d", cursor: "pointer", font: "inherit", fontSize: "10px", fontWeight: 650 } as CSSProperties,
  chipOn: { borderColor: "#d8c48c", background: "#fbf4df", color: "#7a6229" } as CSSProperties,
  listRow: { display: "flex", minHeight: "46px", alignItems: "center", justifyContent: "space-between", gap: "12px", borderTop: "1px solid #eeece5", fontSize: "11px" } as CSSProperties,
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "10px" } as CSSProperties,
  muted: { color: MUTED, fontSize: "11px", lineHeight: 1.6 } as CSSProperties,
  empty: { color: "#9a9c93", fontSize: "11px" } as CSSProperties,
  badge: { display: "inline-flex", alignItems: "center", borderRadius: "99px", padding: "3px 8px", background: "#f4f2ea", color: "#6c6e65", fontSize: "9px", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase" } as CSSProperties,
} as const;

const NOTICE_STYLE: Record<NoticeTone, CSSProperties> = {
  success: { border: "1px solid #c8dbc9", background: "#f0f7ef", color: "#30563b" },
  pending: { border: "1px solid #ead8a9", background: "#fbf4df", color: "#81672c" },
  error: { border: "1px solid #e7c8c0", background: "#fff7f4", color: "#8e4134" },
};

const noticeStyle = (tone: NoticeTone): CSSProperties => ({
  ...NOTICE_STYLE[tone],
  margin: "0 0 14px",
  borderRadius: "9px",
  padding: "10px 13px",
  fontSize: "11px",
  lineHeight: 1.55,
});

type NoticeTone = "success" | "pending" | "error";

/* ---------------------------------------------------------------- shared -- */

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section style={ui.section}>
      <h2 style={ui.sectionTitle}>{title}</h2>
      <p style={ui.sectionHint}>{hint}</p>
      {children}
    </section>
  );
}

/** A labelled control with its hint wired up as the accessible description. */
function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={ui.label}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span id={`${id}-hint`} style={ui.hint}>{hint}</span>}
    </div>
  );
}

function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} style={noticeStyle(tone)}>
      {children}
    </p>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof SettingsApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The settings service took too long. Try again.";
  }
  return "Could not reach the settings service. Check your connection and try again.";
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const CURRENCY_MINOR_UNITS: Record<string, number> = { JPY: 0, KRW: 0, TZS: 0, UGX: 0, VND: 0, KWD: 3, BHD: 3, OMR: 3 };

/** Minor units follow the organization's base currency, defaulting to cents. */
function minorUnitsFor(baseCurrency: string | null): number {
  return CURRENCY_MINOR_UNITS[baseCurrency ?? ""] ?? 2;
}

function minorToInput(minor: number, minorUnits: number): string {
  return String(minor / 10 ** minorUnits);
}

function toMinor(amount: string, minorUnits: number): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10 ** minorUnits);
}

async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Nothing to do: the value stays visible so it can be copied by hand.
  }
}

/* ----------------------------------------------------------------- page ---- */

const TABS = [
  { id: "workspace", label: "Workspace" },
  { id: "modules", label: "Modules" },
  { id: "governance", label: "Governance" },
  { id: "ai", label: "AI & automation" },
  { id: "branding", label: "Branding" },
  { id: "routines", label: "Routines" },
  { id: "runtime", label: "Runtime" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsPage({ baseCurrency }: { baseCurrency?: string | null }) {
  const [tab, setTab] = useState<TabId>("workspace");
  const [accountingOn, setAccountingOn] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchModuleSwitchboard(controller.signal)
      .then((board) => setAccountingOn(board.enabledModules.includes("accounting")))
      .catch(() => setAccountingOn(false));
    return () => controller.abort();
  }, []);

  return (
    <main style={ui.page}>
      <header style={ui.header}>
        <p style={ui.eyebrow}>Workspace control room</p>
        <h1 style={ui.title}>Settings</h1>
        <p style={ui.lede}>
          Workspace facts, module switchboard, and the models behind your workmate. Every write here goes through the
          governed capability pipeline: a human admin applies changes under their own authority, and anything the
          workmate proposes waits in the Approvals inbox.
        </p>
      </header>

      <div role="tablist" aria-label="Settings sections" style={ui.tablist}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`settings-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`settings-panel-${entry.id}`}
            onClick={() => setTab(entry.id)}
            style={{ ...ui.tab, ...(tab === entry.id ? ui.tabActive : null) }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
        {tab === "workspace" && <WorkspaceTab accountingOn={accountingOn} />}
        {tab === "modules" && <ModulesTab />}
        {tab === "governance" && <GovernanceTab baseCurrency={baseCurrency} />}
        {tab === "ai" && <AiTab />}
        {tab === "branding" && <BrandingTab />}
        {tab === "routines" && <RoutinesTab />}
        {tab === "runtime" && <RuntimeTab />}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------ workspace --- */

function WorkspaceTab({ accountingOn }: { accountingOn: boolean | null }) {
  const [orgName, setOrgName] = useState<string>("");
  const [orgError, setOrgError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchOrganizations(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setOrgName(data.orgs.find((org) => org.id === data.activeOrgId)?.name ?? "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setOrgError(errorMessage(error));
      });
    return () => controller.abort();
  }, []);

  return (
    <>
      <Section
        title="Organization"
        hint="The workspace these settings govern. Switch organizations from the account menu in the top bar."
      >
        {orgError && <Notice tone="error">{orgError}</Notice>}
        <div style={ui.card}>
          <div style={{ ...ui.stack, gap: "0" }}>
            <div style={ui.listRow}>
              <span style={ui.muted}>Name</span>
              <strong style={{ color: INK, fontSize: "12px" }}>{orgName || "-"}</strong>
            </div>
            <div style={ui.listRow}>
              <span style={ui.muted}>Modules</span>
              <span style={{ fontSize: "11px" }}>
                {accountingOn === null ? "Checking" : accountingOn ? "Managed by owners" : "Restricted set"} ·{" "}
                <a href={legacyUrl("/team")} style={ui.link}>Team &amp; roles</a>
              </span>
            </div>
            <div style={ui.listRow}>
              <span style={ui.muted}>Agent sessions</span>
              <a href={legacyUrl("/sessions")} style={ui.link}>View trajectory log →</a>
            </div>
          </div>
        </div>
      </Section>

      <EmailSection />
    </>
  );
}

/** Outbound email: shows whether SMTP is live and proves it with a test send. */
function EmailSection() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<NoticeTone | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchEmailStatus(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setStatus(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ configured: false, from: null });
      });
    return () => controller.abort();
  }, []);

  async function sendTest() {
    setBusy(true);
    setNote(null);
    setMessage(null);
    try {
      await sendEmailTest(to);
      setNote("success");
      setMessage("Test email sent, check the inbox.");
    } catch (error) {
      setNote("error");
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Email" hint="Invoices, approvals, and customer care all deliver through SMTP.">
      <div style={ui.card}>
        {!status ? (
          <p style={ui.muted}>Checking…</p>
        ) : status.configured ? (
          <p style={ui.muted}>
            SMTP is configured
            {status.from ? <> - sending as <code style={ui.mono}>{status.from}</code></> : null}.
          </p>
        ) : (
          <p style={ui.muted}>
            Set <code style={ui.mono}>SMTP_HOST</code> (plus optional <code style={ui.mono}>SMTP_FROM</code>) in the
            server environment to enable delivery.
          </p>
        )}
        <div style={{ ...ui.row, justifyContent: "flex-start", marginTop: "12px" }}>
          <label style={{ ...ui.label, flex: "0 0 220px" }}>
            <span className="sr-only">Test recipient</span>
            <input
              type="email"
              placeholder="you@company.com"
              value={to}
              onChange={(event) => setTo(event.currentTarget.value)}
              disabled={!status?.configured}
              style={ui.field}
            />
          </label>
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={busy || !status?.configured || !/.+@.+\..+/.test(to)}
            style={ui.secondary}
          >
            Send test email
          </button>
        </div>
        {message && <Notice tone={note ?? "error"}>{message}</Notice>}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- modules --- */

type SwitchboardState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; data: ModuleSwitchboard };

function ModuleSwitchboard() {
  const [state, setState] = useState<SwitchboardState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", data: await fetchModuleSwitchboard(signal) });
    } catch (error) {
      if (!signal?.aborted) setState({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(next: Set<string>) {
    if (next.size === 0) {
      setNotice({ tone: "error", text: "At least one module must stay enabled." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // The spine is unioned in client-side too, so a stale catalog can never
      // switch off iam, routines, or signals from this screen.
      const modules = [...new Set([...next, ...PROTECTED_MODULE_IDS])];
      const result = await submitGoverned("/api/modules", { modules });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      await load();
      setNotice({ tone: "success", text: "Module switchboard updated. The change is in the ledger." });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") {
    return <p role="status" style={ui.muted}>Loading the module switchboard…</p>;
  }
  if (state.status === "failed") {
    return (
      <div style={ui.card}>
        <Notice tone="error">{state.message}</Notice>
        <button type="button" onClick={() => void load()} style={ui.secondary}>Try again</button>
      </div>
    );
  }

  const enabled = new Set(state.data.enabledModules);

  return (
    <div style={ui.card}>
      <div style={ui.row}>
        <p style={{ ...ui.muted, margin: 0 }}>
          Switch platform surfaces on or off for this organization. Disabled modules disappear from navigation, APIs,
          and agent tools. Core platform modules stay on: they run the switchboard itself.
        </p>
        {state.data.usingDefaults && state.data.catalog.length > 0 && <span style={ui.badge}>defaults</span>}
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <ul style={{ margin: "14px 0 0", padding: 0, listStyle: "none" }}>
        {state.data.catalog.map((module) => {
          const on = enabled.has(module.id);
          const locked = isProtectedModule(module);
          return (
            <li key={module.id} style={ui.listRow}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, color: INK, fontSize: "12px", fontWeight: 600 }}>
                  {module.label}
                  {locked && <span style={{ marginLeft: "8px", color: "#a3a399", fontSize: "9px", fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>core</span>}
                </p>
                <p style={{ ...ui.muted, margin: "2px 0 0", fontSize: "10px" }}>{module.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${on ? "Disable" : "Enable"} ${module.label}`}
                title={locked ? "Core platform module, always on" : undefined}
                disabled={busy || locked}
                onClick={() => {
                  const next = new Set(enabled);
                  if (next.has(module.id)) next.delete(module.id);
                  else next.add(module.id);
                  void save(next);
                }}
                style={{
                  position: "relative",
                  width: "42px",
                  height: "23px",
                  flex: "0 0 auto",
                  border: 0,
                  borderRadius: "99px",
                  padding: 0,
                  background: on ? "#a8894a" : "#d3d2ca",
                  cursor: busy || locked ? "not-allowed" : "pointer",
                  opacity: locked ? 0.65 : 1,
                }}
              >
                <span style={{ position: "absolute", top: "2px", left: on ? "21px" : "2px", width: "19px", height: "19px", borderRadius: "99px", background: "#fff", boxShadow: "0 1px 2px rgb(0 0 0 / 20%)" }} />
              </button>
            </li>
          );
        })}
      </ul>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "14px" }}>
        <button type="button" onClick={() => void load()} disabled={busy} style={ui.secondary}>Refresh</button>
      </div>
    </div>
  );
}

interface ModuleSettingField {
  key: string;
  label: string;
  type: "text" | "number";
  placeholder?: string;
}

const MODULE_SETTING_PANELS: ReadonlyArray<{ moduleId: string; title: string; hint: string; fields: ModuleSettingField[] }> = [
  {
    moduleId: "inventory",
    title: "Inventory",
    hint: "What the product form starts with when you add a new item.",
    fields: [
      { key: "defaultUnitLabel", label: "Default unit label", type: "text", placeholder: "unit" },
      { key: "defaultReorderPointUnits", label: "Default reorder point", type: "number", placeholder: "0" },
    ],
  },
];

function ModuleSettingsPanel({ moduleId, title, hint, fields }: (typeof MODULE_SETTING_PANELS)[number]) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const fieldKeys = fields.map((field) => field.key).join(",");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchModuleSettings(moduleId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const next: Record<string, string> = {};
        for (const field of fields) next[field.key] = String(data.settings[field.key] ?? "");
        setValues(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice({ tone: "error", text: "Could not load these module defaults." });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Field lists are static per module.
  }, [moduleId, fieldKeys]);

  async function save() {
    setSaving(true);
    setNotice(null);
    const settings: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.key] ?? "";
      if (field.type === "number") {
        if (raw !== "") settings[field.key] = Number(raw);
      } else if (raw.trim() !== "") {
        settings[field.key] = raw.trim();
      }
    }
    try {
      const result = await submitGoverned("/api/module-settings", { module: moduleId, settings });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      setNotice({ tone: "success", text: "Saved. New defaults apply right away." });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={title} hint={hint}>
      {loading ? (
        <p style={ui.muted}>Loading defaults…</p>
      ) : (
        <div style={{ ...ui.card, maxWidth: "560px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "12px" }}>
            {fields.map((field) => (
              <label key={field.key} style={ui.label}>
                {field.label}
                <input
                  type={field.type}
                  inputMode={field.type === "number" ? "numeric" : undefined}
                  min={field.type === "number" ? 0 : undefined}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder}
                  aria-label={`${title} ${field.label}`}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  style={ui.field}
                />
              </label>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "13px" }}>
            <button type="button" onClick={() => void save()} disabled={saving} style={ui.primary}>
              {saving ? "Saving…" : "Save defaults"}
            </button>
            {notice && <span role={notice.tone === "error" ? "alert" : "status"} style={{ fontSize: "11px", color: notice.tone === "success" ? "#30563b" : notice.tone === "pending" ? "#81672c" : "#8e4134" }}>{notice.text}</span>}
          </div>
        </div>
      )}
    </Section>
  );
}

function ModulesTab() {
  return (
    <>
      <Section
        title="Switchboard"
        hint="Which applications your organization runs. Turning a module off hides it from people, the workmate, and the job queue at once. As an admin your change applies immediately and lands in the ledger; the workmate proposing the same change still waits for approval."
      >
        <ModuleSwitchboard />
      </Section>

      <Section
        title="Module defaults"
        hint="Configuration each module owns: the values its forms and flows start from. Changes are governed like any other write."
      >
        <p style={{ ...ui.muted, margin: 0 }}>
          Defaults live per module below. Modules without editable settings yet manage their behavior in code and
          surfaces of their own. Settings itself has no switchboard row, so this page stays reachable whatever the
          organization turns off.
        </p>
      </Section>

      {MODULE_SETTING_PANELS.map((panel) => (
        <ModuleSettingsPanel key={panel.moduleId} {...panel} />
      ))}
    </>
  );
}

/* ----------------------------------------------------------- governance --- */

const STRICT_OPTIONS = [
  { id: "identity", label: "Identity actions" },
  { id: "destructive", label: "Destructive actions" },
  { id: "money", label: "Payments over threshold" },
] as const;

function GovernanceTab({ baseCurrency }: { baseCurrency?: string | null }) {
  const minorUnits = minorUnitsFor(baseCurrency ?? null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchPolicy(signal);
      if (signal?.aborted) return;
      setPolicy(data.policy);
      setCanEdit(data.canEdit);
      setThresholdInput(data.policy.moneyThresholdMinor > 0 ? minorToInput(data.policy.moneyThresholdMinor, minorUnits) : "");
      setLoadError(null);
    } catch (error) {
      if (!signal?.aborted) setLoadError(errorMessage(error));
    }
  }, [minorUnits]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save() {
    if (!policy) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await submitGoverned("/api/policy", {
        maxRiskAutonomous: policy.maxRiskAutonomous,
        moneyThresholdMinor: thresholdInput.trim() === "" ? 0 : toMinor(thresholdInput, minorUnits),
        requiresApprovalFor: policy.requiresApprovalFor,
      });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      setNotice({ tone: "success", text: "Policy saved. It applies to the next action immediately." });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  function toggleStrict(id: string) {
    setPolicy((current) =>
      current
        ? {
            ...current,
            requiresApprovalFor: current.requiresApprovalFor.includes(id)
              ? current.requiresApprovalFor.filter((value) => value !== id)
              : [...current.requiresApprovalFor, id],
          }
        : current,
    );
  }

  return (
    <Section
      title="Workmate autonomy"
      hint="The highest risk class the workmate may act at without asking. Whatever you pick, every action is still audited in the ledger."
    >
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {!policy ? (
        !loadError && <p style={ui.muted}>Loading policy…</p>
      ) : (
        <div style={{ ...ui.card, maxWidth: "560px" }}>
          <div style={{ ...ui.stack, gap: "16px" }}>
            <label style={ui.label}>
              Max autonomous risk
              <select
                value={policy.maxRiskAutonomous}
                disabled={!canEdit}
                aria-label="Max autonomous risk"
                onChange={(event) => setPolicy({ ...policy, maxRiskAutonomous: event.currentTarget.value })}
                style={ui.field}
              >
                {POLICY_RISKS.map((risk) => (
                  <option key={risk.id} value={risk.id}>{risk.label}</option>
                ))}
              </select>
              <span style={ui.hint}>
                Write covers creating and updating records. Money adds anything that moves value. Identity and
                destructive are always gated for the workmate, no matter what this says.
              </span>
            </label>

            <label style={ui.label}>
              Payment approval threshold
              <input
                type="text"
                inputMode="decimal"
                value={thresholdInput}
                disabled={!canEdit}
                placeholder="No limit"
                aria-label="Payment approval threshold"
                onChange={(event) => setThresholdInput(event.currentTarget.value)}
                style={ui.field}
              />
              <span style={ui.hint}>
                Workmate payments above this amount wait for a person. Lower it to tighten control; empty for none.
              </span>
            </label>

            <div>
              <span style={{ ...ui.label, marginBottom: "7px" }}>Maker-checker for people (strict mode)</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {STRICT_OPTIONS.map((option) => {
                  const on = policy.requiresApprovalFor.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={on}
                      disabled={!canEdit}
                      onClick={() => toggleStrict(option.id)}
                      style={{ ...ui.chip, ...(on ? ui.chipOn : null) }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <span style={{ ...ui.hint, display: "block", marginTop: "6px" }}>
                Off by default: people with the permission act under their own authority. Turn a chip on to require a
                second pair of eyes for that risk class, even for humans.
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              {canEdit && (
                <button type="button" onClick={() => void save()} disabled={saving} style={ui.primary}>
                  {saving ? "Saving…" : "Save policy"}
                </button>
              )}
              {!canEdit && <span style={ui.empty}>Only organization admins can change policy.</span>}
              {notice && (
                <span role={notice.tone === "error" ? "alert" : "status"} style={{ fontSize: "11px", color: notice.tone === "success" ? "#30563b" : notice.tone === "pending" ? "#81672c" : "#8e4134" }}>
                  {notice.text}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- ai + memory --- */

const MODEL_FIELDS = [
  { field: "primary", label: "Primary", hint: "Conversations, drafting, and coding suggestions" },
  { field: "fast", label: "Fast", hint: "Classifications and quick lookups" },
  { field: "reasoning", label: "Reasoning", hint: "Deep multi-step analysis" },
  { field: "embeddings", label: "Embeddings", hint: "Document search and memory" },
] as const satisfies ReadonlyArray<{ field: keyof AiModels; label: string; hint: string }>;

function AiTab() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProviderId>("nvidia");
  const [baseUrl, setBaseUrl] = useState<string>(AI_PROVIDER_OPTIONS[0]!.baseUrl);
  const [models, setModels] = useState<AiModels>(DEFAULT_AI_MODELS);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: NoticeTone; text: string } | null>(null);

  function applyConfig(next: AiConfig) {
    setConfig(next);
    setProvider(isAiProviderId(next.provider) ? next.provider : "custom");
    setBaseUrl(next.baseUrl);
    setModels(next.models);
    // The stored credential is never in the response, so the field starts empty
    // and the only hint shown is the short display suffix the API returns.
    setApiKey("");
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetchAiConfig(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) applyConfig(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      });
    return () => controller.abort();
  }, []);

  function changeProvider(next: AiProviderId) {
    const previousDefault = AI_PROVIDER_OPTIONS.find((option) => option.id === provider)?.baseUrl ?? "";
    const nextDefault = AI_PROVIDER_OPTIONS.find((option) => option.id === next)?.baseUrl ?? "";
    setProvider(next);
    if (!baseUrl || baseUrl === previousDefault) setBaseUrl(nextDefault);
  }

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const result = await saveAiConfig({
        provider,
        baseUrl,
        models,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (result.kind === "pending") {
        setNote({ tone: "pending", text: result.reason });
      } else {
        applyConfig(result.config);
        setNote({ tone: "success", text: "Model configuration saved. New agent runs use it." });
      }
    } catch (error) {
      setNote({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    if (!config?.configured) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await saveAiConfig({ provider, baseUrl, models, clearApiKey: true });
      if (result.kind === "pending") {
        setNote({ tone: "pending", text: result.reason });
      } else {
        applyConfig(result.config);
        setNote({ tone: "success", text: "Workspace key cleared." });
      }
    } catch (error) {
      setNote({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title="Workspace model provider"
        hint="Choose the provider and model roles used by this workspace. Credentials are encrypted before storage, never returned to the browser, and every change goes through the governed capability pipeline."
      >
        {!config ? (
          <p role={loadError ? "alert" : "status"} style={loadError ? { ...ui.muted, color: "#8e4134" } : ui.muted}>
            {loadError ?? "Checking configuration…"}
          </p>
        ) : (
          <div style={{ ...ui.card, display: "grid", gap: "16px" }}>
            <div style={ui.row}>
              <p style={{ ...ui.muted, margin: 0 }}>
                Source: {config.source === "workspace" ? "workspace override" : "server environment"}
              </p>
              {config.configured ? (
                <span style={{ ...ui.badge, background: "#eef5ec", color: "#3d6b4c" }}>
                  connected {config.keyHint ?? ""}
                </span>
              ) : (
                <span style={{ ...ui.badge, background: "#fbf4df", color: "#81672c" }}>credential missing</span>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              <Field id="settings-ai-provider" label="Provider">
                <select
                  id="settings-ai-provider"
                  value={provider}
                  onChange={(event) => changeProvider(event.currentTarget.value as AiProviderId)}
                  style={ui.field}
                >
                  {AI_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field id="settings-ai-key" label="API key" hint="Write-only. The stored key is never sent back to this page.">
                <input
                  id="settings-ai-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                  placeholder={config.keyHint ? `Current key ${config.keyHint}` : "Paste a provider key"}
                  autoComplete="new-password"
                  aria-describedby="settings-ai-key-hint"
                  style={ui.field}
                />
              </Field>
            </div>

            <Field id="settings-ai-base-url" label="Base URL" hint="Use a custom URL for a self-hosted or OpenAI-compatible gateway.">
              <input
                id="settings-ai-base-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.currentTarget.value)}
                placeholder="https://your-provider.example/v1"
                aria-describedby="settings-ai-base-url-hint"
                style={ui.monoField}
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              {MODEL_FIELDS.map(({ field, label, hint }) => (
                <Field key={field} id={`settings-ai-model-${field}`} label={label} hint={hint}>
                  <input
                    id={`settings-ai-model-${field}`}
                    value={models[field]}
                    onChange={(event) => setModels((current) => ({ ...current, [field]: event.currentTarget.value }))}
                    aria-describedby={`settings-ai-model-${field}-hint`}
                    style={ui.monoField}
                  />
                </Field>
              ))}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
              <button type="button" onClick={() => void save()} disabled={busy} style={ui.primary}>
                {busy ? "Saving…" : "Save model configuration"}
              </button>
              <button
                type="button"
                onClick={() => void clearKey()}
                disabled={busy || !config.configured}
                style={ui.secondary}
              >
                Clear stored key
              </button>
              {note && (
                <span role={note.tone === "error" ? "alert" : "status"} style={{ fontSize: "11px", color: note.tone === "success" ? "#30563b" : note.tone === "pending" ? "#81672c" : "#8e4134" }}>
                  {note.text}
                </span>
              )}
            </div>

            <div style={{ borderTop: "1px solid #eeece5", paddingTop: "4px" }}>
              <div style={ui.listRow}>
                <span style={ui.muted}>Provider</span>
                <span style={{ color: INK, fontSize: "12px", fontWeight: 600 }}>
                  {AI_PROVIDER_OPTIONS.find((option) => option.id === config.provider)?.label ?? config.provider}
                </span>
              </div>
              <div style={ui.listRow}>
                <span style={ui.muted}>Endpoint</span>
                <span style={{ ...ui.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{config.baseUrl}</span>
              </div>
              {MODEL_FIELDS.map(({ field, label, hint }) => (
                <div key={field} style={ui.listRow}>
                  <span style={ui.muted}>
                    {label}
                    <span style={{ display: "block", color: "#a3a399", fontSize: "9px" }}>{hint}</span>
                  </span>
                  <span style={{ ...ui.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{config.models[field]}</span>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "10px" }}>
              <a href={legacyUrl("/proposals")} style={{ ...ui.card, display: "block", textDecoration: "none" }}>
                <p style={{ margin: "0 0 4px", color: INK, fontSize: "12px", fontWeight: 600 }}>Creator mode</p>
                <p style={{ ...ui.muted, margin: 0, fontSize: "10px" }}>
                  Connect a coding agent to propose capabilities as reviewed diffs.
                </p>
              </a>
              <a href={legacyUrl("/sessions")} style={{ ...ui.card, display: "block", textDecoration: "none" }}>
                <p style={{ margin: "0 0 4px", color: INK, fontSize: "12px", fontWeight: 600 }}>Agent sessions</p>
                <p style={{ ...ui.muted, margin: 0, fontSize: "10px" }}>
                  Every model action, its capability, and its outcome, auditable forever.
                </p>
              </a>
            </div>
          </div>
        )}
      </Section>

      <SoulSection />
      <MemorySection />
    </>
  );
}

function SoulSection() {
  const [soul, setSoul] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: NoticeTone; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAgentSoul(controller.signal)
      .then((text) => {
        if (!controller.signal.aborted) setSoul(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNote({ tone: "error", text: "Could not load the agent persona." });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    return () => controller.abort();
  }, []);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await saveAgentSoul(soul);
      setNote({ tone: "success", text: "Saved. Your workmate picks it up on the next message." });
    } catch (error) {
      setNote({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Agent persona (SOUL)"
      hint="Standing instructions your workmate follows in every conversation: voice, tone, hard rules. It cannot override security, approvals, or financial integrity."
    >
      <div style={{ ...ui.card, maxWidth: "640px", display: "grid", gap: "10px" }}>
        <textarea
          value={soul}
          onChange={(event) => setSoul(event.currentTarget.value)}
          disabled={!loaded}
          rows={5}
          aria-label="Agent persona instructions"
          placeholder={"Example:\n- We are a hardware store; keep replies practical and short.\n- Always mention outstanding balances when discussing a customer.\n- Never recommend credit terms beyond Net 30."}
          style={ui.textarea}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button type="button" onClick={() => void save()} disabled={!loaded || busy} style={ui.primary}>
            {busy ? "Saving…" : "Save persona"}
          </button>
          {note && (
            <span role={note.tone === "error" ? "alert" : "status"} style={{ fontSize: "11px", color: note.tone === "success" ? "#30563b" : "#8e4134" }}>
              {note.text}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}

function MemorySection() {
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [canEditMemory, setCanEditMemory] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMemory = useCallback(async (query: string, signal?: AbortSignal) => {
    try {
      const data = await fetchMemory(query, signal);
      if (signal?.aborted) return;
      setMemory(data.memories);
      setCanEditMemory(data.canEdit);
    } catch (error) {
      if (!signal?.aborted) setNotice({ tone: "error", text: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadMemory("", controller.signal);
    return () => controller.abort();
  }, [loadMemory]);

  function onSearch(value: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void loadMemory(value), 200);
  }

  async function deleteMemory(id: string, query: string) {
    setConfirmId(null);
    setNotice(null);
    try {
      const result = await submitGoverned("/api/memory", { action: "delete", memoryId: id });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      setNotice({ tone: "success", text: "Forgotten." });
      await loadMemory(query);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    }
  }

  return (
    <Section
      title="Memory"
      hint="What the workmate has learned about the organization: profile facts, SOPs, decisions, preferences, and document knowledge. Entries wrong or stale? Remove them."
    >
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <div style={ui.card}>
        <div style={{ ...ui.row, justifyContent: "flex-start", marginBottom: "10px" }}>
          <label style={{ ...ui.label, flex: "1 1 240px" }}>
            <span className="sr-only">Search organization memory</span>
            <input
              placeholder="Search memory…"
              aria-label="Search organization memory"
              onChange={(event) => onSearch(event.currentTarget.value)}
              style={ui.field}
            />
          </label>
          <span style={ui.empty}>{memory.length} shown</span>
        </div>

        {memory.length === 0 ? (
          <p style={{ ...ui.muted, margin: 0 }}>Nothing remembered yet.</p>
        ) : (
          <ul style={{ maxHeight: "320px", margin: 0, padding: 0, overflowY: "auto", listStyle: "none" }}>
            {memory.map((entry) => (
              <li key={entry.id} style={ui.listRow}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, color: MUTED, fontSize: "10px", fontWeight: 650 }}>
                    {entry.kind}
                    {entry.source ? <span style={{ color: "#a3a399", fontWeight: 400 }}> · {entry.source}</span> : null}
                  </p>
                  <p style={{ ...ui.muted, margin: "2px 0 0" }}>{entry.preview}</p>
                </div>
                {canEditMemory && (
                  <button
                    type="button"
                    aria-label="Delete memory entry"
                    title="Forget this"
                    onClick={() => setConfirmId(entry.id)}
                    style={{ minHeight: "26px", flex: "0 0 auto", border: "1px solid #e3e1d8", borderRadius: "5px", padding: "0 8px", background: "#fffefa", color: "#8e4134", cursor: "pointer", fontSize: "10px", fontWeight: 650 }}
                  >
                    Forget
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmId && (
        <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 20, display: "grid", placeItems: "center", background: "rgb(32 41 34 / 32%)" }}>
          <div role="dialog" aria-modal="true" aria-labelledby="settings-forget-title" style={{ ...ui.card, maxWidth: "420px", display: "grid", gap: "12px" }}>
            <h3 id="settings-forget-title" style={{ margin: 0, color: INK, fontSize: "14px", fontWeight: 650 }}>Forget this memory?</h3>
            <p style={{ ...ui.muted, margin: 0 }}>
              Searches and agent answers stop using it immediately. The audit trail records the removal.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setConfirmId(null)} style={ui.secondary}>Cancel</button>
              <button
                type="button"
                onClick={() => {
                  const query = document.querySelector<HTMLInputElement>('input[aria-label="Search organization memory"]')?.value ?? "";
                  void deleteMemory(confirmId, query);
                }}
                style={ui.primary}
              >
                Forget
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------- branding --- */

const MAX_LOGO_BYTES = 200_000;

function BrandingTab() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [footer, setFooter] = useState("");
  const [accent, setAccent] = useState("#b45309");
  const [layout, setLayout] = useState<"classic" | "modern">("classic");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchBranding(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setBranding(data.branding);
        setCanEdit(data.canEdit);
        setFooter(data.branding?.invoiceFooter ?? "");
        setAccent(data.branding?.accentColor ?? "#b45309");
        setLayout(data.branding?.layout === "modern" ? "modern" : "classic");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      });
    return () => controller.abort();
  }, []);

  function readLogo(file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setNotice({ tone: "error", text: "Logos up to 200KB are supported." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBranding((current) => ({
        logoDataUrl: String(reader.result),
        accentColor: current?.accentColor ?? null,
        invoiceFooter: current?.invoiceFooter ?? null,
        layout: current?.layout ?? "classic",
      }));
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitGoverned("/api/branding", {
        ...(branding?.logoDataUrl ? { logoDataUrl: branding.logoDataUrl } : {}),
        accentColor: accent,
        invoiceFooter: footer,
        layout,
      });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      setNotice({ tone: "success", text: "Branding saved." });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return <Notice tone="error">{loadError}</Notice>;
  }

  return (
    <Section
      title="Print branding"
      hint="How your invoices and printed documents identify the organization. Printed from Documents, then an order's invoice."
    >
      <div style={{ ...ui.card, maxWidth: "620px", display: "grid", gap: "16px" }}>
        <div style={ui.listRow}>
          <span style={ui.muted}>Logo</span>
          <span style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {branding?.logoDataUrl ? (
              <img src={branding.logoDataUrl} alt="Organization logo" style={{ height: "36px", width: "auto", border: "1px solid " + LINE, borderRadius: "5px", background: "#fff", padding: "3px" }} />
            ) : (
              <span style={ui.empty}>None</span>
            )}
            {canEdit && (
              <label style={{ ...ui.secondary, display: "inline-flex", alignItems: "center" }}>
                Upload
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml"
                  aria-label="Upload logo"
                  style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) readLogo(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            )}
          </span>
        </div>

        <label style={ui.label}>
          Accent color
          <input
            type="color"
            aria-label="Accent color"
            value={accent}
            disabled={!canEdit}
            onChange={(event) => setAccent(event.currentTarget.value)}
            style={{ width: "70px", height: "34px", border: "1px solid " + LINE, borderRadius: "6px", background: "#fffefa", padding: "2px" }}
          />
          <span style={ui.hint}>Rules, headings and totals on printed documents.</span>
        </label>

        <div>
          <span style={{ ...ui.label, marginBottom: "7px" }}>Layout</span>
          <div role="radiogroup" aria-label="Layout" style={{ display: "inline-flex", gap: "3px", border: "1px solid " + LINE, borderRadius: "8px", padding: "3px", background: "#fff" }}>
            {(["classic", "modern"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={layout === option}
                disabled={!canEdit}
                onClick={() => setLayout(option)}
                style={{ ...ui.chip, border: 0, ...(layout === option ? ui.chipOn : null) }}
              >
                {option}
              </button>
            ))}
          </div>
          <span style={{ ...ui.hint, display: "block", marginTop: "6px" }}>Classic: gray table headers. Modern: your accent color.</span>
        </div>

        <label style={ui.label}>
          Invoice footer
          <input
            value={footer}
            disabled={!canEdit}
            onChange={(event) => setFooter(event.currentTarget.value)}
            placeholder="Thank you for your business."
            style={ui.field}
          />
          <span style={ui.hint}>Small print at the foot of every printed document.</span>
        </label>

        {canEdit && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button type="button" onClick={() => void save()} disabled={busy} style={ui.primary}>
              {busy ? "Saving…" : "Save branding"}
            </button>
            {notice && (
              <span role={notice.tone === "error" ? "alert" : "status"} style={{ fontSize: "11px", color: notice.tone === "success" ? "#30563b" : notice.tone === "pending" ? "#81672c" : "#8e4134" }}>
                {notice.text}
              </span>
            )}
          </div>
        )}
        {!canEdit && <p style={{ ...ui.muted, margin: 0 }}>Only organization admins can change print branding.</p>}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- routines --- */

const HEARTBEAT_PROMPT =
  "Proactive heartbeat: scan the business for anything that needs attention (overdue invoices, low stock against reorder points, aging bills, stuck deals). If something needs attention, summarize it with concrete numbers and post it to #general. If nothing needs attention, reply NO_ACTION.";

function RoutinesTab() {
  const [rows, setRows] = useState<Routine[] | null>(null);
  const [name, setName] = useState("");
  const [scheduleText, setScheduleText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [withWebhook, setWithWebhook] = useState(false);
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchRoutines(signal);
      if (!signal?.aborted) setRows(data);
    } catch (error) {
      if (!signal?.aborted) {
        setRows([]);
        setNotice({ tone: "error", text: errorMessage(error) });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function act(action: Record<string, unknown>, successText: string) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitGoverned("/api/routines", action);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      setNotice({ tone: "success", text: successText });
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function create(overrides?: { name: string; prompt: string; scheduleText: string }) {
    setCreating(true);
    setNotice(null);
    const payload = overrides ?? { name, prompt, scheduleText, withWebhook };
    try {
      const result = await submitGoverned("/api/routines", { action: "create", ...payload });
      if (result.kind === "pending") {
        setNotice({ tone: "pending", text: result.reason });
        return;
      }
      const webhookUrl = typeof result.data.webhookUrl === "string" ? result.data.webhookUrl : null;
      setNotice({
        tone: "success",
        text: webhookUrl ? `Routine created. Webhook trigger: ${webhookUrl}` : "Routine created.",
      });
      setName("");
      setScheduleText("");
      setPrompt("");
      setWithWebhook(false);
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Section
      title="Routines"
      hint="Recurring agent runs, scheduled in plain language. Each run is a governed, replayable agent session; findings land in your notifications."
    >
      <div style={{ ...ui.card, maxWidth: "640px", display: "grid", gap: "12px", marginBottom: "18px" }}>
        <label style={ui.label}>
          Name
          <input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Name, e.g. Morning check" aria-label="Routine name" style={ui.field} />
        </label>
        <label style={ui.label}>
          When
          <input value={scheduleText} onChange={(event) => setScheduleText(event.currentTarget.value)} placeholder="When, e.g. weekdays at 9am" aria-label="Schedule in plain language" style={ui.field} />
        </label>
        <label style={ui.label}>
          Instructions
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="What should the agent check or do each run?"
            aria-label="Routine instructions"
            rows={2}
            style={ui.textarea}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "7px", color: MUTED, fontSize: "11px" }}>
          <input type="checkbox" checked={withWebhook} onChange={(event) => setWithWebhook(event.currentTarget.checked)} />
          Allow webhook trigger (Paperclip-compatible)
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "8px" }}>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || !name.trim() || !scheduleText.trim() || !prompt.trim()}
            style={ui.primary}
          >
            {creating ? "Creating…" : "Create routine"}
          </button>
          <button
            type="button"
            onClick={() => void create({ name: "Heartbeat", prompt: HEARTBEAT_PROMPT, scheduleText: "daily at 08:00" })}
            style={ui.secondary}
          >
            Daily heartbeat preset
          </button>
        </div>
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {rows === null ? (
        <p role="status" style={ui.muted}>Loading routines…</p>
      ) : rows.length === 0 ? (
        <p style={ui.muted}>No routines yet. Create one above, or start with the daily heartbeat.</p>
      ) : (
        <ul style={{ display: "grid", gap: "9px", margin: 0, padding: 0, listStyle: "none" }}>
          {rows.map((routine) => (
            <li key={routine.id} style={ui.card}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "7px" }}>
                <strong style={{ color: INK, fontSize: "12px" }}>{routine.name}</strong>
                <span style={ui.badge}>{routine.scheduleLabel}</span>
                {routine.triggerType === "webhook" && <span style={ui.badge}>webhook</span>}
                <span
                  title={routine.lastError ?? undefined}
                  style={{
                    ...ui.badge,
                    ...(routine.lastStatus === "ok"
                      ? { background: "#eef5ec", color: "#3d6b4c" }
                      : routine.lastStatus === "failed"
                        ? { background: "#fff2ef", color: "#8e4134" }
                        : null),
                  }}
                >
                  {routine.lastStatus ?? "never run"}
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginLeft: "auto" }}>
                  <button type="button" disabled={busy} onClick={() => void act({ action: "runNow", routineId: routine.id }, "Run queued; the worker will pick it up.")} style={ui.secondary}>Run now</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act({ action: "update", routineId: routine.id, enabled: !routine.enabled }, routine.enabled ? "Routine paused." : "Routine resumed.")}
                    style={ui.secondary}
                  >
                    {routine.enabled ? "Pause" : "Resume"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void act({ action: "delete", routineId: routine.id }, "Routine deleted.")} style={ui.secondary}>Delete</button>
                </div>
              </div>
              <p style={{ ...ui.muted, margin: "7px 0 0", fontSize: "10px" }}>
                {routine.lastError ?? "Read-only runner; findings become notifications."}
              </p>
              <p style={{ margin: "4px 0 0", color: "#a3a399", fontSize: "10px" }}>
                {routine.enabled && routine.nextRunAt ? `Next run ${new Date(routine.nextRunAt).toLocaleString()}` : "Paused"}
                {routine.webhookUrl && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      title={routine.webhookUrl}
                      onClick={() => void copyToClipboard(routine.webhookUrl ?? "")}
                      style={{ border: 0, padding: 0, background: "none", color: "#4b6b56", cursor: "pointer", font: "inherit", fontSize: "10px", textDecoration: "underline" }}
                    >
                      copy webhook URL
                    </button>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------- runtime --- */

function RuntimeTab() {
  const [rows, setRows] = useState<CompositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCompositions(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setRows(data);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return <Notice tone="error">{error} Runtime inspection is limited to operators who can approve harness compositions.</Notice>;
  }
  if (rows === null) {
    return <p role="status" style={ui.muted}>Loading runtime compositions…</p>;
  }
  if (rows.length === 0) {
    return <p style={ui.muted}>No runtime compositions. Approved profiles and bundles appear here when a durable run is configured.</p>;
  }

  return (
    <Section
      title="Runtime compositions"
      hint="The exact profile and approved bundles a durable run may mount. Inspection shows safe metadata and configuration keys, never patch values or credentials."
    >
      <div style={{ display: "grid", gap: "12px" }}>
        {rows.map(({ id, createdAt, inspection }) => (
          <div key={id} style={ui.card}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
              <span style={{ ...ui.badge, background: inspection.profile.environment === "erp-prod" ? "#fff2ef" : "#eef1f7", color: inspection.profile.environment === "erp-prod" ? "#8e4134" : "#3c4a5e" }}>
                {inspection.profile.environment}
              </span>
              <h3 style={{ margin: 0, color: INK, fontSize: "13px", fontWeight: 650 }}>{inspection.profile.id}</h3>
              <span style={ui.empty}>v{inspection.profile.version} · {timeAgo(createdAt)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px", marginTop: "12px" }}>
              <DigestBox label="Profile digest" value={inspection.profileDigest} />
              <DigestBox label="Composition digest" value={inspection.compositionDigest} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px", marginTop: "14px" }}>
              <div>
                <p style={{ ...ui.label, margin: 0 }}>Approved bundles</p>
                <ul style={{ ...ui.muted, margin: "5px 0 0", paddingLeft: "16px" }}>
                  {inspection.bundles.map((bundle) => (
                    <li key={`${bundle.id}@${bundle.version}`}>
                      <code style={ui.mono}>{bundle.id}@{bundle.version}</code> · {bundle.serviceIds.length} service{bundle.serviceIds.length === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p style={{ ...ui.label, margin: 0 }}>Configuration patches</p>
                {inspection.patches.length === 0 ? (
                  <p style={{ ...ui.muted, margin: "5px 0 0" }}>None</p>
                ) : (
                  <ul style={{ ...ui.muted, margin: "5px 0 0", paddingLeft: "16px" }}>
                    {inspection.patches.map((patch) => (
                      <li key={`${patch.id}@${patch.version}`}>
                        <code style={ui.mono}>{patch.id}@{patch.version}</code> · {patch.configKeys.length} key{patch.configKeys.length === 1 ? "" : "s"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <p style={{ ...ui.mono, margin: "12px 0 0", color: "#a3a399" }}>composition {id}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function DigestBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid " + LINE, borderRadius: "8px", padding: "9px 10px", background: "#f7f6f0" }}>
      <p style={{ margin: 0, color: "#a3a399", fontSize: "9px", fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>{label}</p>
      <code style={{ display: "block", marginTop: "4px", color: "#4c5149", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "10px", overflowWrap: "anywhere" }}>{value}</code>
      <button type="button" onClick={() => void copyToClipboard(value)} style={{ marginTop: "5px", border: 0, padding: 0, background: "none", color: "#4b6b56", cursor: "pointer", fontSize: "10px", fontWeight: 650 }}>Copy</button>
    </div>
  );
}

export default SettingsPage;
