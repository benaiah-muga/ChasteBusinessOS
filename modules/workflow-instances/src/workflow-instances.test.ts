import {
  createCommandRegistry,
  createQueryRegistry,
  createRequestContext,
  defineCommand,
  defineQuery,
  executeCommand,
  executeQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
  InMemoryWorkflowInstanceStore,
} from "@chaste/kernel";
import type { Actor, CommandHelpers, RequestContext } from "@chaste/kernel";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkflowInstancesModule } from "./index.js";

const now = () => new Date("2026-08-17T10:00:00Z");

let commands: ReturnType<typeof createCommandRegistry>;
let queries: ReturnType<typeof createQueryRegistry>;
let instances: InMemoryWorkflowInstanceStore;

function actor(permissions: string[], org = "o1"): Actor {
  return { kind: "user", userId: "u1", organizationId: org, permissions: new Set(permissions) };
}

function requestCtx(permissions: string[], org = "o1"): RequestContext {
  return createRequestContext({
    actor: actor(permissions, org),
    requestId: "req-1",
    now,
    origin: "agent",
    reason: "test",
  });
}

function helpers(): CommandHelpers {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

type SafeResult<T> = { ok: true; data: T } | { ok: false; errorMessage: string };

async function run<T = unknown>(
  name: string,
  input: unknown,
  permissions: string[],
  org = "o1",
): Promise<SafeResult<T>> {
  try {
    const result = await executeCommand<T>(commands, name, input, requestCtx(permissions, org), helpers());
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

async function ask<T = unknown>(
  name: string,
  input: unknown,
  permissions: string[],
  org = "o1",
): Promise<SafeResult<T>> {
  try {
    const result = await executeQuery<T>(queries, name, input, requestCtx(permissions, org));
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

function def(steps: unknown[]) {
  return {
    id: "wf-1",
    name: "Onboard",
    description: "Test workflow",
    trigger: "manual",
    createdBy: "user",
    createdAt: "2026-08-16T00:00:00Z",
    steps,
  };
}

function registerDef(steps: unknown[]) {
  queries.register(
    defineQuery({
      name: "core.workflow.get",
      permissions: ["core.workflow.read"],
      tags: ["core"],
      input: z.object({ workflowId: z.string() }),
      output: z.object({ id: z.string(), name: z.string(), description: z.string(), trigger: z.string(), createdBy: z.string(), createdAt: z.string(), steps: z.array(z.unknown()) }),
      handler: async (input) => {
        if (input.workflowId !== "wf-1") throw new Error("Workflow not found");
        return def(steps);
      },
    }),
  );
}

beforeEach(async () => {
  commands = createCommandRegistry();
  queries = createQueryRegistry();
  instances = new InMemoryWorkflowInstanceStore();

  commands.register(
    defineCommand({
      name: "crm.customer.create",
      permissions: ["crm.customer.create"],
      tags: ["crm"],
      input: z.object({ name: z.string().min(1) }),
      output: z.object({ id: z.string(), name: z.string() }),
      handler: async (input) => ({ id: "cust-1", name: input.name }),
    }),
  );
  commands.register(
    defineCommand({
      name: "acc.invoice.create",
      permissions: ["acc.invoice.create"],
      tags: ["accounting"],
      input: z.object({ number: z.string(), total: z.number(), customerId: z.string().optional() }),
      output: z.object({ id: z.string(), customerId: z.string().optional() }),
      handler: async (input) => ({ id: "inv-1", customerId: input.customerId }),
    }),
  );

  const module = createWorkflowInstancesModule({ instances });
  await module.register({ commands, queries });
});

describe("manifest and permissions", () => {
  it("registers the expected surface", () => {
    const manifest = createWorkflowInstancesModule({ instances }).manifest;
    expect(manifest.id).toBe("workflow-instances");
    expect(manifest.permissions).toEqual(["workflow.instance.read", "workflow.instance.write"]);
    expect(manifest.capabilities).toEqual(["workflow.instances"]);
    expect(commands.get("workflow.instance.start")).toBeDefined();
    expect(commands.get("workflow.instance.advance")).toBeDefined();
    expect(commands.get("workflow.instance.cancel")).toBeDefined();
    expect(queries.get("workflow.instance.list")).toBeDefined();
    expect(queries.get("workflow.instance.get")).toBeDefined();
  });
});

describe("workflow.instance.start", () => {
  it("runs a command workflow to completion and checkpoints steps", async () => {
    queries.register(
      defineQuery({
        name: "core.workflow.get",
        permissions: ["core.workflow.read"],
        tags: ["core"],
        input: z.object({ workflowId: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string(), trigger: z.string(), createdBy: z.string(), createdAt: z.string(), steps: z.array(z.unknown()) }),
        handler: async () => def([
            { id: "step1", type: "command", command: "crm.customer.create", input: { name: "Acme" } },
            {
              id: "step2",
              type: "command",
              command: "acc.invoice.create",
              input: { number: "INV-1", total: 100, customerId: "${step1.id}" },
            },
          ]),
      }),
    );
    const started = await run(
      "workflow.instance.start",
      { workflowId: "wf-1", input: { campaign: "q3" } },
      ["workflow.instance.write", "core.workflow.read", "crm.customer.create", "acc.invoice.create"],
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.instance.status).toBe("completed");
    expect(started.data.run.success).toBe(true);
    expect(started.data.instance.steps).toHaveLength(2);
    expect(started.data.instance.context.step1).toEqual({ id: "cust-1", name: "Acme" });
    expect(started.data.instance.context.campaign).toBe("q3");
    expect(started.data.instance.createdByUserId).toBe("u1");

    const id = started.data.instance.id;
    const got = await ask("workflow.instance.get", { instanceId: id }, ["workflow.instance.read"]);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.data.status).toBe("completed");

    const listed = await ask("workflow.instance.list", {}, ["workflow.instance.read"]);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.items).toHaveLength(1);
  });

  it("parks at pending_approval on an approval gate and resumes via advance", async () => {
    queries.register(
      defineQuery({
        name: "core.workflow.get",
        permissions: ["core.workflow.read"],
        tags: ["core"],
        input: z.object({ workflowId: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string(), trigger: z.string(), createdBy: z.string(), createdAt: z.string(), steps: z.array(z.unknown()) }),
        handler: async () => def([
            { id: "step1", type: "command", command: "crm.customer.create", input: { name: "Acme" } },
            { id: "gate", type: "approval", description: "Approve customer" },
            { id: "step2", type: "command", command: "acc.invoice.create", input: { number: "INV-1", total: 100, customerId: "${step1.id}" } },
          ]),
      }),
    );
    const started = await run(
      "workflow.instance.start",
      { workflowId: "wf-1" },
      ["workflow.instance.write", "core.workflow.read", "crm.customer.create", "acc.invoice.create"],
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.instance.status).toBe("pending_approval");
    expect(started.data.run.success).toBe(false);
    expect(started.data.instance.steps.map((s: { stepId: string }) => s.stepId)).toEqual(["step1", "gate"]);
    const id = started.data.instance.id;

    const advanced = await run(
      "workflow.instance.advance",
      { instanceId: id, approvedStepIds: ["gate"] },
      ["workflow.instance.write", "core.workflow.read", "crm.customer.create", "acc.invoice.create"],
    );
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.data.instance.status).toBe("completed");
    expect(advanced.data.instance.context.step2).toEqual({ id: "inv-1", customerId: "cust-1" });
  });

  it("rejects a second advance once the instance is terminated", async () => {
    queries.register(
      defineQuery({
        name: "core.workflow.get",
        permissions: ["core.workflow.read"],
        tags: ["core"],
        input: z.object({ workflowId: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string(), trigger: z.string(), createdBy: z.string(), createdAt: z.string(), steps: z.array(z.unknown()) }),
        handler: async () => def([{ id: "step1", type: "command", command: "crm.customer.create", input: { name: "Acme" } }]),
      }),
    );
    const started = await run(
      "workflow.instance.start",
      { workflowId: "wf-1" },
      ["workflow.instance.write", "core.workflow.read", "crm.customer.create"],
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.instance.id;

    const again = await run(
      "workflow.instance.advance",
      { instanceId: id },
      ["workflow.instance.write", "core.workflow.read", "crm.customer.create"],
    );
    expect(again.ok).toBe(false);
    expect(again.errorMessage).toContain("already terminated");
  });
});

describe("workflow.instance.cancel", () => {
  it("cancels a pending-approval instance and blocks further advance", async () => {
    queries.register(
      defineQuery({
        name: "core.workflow.get",
        permissions: ["core.workflow.read"],
        tags: ["core"],
        input: z.object({ workflowId: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string(), trigger: z.string(), createdBy: z.string(), createdAt: z.string(), steps: z.array(z.unknown()) }),
        handler: async () => def([
            { id: "gate", type: "approval", description: "Approve" },
          ]),
      }),
    );
    const started = await run(
      "workflow.instance.start",
      { workflowId: "wf-1" },
      ["workflow.instance.write", "core.workflow.read"],
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.instance.id;

    const cancelled = await run("workflow.instance.cancel", { instanceId: id, reason: "No longer needed" }, ["workflow.instance.write"]);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.data.instance.status).toBe("cancelled");
      expect(cancelled.data.instance.error).toBe("No longer needed");
    }

    const again = await run("workflow.instance.cancel", { instanceId: id }, ["workflow.instance.write"]);
    expect(again.ok).toBe(false);
    expect(again.errorMessage).toContain("already terminated");
  });
});

describe("scoping and validation", () => {
  it("scopes get/list to the actor's organization", async () => {
    registerDef([{ id: "step1", type: "command", command: "crm.customer.create", input: { name: "Acme" } }]);
    const started = await run(
      "workflow.instance.start",
      { workflowId: "wf-1" },
      ["workflow.instance.write", "core.workflow.read", "crm.customer.create"],
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.data.instance.id;

    const crossOrg = await ask(
      "workflow.instance.get",
      { instanceId: id },
      ["workflow.instance.read"],
      "o2",
    );
    expect(crossOrg.ok).toBe(false);
    expect(crossOrg.errorMessage).toContain("not found");

    const other = await ask("workflow.instance.list", {}, ["workflow.instance.read"], "o2");
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.data.items).toHaveLength(0);
  });

  it("rejects strict violations and unknown workflow ids", async () => {
    const invalid = await run(
      "workflow.instance.start",
      { workflowId: "wf-1", stray: true },
      ["workflow.instance.write", "core.workflow.read"],
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errorMessage).toContain("Invalid input");

    const missing = await run(
      "workflow.instance.start",
      { workflowId: "wf-nope" },
      ["workflow.instance.write", "core.workflow.read"],
    );
    expect(missing.ok).toBe(false);
  });
});