import { z } from "zod";

/**
 * Deterministic, model-facing schema text for a Zod contract (doc §Tool
 * Surface Optimization: every tool has a strict input schema and a canonical
 * output schema).
 *
 * This is a *faithful summary* of the Zod shape for the model prompt — the
 * boundary validation still uses the real Zod schema in the kernel, so the
 * text can never widen or loosen the contract. Output is a compact annotated
 * JSON value with deterministic key ordering so repeated renders are stable.
 */

type SchemaNode =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SchemaNode }
  | SchemaNode[];

const DEPTH_LIMIT = 12;

function render(schema: z.ZodType, depth: number): SchemaNode {
  if (depth > DEPTH_LIMIT) return "any";

  if (schema instanceof z.ZodDefault) {
    const inner = (schema as z.ZodDefault<z.ZodType>)._def.innerType;
    return inner ? render(inner as z.ZodType, depth + 1) : "any";
  }
  if (schema instanceof z.ZodEffects) {
    return render(schema.innerType() as z.ZodType, depth + 1);
  }

  if (schema instanceof z.ZodOptional) {
    const inner = (schema as z.ZodOptional<z.ZodType>)._def.innerType;
    return `${render(inner, depth + 1)}?`;
  }
  if (schema instanceof z.ZodNullable) {
    const inner = (schema as z.ZodNullable<z.ZodType>)._def.innerType;
    return `${render(inner, depth + 1)}?`;
  }

  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const out: { [key: string]: SchemaNode } = {};
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      out[key] = field ? render(field as z.ZodType, depth + 1) : "any";
    }
    return out;
  }

  if (schema instanceof z.ZodArray) {
    const el = (schema as z.ZodArray<z.ZodType>).element;
    return [render(el, depth + 1)];
  }

  if (schema instanceof z.ZodUnion) {
    const opts = (schema as z.ZodUnion<readonly [z.ZodType, ...z.ZodType[]]>).options;
    return `union(${opts.map((o) => render(o, depth + 1)).join("|")})`;
  }

  if (schema instanceof z.ZodRecord) {
    const value = (schema as z.ZodRecord)._def.valueType;
    return { "[key: string]": render(value, depth + 1) };
  }

  if (schema instanceof z.ZodEnum) {
    return `enum(${schema.options.join("|")})`;
  }

  if (schema instanceof z.ZodLiteral) {
    return `literal(${JSON.stringify((schema as z.ZodLiteral<unknown>).value)})`;
  }

  if (schema instanceof z.ZodNumber) {
    return (schema as z.ZodNumber)._def.checks.some((c) => c.kind === "int")
      ? "integer"
      : "number";
  }

  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodDate) return "date";
  if (schema instanceof z.ZodBigInt) return "bigint";

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) return "any";

  return "any";
}

/** Render a Zod schema as a compact, deterministic JSON text value. */
export function zodToSchemaText(schema: z.ZodType): string {
  return JSON.stringify(render(schema, 0));
}