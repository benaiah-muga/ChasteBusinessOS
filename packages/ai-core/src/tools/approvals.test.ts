import {
  createCommandRegistry,
  createQueryRegistry,
  defineCommand,
  InMemoryApprovalGrantStore,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import type { Actor, CommandHelpers, InboxStore } from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { grantCoveredToolPolicy, grantStoreApprovalResolver } from "./approvals.js";
import { executeBusinessTool } from "./execute.js";
import { defineBusinessTool } from "./registry.js";
import type { ToolContext } from "./types.js";
import { InMemorySessionLog } from "../trajectory/index.js";

const now = () => new Date("2026-08-16T12:00:00Z");

const emailSendTool = defineBusinessTool({
  name: "messaging_send_email",
  description: "Send an email to a recipient outside the platform.",
  command: "messaging.email.send",
  exposeWhen: ["messaging.email.send"],
  input: z.object({ to: z.string(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
  renderResult: (r) => ({ summary: `Email sent to ${r.messageId}.`, structured: r }),
});

function registerCommands() {
  const registry = createCommandRegistry();
  registry.register(
    defineCommand({
      name: "messaging.email.send",
      permissions: ["messaging.email.send"],
      tags: ["messaging"],
      riskClass: "external",
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ messageId: z.string() }),
      handler: async () => ({ messageId: "msg-1" }),
    }),
  );
  return registry;
}

function actor(permissions: string[]): Actor {
  return { kind: "user", userId: "u1", organizationId: "o1", permissions: new Set(permissions) };
}

function helpers(): CommandHelpers {
  return { audit: new InMemoryAuditWriter(), outbox: new InMemoryOutboxWriter() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    organizationId: "o1",
    actor: actor(["messaging.email.send"]),
    correlationId: "corr-1",
    commands: registerCommands(),
    queries: createQueryRegistry(),
    helpers: helpers(),
    trajectory: new InMemorySessionLog(),
    now,
    ...overrides,
  };
}

/** Minimal inbox whose `wait` returns a canned resolution. */
function fakeInbox(resolution: string): InboxStore {
  return {
    addApproval: async (input) => ({
      id: "inbox-1",
      ...input,
      kind: "approval" as const,
      state: "pending" as const,
      inbox: "default",
      visibility: "inbox" as const,
      createdAt: now().toISOString(),
    }),
    wait: async () => resolution,
  } as unknown as InboxStore;
}

async function eventTypes(ctx: ToolContext): Promise<string[]> {
  const events = await ctx.trajectory!.list("s1");
  return events.map((e) => e.type);
}

describe("grantStoreApprovalResolver", () => {
  it("keeps the call pending when no decision surface is wired", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const ctx = makeCtx({
      approvals: grantStoreApprovalResolver(store, {
        organizationId: "o1",
        grantedToUserId: "u1",
        approverUserId: "approver-1",
        now,
      }),
    });

    const out = await executeBusinessTool(emailSendTool, { to: "x@y.z", subject: "hi" }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("approval_required");
    expect(await store.list("o1")).toEqual([]);
    expect(await eventTypes(ctx)).not.toContain("command/dispatched");
  });

  it("mints a durable grant when the human approves via the inbox", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const ctx = makeCtx({
      policyContext: { branchId: "br-1" },
      approvals: grantStoreApprovalResolver(store, {
        organizationId: "o1",
        grantedToUserId: "u1",
        approverUserId: "approver-1",
        inbox: fakeInbox("allow"),
        now,
      }),
    });

    const out = await executeBusinessTool(emailSendTool, { to: "x@y.z", subject: "hi" }, ctx);

    expect(out.ok).toBe(true);
    if (out.ok) return;
    expect(out.approvalGrantId).toBeDefined();

    const grants = await store.list("o1");
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant.scope).toEqual({ commandType: "messaging.email.send" });
    expect(grant.grantedBy).toBe("approver-1");
    expect(grant.grantedToUserId).toBe("u1");
    expect(grant.status).toBe("active");
    expect(grant.policyBasis).toBe("default-risk-policy");
    expect(grant.conditions).toEqual(['branchId="br-1"']);
    expect(grant.expiresAt).toBeDefined();

    const events = await ctx.trajectory!.list("s1");
    const granted = events.find((e) => e.type === "approval/granted")!;
    expect(granted.payload).toMatchObject({
      approvalGrantId: out.approvalGrantId,
      commandType: "messaging.email.send",
    });
    expect(events.map((e) => e.type)).toContain("command/dispatched");
  });

  it("returns approval_required (not a failure) when the human denies", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const ctx = makeCtx({
      approvals: grantStoreApprovalResolver(store, {
        organizationId: "o1",
        grantedToUserId: "u1",
        approverUserId: "approver-1",
        inbox: fakeInbox("deny"),
        now,
      }),
    });

    const out = await executeBusinessTool(emailSendTool, { to: "x@y.z", subject: "hi" }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("approval_required");
    expect(await store.list("o1")).toEqual([]);
    expect(await eventTypes(ctx)).not.toContain("command/dispatched");
  });
});

describe("grantCoveredToolPolicy", () => {
  it("auto-allows a call covered by an existing durable grant", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const grant = await store.create({
      organizationId: "o1",
      grantedBy: "approver-1",
      grantedToUserId: "u1",
      scope: { commandType: "messaging.email.send" },
    });
    const ctx = makeCtx({
      policy: grantCoveredToolPolicy(store, { organizationId: "o1", userId: "u1", now }),
    });

    const out = await executeBusinessTool(emailSendTool, { to: "x@y.z", subject: "hi" }, ctx);

    expect(out.ok).toBe(true);
    if (out.ok) return;
    expect(out.policyDecisions[0]?.policy).toBe(`grant:${grant.id}`);
    expect(await eventTypes(ctx)).not.toContain("approval/requested");
    expect(await eventTypes(ctx)).toContain("command/dispatched");
  });

  it("falls back to the risk policy when no grant covers the call", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const ctx = makeCtx({
      policy: grantCoveredToolPolicy(store, { organizationId: "o1", userId: "u1", now }),
    });

    const out = await executeBusinessTool(emailSendTool, { to: "x@y.z", subject: "hi" }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("approval_required");
    expect(await eventTypes(ctx)).toContain("approval/requested");
  });

  it("does not auto-allow for a different actor", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    await store.create({
      organizationId: "o1",
      grantedBy: "approver-1",
      grantedToUserId: "u1",
      scope: { commandType: "messaging.email.send" },
    });
    const ctx = makeCtx({
      actor: actor(["messaging.email.send", "email.extra"]),
      policy: grantCoveredToolPolicy(store, { organizationId: "o1", userId: "other-user", now }),
    });

    const out = await executeBusinessTool(emailSendTool, { to: "x@y.z", subject: "hi" }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("approval_required");
  });
});