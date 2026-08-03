import { z } from "zod";
import type { AuditWriter } from "./audit.js";
import type { RequestContext } from "./context.js";
import { actorHasPermission } from "./context.js";
import { NotFoundError, PermissionError, ValidationError } from "./errors.js";
import type { OutboxWriter } from "./events.js";
import type { RiskClass } from "./risk.js";

export interface CommandMeta {
  name: string;
  description?: string;
  permissions: string[];
  /** Tags for AI specialist routing, e.g. ["crm"] */
  tags?: string[];
  /** Minimum autonomy required to auto-run without confirm UI */
  minAutonomyForAuto?: "guarded_auto" | "full_autonomous";
  /**
   * Declared side-effect class of this command. Used by the autonomy gate
   * (orchestrator) and the Inbox store. When omitted, defaults are inferred:
   * commands → `write_local`, queries → `read`. Modules should declare
   * `external` for any command whose side effects leave the platform entirely
   * (email, Slack, payment gateway, …).
   */
  riskClass?: RiskClass;
  /**
   * When `riskClass: "external"`, the human-oriented name of the input field
   * that carries the off-platform recipient/target (e.g. `"channel"` for a
   * Slack send). The orchestrator's standing-rule resolver reads this so
   * "allow always" binds to the *target*, not the whole command.
   */
  externalTargetField?: string;
}

export interface CommandDefinition<TIn extends z.ZodType, TOut extends z.ZodType>
  extends CommandMeta {
  input: TIn;
  output: TOut;
  handler: (
    input: z.infer<TIn>,
    ctx: RequestContext,
    helpers: CommandHelpers,
  ) => Promise<z.infer<TOut>>;
}

export interface CommandHelpers {
  audit: AuditWriter;
  outbox: OutboxWriter;
}

export interface CommandRegistry {
  register<TIn extends z.ZodType, TOut extends z.ZodType>(
    def: CommandDefinition<TIn, TOut>,
  ): void;
  get(name: string): CommandDefinition<z.ZodType, z.ZodType> | undefined;
  list(): CommandMeta[];
}

export function createCommandRegistry(): CommandRegistry {
  const map = new Map<string, CommandDefinition<z.ZodType, z.ZodType>>();

  return {
    register(def) {
      if (map.has(def.name)) {
        throw new Error(`Command already registered: ${def.name}`);
      }
      map.set(def.name, def as unknown as CommandDefinition<z.ZodType, z.ZodType>);
    },
    get(name) {
      return map.get(name);
    },
    list() {
      return [...map.values()].map(
        ({ name, description, permissions, tags, minAutonomyForAuto, riskClass, externalTargetField }) => ({
          name,
          description,
          permissions,
          tags,
          minAutonomyForAuto,
          riskClass,
          externalTargetField,
        }),
      );
    },
  };
}

export function defineCommand<TIn extends z.ZodType, TOut extends z.ZodType>(
  def: CommandDefinition<TIn, TOut>,
): CommandDefinition<TIn, TOut> {
  return def;
}

export interface ExecuteCommandResult<T> {
  ok: true;
  data: T;
  command: string;
  requestId: string;
}

export async function executeCommand<T = unknown>(
  registry: CommandRegistry,
  name: string,
  rawInput: unknown,
  ctx: RequestContext,
  helpers: CommandHelpers,
): Promise<ExecuteCommandResult<T>> {
  const def = registry.get(name);
  if (!def) {
    throw new NotFoundError(`Command ${name}`);
  }

  for (const permission of def.permissions) {
    if (!actorHasPermission(ctx.actor, permission)) {
      await helpers.audit.write({
        id: crypto.randomUUID(),
        at: ctx.now().toISOString(),
        organizationId: ctx.actor.organizationId,
        actorUserId: ctx.actor.userId,
        actorKind: ctx.actor.kind,
        aiRunId: ctx.actor.aiRunId,
        action: name,
        success: false,
        requestId: ctx.requestId,
        inputSummary: rawInput,
        errorCode: "PERMISSION_DENIED",
        errorMessage: `Missing permission: ${permission}`,
      });
      throw new PermissionError(permission);
    }
  }

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    await helpers.audit.write({
      id: crypto.randomUUID(),
      at: ctx.now().toISOString(),
      organizationId: ctx.actor.organizationId,
      actorUserId: ctx.actor.userId,
      actorKind: ctx.actor.kind,
      aiRunId: ctx.actor.aiRunId,
      action: name,
      success: false,
      requestId: ctx.requestId,
      inputSummary: rawInput,
      errorCode: "VALIDATION_ERROR",
      errorMessage: parsed.error.message,
    });
    throw new ValidationError(`Invalid input for ${name}`, parsed.error.flatten());
  }

  try {
    const data = await def.handler(parsed.data, ctx, helpers);
    const out = def.output.safeParse(data);
    if (!out.success) {
      throw new ValidationError(`Invalid output for ${name}`, out.error.flatten());
    }

    await helpers.audit.write({
      id: crypto.randomUUID(),
      at: ctx.now().toISOString(),
      organizationId: ctx.actor.organizationId,
      actorUserId: ctx.actor.userId,
      actorKind: ctx.actor.kind,
      aiRunId: ctx.actor.aiRunId,
      action: name,
      success: true,
      requestId: ctx.requestId,
      inputSummary: parsed.data,
    });

    return {
      ok: true,
      data: out.data as T,
      command: name,
      requestId: ctx.requestId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error && "code" in err ? String((err as { code: string }).code) : "HANDLER_ERROR";
    await helpers.audit.write({
      id: crypto.randomUUID(),
      at: ctx.now().toISOString(),
      organizationId: ctx.actor.organizationId,
      actorUserId: ctx.actor.userId,
      actorKind: ctx.actor.kind,
      aiRunId: ctx.actor.aiRunId,
      action: name,
      success: false,
      requestId: ctx.requestId,
      inputSummary: parsed.data,
      errorCode: code,
      errorMessage: message,
    });
    throw err;
  }
}
