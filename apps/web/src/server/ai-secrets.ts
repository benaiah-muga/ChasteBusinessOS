import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function masterKey(): Buffer {
  const secret = process.env.AI_CONFIG_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("AI_CONFIG_ENCRYPTION_KEY or BETTER_AUTH_SECRET is required");
  return createHash("sha256").update(secret).digest();
}

export function encryptProviderKey(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptProviderKey(value: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("invalid encrypted provider key");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}
