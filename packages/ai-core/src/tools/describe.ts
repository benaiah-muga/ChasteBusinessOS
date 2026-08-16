import type { z } from "zod";
import type { RiskClass } from "@chaste/kernel";
import { zodToSchemaText } from "./schema.js";
import type {
  BusinessToolDefinition,
  ToolAccess,
  ToolApprovalClass,
  ToolCostClass,
} from "./types.js";

/**
 * Model-facing tool surface (doc §Tool Surface Optimization): every tool is
 * described with its short description, strict input schema, canonical output
 * schema, risk class, approval class, read/write classification, idempotency,
 * expected latency and cost, and examples. Staged exposure is the caller's
 * concern — `describeToolSet` renders whatever subset the current stage picked.
 */

export interface DescribeToolOptions {
  includeSchema?: boolean;
  includeExamples?: boolean;
  /** When true, render only name + description (capability-directory view). */
  catalogOnly?: boolean;
  /** Risk class override for display when the tool does not declare one. */
  riskClass?: RiskClass;
}

function defaultRisk(tool: BusinessToolDefinition<z.ZodType, z.ZodType>, riskClass?: RiskClass): RiskClass {
  return riskClass ?? tool.risk ?? (tool.kind === "query" ? "read" : "write_local");
}

function defaultApproval(tool: BusinessToolDefinition<z.ZodType, z.ZodType>): ToolApprovalClass {
  if (tool.approvalClass) return tool.approvalClass;
  return defaultRisk(tool) === "read" ? "auto" : "review";
}

function defaultAccess(tool: BusinessToolDefinition<z.ZodType, z.ZodType>): ToolAccess {
  if (tool.access) return tool.access;
  const risk = defaultRisk(tool);
  if (risk === "external") return "external";
  if (risk === "read") return "read";
  return "write";
}

function defaultIdempotent(tool: BusinessToolDefinition<z.ZodType, z.ZodType>): boolean {
  return tool.idempotent ?? tool.kind === "query";
}

function defaultCost(tool: BusinessToolDefinition<z.ZodType, z.ZodType>): ToolCostClass {
  return tool.costClass ?? "standard";
}

/** Render one tool as a compact, stable text block for the model prompt. */
export function describeTool(
  tool: BusinessToolDefinition<z.ZodType, z.ZodType>,
  opts: DescribeToolOptions = {},
): string {
  if (opts.catalogOnly) {
    return `${tool.name}: ${tool.description}`;
  }

  const lines: string[] = [];
  lines.push(`## ${tool.name}`);
  lines.push(tool.description);
  lines.push(`- bus: ${tool.command} (${tool.kind ?? "command"})`);
  lines.push(`- risk: ${defaultRisk(tool, opts.riskClass)}`);
  lines.push(`- approval: ${defaultApproval(tool)}`);
  lines.push(`- access: ${defaultAccess(tool)}`);
  lines.push(`- idempotent: ${defaultIdempotent(tool) ? "yes" : "no"}`);
  lines.push(`- latency: ~${tool.expectedLatencyMs ?? "?"}ms, cost: ${defaultCost(tool)}`);
  if (opts.includeSchema !== false) {
    lines.push(`- input: ${zodToSchemaText(tool.input)}`);
    lines.push(`- output: ${zodToSchemaText(tool.output)}`);
  }
  if (opts.includeExamples !== false && tool.examples && tool.examples.length > 0) {
    for (const ex of tool.examples) {
      lines.push(
        `- ${ex.good ? "good" : "bad"} example: ${ex.summary} args=${JSON.stringify(ex.args)}`,
      );
    }
  }
  return lines.join("\n");
}

export interface DescribeToolSetOptions extends DescribeToolOptions {
  /** Emit the catalog-only one-liner surface instead of full descriptions. */
  catalog?: boolean;
  /** Never render more than this many tools per stage. */
  maxTools?: number;
}

/**
 * Render a set of tools as the model-facing tool surface. Use `catalog: true`
 * for Stage 1 (capability directories) and full descriptions for Stages 2–3.
 */
export function describeToolSet(
  tools: Array<BusinessToolDefinition<z.ZodType, z.ZodType>>,
  opts: DescribeToolSetOptions = {},
): string {
  const picked = opts.maxTools ? tools.slice(0, opts.maxTools) : tools;
  const blocks = picked.map((t) => describeTool(t, { ...opts, catalogOnly: opts.catalog }));
  if (blocks.length === 0) return "(no tools exposed)";
  return blocks.join("\n\n");
}