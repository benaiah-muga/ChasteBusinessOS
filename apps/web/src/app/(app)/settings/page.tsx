"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { callApi, postApi } from "@/lib/api";
import { Badge, Button, Card, CopyButton, EmptyState, LoadingPage } from "@/components/ui";
import { APPS, tileStyle } from "../_shell/apps";
import { appPins, MAX_PINS, usePinnedApps } from "../_shell/pins";
import { useModuleEnabled } from "../_shell/module-context";
import { ModulesManager } from "../_shell/modules-manager";
import { AppFrame } from "../_shell/app-frame";
import { applyMode, useMode, MODES } from "@/components/theme";
import {
  CURRENCIES,
  usePrefs,
  type CurrencyCode,
  type DateFormat,
  type Units,
  type WeekStart,
} from "@/lib/prefs";
import { IconAlertTriangle, IconCheck, IconMoon, IconPinTack, IconSun } from "@/components/icons";
import { cn, timeAgo } from "@/lib/format";

const TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Workspace" },
  { id: "localization", label: "Localization" },
  { id: "ai", label: "AI & automation" },
  { id: "routines", label: "Routines" },
  { id: "runtime", label: "Runtime" },
] as const;

/**
 * Settings: the quiet control room. Appearance and localization are client
 * preferences; workspace facts link out to where authority lives.
 */
export default function SettingsPage() {
  const [tab, setTab] = useState<string>("appearance");

  return (
    <AppFrame
      appId="settings"
      description="Appearance, workspace, localization, and the models behind your workmate."
      persistKey="settings"
      tabs={[...TABS]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === "appearance" && <AppearanceTab />}
      {tab === "workspace" && <WorkspaceTab />}
      {tab === "localization" && <LocalizationTab />}
      {tab === "ai" && <AiTab />}
      {tab === "routines" && <RoutinesTab />}
      {tab === "runtime" && <RuntimeTab />}
    </AppFrame>
  );
}

interface CompositionInspection {
  id: string;
  createdAt: string;
  inspection: {
    profile: { id: string; version: string; environment: string };
    profileDigest: string;
    compositionDigest: string;
    bundles: Array<{ id: string; version: string; serviceIds: string[]; requiredBundleIds?: string[] }>;
    patches: Array<{ id: string; version: string; configKeys: string[] }>;
  };
}

