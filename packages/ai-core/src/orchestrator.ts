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
  FULL_AUTONOMOUS_WARNING,
} from "@chaste/kernel";
import type { ChatMessage, UiPart } from "@chaste/ui-schema";
import type { AiExplanation } from "./explanation.js";
import { toExplanationPart } from "./explanation.js";
import type { AiProvider } from "./providers.js";
import type { Agent } from "@mastra/core/agent";
import { createConversationalAgent } from "./agents/conversational-agent.js";
import { createSupervisorAgent } from "./agents/supervisor.js";

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
  autonomy: AutonomyLevel;
  provider?: AiProvider;
  allowFullAutonomous?: boolean;
  /** Mastra agent for complex intent resolution — fallback when rules/LLM miss */
  mastraAgent?: Agent;
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

export interface PlannedAction {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  specialist?: string;
}

/** Deterministic multi-domain intent parser (always available; LLM is optional assist). */
export function planFromText(text: string): PlannedAction | null {
  const trimmed = text.trim();

  let m = trimmed.match(
    /create\s+customer\s+(.+?)(?:\s+in\s+([A-Za-z][A-Za-z\s-]+))?\.?$/i,
  );
  if (m?.[1]) {
    return {
      command: "crm.customer.create",
      input: { name: m[1].trim(), city: m[2]?.trim() },
      summary: `Create customer ${m[1].trim()}`,
      specialist: "crm",
    };
  }

  m = trimmed.match(/prepare\s+payroll\s+for\s+(.+)$/i);
  if (m?.[1]) {
    return {
      command: "hr.payroll.prepare",
      input: { periodLabel: m[1].trim() },
      summary: `Prepare payroll for ${m[1].trim()}`,
      specialist: "hr",
    };
  }

  m = trimmed.match(
    /create\s+(?:invoice|bill)\s+(\S+)(?:\s+for\s+([\d.]+))?(?:\s+([A-Z]{3}))?$/i,
  );
  if (m?.[1]) {
    return {
      command: "acc.invoice.create",
      input: {
        number: m[1],
        total: m[2] ? Number(m[2]) : 0,
        currency: m[3] ?? "USD",
      },
      summary: `Create invoice ${m[1]}`,
      specialist: "accounting",
    };
  }

  m = trimmed.match(/create\s+vendor\s+(.+)$/i);
  if (m?.[1]) {
    return {
      command: "pur.vendor.create",
      input: { name: m[1].trim() },
      summary: `Create vendor ${m[1].trim()}`,
      specialist: "purchasing",
    };
  }

  m = trimmed.match(/create\s+product\s+(\S+)\s+(.+)$/i);
  if (m?.[1] && m[2]) {
    return {
      command: "inv.product.create",
      input: { sku: m[1], name: m[2].trim() },
      summary: `Create product ${m[1]}`,
      specialist: "inventory",
    };
  }

  m = trimmed.match(/create\s+employee\s+(\S+)\s+(.+)$/i);
  if (m?.[1] && m[2]) {
    return {
      command: "hr.employee.create",
      input: { employeeNumber: m[1], fullName: m[2].trim() },
      summary: `Create employee ${m[2].trim()}`,
      specialist: "hr",
    };
  }

  return null;
}

