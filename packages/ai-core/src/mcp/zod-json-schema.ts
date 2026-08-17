import { z } from "zod";

/**
 * Deterministic Zod → JSON Schema (draft-07 subset) projection for MCP
 * `inputSchema`. The projection is presentation only — the execution pipeline
 * still validates arguments against the real Zod contract at the bus boundary,
 * so this can never widen or loosen the actual schema.
 */

export type JsonSchema = Record<string, unknown>;

const DEPTH_LIMIT = 16;

function innerOf(schema: z.ZodType): z.ZodType {
  const def = (schema as { _def?: { innerType?: z.ZodType } })._def;
  return def?.innerType ?? schema;
}

export function zodToJsonSchema(schema: z.ZodType, depth = 0): JsonSchema {
  if (depth > DEPTH_LIMIT) return {};

  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(innerOf(schema), depth + 1);
  }
  if (schema instanceof z.ZodEffects) {
    return zodToJsonSchema(innerOf(schema), depth + 1);
  }
  if (schema instanceof z.ZodOptional) {
    return { ...zodToJsonSchema(innerOf(schema), depth + 1) };
  }
  if (schema instanceof z.ZodNullable) {
    return { ...zodToJsonSchema(innerOf(schema), depth + 1), nullable: true };
  }

  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key] as z.ZodType | undefined;
      if (!field) continue;
      const optional = field instanceof z.ZodOptional || field instanceof z.ZodDefault;
      properties[key] = zodToJsonSchema(field, depth + 1);
      if (!optional) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
  }
  if (schema instanceof z.ZodArray) {
    const element = (schema as z.ZodArray<z.ZodType>).element;
    return { type: "array", items: zodToJsonSchema(element, depth + 1) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...(schema as z.ZodEnum<[string, ...string[]]>)._def.values] };
  }
  if (schema instanceof z.ZodNativeEnum) {
    return { enum: Object.values((schema as z.ZodNativeEnum<Record<string, string>>)._def.values) };
  }
  if (schema instanceof z.ZodLiteral) {
    return { const: (schema as z.ZodLiteral<unknown>)._def.value };
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema as z.ZodUnion<readonly [z.ZodType, ...z.ZodType[]]>)._def.options;
    return { anyOf: options.map((o) => zodToJsonSchema(o, depth + 1)) };
  }
  if (schema instanceof z.ZodRecord) {
    const record = schema as unknown as { _def: { valueType: z.ZodType } };
    return {
      type: "object",
      additionalProperties: zodToJsonSchema(record._def.valueType, depth + 1),
    };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) return {};

  return {};
}