function RuntimeTab() {
  const [compositions, setCompositions] = useState<CompositionInspection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void callApi<{ compositions?: CompositionInspection[] }>("/api/harness/compositions").then((res) => {
      if (!res.ok) setError(res.error?.title ?? "Couldn't load runtime compositions");
      setCompositions(res.data?.compositions ?? []);
    });
  }, []);

  if (compositions === null) return <LoadingPage />;
  if (error) return <EmptyState icon={<IconAlertTriangle />} title={error} hint="Runtime inspection is limited to operators who can approve harness compositions." />;
  if (compositions.length === 0) {
    return <EmptyState icon={<IconCheck />} title="No runtime compositions" hint="Approved profiles and bundles will appear here when a durable run is configured." />;
  }

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h2 className="section-title">Runtime compositions</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-500">
          The exact profile and approved bundles a durable run may mount. Inspection shows safe metadata and configuration keys, never patch values or credentials.
        </p>
      </div>
      {compositions.map(({ id, createdAt, inspection }) => (
        <Card key={id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={inspection.profile.environment === "erp-prod" ? "red" : "blue"}>{inspection.profile.environment}</Badge>
            <h3 className="text-[15px] font-semibold text-stone-900">{inspection.profile.id}</h3>
            <span className="text-xs text-stone-400">v{inspection.profile.version} · {timeAgo(createdAt)}</span>
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
              <p className="text-[10px] font-semibold tracking-wider text-stone-400 uppercase">Profile digest</p>
              <code className="mt-1 block break-all text-stone-700">{inspection.profileDigest}</code>
              <CopyButton text={inspection.profileDigest} label="Copy" />
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
              <p className="text-[10px] font-semibold tracking-wider text-stone-400 uppercase">Composition digest</p>
              <code className="mt-1 block break-all text-stone-700">{inspection.compositionDigest}</code>
              <CopyButton text={inspection.compositionDigest} label="Copy" />
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold text-stone-500">Approved bundles</p>
              <ul className="mt-1 space-y-1 text-xs text-stone-700">
                {inspection.bundles.map((bundle) => <li key={`${bundle.id}@${bundle.version}`}><code>{bundle.id}@{bundle.version}</code> · {bundle.serviceIds.length} service{bundle.serviceIds.length === 1 ? "" : "s"}</li>)}
              </ul>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-stone-500">Configuration patches</p>
              <ul className="mt-1 space-y-1 text-xs text-stone-700">
                {inspection.patches.length === 0 ? <li className="text-stone-400">None</li> : inspection.patches.map((patch) => <li key={`${patch.id}@${patch.version}`}><code>{patch.id}@{patch.version}</code> · {patch.configKeys.length} key{patch.configKeys.length === 1 ? "" : "s"}</li>)}
              </ul>
            </div>
          </div>
          <p className="mt-3 font-mono text-[10px] text-stone-400">composition {id}</p>
        </Card>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- appearance ---- */

function AppearanceTab() {
  const mode = useMode();
  const pinnedIds = usePinnedApps();
  const apps = APPS;

  return (
    <div className="max-w-3xl">
      <Section title="Color mode" hint="Light, dark, or follow your system - resolved before first paint.">
        <div role="radiogroup" aria-label="Color mode" className="flex w-fit gap-1 rounded-xl border border-stone-200 bg-white p-1 shadow-xs">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => applyMode(m.id)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150",
                mode === m.id ? "bg-gold-50 text-gold-900" : "text-stone-500 hover:bg-stone-100",
              )}
            >
              {m.id === "dark" ? (
                <IconMoon className="size-3.5" />
              ) : m.id === "light" ? (
                <IconSun className="size-3.5" />
              ) : null}
              {m.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Brand" hint="One identity across every surface - warm paper, the inked band, burnished gold.">
        <div className="flex items-center gap-4 rounded-xl border border-stone-200 bg-white p-4 shadow-xs">
          <span
            aria-hidden="true"
            className="flex h-10 w-16 shrink-0 overflow-hidden rounded-lg border border-black/5"
            style={{ background: "linear-gradient(160deg, #111416 0 55%, #f4efe6 55% 100%)" }}
          />
          <div className="text-[13px] leading-relaxed text-stone-600">
            Chaste ships with a single brand palette. Semantic colors - success, warnings, errors - never change between modes.
          </div>
        </div>
      </Section>

      <PinsSection pinnedIds={pinnedIds} apps={apps} />
    </div>
  );
}

/* ------------------------------------------------------------ workspace ---- */

function WorkspaceTab() {
  const accountingOn = useModuleEnabled("accounting");
  const [orgName, setOrgName] = useState<string>("");

  useEffect(() => {
    void (async () => {
      const res = await callApi<{ orgs: { id: string; name: string }[]; activeOrgId: string | null }>("/api/org");
      const active = res.data?.orgs.find((o) => o.id === res.data?.activeOrgId);
      setOrgName(active?.name ?? "");
    })();
  }, []);

  return (
    <div className="max-w-3xl">
      <Section title="Organization" hint="The workspace these settings govern. Switch organizations from the account menu on the rail.">
        <dl className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <dt className="text-stone-500">Name</dt>
            <dd className="font-medium text-stone-900">{orgName || "-"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <dt className="text-stone-500">Modules</dt>
            <dd className="text-stone-700">
              {accountingOn ? "Managed by owners" : "Restricted set"} ·{" "}
              <Link href="/team" className="font-medium text-gold-800 hover:underline">
                Team &amp; roles
              </Link>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <dt className="text-stone-500">Agent sessions</dt>
            <dd>
              <Link href="/sessions" className="font-medium text-gold-800 hover:underline">
                View trajectory log →
              </Link>
            </dd>
          </div>
        </dl>
      </Section>

      <Section
        title="Modules"
        hint="Which applications your organization runs. Turning a module off hides it from people, the workmate, and the job queue at once; changes are identity-class and wait for approval."
      >
        <ModulesManager />
      </Section>

      <EmailSection />
    </div>
  );
}

/* --------------------------------------------------------- localization ---- */

function LocalizationTab() {
  const [prefs, update] = usePrefs();

  return (
    <div className="max-w-2xl">
      <p className="mb-6 text-sm leading-relaxed text-stone-500">
        How figures and dates are <em>presented</em> on this device. The books
        themselves stay in their recording currency - these settings never
        rewrite stored amounts.
      </p>

      <SettingRow label="Display currency" hint="Applied to money figures on pages that adopt it.">
        <select
          value={prefs.currency}
          onChange={(e) => update({ currency: e.target.value as CurrencyCode })}
          aria-label="Display currency"
          className="select w-56"
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.symbol} {c.code} - {c.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Units of measurement" hint="Weights and dimensions across inventory and manufacturing.">
        <div role="radiogroup" aria-label="Units of measurement" className="flex w-fit gap-1 rounded-xl border border-stone-200 bg-white p-1 shadow-xs">
          {(
            [
              ["metric", "Metric (kg, cm, L)"],
              ["imperial", "Imperial (lb, in, gal)"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={prefs.units === id}
              onClick={() => update({ units: id as Units })}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors duration-150",
                prefs.units === id ? "bg-gold-50 text-gold-900" : "text-stone-500 hover:bg-stone-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Date format" hint="Used across tables and documents.">
        <div role="radiogroup" aria-label="Date format" className="flex w-fit gap-1 rounded-xl border border-stone-200 bg-white p-1 shadow-xs">
          {(
            [
              ["dmy", "26 Aug 2026"],
              ["iso", "2026-08-26"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={prefs.dateFormat === id}
              onClick={() => update({ dateFormat: id as DateFormat })}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors duration-150",
                prefs.dateFormat === id ? "bg-gold-50 text-gold-900" : "text-stone-500 hover:bg-stone-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Week starts on" hint="Anchors calendars, timesheets, and payroll weeks.">
        <div role="radiogroup" aria-label="Week starts on" className="flex w-fit gap-1 rounded-xl border border-stone-200 bg-white p-1 shadow-xs">
          {(
            [
              ["mon", "Monday"],
              ["sun", "Sunday"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={prefs.weekStart === id}
              onClick={() => update({ weekStart: id as WeekStart })}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors duration-150",
                prefs.weekStart === id ? "bg-gold-50 text-gold-900" : "text-stone-500 hover:bg-stone-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </SettingRow>

      <p className="mt-6 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-relaxed text-stone-500">
        Recording currency for new documents is set per document (invoices carry
        their own currency); this display preference is applied on top.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- ai tab ---- */

interface AiConfig {
  provider: string;
  configured: boolean;
  baseUrl: string;
  models: { primary: string; fast: string; reasoning: string; embeddings: string };
  keyHint?: string | null;
  source: string;
}

type AiProviderId = "nvidia" | "openrouter" | "groq" | "mistral" | "zai" | "openai" | "custom";

const AI_PROVIDER_OPTIONS: Array<{ id: AiProviderId; label: string; baseUrl: string }> = [
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "zai", label: "Z.ai (GLM)", baseUrl: "https://api.z.ai/api/paas/v4" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "custom", label: "Custom OpenAI-compatible", baseUrl: "" },
];

const DEFAULT_AI_MODELS = {
  primary: "moonshotai/kimi-k2.6",
  fast: "meta/muse-glimmer-30b",
  reasoning: "nvidia/nemotron-3-ultra-550b-a55b",
  embeddings: "nvidia/nv-embedqa-e5-v5",
};

function AiTab() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProviderId>("nvidia");
  const [baseUrl, setBaseUrl] = useState(AI_PROVIDER_OPTIONS[0]!.baseUrl);
  const [models, setModels] = useState(DEFAULT_AI_MODELS);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function applyConfig(next: AiConfig) {
    const nextProvider = AI_PROVIDER_OPTIONS.some((option) => option.id === next.provider) ? (next.provider as AiProviderId) : "custom";
    setConfig(next);
    setProvider(nextProvider);
    setBaseUrl(next.baseUrl);
    setModels(next.models);
    setApiKey("");
  }

  useEffect(() => {
    void callApi<AiConfig>("/api/ai-config").then((res) => {
      if (res.data) applyConfig(res.data);
      else setError(res.error?.title ?? "Could not load model configuration");
    });
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
    const res = await postApi<AiConfig & { pendingApproval?: boolean }>("/api/ai-config", {
      provider,
      baseUrl,
      models,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setBusy(false);
    if (res.status === 202) {
      setNote("Configuration submitted for administrator approval.");
    } else if (res.data && res.ok && "provider" in res.data) {
      applyConfig(res.data);
      setNote("Model configuration saved. New agent runs use it.");
    } else {
      setNote(res.error?.title ?? "Could not save model configuration.");
    }
  }

  async function clearKey() {
    if (!config?.configured) return;
    setBusy(true);
    setNote(null);
    const res = await postApi<AiConfig & { pendingApproval?: boolean }>("/api/ai-config", {
      provider,
      baseUrl,
      models,
      clearApiKey: true,
    });
    setBusy(false);
    if (res.status === 202) setNote("Key removal submitted for administrator approval.");
    else if (res.data && res.ok && "provider" in res.data) {
      applyConfig(res.data);
      setNote("Workspace key cleared.");
    } else setNote(res.error?.title ?? "Could not clear workspace key.");
  }

  function updateModel(field: keyof typeof DEFAULT_AI_MODELS, value: string) {
    setModels((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-6 text-sm leading-relaxed text-stone-500">
        Choose the provider and model roles used by this workspace. Credentials
        are encrypted before storage, never returned to the browser, and every
        change goes through the governed capability pipeline.
      </p>

      {!config ? (
        <p className="text-sm text-stone-400">{error ?? "Checking configuration…"}</p>
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="section-title">Workspace model provider</h2>
                <p className="mt-1 text-xs text-stone-500">Source: {config.source === "workspace" ? "workspace override" : "server environment"}</p>
              </div>
              {config.configured ? <Badge tone="green">connected {config.keyHint ?? ""}</Badge> : <Badge tone="amber">credential missing</Badge>}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-stone-600">
                Provider
                <select value={provider} onChange={(e) => changeProvider(e.target.value as AiProviderId)} className="select mt-1 w-full">
                  {AI_PROVIDER_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
              <label className="text-sm text-stone-600">
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config.keyHint ? `Current key ${config.keyHint}` : "Paste a provider key"}
                  className="input mt-1 w-full"
                  autoComplete="new-password"
                />
              </label>
            </div>
            <label className="mt-4 block text-sm text-stone-600">
              Base URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="input mt-1 w-full font-mono text-xs" placeholder="https://your-provider.example/v1" />
              <span className="mt-1 block text-xs text-stone-400">Use a custom URL for a self-hosted or OpenAI-compatible gateway.</span>
            </label>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["primary", "Primary", "Conversations, drafting, and coding suggestions"],
                  ["fast", "Fast", "Classifications and quick lookups"],
                  ["reasoning", "Reasoning", "Deep multi-step analysis"],
                  ["embeddings", "Embeddings", "Document search and memory"],
                ] as const
              ).map(([field, label, hint]) => (
                <label key={field} className="text-sm text-stone-600">
                  {label}
                  <input value={models[field]} onChange={(e) => updateModel(field, e.target.value)} className="input mt-1 w-full font-mono text-xs" />
                  <span className="mt-1 block text-[11px] text-stone-400">{hint}</span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button size="sm" loading={busy} onClick={() => void save()}>Save model configuration</Button>
              <Button size="sm" tone="secondary" disabled={busy || !config.configured} onClick={() => void clearKey()}>Clear stored key</Button>
              {note && <span className="text-xs text-stone-500">{note}</span>}
            </div>
          </Card>

          <div className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <dt className="text-stone-500">Provider</dt>
              <dd className="flex items-center gap-2 font-medium text-stone-900">
                {AI_PROVIDER_OPTIONS.find((option) => option.id === config.provider)?.label ?? config.provider}
                {config.configured ? (
                  <span className="badge badge-green">connected</span>
                ) : (
                  <span className="badge badge-amber">key missing</span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <dt className="text-stone-500">Endpoint</dt>
              <dd className="truncate font-mono text-xs text-stone-600">{config.baseUrl}</dd>
            </div>
            <ModelRow label="Primary" model={config.models.primary} hint="Conversations, drafting, coding suggestions" />
            <ModelRow label="Fast" model={config.models.fast} hint="Classifications and quick lookups" />
            <ModelRow label="Reasoning" model={config.models.reasoning} hint="Deep multi-step analysis" />
            <ModelRow label="Embeddings" model={config.models.embeddings} hint="Document search and memory" />
          </div>

          <p className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">
            Coding-agent subscriptions are not imported from local CLI files. Use a detected Codex, OpenCode, or Kilo agent through Creator mode, or enter an API key / endpoint that this workspace is authorized to call.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Link
              href="/proposals"
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-xs transition-colors duration-150 hover:border-stone-300"
            >
              <p className="text-sm font-medium text-stone-900">Creator mode</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                Connect a coding agent to propose capabilities as reviewed diffs.
              </p>
            </Link>
            <Link
              href="/sessions"
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-xs transition-colors duration-150 hover:border-stone-300"
            >
              <p className="text-sm font-medium text-stone-900">Agent sessions</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                Every model action, its capability, and its outcome - auditable forever.
              </p>
            </Link>
          </div>
        </>
      )}

      <div className="mt-8 border-t border-stone-100 pt-6">
        <SoulSection />
      </div>
    </div>
  );
}

function ModelRow({ label, model, hint }: { label: string; model: string; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <dt className="text-sm text-stone-500">
        {label}
        <span className="block text-[11px] text-stone-400">{hint}</span>
      </dt>
      <dd className="truncate font-mono text-xs text-stone-600">{model}</dd>
    </div>
  );
}

/* -------------------------------------------------------------- shared ----- */

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
      <p className="mt-1 text-sm leading-relaxed text-stone-500">{hint}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-stone-100 pb-5 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-800">{label}</p>
        <p className="mt-0.5 text-xs text-stone-500">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function PinsSection({ pinnedIds, apps }: { pinnedIds: string[]; apps: typeof APPS }) {
  return (
    <Section
      title="Pinned apps"
      hint={`Your daily drivers live one click away on the workspace rail. Pin up to ${MAX_PINS}.`}
    >
      <div className="mb-3 flex items-baseline justify-end gap-3">
        <span className="tnum text-xs text-stone-400">
          {pinnedIds.length}/{MAX_PINS} on the rail
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {apps.map((app) => {
          const pinned = pinnedIds.includes(app.id);
          return (
            <li key={app.id}>
              <button
                type="button"
                onClick={() => appPins.toggle(app.id)}
                disabled={!pinned && pinnedIds.length >= MAX_PINS}
                aria-pressed={pinned}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-150",
                  pinned
                    ? "border-gold-300 bg-gold-50/60"
                    : "border-stone-200 bg-white hover:border-stone-300 disabled:pointer-events-none disabled:opacity-40",
                )}
              >
                <span
                  aria-hidden="true"
                  style={tileStyle()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                >
                  <app.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-stone-900">{app.name}</span>
                  <span className="block truncate text-[11px] text-stone-400">{app.tagline}</span>
                </span>
                <IconPinTack
                  className={cn("size-4 shrink-0", pinned ? "text-gold-700" : "text-stone-300")}
                  strokeWidth={pinned ? 2.4 : 1.75}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Outbound email: shows whether SMTP is live and proves it with a test send. */
function EmailSection() {
  const [status, setStatus] = useState<{ configured: boolean; from: string | null } | null>(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await callApi<{ configured: boolean; from: string | null }>("/api/email");
      if (res.data) setStatus(res.data);
    })();
  }, []);

  async function sendTest() {
    setBusy(true);
    setNote(null);
    const res = await postApi<{ reason?: string }>("/api/email", { action: "test", to: to.trim() });
    setBusy(false);
    setNote(res.ok ? "Test email sent - check the inbox." : (res.error?.title ?? "Send failed."));
  }

  return (
    <Section title="Email" hint="Invoices, approvals, and customer care all deliver through SMTP.">
      <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
        {!status ? (
          <p className="text-sm text-stone-400">Checking…</p>
        ) : status.configured ? (
          <p className="text-sm text-stone-500">
            SMTP is configured
            {status.from ? (
              <>
                {" "}
                - sending as <code className="rounded bg-stone-100 px-1">{status.from}</code>
              </>
            ) : null}
            .
          </p>
        ) : (
          <p className="text-sm text-stone-500">
            Set <code className="rounded bg-stone-100 px-1">SMTP_HOST</code> (+ optional{" "}
            <code className="rounded bg-stone-100 px-1">SMTP_FROM</code>) in the server environment to enable delivery.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            aria-label="Test recipient"
            type="email"
            placeholder="you@company.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={!status?.configured}
            className="input h-8 w-56"
          />
          <Button size="sm" tone="secondary" disabled={busy || !status?.configured || !/.+@.+\..+/.test(to)} onClick={() => void sendTest()}>
            Send test email
          </Button>
          {note && <span className="text-xs text-stone-500">{note}</span>}
        </div>
      </div>
    </Section>
  );
}

/* --------------------------------------------------- soul + routines ---- */

function SoulSection() {
  const [soul, setSoul] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void callApi<{ agentSoul: string }>("/api/org", { method: "PUT" }).then((res) => {
      if (res.data) setSoul(res.data.agentSoul ?? "");
      setLoaded(true);
    });
  }, []);

  async function save() {
    setBusy(true);
    setNote(null);
    const res = await callApi("/api/org", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentSoul: soul }),
    });
    setBusy(false);
    setNote(res.ok ? "Saved. Your workmate picks it up on the next message." : (res.error?.title ?? "Could not save"));
  }

  return (
    <Section
      title="Agent persona (SOUL)"
      hint="Standing instructions your workmate follows in every conversation: voice, tone, hard rules. It cannot override security, approvals, or financial integrity."
    >
      <div className="max-w-2xl">
        <textarea
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          disabled={!loaded}
          rows={5}
          aria-label="Agent persona instructions"
          placeholder={"Example:\n- We are a hardware store; keep replies practical and short.\n- Always mention outstanding balances when discussing a customer.\n- Never recommend credit terms beyond Net 30."}
          className="w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-stone-400 focus:border-gold-500"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" loading={busy} onClick={() => void save()}>
            Save persona
          </Button>
          {note && <span className="text-xs text-stone-500">{note}</span>}
        </div>
      </div>
    </Section>
  );
}

interface RoutineRow {
  id: string;
  name: string;
  scheduleLabel: string;
  triggerType: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  webhookUrl: string | null;
}

const HEARTBEAT_PROMPT =
  "Proactive heartbeat: scan the business for anything that needs attention (overdue invoices, low stock against reorder points, aging bills, stuck deals). If something needs attention, summarize it with concrete numbers and post it to #general. If nothing needs attention, reply NO_ACTION.";

function RoutinesTab() {
  const [rows, setRows] = useState<RoutineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scheduleText, setScheduleText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [withWebhook, setWithWebhook] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    void callApi<{ routines: RoutineRow[] }>("/api/routines").then((res) => {
      if (res.data) setRows(res.data.routines);
      else setError(res.error?.title ?? "Could not load routines");
    });
  };
  useEffect(load, []);

  async function act(body: Record<string, unknown>, successNote: string) {
    const res = await postApi("/api/routines", body);
    if (res.ok) {
      setNote(successNote);
      load();
    } else {
      setNote(res.error?.title ?? "That did not work");
    }
  }

  async function create(overrides?: { name: string; prompt: string; scheduleText: string }) {
    setCreating(true);
    setNote(null);
    const payload = overrides ?? { name, prompt, scheduleText, withWebhook };
    const res = await postApi<{ webhookUrl: string | null }>("/api/routines", { action: "create", ...payload });
    setCreating(false);
    if (res.ok) {
      setNote(
        res.data?.webhookUrl
          ? `Routine created. Webhook trigger: ${res.data.webhookUrl}`
          : "Routine created.",
      );
      setName("");
      setScheduleText("");
      setPrompt("");
      setWithWebhook(false);
      load();
    } else {
      setNote(res.error?.title ?? "Could not create the routine");
    }
  }

  return (
    <div className="max-w-3xl">
      <Section
        title="Routines"
        hint="Recurring agent runs, scheduled in plain language. Each run is a governed, replayable agent session; findings land in your notifications."
      >
        <div className="mb-5 grid gap-2 rounded-xl border border-stone-200 bg-white p-4 shadow-xs sm:grid-cols-[1fr_1fr]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. Morning check"
            aria-label="Routine name"
            className="input"
          />
          <input
            value={scheduleText}
            onChange={(e) => setScheduleText(e.target.value)}
            placeholder="When, e.g. weekdays at 9am"
            aria-label="Schedule in plain language"
            className="input"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent check or do each run?"
            aria-label="Routine instructions"
            rows={2}
            className="input resize-y sm:col-span-2"
          />
          <label className="flex items-center gap-2 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={withWebhook}
              onChange={(e) => setWithWebhook(e.target.checked)}
              className="accent-gold-700"
            />
            Allow webhook trigger (Paperclip-compatible)
          </label>
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              loading={creating}
              disabled={!name.trim() || !scheduleText.trim() || !prompt.trim()}
              onClick={() => void create()}
            >
              Create routine
            </Button>
            <Button
              size="sm"
              tone="secondary"
              onClick={() =>
                void create({ name: "Heartbeat", prompt: HEARTBEAT_PROMPT, scheduleText: "daily at 08:00" })
              }
            >
              Daily heartbeat preset
            </Button>
          </div>
        </div>

        {note && <p className="mb-4 text-xs text-stone-500">{note}</p>}
        {error && <p className="mb-4 text-sm text-red-700">{error}</p>}

        {rows !== null && rows.length === 0 && (
          <p className="text-sm text-stone-400">
            No routines yet. Create one above, or start with the daily heartbeat.
          </p>
        )}
        <ul className="space-y-2">
          {rows?.map((r) => (
            <li key={r.id} className="rounded-xl border border-stone-200 bg-white p-4 shadow-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-stone-900">{r.name}</span>
                <span className="badge">{r.scheduleLabel}</span>
                {r.triggerType === "webhook" && <span className="badge">webhook</span>}
                <span
                  className={
                    r.lastStatus === "ok"
                      ? "badge badge-green"
                      : r.lastStatus === "failed"
                        ? "badge badge-red"
                        : "badge"
                  }
                  title={r.lastError ?? undefined}
                >
                  {r.lastStatus ?? "never run"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" tone="secondary" onClick={() => void act({ action: "runNow", routineId: r.id }, "Run queued; the worker will pick it up.")}>
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={() => void act({ action: "update", routineId: r.id, enabled: !r.enabled }, r.enabled ? "Routine paused." : "Routine resumed.")}
                  >
                    {r.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" tone="secondary" onClick={() => void act({ action: "delete", routineId: r.id }, "Routine deleted.")}>
                    Delete
                  </Button>
                </div>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{r.lastError ?? "Read-only runner; findings become notifications."}</p>
              <p className="mt-1 text-[11px] text-stone-400">
                {r.enabled && r.nextRunAt ? `Next run ${new Date(r.nextRunAt).toLocaleString()}` : "Paused"}
                {r.webhookUrl && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      title={r.webhookUrl}
                      onClick={() => void navigator.clipboard.writeText(r.webhookUrl ?? "")}
                      className="cursor-pointer font-mono underline underline-offset-2"
                    >
                      copy webhook URL
                    </button>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
