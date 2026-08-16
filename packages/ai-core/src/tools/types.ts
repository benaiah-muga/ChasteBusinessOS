import type {
  Actor,
  ActorOrigin,
  CommandHelpers,
  CommandRegistry,
  EvidenceRef,
  PolicyContext,
  PolicyDecision,
  QueryRegistry,
  RiskClass,
} from "@chaste/kernel";
import type { z } from "zod";
import type { SessionLog } from "../trajectory/index.js";

/**
 * Agent tool and capability registry (research doc §Tool and Capability
 * Registry, §Tool Surface Optimization, §Agent Tool Wrapper Template).
 *
 * Tools are thin consumers of the same command/query bus humans use. A tool
 * declares where it lands on the bus (`command`), which permissions an actor
 * must hold to even *see* it (`exposeWhen`), and how its result is rendered
 * back to the model (`renderResult`). No tool implements business logic, and
 * no tool may hide a write outside the bus — everything dispatches through
 * `dispatchCommand`/`executeQuery` under the actor's own (never elevated)
 * permission set.
 */

export type ToolAccess = "read" | "write" | "external";
export type ToolApprovalClass = "auto" | "review";
export type ToolCostClass = "cheap" | "standard" | "reasoning" | "vision" | "local";

export interface ToolExample {
  /** Whether this is an example of a good (true) or bad (false) call. */
  good: boolean;
  summary: string;
  args: unknown;
}

/**
 * A business tool definition (doc Agent Tool Wrapper Template). `input` and
 * `output` are the same Zod contracts the underlying command/query validates,
 * so the tool never re-implements business rules — it just mirrors the bus.
 */
export interface BusinessToolDefinition<TIn extends z.ZodType, TOut extends z.ZodType> {
  /** Model-facing tool name, e.g. `procurement_create_purchase_order`. */
  name: string;
  /** Short model-facing description. */
  description: string;
  /** Which bus the tool calls: a command (default) or a query. */
  kind?: "command" | "query";
  /** Name of the command/query on the bus this tool dispatches. */
  command: string;
  /**
   * Risk class override. When omitted the risk is derived from the underlying
   * bus definition (command metadata) — a tool must not invent a risk
   * taxonomy that disagrees with the command it wraps.
   */
  risk?: RiskClass;
  /**
   * Permissions the actor must hold for the tool to be visible *and*
   * executable. The tool is hidden from model context unless every permission
   * here is held (doc acceptance criteria: "hidden from model context unless
   * the actor/task can use it").
   */
  exposeWhen: string[];
  /** Strict input schema (validated at the bus boundary by the same schema). */
  input: TIn;
  /** Canonical output schema. */
  output: TOut;
  /** Idempotency behavior. Defaults to true for queries, false for commands. */
  idempotent?: boolean;
  /** Doc's approval class. Defaults to `auto` for reads, `review` otherwise. */
  approvalClass?: ToolApprovalClass;
  /** Read/write classification. Defaults from kind + risk. */
  access?: ToolAccess;
  /** Expected latency in milliseconds (tool-surface metadata). */
  expectedLatencyMs?: number;
  /** Expected cost class (tool-surface metadata). */
  costClass?: ToolCostClass;
  /** Examples of good and bad calls (tool-surface metadata). */
  examples?: ToolExample[];
  /**
   * Render the canonical output into a concise model-facing result
   * (`{ summary, structured }`). Default: `{ summary: "ok", structured }`.
   */
  renderResult?: (result: z.infer<TOut>) => RenderedToolResult<z.infer<TOut>>;
  /** Human UI renderer for call and result (doc tool-surface requirement). */
  renderHuman?: (call: { args: unknown }, result: z.infer<TOut>) => unknown;
}

/** Concise model-facing result of a tool call. */
export interface RenderedToolResult<T = unknown> {
  summary: string;
  structured: T;
  /** Optional human-oriented rendering of the same result. */
  human?: unknown;
}

/** A durable approval grant request/resolution (doc §Human Collaboration). */
export interface ApprovalRequest {
  tool: string;
  commandType: string;
  riskClass: RiskClass;
  args: unknown;
  reason?: string;
  policyContext: PolicyContext;
}

export interface ApprovalResolution {
  granted: boolean;
  /** Id of the durable approval grant when granted. */
  grantId?: string;
  /** Policy basis for the grant. */
  policyBasis?: string;
}

/**
 * Resolves approval-required outcomes into durable grants. Absent a resolver,
 * an approval-required call is returned as an *approval request*, never as a
 * failure and never silently executed.
 */
export interface ApprovalResolver {
  request(req: ApprovalRequest): Promise<ApprovalResolution>;
}

/**
 * Policy consulted by the execution pipeline after risk classification. When
 * absent, the default policy applies: `read` and `write_local` dispatch under
 * the actor's own RBAC; `exec` and `external` require approval.
 */
export type ToolPolicy = (req: {
  tool: BusinessToolDefinition<z.ZodType, z.ZodType>;
  args: unknown;
  riskClass: RiskClass;
  commandType: string;
  isQuery: boolean;
}) => Promise<PolicyDecision> | PolicyDecision;

/** Everything `executeBusinessTool` needs to run one tool call. */
export interface ToolContext {
  sessionId: string;
  organizationId: string;
  actor: Actor;
  /** Defaults to `agent`; never elevates permissions. */
  origin?: ActorOrigin;
  correlationId: string;
  causationId?: string;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
  policyContext?: PolicyContext;
  /** Caller-supplied idempotency key for retryable/external commands. */
  idempotencyKey?: string;
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  /** Append-only trajectory sink; pipeline emits tool/policy/command events. */
  trajectory?: SessionLog;
  /** Approval resolver for approval-required outcomes. */
  approvals?: ApprovalResolver;
  /** Risk → approval policy. Defaults to {@link defaultToolPolicy}. */
  policy?: ToolPolicy;
  now?: () => Date;
}

export type ToolOutcome<T = unknown> =
  | {
      ok: true;
      result: RenderedToolResult<T>;
      commandType: string;
      requestId: string;
      policyDecisions: PolicyDecision[];
      approvalGrantId?: string;
    }
  | {
      ok: false;
      kind: "denied";
      commandType: string;
      reason: string;
      policyDecisions: PolicyDecision[];
    }
  | {
      ok: false;
      kind: "validation";
      commandType: string;
      issues: Array<{ path: string; message: string }>;
      policyDecisions: PolicyDecision[];
    }
  | {
      ok: false;
      kind: "approval_required";
      commandType: string;
      approvalRequest: ApprovalRequest;
      policyDecisions: PolicyDecision[];
    }
  | {
      ok: false;
      kind: "error";
      commandType: string;
      message: string;
      code?: string;
      policyDecisions: PolicyDecision[];
    };

/** Registry of registered business tools. */
export interface ToolRegistry {
  register<TIn extends z.ZodType, TOut extends z.ZodType>(
    tool: BusinessToolDefinition<TIn, TOut>,
  ): void;
  get(name: string): BusinessToolDefinition<z.ZodType, z.ZodType> | undefined;
  has(name: string): boolean;
  /** Every registered tool (not filtered). */
  list(): Array<BusinessToolDefinition<z.ZodType, z.ZodType>>;
  /** Only tools the actor may see and use (all `exposeWhen` held). */
  listForActor(actor: Actor): Array<BusinessToolDefinition<z.ZodType, z.ZodType>>;
}