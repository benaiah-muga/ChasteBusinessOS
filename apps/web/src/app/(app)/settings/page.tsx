"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { callApi, postApi } from "@/lib/api";
import { Button, ConfirmDialog, Notice } from "@/components/ui";
import { APPS, tileStyle } from "../_shell/apps";
import { appPins, MAX_PINS, usePinnedApps } from "../_shell/pins";
import { useModuleEnabled } from "../_shell/module-context";
import { ModulesManager } from "../_shell/modules-manager";
import { AppFrame } from "../_shell/app-frame";
import { applyMode, useMode, MODES } from "@/components/theme";
import {
  CURRENCIES,
  usePrefs,
  type DateFormat,
  type DisplayCurrency,
  type Units,
  type WeekStart,
} from "@/lib/prefs";
import { IconMoon, IconPinTack, IconSun, IconTrash } from "@/components/icons";
import { cn, minorToInput, toMinor } from "@/lib/format";
import { useMoneySync } from "@/lib/money";

const TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Workspace" },
  { id: "modules", label: "Modules" },
  { id: "governance", label: "Governance" },
  { id: "localization", label: "Localization" },
  { id: "ai", label: "AI & automation" },
  { id: "routines", label: "Routines" },
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
      {tab === "modules" && <ModulesTab />}
      {tab === "governance" && <GovernanceTab />}
      {tab === "localization" && <LocalizationTab />}
      {tab === "ai" && <AiTab />}
      {tab === "routines" && <RoutinesTab />}
    </AppFrame>
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

      <EmailSection />
    </div>
  );
}

/* --------------------------------------------------------- localization ---- */

function LocalizationTab() {
  const [prefs, update] = usePrefs();
  const activeCurrency = useMoneySync();

  return (
    <div className="max-w-2xl">
      <p className="mb-6 text-sm leading-relaxed text-stone-500">
        How figures and dates are <em>presented</em> on this device. The books
        themselves stay in their recording currency - these settings never
        rewrite stored amounts.
      </p>

      <SettingRow label="Display currency" hint="Applies to every money figure in the app, on top of the organization's base currency.">
        <select
          value={prefs.currency}
          onChange={(e) => update({ currency: e.target.value as DisplayCurrency })}
          aria-label="Display currency"
          className="select w-56"
        >
          <option value="org">Organization default ({activeCurrency})</option>
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

      <SettingRow label="Writing aids" hint="Spell and grammar underlines in the document editor and other writing surfaces.">
        <button
          type="button"
          role="switch"
          aria-checked={prefs.writingAids}
          onClick={() => update({ writingAids: !prefs.writingAids })}
          className={cn(
            "relative h-6 w-11 cursor-pointer rounded-full transition-colors duration-150",
            prefs.writingAids ? "bg-emerald-600" : "bg-stone-300",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all duration-150",
              prefs.writingAids ? "left-[1.375rem]" : "left-0.5",
            )}
          />
          <span className="sr-only">{prefs.writingAids ? "Writing aids on" : "Writing aids off"}</span>
        </button>
      </SettingRow>

      <p className="mt-6 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-relaxed text-stone-500">
        Recording currency for new documents is set per document (invoices carry
        their own currency); this display preference is applied on top.
      </p>

      <BrandingSection />
    </div>
  );
}

/* ----------------------------------------------------- print branding ---- */

