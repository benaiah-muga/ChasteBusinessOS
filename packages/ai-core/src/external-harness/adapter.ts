import type { Actor } from "@chaste/kernel";
import type { McpGateway } from "../mcp/gateway.js";
import type { SessionLog } from "../trajectory/index.js";
import { sessionEvent } from "../trajectory/index.js";
import type {
  HarnessActorSnapshot,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessKind,
  HarnessMessage,
  HarnessRunHandle,
  HarnessRunResult,
  HarnessRunStatus,
  HarnessStartRequest,
  HarnessToolOutcome,
} from "./types.js";
import { harnessStartRequestSchema, harnessMessageSchema } from "./types.js";
import { EXTERNAL_HARNESS_DEFINITIONS } from "./definitions.js";
import type { HarnessDefinition } from "./types.js";

/**
 * ADR 0014 tranche 15 — external harness adapter (build item 16).
 *
 * Binds a delegated external run to a Chaste actor and trajectory. Every
 * run starts on `runId` (a Chaste trajectory session — the audit spine),
 * records `externalHarness/*` events, and mediates all tool calls through the
 * MCP gateway so nothing bypasses the bus. The handle is fully
 * reconstructable from the trajectory, so stateless hosts resume runs from
 * `runId` alone.
 */

export interface HarnessAdapterOptions {
  definition: HarnessDefinition;
  mcp: McpGateway;
  log: SessionLog;
  now?: () => Date;
}

export function actorToSnapshot(actor: Actor): HarnessActorSnapshot {
  return {
    kind: actor.kind,
    userId: actor.userId,
    organizationId: actor.organizationId,
    displayName: actor.displayName,
    clientId: actor.clientId,
    permissions: [...actor.permissions],
  };
}

export function actorFromSnapshot(snapshot: HarnessActorSnapshot): Actor {
  return {
    kind: snapshot.kind,
    userId: snapshot.userId,
    organizationId: snapshot.organizationId,
    displayName: snapshot.displayName,
    clientId: snapshot.clientId,
    permissions: new Set(snapshot.permissions),
  };
}

