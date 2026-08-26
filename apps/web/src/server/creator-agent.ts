import { execFile } from "node:child_process";

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
 * Known agentic coding CLIs that can drive Creator mode. Detection is
 * read-only: we look for the binary and ask its version, nothing more.
 * The user always runs installs themselves — the wizard only hands them
 * the command — so the web app never executes package-manager writes.
 */
const CANDIDATES: AgentCandidate[] = [
  {
    cli: "claude",
    label: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    authNote: "Run `claude` once in a terminal and sign in with your Anthropic account.",
  },
  {
    cli: "codex",
    label: "OpenAI Codex CLI",
    install: "npm install -g @openai/codex",
    authNote: "Run `codex` once in a terminal and sign in with your ChatGPT account.",
  },
  {
    cli: "gemini",
    label: "Gemini CLI",
    install: "npm install -g @google/gemini-cli",
    authNote: "Run `gemini` once in a terminal and sign in with your Google account.",
  },
];

export interface DetectedAgent {
  installed: boolean;
  cli: string | null;
  label: string | null;
  version: string | null;
  candidates: AgentCandidate[];
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function probe(cli: string): Promise<{ found: boolean; version: string | null }> {
  // `command -v` through sh resolves PATH without spawning the tool blindly.
  const path = await run("sh", ["-c", `command -v ${JSON.stringify(cli)} 2>/dev/null`], 3000);
  if (!path) return { found: false, version: null };
  const version = await run(cli, ["--version"], 5000);
  return { found: true, version: version?.split("\n")[0] ?? null };
}

/** Detects the first installed coding-agent CLI, probing candidates in order. */
export async function detectCodingAgent(): Promise<DetectedAgent> {
  for (const c of CANDIDATES) {
    const { found, version } = await probe(c.cli);
    if (found) {
      return { installed: true, cli: c.cli, label: c.label, version, candidates: CANDIDATES };
    }
  }
  return { installed: false, cli: null, label: null, version: null, candidates: CANDIDATES };
}
