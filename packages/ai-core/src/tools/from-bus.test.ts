import {
  createCommandRegistry,
  createQueryRegistry,
  defineCommand,
  defineQuery,
} from "@chaste/kernel";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { buildToolsFromBus, toolNameForBusName } from "./from-bus.js";

const rowSchema = z.object({ id: z.string() });

function sampleRegistries() {
  const commands = createCommandRegistry();
  const queries = createQueryRegistry();
  commands.register(
    defineCommand({
      name: "alpha.commit",
      description: "Commit the alpha ledger",
      permissions: ["alpha.write"],
      tags: ["alpha"],
      riskClass: "exec",
      input: z.object({ amount: z.number() }),
      output: rowSchema,
      handler: async ({ amount }) => ({ id: String(amount) }),
    }),
  );
  commands.register(
    defineCommand({
      name: "beta.create",
      permissions: ["beta.write"],
      input: z.object({ name: z.string() }),
      output: rowSchema,
      handler: async ({ name }) => ({ id: name }),
    }),
  );
  queries.register(
    defineQuery({
      name: "alpha.ledger",
      description: "Read the alpha ledger",
      permissions: ["alpha.read"],
      input: z.object({ limit: z.number().optional() }),
      output: z.object({ rows: z.array(rowSchema) }),
      handler: async () => ({ rows: [] }),
    }),
  );
  return { commands, queries };
}

describe("buildToolsFromBus", () => {
  it("registers one tool per command/query with bus-aligned contracts", () => {
    const { commands, queries } = sampleRegistries();
    const registry = buildToolsFromBus({ commands, queries });

    const commit = registry.get("alpha_commit");
    expect(commit).toBeDefined();
    expect(commit?.kind).toBe("command");
    expect(commit?.command).toBe("alpha.commit");
    expect(commit?.exposeWhen).toEqual(["alpha.write"]);
    expect(commit?.idempotent).toBe(false);
    expect(commit?.description).toContain("alpha ledger");
    expect(commit?.risk).toBeUndefined();
    expect(commit?.input.safeParse({ amount: 5 }).success).toBe(true);
    expect(commit?.input.safeParse({ amount: "x" }).success).toBe(false);

    const ledger = registry.get("alpha_ledger");
    expect(ledger?.kind).toBe("query");
    expect(ledger?.command).toBe("alpha.ledger");
    expect(ledger?.exposeWhen).toEqual(["alpha.read"]);
    expect(ledger?.idempotent).toBe(true);

    expect(registry.has("beta_create")).toBe(true);
    expect(registry.list()).toHaveLength(3);
  });

  it("applies the include filter", () => {
    const { commands, queries } = sampleRegistries();
    const registry = buildToolsFromBus({
      commands,
      queries,
      include: (def) => def.kind === "query" || def.name.startsWith("alpha."),
    });
    expect(registry.has("alpha_commit")).toBe(true);
    expect(registry.has("beta_create")).toBe(false);
    expect(registry.has("alpha_ledger")).toBe(true);
  });
});

describe("toolNameForBusName", () => {
  it("maps dotted bus names to underscored tool names", () => {
    expect(toolNameForBusName("activities.create")).toBe("activities_create");
    expect(toolNameForBusName("core.workflow.list")).toBe("core_workflow_list");
  });
});