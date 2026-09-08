import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodingAgent {
  id: string;
  displayName: string;
  binaries: string[];
  configDirs: string[];
}

export interface DetectedCodingAgent extends CodingAgent {
  /** Absolute path of the first binary found on PATH, when any. */
  binPath: string | null;
  /** Config dirs that exist under the given home, when any. */
  configPaths: string[];
  /** First line of `<bin> --version`, when a binary answered. */
  version: string | null;
}

/**
 * Known agentic coding CLIs. Detection is read-only: we look for the binary
 * on PATH and for each tool's config directory under the user's home.
 */
const KNOWN: CodingAgent[] = [
  { id: "opencode", displayName: "OpenCode", binaries: ["opencode"], configDirs: [".config/opencode"] },
  { id: "claude-code", displayName: "Claude Code", binaries: ["claude"], configDirs: [".claude"] },
  { id: "codex", displayName: "Codex CLI", binaries: ["codex"], configDirs: [".codex"] },
  { id: "kilocode", displayName: "Kilo Code", binaries: ["kilo", "kilocode"], configDirs: [".kilocode", ".config/kilo"] },
  // Aider has no stable single config dir; probe the files it actually creates.
  { id: "aider", displayName: "Aider", binaries: ["aider"], configDirs: [".aider", ".aider.conf.yml", ".aider.tags.yml", ".aider.chat.history"] },
  { id: "gemini-cli", displayName: "Gemini CLI", binaries: ["gemini"], configDirs: [".gemini"] },
];

const VERSION_TIMEOUT_MS = 5000;

/**
 * Native PATH scan instead of `which`: spawning `which` with an overridden
 * PATH resolves `which` itself through the child env and fails with ENOENT.
 * This also keeps detection portable and side-effect free.
 */
async function which(bin: string, pathEnv?: string): Promise<string | null> {
  const dirs = (pathEnv ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin, process.platform === "win32" ? ".exe" : "");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function probeVersion(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binPath, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim().split("\n")[0] ?? "";
      resolve(line || null);
    });
  });
}

export interface DetectOptions {
  /** Home directory to scan for config dirs; defaults to os.homedir(). */
  home?: string;
  /** Override PATH for binary lookup (tests use a fixture dir of fakes). */
  pathEnv?: string;
  /** Probe `<bin> --version` for detected binaries; default true. */
  versions?: boolean;
}

/**
 * Detects installed coding agents on this machine. An agent is detected when
 * a binary is on PATH or a config dir exists; both facts are reported so the
 * UI can distinguish "installed CLI" from "has config/auth but not on PATH".
 */
export async function detectCodingAgents(opts: DetectOptions = {}): Promise<DetectedCodingAgent[]> {
  const home = opts.home ?? os.homedir();
  const wantVersions = opts.versions ?? true;
  const found = await Promise.all(
    KNOWN.map(async (agent): Promise<DetectedCodingAgent | null> => {
      let binPath: string | null = null;
      for (const bin of agent.binaries) {
        const hit = await which(bin, opts.pathEnv);
        if (hit) {
          binPath = hit;
          break;
        }
      }
      const configPaths: string[] = [];
      for (const dir of agent.configDirs) {
        const full = path.join(home, dir);
        if (await dirExists(full)) configPaths.push(full);
      }
      if (!binPath && configPaths.length === 0) return null;
      const version = binPath && wantVersions ? await probeVersion(binPath) : null;
      return { ...agent, binPath, configPaths, version };
    }),
  );
  return found.filter((a): a is DetectedCodingAgent => a !== null);
}
