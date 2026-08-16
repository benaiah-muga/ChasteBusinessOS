import {
  classifiableFromMeta,
  classify,
  createCommandEnvelope,
  createRequestContext,
  dispatchCommand,
  executeQuery,
} from "@chaste/kernel";
import type {
  CommandRegistry,
  PolicyDecision,
  QueryRegistry,
  RiskClass,
} from "@chaste/kernel";
import { z } from "zod";
import { sessionEvent } from "../trajectory/index.js";
import type { AgentSessionEventType } from "../trajectory/index.js";
import type {
  ApprovalRequest,
  BusinessToolDefinition,
  RenderedToolResult,
  ToolContext,
  ToolOutcome,
} from "./types.js";

/**
 * Execution pipeline for business tools (doc §Tool and Capability Registry):
 *
 * ```text
 * model tool call
 *   -> log tool/call
 *   -> parse and validate arguments
 *   -> authorize tool visibility and execution
 *   -> classify risk
 *   -> require approval if policy says so
 *   -> dispatch command/query
 *   -> record policy decisions and command/query result
 *   -> normalize output to structured value
 *   -> render concise model-facing result
 *   -> log tool/result
 * ```
 *
 * The tool never implements business logic and never touches storage — it only
 * dispatches through the bus under the actor's own (never elevated)
 * permissions, emitting trajectory events at every step so the session can be
 * replayed and explained.
 */

/** Default risk → approval policy: reads and in-tenant writes are the actor's
 * own authority; `exec`/`external` side effects need a durable grant. */
export function defaultToolPolicy(req: {
  riskClass: RiskClass;
  isQuery: boolean;
  now?: () => Date;
}): PolicyDecision {
  const requiresApproval = req.riskClass === "exec" || req.riskClass === "external";
  return {
    kind: requiresApproval ? "approval_required" : "allow",
    policy: "default-risk-policy",
    reason: requiresApproval
      ? `${req.riskClass} risk requires a durable human approval before dispatch`
      : `${req.riskClass} risk is within the actor's own authority`,
    evaluatedAt: (req.now?.() ?? new Date()).toISOString(),
    context: {},
  };
}

async function toolRiskClass(
  tool: BusinessToolDefinition<z.ZodType, z.ZodType>,
  commands: CommandRegistry,
): Promise<RiskClass> {
  if (tool.risk) return tool.risk;
  const isQuery = tool.kind === "query";
  const def = isQuery ? undefined : commands.get(tool.command);
  return classify(tool.command, { isQuery, classifiable: classifiableFromMeta(def) });
}

async function logEvent(
  ctx: ToolContext,
  type: AgentSessionEventType,
  payload: unknown,
): Promise<void> {
  if (!ctx.trajectory) return;
  await ctx.trajectory.append(
    sessionEvent(ctx.sessionId, ctx.organizationId, type, payload, {
      now: ctx.now,
    }),
  );
}

/** Resolve missing-permission to a typed denial with a named policy basis. */
function permissionDenial(
  tool: BusinessToolDefinition<z.ZodType, z.ZodType>,
  missing: string[],
): PolicyDecision {
  return {
    kind: "deny",
    policy: "tool-exposeWhen",
    reason: `Actor lacks required permissions: ${missing.join(", ")}`,
    evaluatedAt: new Date().toISOString(),
    context: {},
  };
}

