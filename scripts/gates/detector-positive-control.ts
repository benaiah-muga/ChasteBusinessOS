/**
 * Gate G5: coding-agent detector positive control.
 *
 * Part 1 (controlled fixture, offline): a temp home + fake PATH must yield
 * exact detections, proving config-dir and binary scanning both work.
 * Part 2 (this machine): detection must find at least one real agent,
 * proving the live PATH/home scan works outside fixtures.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectCodingAgents } from "@chaste/ai";

async function main(): Promise<void> {
  // ── Part 1: controlled fixture ──
  const base = await mkdtemp(path.join(tmpdir(), "chaste-g5-"));
  try {
    const home = path.join(base, "home");
    const binDir = path.join(base, "bin");
    await mkdir(home, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(home, ".kilocode"), { recursive: true });
    const fake = path.join(binDir, "claude");
    await writeFile(fake, "#!/bin/sh\necho 'claude 9.9.9 (fixture)'\n");
    await chmod(fake, 0o755);

    const found = await detectCodingAgents({ home, pathEnv: binDir });
    const claude = found.find((a) => a.id === "claude-code");
    const kilo = found.find((a) => a.id === "kilocode");
    if (!claude || claude.binPath !== fake || claude.version !== "claude 9.9.9 (fixture)") {
      throw new Error(`fixture binary detection failed: ${JSON.stringify(claude)}`);
    }
    if (!kilo || kilo.binPath !== null || kilo.configPaths.length !== 1) {
      throw new Error(`fixture config-dir detection failed: ${JSON.stringify(kilo)}`);
    }
    if (found.find((a) => a.id === "aider")) {
      throw new Error("absent agent was reported");
    }
    console.log(`[G5] fixture OK: ${found.map((a) => a.id).join(", ")}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  // ── Part 2: this machine ──
  const live = await detectCodingAgents({ versions: false });
  if (live.length === 0) {
    throw new Error("no coding agents detected on this machine; expected at least one");
  }
  console.log(`[G5] live OK: ${live.map((a) => `${a.id}${a.binPath ? " (bin)" : " (cfg)"}`).join(", ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
