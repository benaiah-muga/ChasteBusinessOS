/**
 * Plugin distribution format for community capability packages.
 *
 * A plugin is a signed manifest: canonical JSON, hashed with SHA-256,
 * signed with the publisher's ed25519 key. Verification is pure and
 * dependency-free (node:crypto) so it can run at boot, at install, and in
 * CI without trusting the network or the registry.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { z } from "zod";

export const PLUGIN_MANIFEST_VERSION = 1;

export const pluginManifestSchema = z.object({
  formatVersion: z.literal(1),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab"),
  name: z.string().min(1).max(120),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "version must be semver x.y.z"),
  summary: z.string().min(10).max(500),
  /** Capability ids this package provides; must be module-qualified. */
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/))
    .min(1)
    .max(100),
  /** Risk classes declared per capability id; every capability must appear. */
  risks: z.record(z.string(), z.enum(["read", "write", "money", "identity", "destructive", "secret"])),
  homepage: z.string().url().optional(),
  license: z.string().default("Apache-2.0"),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export class ManifestMismatchError extends Error {}

/**
 * Canonical JSON: sorted keys, no whitespace. Two byte-different-but-equal
 * JSON documents must hash identically or signatures can be forged by
 * re-serialization.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function manifestDigest(manifest: PluginManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

/** ed25519 keypair; base64-encoded for storage/transport. */
export function generatePublisherKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** Signs the canonical digest of a manifest; returns base64 signature. */
export function signManifest(manifest: PluginManifest, privateKeyBase64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(manifestDigest(manifest), "hex"), key).toString("base64");
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/** Pure verification: schema first, then structural consistency, then crypto. */
export function verifyPlugin(
  manifest: unknown,
  signatureBase64: string,
  publisherPublicKeyBase64: string,
): VerifyResult {
  const parsed = pluginManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return { valid: false, reason: `manifest fails schema: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  const m = parsed.data;
  for (const capId of m.capabilities) {
    if (!m.risks[capId]) {
      return { valid: false, reason: `capability ${capId} has no declared risk class` };
    }
  }
  if (Object.keys(m.risks).some((k) => !m.capabilities.includes(k))) {
    return { valid: false, reason: "risks declare capability ids not present in capabilities[]" };
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(publisherPublicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = verify(
      null,
      Buffer.from(manifestDigest(m), "hex"),
      key,
      Buffer.from(signatureBase64, "base64"),
    );
    return ok ? { valid: true } : { valid: false, reason: "signature does not match manifest digest" };
  } catch {
    return { valid: false, reason: "malformed public key or signature encoding" };
  }
}
