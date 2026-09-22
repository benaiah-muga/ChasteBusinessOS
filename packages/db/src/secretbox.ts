import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Reversible secret encryption for org-provided credentials (AI provider
 * API keys). AES-256-GCM with a key from CHASTE_ENCRYPTION_KEY:
 *  - 64 hex chars or 44 base64 chars are used as the raw 32-byte key
 *  - anything else is treated as a passphrase and stretched with SHA-256
 *    (acceptable, but a real random key is stronger - say so in ops docs)
 * No key, no storage: callers must refuse to save credentials rather than
 * write plaintext to the database.
 */

export function encryptionKey(): Buffer | null {
  const raw = process.env.CHASTE_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptionConfigured(): boolean {
  return encryptionKey() !== null;
}

/** AES-256-GCM; payload is base64(iv).base64(tag).base64(ciphertext). */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("CHASTE_ENCRYPTION_KEY is not set; refusing to store a secret in plaintext");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("CHASTE_ENCRYPTION_KEY is not set; cannot decrypt a stored secret");
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed secret payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function secretLast4(plaintext: string): string {
  return plaintext.slice(-4);
}