function BrandingSection() {
  const [branding, setBranding] = useState<{
    logoDataUrl: string | null;
    accentColor: string | null;
    invoiceFooter: string | null;
    layout: string;
  } | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [footer, setFooter] = useState("");
  const [accent, setAccent] = useState("#b45309");
  const [layout, setLayout] = useState<"classic" | "modern">("classic");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await callApi<{
        branding: { logoDataUrl: string | null; accentColor: string | null; invoiceFooter: string | null; layout: string } | null;
        canEdit: boolean;
      }>("/api/branding");
      if (res.ok && res.data) {
        setBranding(res.data.branding);
        setCanEdit(res.data.canEdit);
        setFooter(res.data.branding?.invoiceFooter ?? "");
        setAccent(res.data.branding?.accentColor ?? "#b45309");
        setLayout(res.data.branding?.layout === "modern" ? "modern" : "classic");
      }
    })();
  }, []);

  function readLogo(f: File) {
    if (f.size > 200_000) {
      setError("Logos up to 200KB are supported.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBranding((b) => ({ ...(b ?? { accentColor: null, invoiceFooter: null, layout: "classic" }), logoDataUrl: String(reader.result) }));
      setSaved(false);
    };
    reader.readAsDataURL(f);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await postApi("/api/branding", {
        ...(branding?.logoDataUrl ? { logoDataUrl: branding.logoDataUrl } : {}),
        accentColor: accent,
        invoiceFooter: footer,
        layout,
      });
      if (res.status === 202) setError("Proposed to the workmate's queue: approvals inbox holds the change.");
      else if (!res.ok) setError(res.error?.title ?? "Could not save branding.");
      else setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 border-t border-stone-200 pt-6">
      <p className="figure-label">Print branding</p>
      <p className="mb-4 mt-1 text-sm text-stone-500">
        How your invoices and printed documents identify the organization. Printed from{" "}
        <code className="rounded bg-stone-100 px-1 font-mono text-xs">Documents → an order&apos;s invoice</code>.
      </p>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
          {error}
        </p>
      )}
      <SettingRow label="Logo" hint="PNG, JPEG or SVG up to 200KB. Shown at the top of printed documents.">
        <div className="flex items-center gap-3">
          {branding?.logoDataUrl ? (
            <img src={branding.logoDataUrl} alt="Organization logo" className="h-10 w-auto rounded border border-stone-200 bg-white p-1" />
          ) : (
            <span className="text-xs text-stone-400">None</span>
          )}
          {canEdit && (
            <label className="cursor-pointer rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 shadow-xs hover:bg-stone-50">
              Upload
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                aria-label="Upload logo"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) readLogo(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      </SettingRow>
      <SettingRow label="Accent color" hint="Rules, headings and totals on printed documents.">
        <input
          type="color"
          aria-label="Accent color"
          value={accent}
          disabled={!canEdit}
          onChange={(e) => setAccent(e.target.value)}
          className="h-9 w-16 cursor-pointer rounded-lg border border-stone-200 bg-white p-1"
        />
      </SettingRow>
      <SettingRow label="Layout" hint="Classic: gray table headers. Modern: your accent color.">
        <div role="radiogroup" aria-label="Layout" className="flex w-fit gap-1 rounded-xl border border-stone-200 bg-white p-1 shadow-xs">
          {(["classic", "modern"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={layout === l}
              disabled={!canEdit}
              onClick={() => setLayout(l)}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-colors duration-150",
                layout === l ? "bg-gold-50 text-gold-900" : "text-stone-500 hover:bg-stone-100",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Invoice footer" hint="Small print at the foot of every printed document.">
        <input
          value={footer}
          disabled={!canEdit}
          onChange={(e) => setFooter(e.target.value)}
          placeholder="Thank you for your business."
          className="input max-w-sm"
        />
      </SettingRow>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button loading={busy} onClick={save}>
            Save branding
          </Button>
          {saved && <span className="text-sm font-medium text-emerald-700">Saved</span>}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- ai tab ---- */

const AI_PROVIDERS = [
  { id: "nim", label: "NVIDIA NIM" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" },
  { id: "zai", label: "Z.ai" },
] as const;

const AI_ROLES: { key: string; label: string; hint: string }[] = [
  { key: "primary", label: "Primary", hint: "Conversations, drafting, agent turns" },
  { key: "fast", label: "Fast", hint: "Classifications and quick lookups" },
  { key: "reasoning", label: "Reasoning", hint: "Deep multi-step analysis" },
  { key: "embeddings", label: "Embeddings", hint: "Document search and memory" },
  { key: "ocr", label: "OCR", hint: "Document image parsing" },
];

interface OrgAiSettings {
  provider: string;
  keyLast4: string | null;
  hasKey: boolean;
  baseUrl: string | null;
  routing: Record<string, string>;
}

interface MemoryEntry {
  id: string;
  kind: string;
  source: string | null;
  preview: string;
  createdAt: string;
}

function AiTab() {
  const [payload, setPayload] = useState<{
    settings: OrgAiSettings | null;
    canEdit: boolean;
    encryptionReady: boolean;
    envFallback: { provider: string; models: Record<string, string>; keyConfigured: boolean };
  } | null>(null);
  const [provider, setProvider] = useState("nim");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "pending" | "info"; text: string } | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [canEditMemory, setCanEditMemory] = useState(false);
  const [confirmMemoryId, setConfirmMemoryId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await callApi<NonNullable<unknown>>("/api/ai-settings");
      if (!res.data) return;
      const d = res.data as {
        settings: OrgAiSettings | null;
        canEdit: boolean;
        encryptionReady: boolean;
        envFallback: { provider: string; models: Record<string, string>; keyConfigured: boolean };
      };
      setPayload(d);
      if (d.settings) {
        setProvider(d.settings.provider);
        setBaseUrl(d.settings.baseUrl ?? "");
        setRouting(d.settings.routing ?? {});
      }
    })();
  }, []);

  const loadMemory = useCallback(async (q: string) => {
    const res = await callApi<{ memories?: MemoryEntry[]; canEdit?: boolean }>(
      `/api/memory${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
    );
    if (res.data?.memories) setMemory(res.data.memories);
    setCanEditMemory(Boolean(res.data?.canEdit));
  }, []);

  useEffect(() => {
    void loadMemory("");
  }, [loadMemory]);

  async function save() {
    setSaving(true);
    setNotice(null);
    const res = await postApi<{ pendingApproval?: boolean }>("/api/ai-settings", {
      provider,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      routing: Object.fromEntries(Object.entries(routing).filter(([, v]) => v.trim() !== "")),
    });
    setSaving(false);
    if (res.status === 202 || res.data?.pendingApproval) {
      setNotice({ tone: "pending", text: "Change sent to the Approvals inbox." });
      return;
    }
    if (!res.ok) {
      setNotice({ tone: "error", text: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't save." });
      return;
    }
    setApiKey("");
    setNotice({ tone: "ok", text: "Saved. The workmate's next turn uses it." });
    void (async () => {
      const fresh = await callApi<{ settings: OrgAiSettings | null }>("/api/ai-settings");
      if (fresh.data) setPayload((p) => (p ? { ...p, settings: fresh.data!.settings } : p));
    })();
  }

  async function testConnection() {
    setTesting(true);
    setNotice(null);
    const res = await fetch("/api/ai-settings/test", { method: "POST" });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; model?: string; latencyMs?: number; error?: string; provider?: string };
    setTesting(false);
    if (d.ok) setNotice({ tone: "ok", text: `Connected via ${d.provider} (${d.model}) in ${d.latencyMs}ms.` });
    else setNotice({ tone: "error", text: `Connection failed: ${d.error ?? "unknown error"}` });
  }

  async function deleteMemory(id: string) {
    const res = await postApi<{ pendingApproval?: boolean }>("/api/memory", { action: "delete", memoryId: id });
    setConfirmMemoryId(null);
    if (res.status === 202 || res.data?.pendingApproval) {
      setNotice({ tone: "pending", text: "Memory deletion sent to the Approvals inbox." });
      return;
    }
    if (!res.ok) {
      setNotice({ tone: "error", text: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't delete." });
      return;
    }
    void loadMemory(memoryQuery);
  }

  const settings = payload?.settings ?? null;
  const editDisabled = !payload?.canEdit;

  return (
    <div className="max-w-2xl">
      <Section
        title="Provider & credentials"
        hint="Your organization's own AI provider. The key is encrypted at rest, never shown again, and never sent to the browser; without one, the server's env configuration applies."
      >
        {!payload ? (
          <div className="h-24 animate-pulse rounded-xl bg-stone-100" />
        ) : (
          <div className="max-w-xl space-y-4 rounded-xl border border-stone-200 bg-white p-4 shadow-xs">
            {!payload.encryptionReady && (
              <Notice tone="pending">
                Secret storage is not configured: ask the operator to set CHASTE_ENCRYPTION_KEY. Until then, org keys
                cannot be saved and the server environment configuration applies.
              </Notice>
            )}
            {settings?.hasKey && (
              <p className="text-xs text-emerald-700">
                Organization key on file: ••••{settings.keyLast4}. Leave the key field empty to keep it.
              </p>
            )}
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Provider</span>
              <select
                className="select"
                value={provider}
                disabled={editDisabled}
                aria-label="AI provider"
                onChange={(e) => setProvider(e.target.value)}
              >
                {AI_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">
                API key {settings?.hasKey ? "(leave empty to keep current)" : ""}
              </span>
              <input
                type="password"
                value={apiKey}
                disabled={editDisabled || !payload.encryptionReady}
                placeholder={settings?.hasKey ? "••••" + settings.keyLast4 : "paste the provider API key"}
                aria-label="Provider API key"
                onChange={(e) => setApiKey(e.target.value)}
                className="input font-mono"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Base URL (optional)</span>
              <input
                value={baseUrl}
                disabled={editDisabled}
                placeholder="https://integrate.api.nvidia.com/v1"
                aria-label="Provider base URL override"
                onChange={(e) => setBaseUrl(e.target.value)}
                className="input font-mono"
              />
            </label>

            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Model routing</span>
              <div className="space-y-2.5">
                {AI_ROLES.map((r) => (
                  <label key={r.key} className="block">
                    <span className="mb-1 flex items-baseline justify-between">
                      <span className="text-[13px] font-medium text-stone-700">{r.label}</span>
                      <span className="text-[11px] text-stone-400">{r.hint}</span>
                    </span>
                    <input
                      value={routing[r.key] ?? ""}
                      disabled={editDisabled}
                      placeholder={payload.envFallback.models[r.key === "ocr" ? "primary" : r.key] ?? "server default"}
                      aria-label={`Model for ${r.label}`}
                      onChange={(e) => setRouting((prev) => ({ ...prev, [r.key]: e.target.value }))}
                      className="input font-mono text-xs"
                    />
                  </label>
                ))}
              </div>
              <span className="mt-1.5 block text-xs leading-relaxed text-stone-400">
                Empty fields fall back to the server defaults listed below. A "provider/" prefix (for example
                openrouter/) overrides the provider for that role.
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {payload.canEdit && (
                <>
                  <Button size="sm" onClick={() => void save()} loading={saving} disabled={!payload.encryptionReady}>
                    Save configuration
                  </Button>
                  <Button size="sm" tone="secondary" onClick={() => void testConnection()} loading={testing}>
                    Test connection
                  </Button>
                </>
              )}
              {notice && (
                <span
                  className={cn(
                    "text-xs",
                    notice.tone === "ok"
                      ? "text-emerald-700"
                      : notice.tone === "pending"
                        ? "text-amber-700"
                        : notice.tone === "info"
                          ? "text-stone-500"
                          : "text-red-700",
                  )}
                  role="status"
                >
                  {notice.text}
                </span>
              )}
              {editDisabled && <span className="text-xs text-stone-400">Only organization admins can change this.</span>}
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Memory"
        hint="What the workmate has learned about the organization: profile facts, SOPs, decisions, preferences, and document knowledge. Entries wrong or stale? Remove them."
      >
        <div className="rounded-xl border border-stone-200 bg-white shadow-xs">
          <div className="flex items-center gap-2 border-b border-stone-100 px-3 py-2">
            <input
              value={memoryQuery}
              onChange={(e) => {
                setMemoryQuery(e.target.value);
                void loadMemory(e.target.value);
              }}
              placeholder="Search memory…"
              aria-label="Search organization memory"
              className="input h-8 flex-1 text-xs"
            />
            <span className="text-[11px] whitespace-nowrap text-stone-400">{memory.length} shown</span>
          </div>
          {memory.length === 0 ? (
            <p className="p-4 text-sm text-stone-400">Nothing remembered yet.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-stone-100 overflow-y-auto">
              {memory.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-stone-500">
                      {m.kind}
                      {m.source ? <span className="font-normal text-stone-400"> · {m.source}</span> : null}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-stone-800">{m.preview}</p>
                  </div>
                  {canEditMemory && (
                    <button
                      type="button"
                      aria-label="Delete memory entry"
                      title="Forget this"
                      onClick={() => setConfirmMemoryId(m.id)}
                      className="icon-btn size-6 shrink-0 hover:text-red-700"
                    >
                      <IconTrash className="size-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Server defaults" hint="What applies when this organization has not set its own configuration.">
        <div className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white text-sm shadow-xs">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-stone-500">Provider</span>
            <span className="font-medium text-stone-900">{payload?.envFallback.provider || "nim"}</span>
          </div>
          {Object.entries(payload?.envFallback.models ?? {}).map(([role, model]) => (
            <div key={role} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-stone-500 capitalize">{role}</span>
              <span className="font-mono text-xs text-stone-700">{model}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-stone-500">Env key</span>
            <span className="text-stone-700">{payload?.envFallback.keyConfigured ? "configured" : "not set"}</span>
          </div>
        </div>
      </Section>

      <ConfirmDialog
        open={confirmMemoryId != null}
        onClose={() => setConfirmMemoryId(null)}
        onConfirm={() => confirmMemoryId && void deleteMemory(confirmMemoryId)}
        title="Forget this memory?"
        body="Searches and agent answers stop using it immediately. The audit trail records the removal."
        confirmLabel="Forget"
      />
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

/* --------------------------------------------------------------- modules -- */

interface ModuleSettingsField {
  key: string;
  label: string;
  type: "text" | "number";
  placeholder?: string;
}

const MODULE_SETTING_PANELS: { moduleId: string; title: string; hint: string; fields: ModuleSettingsField[] }[] = [
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

function ModuleSettingsPanel({ moduleId, title, hint, fields }: { moduleId: string; title: string; hint: string; fields: ModuleSettingsField[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "pending"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await callApi<{ settings?: Record<string, unknown> }>(`/api/module-settings?module=${moduleId}`);
      if (res.data?.settings) {
        const next: Record<string, string> = {};
        for (const f of fields) next[f.key] = String(res.data.settings[f.key] ?? "");
        setValues(next);
      }
      setLoading(false);
    })();
    // Field lists are static per module.
  }, [moduleId, fields]);

  async function save() {
    setSaving(true);
    setNotice(null);
    const settings: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.key] ?? "";
      if (f.type === "number") {
        if (raw !== "") settings[f.key] = Number(raw);
      } else if (raw.trim() !== "") {
        settings[f.key] = raw.trim();
      }
    }
    const res = await postApi<{ pendingApproval?: boolean }>(`/api/module-settings`, { module: moduleId, settings });
    setSaving(false);
    if (res.status === 202 || res.data?.pendingApproval) {
      setNotice({ tone: "pending", text: "Change sent to the Approvals inbox." });
      return;
    }
    if (!res.ok) {
      setNotice({ tone: "error", text: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't save." });
      return;
    }
    setNotice({ tone: "ok", text: "Saved. New defaults apply right away." });
  }

  return (
    <Section title={title} hint={hint}>
      {loading ? (
        <div className="h-16 animate-pulse rounded-xl bg-stone-100" />
      ) : (
        <div className="max-w-xl rounded-xl border border-stone-200 bg-white p-4 shadow-xs">
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-stone-700">{f.label}</span>
                <input
                  type={f.type}
                  inputMode={f.type === "number" ? "numeric" : undefined}
                  min={f.type === "number" ? 0 : undefined}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  aria-label={`${title} ${f.label}`}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="input"
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" onClick={() => void save()} loading={saving}>
              Save defaults
            </Button>
            {notice && (
              <span
                className={cn(
                  "text-xs",
                  notice.tone === "ok" ? "text-emerald-700" : notice.tone === "pending" ? "text-amber-700" : "text-red-700",
                )}
                role="status"
              >
                {notice.text}
              </span>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function ModulesTab() {
  return (
    <div className="max-w-3xl">
      <Section
        title="Switchboard"
        hint="Which applications your organization runs. Turning a module off hides it from people, the workmate, and the job queue at once; as an admin your change applies immediately and lands in the ledger. The workmate proposing the same change still waits for approval."
      >
        <ModulesManager />
      </Section>

      <Section
        title="Module defaults"
        hint="Configuration each module owns: the values its forms and flows start from. Changes are governed like any other write."
      >
        <p className="text-[13px] leading-relaxed text-stone-500">
          Defaults live per module below. Modules without editable settings yet manage their behavior in code and
          surfaces of their own.
        </p>
      </Section>
      {MODULE_SETTING_PANELS.map((p) => (
        <ModuleSettingsPanel key={p.moduleId} {...p} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ governance -- */

const POLICY_RISKS = [
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
  { id: "money", label: "Money" },
  { id: "identity", label: "Identity" },
  { id: "destructive", label: "Destructive" },
] as const;

const STRICT_OPTIONS = [
  { id: "identity", label: "Identity actions" },
  { id: "destructive", label: "Destructive actions" },
  { id: "money", label: "Payments over threshold" },
] as const;

function GovernanceTab() {
  const [policy, setPolicy] = useState<{ maxRiskAutonomous: string; moneyThresholdMinor: number; requiresApprovalFor: string[] } | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "pending"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await callApi<{
        policy?: { maxRiskAutonomous: string; moneyThresholdMinor: number; requiresApprovalFor: string[] };
        canEdit?: boolean;
      }>("/api/policy");
      if (res.data?.policy) {
        setPolicy(res.data.policy);
        setThresholdInput(res.data.policy.moneyThresholdMinor > 0 ? minorToInput(res.data.policy.moneyThresholdMinor) : "");
      }
      setCanEdit(Boolean(res.data?.canEdit));
    })();
  }, []);

  async function save() {
    if (!policy) return;
    setSaving(true);
    setNotice(null);
    const res = await postApi<{ pendingApproval?: boolean }>("/api/policy", {
      maxRiskAutonomous: policy.maxRiskAutonomous,
      moneyThresholdMinor: thresholdInput.trim() === "" ? 0 : toMinor(thresholdInput),
      requiresApprovalFor: policy.requiresApprovalFor,
    });
    setSaving(false);
    if (res.status === 202 || res.data?.pendingApproval) {
      setNotice({ tone: "pending", text: "Change sent to the Approvals inbox." });
      return;
    }
    if (!res.ok) {
      setNotice({ tone: "error", text: res.error ? `${res.error.title}${res.error.hint ? ` - ${res.error.hint}` : ""}` : "Couldn't save." });
      return;
    }
    setNotice({ tone: "ok", text: "Policy saved. It applies to the next action immediately." });
  }

  function toggleStrict(id: string) {
    setPolicy((p) =>
      p
        ? {
            ...p,
            requiresApprovalFor: p.requiresApprovalFor.includes(id)
              ? p.requiresApprovalFor.filter((x) => x !== id)
              : [...p.requiresApprovalFor, id],
          }
        : p,
    );
  }

  return (
    <div className="max-w-3xl">
      <Section
        title="Workmate autonomy"
        hint="The highest risk class the workmate may act at without asking. Whatever you pick, every action is still audited in the ledger."
      >
        {!policy ? (
          <div className="h-24 animate-pulse rounded-xl bg-stone-100" />
        ) : (
          <div className="max-w-xl space-y-4 rounded-xl border border-stone-200 bg-white p-4 shadow-xs">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Max autonomous risk</span>
              <select
                className="select"
                value={policy.maxRiskAutonomous}
                disabled={!canEdit}
                aria-label="Max autonomous risk"
                onChange={(e) => setPolicy((p) => (p ? { ...p, maxRiskAutonomous: e.target.value } : p))}
              >
                {POLICY_RISKS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <span className="mt-1.5 block text-xs leading-relaxed text-stone-400">
                Write covers creating and updating records. Money adds anything that moves value. Identity and
                destructive are always gated for the workmate, no matter what this says.
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Payment approval threshold</span>
              <input
                type="text"
                inputMode="decimal"
                value={thresholdInput}
                disabled={!canEdit}
                placeholder="No limit"
                aria-label="Payment approval threshold"
                onChange={(e) => setThresholdInput(e.target.value)}
                className="input"
              />
              <span className="mt-1.5 block text-xs leading-relaxed text-stone-400">
                Workmate payments above this amount wait for a person. Lower it to tighten control; empty for none.
              </span>
            </label>

            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-stone-700">Maker-checker for people (strict mode)</span>
              <div className="flex flex-wrap gap-1.5">
                {STRICT_OPTIONS.map((s) => {
                  const on = policy.requiresApprovalFor.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      disabled={!canEdit}
                      onClick={() => toggleStrict(s.id)}
                      className={cn(
                        "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150",
                        on ? "border-gold-500 bg-gold-50 text-gold-900" : "border-stone-200 bg-white text-stone-500 hover:border-stone-300",
                        !canEdit && "cursor-not-allowed opacity-50",
                      )}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <span className="mt-1.5 block text-xs leading-relaxed text-stone-400">
                Off by default: people with the permission act under their own authority. Turn a chip on to require a
                second pair of eyes for that risk class, even for humans.
              </span>
            </div>

            <div className="flex items-center gap-3">
              {canEdit && (
                <Button size="sm" onClick={() => void save()} loading={saving}>
                  Save policy
                </Button>
              )}
              {notice && (
                <span
                  className={cn(
                    "text-xs",
                    notice.tone === "ok" ? "text-emerald-700" : notice.tone === "pending" ? "text-amber-700" : "text-red-700",
                  )}
                  role="status"
                >
                  {notice.text}
                </span>
              )}
              {!canEdit && <span className="text-xs text-stone-400">Only organization admins can change policy.</span>}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
