/**
 * Minimal .env loader for gate scripts (no dependency): exports KEY=VALUE
 * lines from the repo .env without ever overriding real process env.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export function loadRepoEnv(): void {
  let raw: string;
  try {
    // Gates run from the repo root (declared in the ledger CWD); tsx's
    // module transform does not reliably provide import.meta.dirname.
    raw = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadRepoEnv();
