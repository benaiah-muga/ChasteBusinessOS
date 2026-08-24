import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  generatePublisherKey,
  manifestDigest,
  pluginManifestSchema,
  signManifest,
  verifyPlugin,
  type PluginManifest,
} from "./index";

const manifest = {
  formatVersion: 1 as const,
  slug: "acme-warehouse",
  name: "Acme Warehouse Tools",
  version: "1.2.3",
  summary: "Extra warehouse capabilities from Acme: cycle counting and bin transfers.",
  capabilities: ["acme.cycleCount", "acme.binTransfer"],
  risks: { "acme.cycleCount": "write", "acme.binTransfer": "write" },
  license: "Apache-2.0",
} satisfies PluginManifest;

describe("canonicalJson", () => {
  it("is order-independent for equal documents (array order is preserved)", () => {
    expect(canonicalJson({ b: 1, a: [2, { z: 0, y: null }] })).toBe(
      canonicalJson({ a: [2, { y: null, z: 0 }], b: 1 }),
    );
  });

  it("array reordering changes the digest, signatures bind to element order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("sign + verify", () => {
  it("a correctly signed manifest verifies", () => {
    const keys = generatePublisherKey();
    const sig = signManifest(manifest, keys.privateKey);
    expect(verifyPlugin(manifest, sig, keys.publicKey)).toEqual({ valid: true });
  });

  it("any manifest mutation invalidates the signature", () => {
    const keys = generatePublisherKey();
    const sig = signManifest(manifest, keys.privateKey);
    const tampered = { ...manifest, version: "9.9.9" };
    const r = verifyPlugin(tampered, sig, keys.publicKey);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("does not match");
  });

  it("a foreign key cannot verify someone else's manifest", () => {
    const publisher = generatePublisherKey();
    const attacker = generatePublisherKey();
    const sig = signManifest(manifest, publisher.privateKey);
    expect(verifyPlugin(manifest, sig, attacker.publicKey).valid).toBe(false);
    // Attacker re-signs the same manifest with their own key, signature is
    // valid crypto but against the wrong publisher; installers pin keys.
    const forged = signManifest(manifest, attacker.privateKey);
    expect(verifyPlugin(manifest, forged, publisher.publicKey).valid).toBe(false);
  });

  it("malformed key material fails closed", () => {
    expect(verifyPlugin(manifest, "AAAA", "not-base64!!").valid).toBe(false);
  });

  it("schema violations are reported before any crypto runs", () => {
    const bad = { ...manifest, slug: "Bad Slug!" };
    const r = verifyPlugin(bad, "AAAA", "AAAA");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("schema");
  });

  it("every declared capability must carry a risk class", () => {
    const missingRisk = { ...manifest, risks: { "acme.cycleCount": "write" } };
    const r = verifyPlugin(missingRisk, "AAAA", "AAAA");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("no declared risk");
  });

  it("risks may not declare ids outside capabilities[]", () => {
    const extra = { ...manifest, risks: { ...manifest.risks, "acme.ghost": "read" } };
    const r = verifyPlugin(extra, "AAAA", "AAAA");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("not present");
  });

  it("digest is stable across runs (deterministic hashing)", () => {
    expect(manifestDigest(manifest)).toBe(manifestDigest({ ...manifest }));
  });

  it("the schema rejects non-semver versions", () => {
    expect(pluginManifestSchema.safeParse({ ...manifest, version: "1.x" }).success).toBe(false);
  });
});
