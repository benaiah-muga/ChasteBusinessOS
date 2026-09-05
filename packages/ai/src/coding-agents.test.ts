import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCodingAgents } from "./coding-agents";

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

async function makeFixture(): Promise<{ home: string; binDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "chaste-agents-"));
  cleanup = () => rm(base, { recursive: true, force: true });
  const home = path.join(base, "home");
  const binDir = path.join(base, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(binDir, { recursive: true });
  return { home, binDir };
}

async function fakeBin(binDir: string, name: string, versionLine: string): Promise<void> {
  const p = path.join(binDir, name);
  await writeFile(p, `#!/bin/sh\necho "${versionLine}"\n`);
  await chmod(p, 0o755);
}

describe("detectCodingAgents", () => {
  it("detects a binary on PATH and reports its version", async () => {
    const { home, binDir } = await makeFixture();
    await fakeBin(binDir, "claude", "Claude Code 2.1.0");
    const found = await detectCodingAgents({ home, pathEnv: binDir });
    const claude = found.find((a) => a.id === "claude-code");
    expect(claude).toBeTruthy();
    expect(claude!.binPath).toBe(path.join(binDir, "claude"));
    expect(claude!.version).toBe("Claude Code 2.1.0");
  });

  it("detects a config dir without a binary and leaves binPath null", async () => {
    const { home, binDir } = await makeFixture();
    await mkdir(path.join(home, ".kilocode"), { recursive: true });
    const found = await detectCodingAgents({ home, pathEnv: binDir });
    const kilo = found.find((a) => a.id === "kilocode");
    expect(kilo).toBeTruthy();
    expect(kilo!.binPath).toBeNull();
    expect(kilo!.configPaths).toEqual([path.join(home, ".kilocode")]);
    expect(kilo!.version).toBeNull();
  });

  it("does not report absent agents", async () => {
    const { home, binDir } = await makeFixture();
    const found = await detectCodingAgents({ home, pathEnv: binDir });
    expect(found.find((a) => a.id === "aider")).toBeUndefined();
    expect(found.find((a) => a.id === "opencode")).toBeUndefined();
  });

  it("finds aider through its real config files (regression: glob dir never matched)", async () => {
    const { home, binDir } = await makeFixture();
    await writeFile(path.join(home, ".aider.conf.yml"), "model: x\n");
    const found = await detectCodingAgents({ home, pathEnv: binDir });
    expect(found.find((a) => a.id === "aider")).toBeTruthy();
  });

  it("skips version probing when versions=false", async () => {
    const { home, binDir } = await makeFixture();
    await fakeBin(binDir, "codex", "codex 1.0");
    const found = await detectCodingAgents({ home, pathEnv: binDir, versions: false });
    expect(found.find((a) => a.id === "codex")!.version).toBeNull();
  });

  it("does not leak the real home into the scan", async () => {
    const { home, binDir } = await makeFixture();
    const found = await detectCodingAgents({ home, pathEnv: binDir });
    for (const a of found) {
      for (const p of a.configPaths) expect(p.startsWith(home)).toBe(true);
    }
  });
});
