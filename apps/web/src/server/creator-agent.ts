import os from "node:os";
import { detectCodingAgents, type DetectedCodingAgent } from "@chaste/ai";

export interface AgentCandidate {
  /** CLI binary name on PATH. */
  cli: string;
  label: string;
  /** Install command shown in the wizard. */
  install: string;
  /** Where authentication happens, when it must leave the app. */
  authNote: string;
}

/**
 * Install and auth guidance per known agent id. Detection itself lives in
 * @chaste/ai (single source of truth); this layer only knows how to present
 * what was found and how to help install what was not. The user always runs
 * installs themselves — the wizard only hands them the command — so the web
 * app never executes package-manager writes.
 */
const CANDIDATES: Record<string, AgentCandidate> = {
  "claude-code": {
    cli: "claude",
    label: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    authNote: "Run `claude` once in a terminal and sign in with your Anthropic account.",
  },
  codex: {
    cli: "codex",
    label: "OpenAI Codex CLI",
    install: "npm install -g @openai/codex",
    authNote: "Run `codex` once in a terminal and sign in with your ChatGPT account.",
  },
  "gemini-cli": {
    cli: "gemini",
    label: "Gemini CLI",
    install: "npm install -g @google/gemini-cli",
    authNote: "Run `gemini` once in a terminal and sign in with your Google account.",
  },
  opencode: {
    cli: "opencode",
    label: "OpenCode",
    install: "curl -fsSL https://opencode.ai/install | bash",
    authNote: "Run `opencode` once in a terminal and sign in with your provider account.",
  },
  kilocode: {
    cli: "kilo",
    label: "Kilo Code",
    install: "npm install -g @kilocode/cli",
    authNote: "Run `kilo` once in a terminal and sign in with your Kilo account.",
  },
  aider: {
    cli: "aider",
    label: "Aider",
    install: "python -m pip install aider-install && aider-install",
    authNote: "Export an ANTHROPIC_API_KEY or OPENAI_API_KEY, then run `aider`.",
  },
};

export interface DetectedAgent {
  installed: boolean;
  cli: string | null;
  label: string | null;
  version: string | null;
  /** Everything detected, best candidate first (binary beats config-only). */
  agents: Array<{
    id: string;
    label: string;
    version: string | null;
    viaBinary: boolean;
    configDirs: string[];
  }>;
  candidates: AgentCandidate[];
}

function labelFor(agent: DetectedCodingAgent): string {
  return CANDIDATES[agent.id]?.label ?? agent.displayName;
}

/** Detects installed coding-agent CLIs, probing versions of found binaries. */
export async function detectCodingAgent(): Promise<DetectedAgent> {
  const found = await detectCodingAgents();
  // A binary on PATH is the usable candidate; config-only hits mean the tool
  // was installed before but is not callable right now.
  const ranked = [...found].sort((a, b) => Number(b.binPath !== null) - Number(a.binPath !== null));
  const best = ranked[0];
  return {
    installed: Boolean(best?.binPath),
    cli: best?.binPath ? (CANDIDATES[best.id]?.cli ?? best.binaries[0] ?? null) : null,
    label: best ? labelFor(best) : null,
    version: best?.binPath ? best.version : null,
    agents: ranked.map((a) => ({
      id: a.id,
      label: labelFor(a),
      version: a.version,
      viaBinary: Boolean(a.binPath),
      configDirs: a.configPaths.map((p) =>
        p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p,
      ),
    })),
    candidates: Object.values(CANDIDATES),
  };
}