export function createHarnessAdapter(opts: HarnessAdapterOptions): HarnessAdapter {
  const { definition, mcp, log, now } = opts;
  const t = now ?? (() => new Date());

  function startEventPayload(request: HarnessStartRequest, fields: ReturnType<typeof harnessStartRequestSchema.parse>) {
    return {
      harnessId: definition.id,
      harnessKind: definition.kind,
      objective: fields.objective,
      tenantId: fields.tenantId,
      workspace: fields.workspace,
      allowedTools: fields.allowedTools,
      forbiddenDataClasses: fields.forbiddenDataClasses,
      outputSchema: fields.outputSchema,
      budget: fields.budget,
      deadline: fields.deadline,
      auditCorrelationId: fields.auditCorrelationId,
      actor: actorToSnapshot(request.actor),
    };
  }

  function emptyHandle(request: HarnessStartRequest, fields: ReturnType<typeof harnessStartRequestSchema.parse>): HarnessRunHandle {
    return {
      runId: crypto.randomUUID(),
      harnessId: definition.id,
      kind: definition.kind,
      actor: actorToSnapshot(request.actor),
      objective: fields.objective,
      tenantId: fields.tenantId,
      workspace: fields.workspace,
      allowedTools: fields.allowedTools,
      forbiddenDataClasses: fields.forbiddenDataClasses,
      outputSchema: fields.outputSchema,
      budget: fields.budget,
      deadline: fields.deadline,
      auditCorrelationId: fields.auditCorrelationId,
      status: "running",
      usageVisibility: "unknown",
      modelUsage: [],
      toolOutcomes: [],
      artifacts: [],
      proposedCommands: [],
      summary: fields.objective,
    };
  }

  async function start(request: HarnessStartRequest): Promise<HarnessRunHandle> {
    const fields = harnessStartRequestSchema.parse(request);
    const handle = emptyHandle(request, fields);
    await log.append(
      sessionEvent(
        handle.runId,
        request.actor.organizationId,
        "externalHarness/session-start",
        startEventPayload(request, fields),
        { now: t },
      ),
    );
    return handle;
  }

  /** Adapter-level gate: only tools the run was explicitly granted may be
   * called. The gateway then revalidates/reauthorizes per the actor. */
  function toolAllowed(handle: HarnessRunHandle, tool: string): boolean {
    return handle.allowedTools.some((g) => g.tool === tool);
  }

  async function runToolCall(
    handle: HarnessRunHandle,
    tool: string,
    args: unknown,
    toolCallId?: string,
  ): Promise<HarnessToolOutcome> {
    if (!toolAllowed(handle, tool)) {
      return {
        tool,
        toolCallId,
        ok: false,
        error: `tool not in allowedTools: ${tool}`,
      };
    }
    const actor = actorFromSnapshot(handle.actor);
    const gateway = mcp.createSession({
      sessionId: handle.runId,
      organizationId: actor.organizationId,
      actor,
    });
    try {
      const result = await gateway.callTool(tool, args ?? {});
      const text = result.content.map((c) => c.text).join("\n");
      return {
        tool,
        toolCallId,
        ok: !result.isError,
        summary: text,
        error: result.isError ? text : undefined,
        approvalRequired: result.isError === true && text.includes("approval_required"),
      };
    } catch (err) {
      return {
        tool,
        toolCallId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function followup(handle: HarnessRunHandle, message: HarnessMessage): Promise<HarnessRunHandle> {
    const fields = harnessMessageSchema.parse(message);
    const next = { ...handle, modelUsage: [...handle.modelUsage], toolOutcomes: [...handle.toolOutcomes], artifacts: [...handle.artifacts], proposedCommands: [...handle.proposedCommands] };

    const usageRecorded = Boolean(fields.provider && fields.model);
    if (usageRecorded) next.usageVisibility = "recorded";
    next.modelUsage.push({
      provider: fields.provider,
      model: fields.model,
      promptTokens: fields.usage?.promptTokens,
      completionTokens: fields.usage?.completionTokens,
      costCents: fields.usage?.costCents,
    });

    await log.append(
      sessionEvent(
        next.runId,
        next.actor.organizationId,
        "externalHarness/turn",
        {
          role: fields.role,
          content: fields.content,
          provider: fields.provider,
          model: fields.model,
          usage: fields.usage,
          usageVisibility: usageRecorded ? "recorded" : "unknown",
          proposedCommands: fields.proposedCommands,
        },
        { now: t },
      ),
    );

    for (const call of fields.toolCalls ?? []) {
      await log.append(
        sessionEvent(
          next.runId,
          next.actor.organizationId,
          "externalHarness/tool-call",
          { tool: call.tool, args: call.args, toolCallId: call.toolCallId },
          { now: t },
        ),
      );
      const outcome = await runToolCall(next, call.tool, call.args, call.toolCallId);
      next.toolOutcomes.push(outcome);
      await log.append(
        sessionEvent(
          next.runId,
          next.actor.organizationId,
          "externalHarness/tool-result",
          outcome,
          { now: t },
        ),
      );
    }

    for (const artifact of fields.artifacts ?? []) {
      next.artifacts.push(artifact);
      await log.append(
        sessionEvent(next.runId, next.actor.organizationId, "externalHarness/artifact", artifact, { now: t }),
      );
    }
    if (fields.proposedCommands?.length) next.proposedCommands.push(...fields.proposedCommands);
    next.summary = fields.content;

    if (fields.endSession) {
      next.status = "succeeded";
      await log.append(
        sessionEvent(
          next.runId,
          next.actor.organizationId,
          "externalHarness/session-end",
          { status: "succeeded" as const },
          { now: t },
        ),
      );
    }
    return next;
  }

  async function cancel(handle: HarnessRunHandle, reason: string): Promise<HarnessRunHandle> {
    const next = { ...handle, status: "cancelled" as const };
    await log.append(
      sessionEvent(
        next.runId,
        next.actor.organizationId,
        "externalHarness/session-end",
        { status: "cancelled" as const, reason },
        { now: t },
      ),
    );
    return next;
  }

  async function collect(handle: HarnessRunHandle): Promise<HarnessRunResult> {
    return {
      status: handle.status,
      summary: handle.summary,
      evidenceRefs: handle.artifacts,
      artifacts: handle.artifacts,
      traceRef: handle.runId,
      modelUsage: handle.modelUsage,
      proposedCommands: handle.proposedCommands,
      usageVisibility: handle.usageVisibility,
    };
  }

  async function capabilities(): Promise<HarnessCapabilities> {
    return {
      id: definition.id,
      kind: definition.kind,
      name: definition.name,
      description: definition.description,
      connector: definition.connector,
      recordsProviderModel: definition.recordsProviderModel,
      supportsArtifacts: definition.supportsArtifacts,
      integrationNotes: definition.integrationNotes,
    };
  }

  return { id: definition.id, kind: definition.kind, capabilities, start, followup, cancel, collect };
}

export interface HarnessAdapterSetOptions {
  mcp: McpGateway;
  log: SessionLog;
  now?: () => Date;
}

/** Build the four supported external harness adapters over one gateway + log. */
export function createHarnessAdapters(opts: HarnessAdapterSetOptions): HarnessAdapter[] {
  return EXTERNAL_HARNESS_DEFINITIONS.map((definition) =>
    createHarnessAdapter({ definition, mcp: opts.mcp, log: opts.log, now: opts.now }),
  );
}

interface HarnessStartEventPayload {
  harnessId?: string;
  harnessKind?: HarnessKind;
  objective?: string;
  tenantId?: string;
  workspace?: string;
  allowedTools?: Array<{ tool: string; args?: Record<string, unknown> }>;
  forbiddenDataClasses?: string[];
  outputSchema?: unknown;
  budget?: { maxUsd: number };
  deadline?: string;
  auditCorrelationId?: string;
  actor?: HarnessActorSnapshot;
}

/**
 * Reconstruct a run handle from its trajectory events (build item 16, audit
 * spine rule). A stateless host resumes a run from `runId` by reading the
 * session stream and rebuilding the handle — the Chaste trajectory, not
 * process memory, is the source of truth for the run.
 */
export function harnessRunFromTrajectory(
  runId: string,
  events: Array<{ type: string; payload: unknown }>,
): HarnessRunHandle | undefined {
  const start = events.find((e) => e.type === "externalHarness/session-start");
  if (!start) return undefined;
  const p = (start.payload ?? {}) as HarnessStartEventPayload;
  const handle: HarnessRunHandle = {
    runId,
    harnessId: p.harnessId ?? "custom",
    kind: p.harnessKind ?? "custom",
    actor: p.actor ?? {
      kind: "user",
      userId: "unknown",
      organizationId: "unknown",
      permissions: [],
    },
    objective: p.objective ?? "",
    tenantId: p.tenantId,
    workspace: p.workspace,
    allowedTools: (p.allowedTools ?? []) as HarnessRunHandle["allowedTools"],
    forbiddenDataClasses: p.forbiddenDataClasses ?? [],
    outputSchema: p.outputSchema,
    budget: p.budget,
    deadline: p.deadline,
    auditCorrelationId: p.auditCorrelationId,
    status: "running",
    usageVisibility: "unknown",
    modelUsage: [],
    toolOutcomes: [],
    artifacts: [],
    proposedCommands: [],
    summary: p.objective ?? "",
  };

  for (const e of events) {
    switch (e.type) {
      case "externalHarness/turn": {
        const turn = e.payload as {
          content?: string;
          provider?: string;
          model?: string;
          usage?: HarnessRunHandle["modelUsage"][number];
          usageVisibility?: "recorded" | "unknown";
          proposedCommands?: unknown[];
        };
        if (turn.usageVisibility) handle.usageVisibility = turn.usageVisibility;
        handle.modelUsage.push({
          provider: turn.provider,
          model: turn.model,
          promptTokens: turn.usage?.promptTokens,
          completionTokens: turn.usage?.completionTokens,
          costCents: turn.usage?.costCents,
        });
        if (turn.proposedCommands?.length) handle.proposedCommands.push(...turn.proposedCommands);
        if (turn.content != null) handle.summary = turn.content;
        break;
      }
      case "externalHarness/tool-result": {
        handle.toolOutcomes.push(e.payload as HarnessToolOutcome);
        break;
      }
      case "externalHarness/artifact": {
        handle.artifacts.push(e.payload as HarnessRunHandle["artifacts"][number]);
        break;
      }
      case "externalHarness/session-end": {
        const end = e.payload as { status?: HarnessRunStatus; reason?: string };
        if (end.status) handle.status = end.status;
        break;
      }
    }
  }
  return handle;
}
