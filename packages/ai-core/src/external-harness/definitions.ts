import type { HarnessDefinition } from "./types.js";

/** The four supported external harnesses (research doc §External Harness
 * Adapters). These are declarative integration contracts: the platform exposes
 * them, records their runs on the Chaste trajectory, and mediates every tool
 * call — the actual external process is spawned by the caller through the
 * connector. */
export const EXTERNAL_HARNESS_DEFINITIONS: HarnessDefinition[] = [
  {
    id: "codex",
    kind: "codex",
    name: "Codex CLI",
    description:
      "OpenAI Codex as an MCP server for software-development workflows: connector implementation, test generation, migration scripts, docs automation, multi-agent engineering.",
    connector: "MCP server (Codex CLI)",
    recordsProviderModel: true,
    supportsArtifacts: true,
    integrationNotes: [
      "Run Codex CLI as an MCP server for developer workflows.",
      "Use Codex skills for repeatable engineering operations; map them to Chaste skill packages where portable.",
      "Capture trace/artifacts and convert useful failures into Chaste evals.",
      "Never use Codex as a direct ERP business operator — it goes through the same Chaste MCP/command tools as every other harness.",
    ],
  },
  {
    id: "claude-code",
    kind: "claude-code",
    name: "Claude Code",
    description:
      "Claude Agent SDK programmable runs for code generation, connector development, report templates, and workflow simulation, with subagent-style isolated analysis.",
    connector: "Claude Agent SDK (programmable runs)",
    recordsProviderModel: true,
    supportsArtifacts: true,
    integrationNotes: [
      "Use Claude Agent SDK for programmable runs.",
      "Configure subagents with tool restrictions, spend caps, and output schemas.",
      "Use hooks as deterministic checkpoints, but keep Chaste policy as final authority.",
      "Map Claude skills to Chaste internal skill packages where portable.",
    ],
  },
  {
    id: "opencode",
    kind: "opencode",
    name: "opencode",
    description:
      "Model/harness gateway for cost-sensitive technical automation, local/open model experimentation, and provider comparison across many configured LLM providers.",
    connector: "opencode (model/harness gateway)",
    recordsProviderModel: true,
    supportsArtifacts: false,
    integrationNotes: [
      "Treat opencode as a model/harness gateway for developer tasks.",
      "Use its provider/model configuration for technical runs, but require Chaste to record selected provider/model where available.",
      "Expose Chaste business APIs only through scoped MCP tools.",
    ],
  },
  {
    id: "deepseek-harness",
    kind: "deepseek-harness",
    name: "DeepSeek Harness",
    description:
      "Plugin-first Cordis runtime for long-horizon technical automation, plugin-style experiments, complex tool orchestration with trace/fork/replay, and benchmarking model/harness combinations.",
    connector: "MCP or thin tool provider (isolated worker/service)",
    recordsProviderModel: true,
    supportsArtifacts: true,
    integrationNotes: [
      "Run DeepSeek Harness as an isolated worker or service profile.",
      "Expose Chaste capabilities through MCP or a thin tool provider that calls Chaste APIs.",
      "Map DeepSeek session events to Chaste externalHarness/* trajectory events.",
      "Creator-like mode is for internal platform developers only, never ordinary business users.",
    ],
  },
];

export function harnessDefinitionFor(
  idOrKind: string,
): HarnessDefinition | undefined {
  return EXTERNAL_HARNESS_DEFINITIONS.find(
    (d) => d.id === idOrKind || d.kind === idOrKind,
  );
}
