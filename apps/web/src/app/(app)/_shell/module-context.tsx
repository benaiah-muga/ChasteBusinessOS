"use client";

import { createContext, useContext, type ReactNode } from "react";
import { resolveEnabledModules } from "./modules";
import { EmptyState } from "@/components/ui";
import { IconAlertTriangle } from "@/components/icons";

const EnabledModulesContext = createContext<ReadonlySet<string> | null>(null);

export function EnabledModulesProvider({
  value,
  children,
}: {
  value: string[] | null;
  children: ReactNode;
}) {
  return (
    <EnabledModulesContext.Provider value={resolveEnabledModules(value)}>
      {children}
    </EnabledModulesContext.Provider>
  );
}

/** True when the module may render. Null context (tests) means allowed. */
export function useModuleEnabled(moduleId: string): boolean {
  const enabled = useContext(EnabledModulesContext);
  return !enabled || enabled.has(moduleId);
}

/**
 * Deep-link guard: a disabled module's page renders this instead of its UI.
 * The kernel executor independently refuses every capability behind it, so
 * this is presentation, not the security boundary.
 */
export function ModuleDisabled({ label }: { label: string }) {
  return (
    <div className="mx-auto max-w-xl pt-10">
      <EmptyState
        icon={<IconAlertTriangle className="size-5" />}
        title={`${label} is disabled`}
        hint="This module is switched off for your organization. An org admin can re-enable it under Team & roles → Modules."
      />
    </div>
  );
}
