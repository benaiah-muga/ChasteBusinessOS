import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("integrated operational UI surfaces", () => {
  it("sessions surface includes durable runs and canonical replay", () => {
    const page = source("src/app/(app)/sessions/page.tsx");
    const runsRoute = source("src/app/api/durable-runs/route.ts");
    const replayRoute = source("src/app/api/sessions/[id]/replay/route.ts");
    expect(page).toContain("/api/durable-runs");
    expect(page).toContain("Canonical replay");
    expect(page).toContain("Durable work");
    expect(runsRoute).toContain("resolved.orgId");
    expect(replayRoute).toContain("replaySession");
    console.log("UI-SESSIONS-SURFACE-OK");
  });

  it("Creator surface includes gaps, releases, and canary evidence", () => {
    const page = source("src/app/(app)/proposals/page.tsx");
    const proposalsRoute = source("src/app/api/proposals/route.ts");
    const gapsRoute = source("src/app/api/capability-gaps/route.ts");
    expect(page).toContain("Capability gaps");
    expect(page).toContain("Controlled release");
    expect(page).toContain("Record pass");
    expect(proposalsRoute).toContain("creatorEvolutionOutcomes");
    expect(gapsRoute).toContain('eq(tickets.origin, "capability_gap")');
    console.log("UI-CREATOR-SURFACE-OK");
  });

  it("harness surface exposes safe tenant-scoped inspection", () => {
    const page = source("src/app/(app)/settings/page.tsx");
    const route = source("src/app/api/harness/compositions/route.ts");
    expect(page).toContain("Runtime compositions");
    expect(page).toContain("Configuration patches");
    expect(route).toContain("inspectComposition");
    expect(route).toContain("harness.approve");
    console.log("UI-HARNESS-SURFACE-OK");
  });

  it("release controls route every mutation through the kernel approval result", () => {
    const page = source("src/app/(app)/proposals/page.tsx");
    const route = source("src/app/api/creator/evolution/route.ts");
    for (const action of ["stage", "promote", "rollback", "canary"]) {
      expect(page).toContain(`action: "${action}"`);
      expect(route).toContain(`z.literal("${action}")`);
    }
    expect(route).toContain("pendingApproval");
    expect(route).toContain("buildExecutor");
    console.log("UI-RELEASE-CONTROLS-OK");
  });

  it("AI settings expose workspace credentials and personal coding-plan connections", () => {
    const page = source("src/app/(app)/settings/page.tsx");
    const connections = source("src/app/(app)/settings/coding-plans.tsx");
    const route = source("src/app/api/ai-config/route.ts");
    const connectionRoute = source("src/app/api/ai-connections/route.ts");
    expect(page).toContain("Workspace model provider");
    expect(page).toContain("Custom OpenAI-compatible");
    expect(page).toContain("Coding-plan connections");
    expect(connections).toContain("Connect Codex plan");
    expect(connections).toContain("Connect OpenCode");
    expect(connections).toContain("Scheduled and background work continues to use the workspace provider");
    expect(route).toContain('settings.configureAiProvider');
    expect(route).toContain("encryptedApiKey");
    expect(connectionRoute).toContain("connect_opencode");
    expect(connectionRoute).toContain("poll_codex_login");
    console.log("UI-AI-CONFIG-SURFACE-OK");
  });

  it("currency selection reaches the shared formatter", () => {
    const shell = source("src/app/(app)/app-shell.tsx");
    const format = source("src/lib/format.ts");
    expect(shell).toContain("setActiveCurrency");
    expect(shell).toContain("baseCurrency");
    expect(format).toContain('UGX: "USh "');
    console.log("UI-CURRENCY-SURFACE-OK");
  });
});
