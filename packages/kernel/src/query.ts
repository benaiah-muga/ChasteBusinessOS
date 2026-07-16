import { z } from "zod";
import type { RequestContext } from "./context.js";
import { actorHasPermission } from "./context.js";
import { NotFoundError, PermissionError, ValidationError } from "./errors.js";

export interface QueryMeta {
  name: string;
  description?: string;
  permissions: string[];
  tags?: string[];
}

export interface QueryDefinition<TIn extends z.ZodType, TOut extends z.ZodType> extends QueryMeta {
  input: TIn;
  output: TOut;
  handler: (input: z.infer<TIn>, ctx: RequestContext) => Promise<z.infer<TOut>>;
}

export interface QueryRegistry {
  register<TIn extends z.ZodType, TOut extends z.ZodType>(def: QueryDefinition<TIn, TOut>): void;
  get(name: string): QueryDefinition<z.ZodType, z.ZodType> | undefined;
  list(): QueryMeta[];
}

export function createQueryRegistry(): QueryRegistry {
  const map = new Map<string, QueryDefinition<z.ZodType, z.ZodType>>();

  return {
    register(def) {
      if (map.has(def.name)) {
        throw new Error(`Query already registered: ${def.name}`);
      }
      map.set(def.name, def as unknown as QueryDefinition<z.ZodType, z.ZodType>);
    },
    get(name) {
      return map.get(name);
    },
    list() {
      return [...map.values()].map(({ name, description, permissions, tags }) => ({
        name,
        description,
        permissions,
        tags,
      }));
    },
  };
}

export function defineQuery<TIn extends z.ZodType, TOut extends z.ZodType>(
  def: QueryDefinition<TIn, TOut>,
): QueryDefinition<TIn, TOut> {
  return def;
}

export async function executeQuery<T = unknown>(
  registry: QueryRegistry,
  name: string,
  rawInput: unknown,
  ctx: RequestContext,
): Promise<{ ok: true; data: T; query: string; requestId: string }> {
  const def = registry.get(name);
  if (!def) {
    throw new NotFoundError(`Query ${name}`);
  }

  for (const permission of def.permissions) {
    if (!actorHasPermission(ctx.actor, permission)) {
      throw new PermissionError(permission);
    }
  }

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(`Invalid input for ${name}`, parsed.error.flatten());
  }

  const data = await def.handler(parsed.data, ctx);
  const out = def.output.safeParse(data);
  if (!out.success) {
    throw new ValidationError(`Invalid output for ${name}`, out.error.flatten());
  }

  return {
    ok: true,
    data: out.data as T,
    query: name,
    requestId: ctx.requestId,
  };
}