export async function handleChatTurn(
  deps: OrchestratorDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  const session = {
    ...input.session,
    messages: [...input.session.messages],
  };

  if (input.cancelId && session.pending?.id === input.cancelId) {
    session.pending = undefined;
    session.messages.push(
      msg("assistant", [{ type: "text", text: "Cancelled. No changes were made." }]),
    );
    return { session };
  }

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
        { type: "text", text: `Done. Executed \`${pending.command}\`.` },
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
  let planned = planFromText(input.userText);

  // Optional LLM assist when rules miss (provider may be none)
  if (!planned && deps.provider && deps.provider.id !== "none") {
    try {
      const toolList = catalog.map((c) => c.name).join(", ");
      const completion = await deps.provider.complete({
        system: `You map user requests to a single JSON action: {"command":"...","input":{...}} using only: ${toolList}. Reply JSON only.`,
        user: input.userText,
      });
      const jsonMatch = completion.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { command?: string; input?: Record<string, unknown> };
        if (parsed.command && catalog.some((c) => c.name === parsed.command)) {
          planned = {
            command: parsed.command,
            input: parsed.input ?? {},
            summary: `LLM-planned ${parsed.command}`,
            specialist: catalog.find((c) => c.name === parsed.command)?.tags?.[0],
          };
        }
      }
    } catch {
      // fall through to Mastra agent or help text
    }
  }

  // Mastra agent fallback — for complex or multi-step intents
  if (!planned && deps.mastraAgent) {
    try {
      const toolList = catalog.map((c) => `${c.name} — ${c.description ?? c.name}`).join("\n");
      const completion = await deps.mastraAgent.generate(
        `The user said: "${input.userText}"\n\n` +
        `Available commands:\n${toolList}\n\n` +
        `Respond with a JSON object: {"command":"<command.name>","input":{...}} or {"clarify":"<question>"}`,
      );
      const responseText = typeof completion === "string" ? completion : completion?.text ?? "";

      // Check if agent wants to clarify
      const clarifyMatch = responseText.match(/\{"clarify"\s*:\s*"([^"]+)"\}/);
      if (clarifyMatch?.[1]) {
        session.messages.push(msg("assistant", [{ type: "text", text: clarifyMatch[1] }]));
        return { session };
      }

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { command?: string; input?: Record<string, unknown> };
        if (parsed.command && catalog.some((c) => c.name === parsed.command)) {
          planned = {
            command: parsed.command,
            input: parsed.input ?? {},
            summary: `Mastra-planned ${parsed.command}`,
            specialist: catalog.find((c) => c.name === parsed.command)?.tags?.[0],
          };
        }
      }
    } catch {
      // fall through to help text
    }
  }

  if (!planned) {
    session.messages.push(
      msg("assistant", [
        {
          type: "text",
          text:
            "I can prepare validated business actions. Examples:\n" +
            "• Create customer Acme Ltd in Nairobi\n" +
            "• Create invoice INV-1001 for 250.00 USD\n" +
            "• Create vendor Contoso Supplies\n" +
            "• Create product SKU-1 Widget\n" +
            "• Create employee E-100 Jane Doe\n" +
            "• Prepare payroll for March 2026",
        },
        {
          type: "explanation",
          summary: "No structured intent matched.",
          reasons: ["Rule parser and optional LLM did not produce a valid command"],
          rulesApplied: ["intent_validation"],
          dataUsed: ["user message", "command catalog", `provider:${deps.provider?.id ?? "none"}`],
        },
      ]),
    );
    return { session };
  }

  const meta = catalog.find((c) => c.name === planned!.command) as CommandMeta | undefined;
  if (!meta) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: `Command ${planned.command} is not available (module not loaded).`,
          code: "MODULE_MISSING",
        },
      ]),
    );
    return { session };
  }

  const effective = stricterAutonomy(deps.autonomy, deps.autonomy);
  const runId = crypto.randomUUID();

  const explanation: AiExplanation = {
    runId,
    summary: planned.summary,
    reasons: [
      "Matched business intent",
      planned.specialist ? `Specialist tag: ${planned.specialist}` : "General routing",
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
    plannedCommand: planned.command,
    plannedInput: planned.input,
  };

  if (effective === "full_autonomous" && deps.allowFullAutonomous === false) {
    session.messages.push(
      msg("assistant", [
        {
          type: "error",
          message: "Full autonomous mode is not enabled on this platform.",
          code: "AUTONOMY_DISABLED",
        },
        {
          type: "text",
          text: FULL_AUTONOMOUS_WARNING,
        },
      ]),
    );
    return { session };
  }

  if (canAutoExecute(effective)) {
    const aiCtx: RequestContext = {
      ...input.ctx,
      actor: { ...input.ctx.actor, kind: "ai_assisted", aiRunId: runId },
    };
    const result = await executeCommand(
      deps.commands,
      planned.command,
      planned.input,
      aiCtx,
      deps.helpers,
    );
    const parts: UiPart[] = [
      { type: "text", text: `Executed automatically (autonomy=${effective}).` },
      toExplanationPart(explanation),
    ];
    if (effective === "full_autonomous") {
      parts.push({ type: "text", text: FULL_AUTONOMOUS_WARNING });
    }
    parts.push({
      type: "table",
      columns: [
        { key: "field", label: "Field" },
        { key: "value", label: "Value" },
      ],
      rows: Object.entries(result.data as Record<string, unknown>).map(([field, value]) => ({
        field,
        value: String(value ?? ""),
      })),
    });
    session.messages.push(msg("assistant", parts));
    return { session, explanation };
  }

  const confirmId = crypto.randomUUID();
  session.pending = {
    id: confirmId,
    command: planned.command,
    input: planned.input,
    createdAt: new Date().toISOString(),
  };

  const recommendOnly = effective === "recommend";
  session.messages.push(
    msg("assistant", [
      {
        type: "text",
        text: recommendOnly
          ? "Recommendation only (autonomy=recommend). Raise autonomy to confirm or auto-execute."
          : "Prepared a validated action. Confirm to run it through the same business command as the manual UI.",
      },
      toExplanationPart(explanation),
      {
        type: "confirm_action",
        id: confirmId,
        title: planned.summary,
        description: `${planned.command}`,
        command: planned.command,
        input: planned.input,
        confirmLabel: recommendOnly ? "Disabled" : "Confirm",
        cancelLabel: "Cancel",
      },
    ]),
  );

  return { session, explanation };
}
