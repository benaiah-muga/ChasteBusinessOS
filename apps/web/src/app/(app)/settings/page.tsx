"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { callApi, postApi } from "@/lib/api";
import { Button } from "@/components/ui";
import { APPS, tileStyle } from "../_shell/apps";
import { appPins, MAX_PINS, usePinnedApps } from "../_shell/pins";
import { useModuleEnabled } from "../_shell/module-context";
import { ModulesManager } from "../_shell/modules-manager";
import { AppFrame } from "../_shell/app-frame";
import { THEMES, applyTheme, applyMode, useTheme, useMode, type ThemeId, MODES } from "@/components/theme";
import {
  CURRENCIES,
  usePrefs,
  type CurrencyCode,
  type DateFormat,
  type Units,
  type WeekStart,
} from "@/lib/prefs";
import { IconCheck, IconMoon, IconPinTack, IconSun } from "@/components/icons";
import { cn } from "@/lib/format";

const SWATCH: Record<ThemeId, [string, string]> = {
  chaste: ["#9b1313", "#faf9f8"],
  graphite: ["#265a80", "#f8f9fb"],
  verdant: ["#276135", "#f8faf6"],
  meridian: ["#a67a28", "#fbf9f4"],
};

const TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Workspace" },
  { id: "localization", label: "Localization" },
  { id: "ai", label: "AI & automation" },
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
    </AppFrame>
  );
}

/* ----------------------------------------------------------- appearance ---- */

function AppearanceTab() {
  const theme = useTheme();
  const mode = useMode();
  const pinnedIds = usePinnedApps();
  const apps = APPS;

  return (
    <div className="max-w-3xl">
      <Section title="Color mode" hint="Light, dark, or follow your system — resolved before first paint.">
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
                mode === m.id ? "bg-maroon-50 text-maroon-900" : "text-stone-500 hover:bg-stone-100",
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

      <Section title="Theme" hint="Four palettes, one product. Semantic colors — success, warnings, errors — never change.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {THEMES.map((t) => {
            const active = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => applyTheme(t.id)}
                aria-pressed={active}
                className={cn(
                  "cursor-pointer rounded-xl border p-3 text-left transition-all duration-150",
                  active
                    ? "border-maroon-500 bg-white shadow-xs ring-[3px] ring-maroon-600/10"
                    : "border-stone-200 hover:border-stone-300 hover:bg-white",
                )}
              >
                <span
                  aria-hidden="true"
                  className="mb-2.5 flex h-10 overflow-hidden rounded-lg border border-black/5"
                  style={{
                    background: `linear-gradient(160deg, ${SWATCH[t.id][0]} 0 55%, ${SWATCH[t.id][1]} 55% 100%)`,
                  }}
                />
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-stone-900">{t.label}</span>
                  {active && <IconCheck className="size-3.5 text-maroon-700" />}
                </span>
                <span className="block text-[11px] text-stone-400">{t.id === "meridian" ? `${t.hint} · default` : t.hint}</span>
              </button>
            );
          })}
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
            <dd className="font-medium text-stone-900">{orgName || "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <dt className="text-stone-500">Modules</dt>
            <dd className="text-stone-700">
              {accountingOn ? "Managed by owners" : "Restricted set"} ·{" "}
              <Link href="/team" className="font-medium text-maroon-800 hover:underline">
                Team &amp; roles
              </Link>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <dt className="text-stone-500">Agent sessions</dt>
            <dd>
              <Link href="/sessions" className="font-medium text-maroon-800 hover:underline">
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
        themselves stay in their recording currency — these settings never
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
              {c.symbol} {c.code} — {c.label}
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
                prefs.units === id ? "bg-maroon-50 text-maroon-900" : "text-stone-500 hover:bg-stone-100",
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
                prefs.dateFormat === id ? "bg-maroon-50 text-maroon-900" : "text-stone-500 hover:bg-stone-100",
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
                prefs.weekStart === id ? "bg-maroon-50 text-maroon-900" : "text-stone-500 hover:bg-stone-100",
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
  source: string;
}

function AiTab() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void callApi<AiConfig>("/api/ai-config").then((res) => {
      if (res.data) setConfig(res.data);
      else setError(res.error?.title ?? "Could not load model configuration");
    });
  }, []);

  return (
    <div className="max-w-2xl">
      <p className="mb-6 text-sm leading-relaxed text-stone-500">
        Your workmate runs on models configured in the server environment —
        keys never enter the browser, and the model reaches your business only
        through the same governed capabilities you use.
      </p>

      {!config ? (
        <p className="text-sm text-stone-400">{error ?? "Checking configuration…"}</p>
      ) : (
        <>
          <div className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <dt className="text-stone-500">Provider</dt>
              <dd className="flex items-center gap-2 font-medium text-stone-900">
                {config.provider === "openrouter" ? "OpenRouter" : "NVIDIA NIM"}
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

          {!config.configured && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Set <code className="rounded bg-amber-100 px-1">NVIDIA_API_KEY</code> (or{" "}
              <code className="rounded bg-amber-100 px-1">OPENROUTER_API_KEY</code> with{" "}
              <code className="rounded bg-amber-100 px-1">MODEL_PROVIDER=openrouter</code>) in the server environment.
            </p>
          )}

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
                Every model action, its capability, and its outcome — auditable forever.
              </p>
            </Link>
          </div>
        </>
      )}
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
                    ? "border-maroon-300 bg-maroon-50/60"
                    : "border-stone-200 bg-white hover:border-stone-300 disabled:pointer-events-none disabled:opacity-40",
                )}
              >
                <span
                  aria-hidden="true"
                  style={tileStyle(app.hue)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                >
                  <app.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-stone-900">{app.name}</span>
                  <span className="block truncate text-[11px] text-stone-400">{app.tagline}</span>
                </span>
                <IconPinTack
                  className={cn("size-4 shrink-0", pinned ? "text-maroon-700" : "text-stone-300")}
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
    setNote(res.ok ? "Test email sent — check the inbox." : (res.error?.title ?? "Send failed."));
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
                — sending as <code className="rounded bg-stone-100 px-1">{status.from}</code>
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
