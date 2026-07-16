import {
  type AutonomyLevel,
  type CommandMeta,
  type CommandRegistry,
  type QueryRegistry,
  type RequestContext,
  canAutoExecute,
  executeCommand,
  type CommandHelpers,
  stricterAutonomy,
} from "@chaste/kernel";
import type { ChatMessage, UiPart } from "@chaste/ui-schema";
import type { AiExplanation } from "./explanation.js";
import { toExplanationPart } from "./explanation.js";

export interface PendingConfirmation {
  id: string;
  command: string;
  input: unknown;
  createdAt: string;
}

export interface ChatSessionState {
  id: string;
  messages: ChatMessage[];
  pending?: PendingConfirmation;
}

export interface OrchestratorDeps {
  commands: CommandRegistry;
  queries: QueryRegistry;
  helpers: CommandHelpers;
  /** Org default autonomy */
  autonomy: AutonomyLevel;
}

export interface ChatTurnInput {
  session: ChatSessionState;
  userText?: string;
  confirmId?: string;
  cancelId?: string;
  ctx: RequestContext;
}

export interface ChatTurnResult {
  session: ChatSessionState;
  explanation?: AiExplanation;
}

function msg(role: ChatMessage["role"], parts: UiPart[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    parts,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Deterministic demo intent parser (no LLM required).
 * Later: LLM planner with the same output contract.
 */
export function parseCustomerCreateIntent(text: string): { name: string; city?: string } | null {
  const trimmed = text.trim();
  // "Create customer Acme Ltd in Nairobi"
  const m = trimmed.match(
    /create\s+customer\s+(.+?)(?:\s+in\s+([A-Za-z][A-Za-z\s-]+))?\.?$/i,
  );
  if (!m?.[1]) return null;
  const name = m[1].trim();
  const city = m[2]?.trim();
  if (!name) return null;
  return city ? { name, city } : { name };
}

export function selectSpecialistTag(
  text: string,
  availableTags: string[],
): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes("customer") || lower.includes("crm")) {
    return availableTags.includes("crm") ? "crm" : undefined;
  }
  return undefined;
}

