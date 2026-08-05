import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  createLocalStore,
  createMemoryStore,
  createNullStore,
  createObjectStore,
  decryptBackup,
  encryptBackup,
  manifestChecksum,
  objectStoreStatus,
} from "./backup.js";

const originalEnv = { ...process.env };

function applyEnv(next: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CHASTE_")) delete process.env[key];
  }
  Object.assign(process.env, next);
}

const KEY = "a".repeat(64); // 32 bytes hex

beforeEach(() => {
  applyEnv({ CHASTE_BACKUP_KEY: KEY });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("AES-256-GCM encryption", () => {
  it("round-trips a manifest", () => {
    const plain = JSON.stringify({ hello: "world", n: 42 });
    const blob = encryptBackup(plain);
    expect(decryptBackup(blob)).toBe(plain);
  });

  it("produces a non-deterministic ciphertext (fresh nonce)", () => {
    const a = encryptBackup("same input");
    const b = encryptBackup("same input");
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects a blob encrypted with a different key", () => {
    const blob = encryptBackup("secret");
    applyEnv({ CHASTE_BACKUP_KEY: "b".repeat(64) });
    expect(() => decryptBackup(blob)).toThrow(/different key/);
  });

  it("rejects tampered ciphertext (auth tag check)", () => {
    const blob = encryptBackup("integrity matters");
    const tampered = { ...blob, ct: blob.ct.slice(0, -2) + (blob.ct.endsWith("00") ? "ff" : "00") };
    expect(() => decryptBackup(tampered)).toThrow();
  });

  it("requires a 32-byte hex key", () => {
    applyEnv({ CHASTE_BACKUP_KEY: "tooshort" });
    expect(() => encryptBackup("x")).toThrow(/32-byte hex/);
  });
});

describe("manifest", () => {
  it("builds a versioned manifest and a stable checksum", () => {
    const m = buildManifest("org-1", { users: [{ id: "u1" }] }, "2026-01-01T00:00:00Z");
    expect(m.schema).toBe("chaste-backup.v1");
    expect(m.organizationId).toBe("org-1");
    expect(manifestChecksum(m)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("object stores", () => {
  it("memory store round-trips and reports missing keys", async () => {
    const store = createMemoryStore();
    await store.put("k/v1", "payload");
    expect(await store.get("k/v1")).toBe("payload");
    await expect(store.get("k/nope")).rejects.toThrow(/not found/);
  });

  it("local store persists to disk and reads back", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "chaste-backup-"));
    const store = createLocalStore(dir);
    await store.put("orgs/org-1/backups/b.json.enc", "blobdata");
    expect(await store.get("orgs/org-1/backups/b.json.enc")).toBe("blobdata");
  });

  it("null store fails with a clear configuration error", async () => {
    const store = createNullStore();
    await expect(store.put("k", "v")).rejects.toThrow(/object store configured/);
    await expect(store.get("k")).rejects.toThrow(/object store configured/);
  });

  it("env-driven selection: s3 > local > none", () => {
    applyEnv({ CHASTE_S3_BUCKET: "b", CHASTE_S3_ACCESS_KEY_ID: "a", CHASTE_S3_SECRET_ACCESS_KEY: "s" });
    expect(createObjectStore().id).toBe("s3");

    applyEnv({ CHASTE_BACKUP_DIR: "/tmp/x" });
    expect(createObjectStore().id).toBe("local");

    applyEnv({});
    expect(createObjectStore().id).toBe("none");
  });

  it("provider status reports provider + encryption config, never secrets", () => {
    applyEnv({
      CHASTE_S3_BUCKET: "b",
      CHASTE_S3_ACCESS_KEY_ID: "a",
      CHASTE_S3_SECRET_ACCESS_KEY: "secret-value",
      CHASTE_BACKUP_KEY: KEY,
    });
    const status = objectStoreStatus();
    expect(status.provider).toBe("s3");
    expect(status.encryptionConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret-value");
  });
});