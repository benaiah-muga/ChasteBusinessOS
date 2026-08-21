import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CodingAgent {
  id: string;
  displayName: string;
  binaries: string[];
  configDirs: string[];
}

const KNOWN: CodingAgent[] = [
  { id: "opencode", displayName: "OpenCode", binaries: ["opencode"], configDirs: [".config/opencode"] },
  { id: "claude-code", displayName: "Claude Code", binaries: ["claude"], configDirs: [".claude"] },
  { id: "codex", displayName: "Codex CLI", binaries: ["codex"], configDirs: [".codex"] },
  { id: "kilocode", displayName: "Kilo Code", binaries: ["kilo"], configDirs: [".kilocode"] },
  { id: "aider", displayName: "Aider", binaries: ["aider"], configDirs: [".aider*"] },
  { id: "gemini-cli", displayName: "Gemini CLI", binaries: ["gemini"], configDirs: [".gemini"] },
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await run("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectCodingAgents(home = os.homedir()): Promise<CodingAgent[]> {
  const found = await Promise.all(
    KNOWN.map(async (agent) => {
      const binHits = (await Promise.all(agent.binaries.map(which))).filter(Boolean) as string[];
      const cfgHits = (
        await Promise.all(
          agent.configDirs.map((d) => dirExists(path.join(home, d)).then((ok) => (ok ? path.join(home, d) : null))),
        )
      ).filter(Boolean) as string[];
      if (binHits.length === 0 && cfgHits.length === 0) return null;
      return agent;
    }),
  );
  return found.filter((a): a is CodingAgent => a !== null);
}
