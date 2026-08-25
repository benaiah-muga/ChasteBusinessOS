"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { IconPlus, IconCheck } from "@/components/icons";
import { callApi } from "@/lib/api";

interface ModuleInfo {
  id: string;
  label: string;
  description: string;
  href: string | null;
}

/**
 * The module switchboard. Saving goes through the governed iam.setModules
 * capability (identity-class), so changes land in the Approvals inbox and
 * apply after a human with iam.admin approves — the UI never flips the
 * switch directly.
 */
export function ModulesManager() {
  const [catalog, setCatalog] = useState<ModuleInfo[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [usingDefaults, setUsingDefaults] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi<{
      catalog?: ModuleInfo[];
      enabledModules?: string[];
      usingDefaults?: boolean;
    }>("/api/modules");
    if (!res.ok || !res.data) {
      setError(res.error?.title ?? "Couldn't load modules");
      return;
    }
    setCatalog(res.data.catalog ?? []);
    setEnabled(new Set(res.data.enabledModules ?? []));
    setUsingDefaults(Boolean(res.data.usingDefaults));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: Set<string>) {
    if (next.size === 0) {
      setError("At least one module must stay enabled.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await callApi<{ pendingApproval?: boolean; hint?: string }>("/api/modules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modules: [...next] }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error?.hint ?? res.error?.title ?? "Couldn't save");
      return;
    }
    if (res.status === 202 || res.data?.pendingApproval) {
      setNotice(res.data?.hint ?? "Change sent to the Approvals inbox.");
      return;
    }
    await load();
  }

  function toggle(id: string) {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEnabled(next);
    void save(next);
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white shadow-xs">
      <header className="flex items-center justify-between border-b border-stone-100 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Modules</h2>
          <p className="text-xs text-stone-500">
            Switch platform surfaces on or off for this organization.
            Disabled modules disappear from navigation, APIs, and agent tools.
          </p>
        </div>
        {usingDefaults && catalog.length > 0 && (
          <Badge tone="neutral">defaults</Badge>
        )}
      </header>

      {notice && (
        <p className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-xs text-amber-800">{notice}</p>
      )}
      {error && (
        <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">{error}</p>
      )}

      <ul className="divide-y divide-stone-100">
        {catalog.map((m) => {
          const on = enabled.has(m.id);
          return (
            <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-900">{m.label}</p>
                <p className="truncate text-xs text-stone-500">{m.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${on ? "Disable" : "Enable"} ${m.label}`}
                disabled={busy}
                onClick={() => toggle(m.id)}
                className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-150 ${
                  on ? "bg-maroon-700" : "bg-stone-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 flex size-5 items-center justify-center rounded-full bg-white shadow transition-all duration-150 ${
                    on ? "left-[22px]" : "left-0.5"
                  }`}
                >
                  {on && <IconCheck className="size-3 text-maroon-700" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <footer className="flex justify-end px-5 py-3">
        <Button size="sm" onClick={load} disabled={busy}>
          <IconPlus className="size-3.5 rotate-45" />
          Refresh
        </Button>
      </footer>
    </section>
  );
}
