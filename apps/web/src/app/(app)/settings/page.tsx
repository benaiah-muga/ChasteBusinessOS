"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { callApi, postApi } from "@/lib/api";
import { Button } from "@/components/ui";
import { APPS, tileStyle } from "../_shell/apps";
import { appPins, MAX_PINS, usePinnedApps } from "../_shell/pins";
import { useModuleEnabled } from "../_shell/module-context";
import { ModulesManager } from "../_shell/modules-manager";
import { THEMES, applyTheme, applyMode, useTheme, useMode, type ThemeId, MODES } from "@/components/theme";
import { IconCheck, IconMoon, IconPinTack, IconSun } from "@/components/icons";
import { cn } from "@/lib/format";

const SWATCH: Record<ThemeId, [string, string]> = {
  chaste: ["#9b1313", "#faf9f8"],
  graphite: ["#265a80", "#f8f9fb"],
  verdant: ["#276135", "#f8faf6"],
  meridian: ["#a67a28", "#fbf9f4"],
};

/**
 * Settings: the quiet control room. Appearance and pins are client
 * preferences; workspace facts link out to where authority lives (Team & roles).
 */
export default function SettingsPage() {
  const theme = useTheme();
  const mode = useMode();
  const pinnedIds = usePinnedApps();
  const accountingOn = useModuleEnabled("accounting");
  const [orgName, setOrgName] = useState<string>("");

  useEffect(() => {
    void (async () => {
      const res = await callApi<{ orgs: { id: string; name: string }[]; activeOrgId: string | null }>("/api/org");
      const active = res.data?.orgs.find((o) => o.id === res.data?.activeOrgId);
      setOrgName(active?.name ?? "");
    })();
  }, []);

  const businessApps = APPS.filter((a) => !a.system);
  const systemApps = APPS.filter((a) => a.system);

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8">
        <p className="figure-label">Settings</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-stone-900">Make it yours</h1>
      </header>

      <AppearanceSection theme={theme} mode={mode} />
      <PinsSection pinnedIds={pinnedIds} apps={[...businessApps, ...systemApps]} />
      <ModulesSection />
      <EmailSection />
      <WorkspaceSection orgName={orgName} modulesNote={accountingOn ? "Managed by owners" : "Restricted set"} />
    </div>
  );
}

function ModulesSection() {
  return (
    <section aria-label="Modules" className="mb-10">
      <h2 className="text-sm font-semibold text-stone-800">Modules</h2>
      <p className="mt-1 text-sm text-stone-500">
        Which applications your organization runs. Turning a module off hides it from people, the
        workmate, and the job queue at once; changes are identity-class and wait for approval.
      </p>
      <div className="mt-4">
        <ModulesManager />
      </div>
    </section>
  );
}

function AppearanceSection({ theme, mode }: { theme: ThemeId; mode: ReturnType<typeof useMode> }) {
  return (
    <section aria-label="Appearance" className="mb-10">
      <h2 className="text-sm font-semibold text-stone-800">Appearance</h2>
      <p className="mt-1 text-sm text-stone-500">
        Four palettes, one product. Semantic colors — success, warnings, errors — never change.
      </p>
      <div
        role="radiogroup"
        aria-label="Color mode"
        className="mt-4 flex w-fit gap-1 rounded-xl border border-stone-200 bg-white p-1 shadow-xs"
      >
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
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
              <span className="block text-[11px] text-stone-400">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PinsSection({ pinnedIds, apps }: { pinnedIds: string[]; apps: typeof APPS }) {
  return (
    <section aria-label="Pinned apps" className="mb-10">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-800">Pinned apps</h2>
        <span className="tnum text-xs text-stone-400">
          {pinnedIds.length}/{MAX_PINS} on the rail
        </span>
      </div>
      <p className="mt-1 text-sm text-stone-500">
        Your daily drivers live one click away on the workspace rail. Pin up to {MAX_PINS}.
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
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
    </section>
  );
}

function WorkspaceSection({ orgName, modulesNote }: { orgName: string; modulesNote: string }) {
  return (
    <section aria-label="Workspace" className="mb-16">
      <h2 className="text-sm font-semibold text-stone-800">Workspace</h2>
      <dl className="mt-4 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white shadow-xs">
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <dt className="text-stone-500">Organization</dt>
          <dd className="font-medium text-stone-900">{orgName || "—"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <dt className="text-stone-500">Modules</dt>
          <dd className="text-stone-700">
            {modulesNote} ·{" "}
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
    </section>
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
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
      <h2 className="text-sm font-semibold text-stone-900">Email</h2>
      {!status ? (
        <p className="mt-1 text-sm text-stone-400">Checking…</p>
      ) : status.configured ? (
        <p className="mt-1 text-sm text-stone-500">
          SMTP is configured{status.from ? <> — sending as <code className="rounded bg-stone-100 px-1">{status.from}</code></> : null}. Invoices, approvals, and customer care all deliver through it.
        </p>
      ) : (
        <p className="mt-1 text-sm text-stone-500">
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
          className="w-56 rounded border border-stone-200 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-stone-400 disabled:opacity-50"
        />
        <Button size="sm" tone="secondary" disabled={busy || !status?.configured || !/.+@.+\..+/.test(to)} onClick={() => void sendTest()}>
          Send test email
        </Button>
        {note && <span className="text-xs text-stone-500">{note}</span>}
      </div>
    </section>
  );
}