export async function handleChatTurn(
  deps: OrchestratorDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  const session = {
    ...input.session,
    messages: [...input.session.messages],
  };

  // Cancel pending
  if (input.cancelId && session.pending?.id === input.cancelId) {
    session.pending = undefined;
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Cancelled. No changes were made." }]),
    );
    return { session };
  }

  // Confirm pending — same command bus as manual UI
  if (input.confirmId && session.pending?.id === input.confirmId) {
    const pending = session.pending;
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: {
        ...input.ctx.actor,
        kind: "ai_assisted",
        aiRunId: input.ctx.actor.aiRunId ?? crypto.randomUUID(),
      },
    };
    const result = await executeCommand(
      deps.commands,
      pending.command,
      pending.input,
      aiCtx,
      deps.helpers,
    );
    session.pending = undefined;
    const explanation: AiExplanation = {
      runId: aiCtx.actor.aiRunId!,
      summary: `Executed ${pending.command} after user confirmation.`,
      reasons: ["User confirmed the prepared action", "Same command path as manual UI"],
      rulesApplied: ["ai_manual_parity", "permission_check", "zod_validation", "autonomy:confirm"],
      dataUsed: ["user confirmation", "prepared command input"],
      autonomy: "confirm",
      plannedCommand: pending.command,
      plannedInput: pending.input,
    };
    session.messages.push(
      msg("assistant", [
        { type: "text", text: `Done. Created via \`${pending.command}\`.` },
        toExplanationPart(explanation),
        {
          type: "table",
          columns: [
            { key: "field", label: "Field" },
            { key: "value", label: "Value" },
          ],
          rows: Object.entries(result.data as Record<string, unknown>).map(([field, value]) => ({
            field,
            value: String(value ?? ""),
          })),
        },
      ]),
    );
    return { session, explanation };
  }

  if (!input.userText?.trim()) {
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Send a message or confirm a pending action." }]),
    );
    return { session };
  }

  session.messages.push(msg("user", [{ type: "text", text: input.userText }]));

  const catalog = deps.commands.list();
  const intent = parseCustomerCreateIntent(input.userText);
  const tags = [...new Set(catalog.flatMap((c) => c.tags ?? []))];
  const specialist = selectSpecialistTag(input.userText, tags);

  if (!intent) {
    const available = catalog
      .filter((c) => !specialist || c.tags?.includes(specialist))
      .map((c) => c.name);
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text:
            "I can help with installed module tools. Try: “Create customer Acme Ltd in Nairobi”. " +
            (available.length ? `Known commands: ${available.join(", ")}.` : ""),
        },
        {
          type: "explanation",
          summary: "No structured intent matched.",
          reasons: ["Deterministic parser did not recognize a supported action"],
          rulesApplied: ["intent_validation", specialist ? `specialist:${specialist}` : "general"],
          dataUsed: ["user message", "command catalog"],
        },
      ]),
    );
    return { session };
  }

  const commandName = "crm.customer.create";
  const meta = catalog.find((c) => c.name === commandName) as CommandMeta | undefined;
  if (!meta) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: "CRM customer create is not available. Is demo-crm installed?",
          code: "MODULE_MISSING",
        },
      ]),
    );
    return { session };
  }

  const commandAutonomy = meta.minAutonomyForAuto
    ? stricterAutonomy(deps.autonomy, "confirm")
    : deps.autonomy;
  // Creating customers defaults to confirm unless guarded/full auto
  const effective = stricterAutonomy(commandAutonomy, deps.autonomy);
  const runId = crypto.randomUUID();
  const plannedInput = {
    name: intent.name,
    city: intent.city,
  };

  const explanation: AiExplanation = {
    runId,
    summary: `Plan: create customer “${intent.name}” via ${commandName}.`,
    reasons: [
      "Matched natural-language create-customer pattern",
      specialist ? `Routed under specialist tag “${specialist}”` : "General routing",
      "Tool is module command — not a privileged AI API",
    ],
    rulesApplied: [
      "ai_manual_parity",
      `autonomy:${effective}`,
      "zod_validation_on_execute",
      "permission_check_on_execute",
    ],
    dataUsed: ["user message", "command catalog", "org autonomy policy"],
    autonomy: effective,
    plannedCommand: commandName,
    plannedInput,
  };

  if (canAutoExecute(effective)) {
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: { ...input.ctx.actor, kind: "ai_assisted", aiRunId: runId },
    };
    const result = await executeCommand(
      deps.commands,
      commandName,
      plannedInput,
      aiCtx,
      deps.helpers,
    );
    session.messages.push(
      msg("assistant", [
        { type: "text", text: `Executed automatically (${effective}).` },
        toExplanationPart(explanation),
        {
          type: "table",
          columns: [
            { key: "field", label: "Field" },
            { key: "value", label: "Value" },
          ],
          rows: Object.entries(result.data as Record<string, unknown>).map(([field, value]) => ({
            field,
            value: String(value ?? ""),
          })),
        },
      ]),
    );
    return { session, explanation };
  }

  // recommend or confirm → prepare UI card
  const confirmId = crypto.randomUUID();
  session.pending = {
    id: confirmId,
    command: commandName,
    input: plannedInput,
    createdAt: new Date().toISOString(),
  };

  const recommendOnly = effective === "recommend";
  session.messages.push(
    msg("assistant", [
      {
        type: "text",
        text: recommendOnly
          ? "Recommendation only (autonomy=recommend). Confirm is disabled until autonomy is raised."
          : "I prepared a validated action. Confirm to run it through the same business command as the manual UI.",
      },
      toExplanationPart(explanation),
      {
        type: "confirm_action",
        id: confirmId,
        title: "Create customer",
        description: `${intent.name}${intent.city ? ` · ${intent.city}` : ""}`,
        command: commandName,
        input: plannedInput,
        confirmLabel: recommendOnly ? "Disabled" : "Confirm create",
        cancelLabel: "Cancel",
      },
    ]),
  );

  return { session, explanation };
}