export async function executeBusinessTool<T = unknown>(
  tool: BusinessToolDefinition<z.ZodType, z.ZodType>,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome<T>> {
  const policyDecisions: PolicyDecision[] = [];
  const commandType = tool.command;

  // 1. Log the call arguments *before* anything else happens.
  const riskClass = await toolRiskClass(tool, ctx.commands);
  await logEvent(ctx, "tool/call", {
    tool: tool.name,
    args: rawArgs,
    riskClass,
  });

  // 2. Parse and validate arguments against the same strict schema the bus
  //    will validate against. Nothing is dispatched on failure.
  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    }));
    await logEvent(ctx, "tool/result", {
      tool: tool.name,
      ok: false,
      kind: "validation",
      issues,
    });
    return { ok: false, kind: "validation", commandType, issues, policyDecisions };
  }

  // 3. Authorize tool visibility and execution (doc: tool hidden unless the
  //    actor/task can use it). Defense in depth on top of `listForActor`.
  const missing = tool.exposeWhen.filter(
    (p) => !ctx.actor.permissions.has("*") && !ctx.actor.permissions.has(p),
  );
  if (missing.length > 0) {
    const denial = permissionDenial(tool, missing);
    policyDecisions.push(denial);
    await logEvent(ctx, "policy/decision", denial);
    await logEvent(ctx, "tool/result", {
      tool: tool.name,
      ok: false,
      kind: "denied",
      reason: denial.reason,
    });
    return { ok: false, kind: "denied", commandType, reason: denial.reason, policyDecisions };
  }

  // 4. Classify risk.
  // 5. Require approval if policy says so. Approval-required outcomes are
  //    rendered as approval *requests*, never as failures. An `allow` granted
  //    by a durable grant (`policy: "grant:<id>"`, set by
  //    `grantCoveredToolPolicy`) cites the grant as the envelope's
  //    `approvalGrantId` so audit and the handler can trace the authority.
  const policy = ctx.policy ?? ((r) => defaultToolPolicy(r));
  const decision = await policy({ tool, args: parsed.data, riskClass, commandType, isQuery: tool.kind === "query" });
  policyDecisions.push(decision);
  await logEvent(ctx, "policy/decision", decision);

  if (decision.kind === "deny") {
    await logEvent(ctx, "tool/result", {
      tool: tool.name,
      ok: false,
      kind: "denied",
      reason: decision.reason,
    });
    return { ok: false, kind: "denied", commandType, reason: decision.reason, policyDecisions };
  }

  let approvalGrantId: string | undefined;
  if (decision.kind === "allow" && decision.policy.startsWith("grant:")) {
    approvalGrantId = decision.policy.slice("grant:".length);
  }
  if (decision.kind === "approval_required") {
    const approvalRequest: ApprovalRequest = {
      tool: tool.name,
      commandType,
      riskClass,
      args: parsed.data,
      reason: ctx.reason,
      policyContext: ctx.policyContext ?? {},
      policyBasis: decision.policy,
      evidenceRefs: ctx.evidenceRefs,
    };
    await logEvent(ctx, "approval/requested", approvalRequest);

    const resolution = ctx.approvals ? await ctx.approvals.request(approvalRequest) : undefined;
    if (!resolution?.granted) {
      await logEvent(ctx, "tool/result", {
        tool: tool.name,
        ok: false,
        kind: "approval_required",
        approvalRequest,
      });
      return {
        ok: false,
        kind: "approval_required",
        commandType,
        approvalRequest,
        policyDecisions,
      };
    }
    approvalGrantId = resolution.grantId;
    await logEvent(ctx, "approval/granted", {
      approvalGrantId,
      tool: tool.name,
      commandType,
      policyBasis: resolution.policyBasis ?? decision.policy,
    });
  }

  // 6. Dispatch through the same bus humans use. A bus failure (handler
  //    error, not-found, nested denial) is recorded and returned as a typed
  //    `error` outcome — the trajectory stays complete.
  const isQuery = tool.kind === "query";
  let requestId: string;
  let busResult: unknown;

  try {
    if (isQuery) {
      await logEvent(ctx, "query/dispatched", { queryType: commandType });
      const qctx = createRequestContext({
        actor: ctx.actor,
        now: ctx.now,
        origin: ctx.origin ?? "agent",
        reason: ctx.reason,
        evidenceRefs: ctx.evidenceRefs,
        policyContext: ctx.policyContext,
        idempotencyKey: ctx.idempotencyKey,
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
      });
      const result = await executeQuery(ctx.queries, commandType, parsed.data, qctx);
      requestId = result.requestId;
      busResult = result.data;
      await logEvent(ctx, "query/result", {
        queryType: commandType,
        requestId,
        ok: true,
        result: busResult,
      });
    } else {
      await logEvent(ctx, "command/dispatched", {
        commandType,
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        reason: ctx.reason,
      });
      const envelope = createCommandEnvelope(
        {
          commandType,
          actor: ctx.actor,
          tenantId: ctx.organizationId,
          payload: parsed.data,
          origin: ctx.origin ?? "agent",
          reason: ctx.reason,
          evidenceRefs: ctx.evidenceRefs,
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
approvalGrantId,
        policyContext: { ...ctx.policyContext, policy: decision.policy },
        idempotencyKey: ctx.idempotencyKey,
        },
        { now: ctx.now },
      );
      const result = await dispatchCommand<T>(ctx.commands, envelope, ctx.helpers, {
        now: ctx.now,
      });
      requestId = result.requestId;
      busResult = result.data;
      await logEvent(ctx, "command/result", {
        commandType,
        requestId,
        ok: true,
        result: busResult,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && "code" in err ? String((err as { code: string }).code) : "BUS_ERROR";
    await logEvent(ctx, isQuery ? "query/result" : "command/result", {
      commandType,
      ok: false,
      errorCode: code,
      errorMessage: message,
    });
    await logEvent(ctx, "tool/result", {
      tool: tool.name,
      ok: false,
      kind: "error",
      message,
    });
    return { ok: false, kind: "error", commandType, message, code, policyDecisions };
  }

  // 7. Record policy decisions and command/query result.
  // 8. Normalize output to the canonical structured value.
  const normalized = tool.output.safeParse(busResult);
  if (!normalized.success) {
    const issues = normalized.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    }));
    await logEvent(ctx, "tool/result", {
      tool: tool.name,
      ok: false,
      kind: "error",
      message: "Tool output failed the canonical output schema",
      issues,
    });
    return {
      ok: false,
      kind: "error",
      commandType,
      message: "Tool output failed the canonical output schema",
      code: "INVALID_TOOL_OUTPUT",
      policyDecisions,
    };
  }

  // 9. Render a concise model-facing result.
  const rendered: RenderedToolResult<T> = tool.renderResult
    ? await tool.renderResult(normalized.data as T)
    : { summary: "ok", structured: normalized.data as T };

  // 10. Log the rendered tool/result.
  await logEvent(ctx, "tool/result", {
    tool: tool.name,
    ok: true,
    summary: rendered.summary,
    structured: rendered.structured,
  });

  return {
    ok: true,
    result: rendered,
    commandType,
    requestId,
    policyDecisions,
    approvalGrantId,
  };
}