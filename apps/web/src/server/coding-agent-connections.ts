import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import https from "node:https";
import http from "node:http";
import { eq, and, sql } from "drizzle-orm";
import { codingAgentConnections, type Database } from "@chaste/db";
import { decryptProviderKey, encryptProviderKey } from "./ai-secrets";

export type CodingAgentProvider = "codex" | "opencode";

export interface PublicCodingAgentConnection {
  id: string;
  provider: CodingAgentProvider;
  endpoint: string | null;
  modelId: string | null;
  status: string;
  isDefault: boolean;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt: string | null;
  connectedAt: string;
}

export interface OpenCodeCredential {
  username: string;
  password: string;
}

interface ToolAccessClaims {
  aud: "chaste-mcp";
  orgId: string;
  userId: string;
  connectionId: string;
  sessionId?: string;
  allowedTools: string[];
  iat: number;
  exp: number;
}

const MAX_REMOTE_RESPONSE_BYTES = 1_000_000;
const TOKEN_DAY_SECONDS = 86_400;
const CONNECTION_STATUS = { connected: "connected", disconnected: "disconnected", attention: "needs_attention" } as const;
const loginProcesses = globalThis as typeof globalThis & {
  __chasteCodexLoginProcesses?: Map<string, ChildProcess>;
  __chasteCodexLoginStates?: Map<string, { verificationUrl: string | null; userCode: string | null }>;
};
const codexLoginProcesses = (loginProcesses.__chasteCodexLoginProcesses ??= new Map());
const codexLoginStates = (loginProcesses.__chasteCodexLoginStates ??= new Map());

export function publicConnection(row: typeof codingAgentConnections.$inferSelect): PublicCodingAgentConnection {
  return {
    id: row.id,
    provider: row.provider as CodingAgentProvider,
    endpoint: row.endpoint,
    modelId: row.modelId,
    status: row.status,
    isDefault: row.isDefault,
    runCount: row.runCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    connectedAt: row.connectedAt.toISOString(),
  };
}

function codexBinary(): string {
  return process.env.CODEX_BIN?.trim() || "codex";
}

export function codexHome(orgId: string, userId: string): string {
  const root = process.env.CHASTE_CODEX_CONNECTION_HOME?.trim();
  const base = root || `${process.env.HOME || process.cwd()}/.chaste/codex-connections`;
  const key = createHash("sha256").update(`${orgId}:${userId}`).digest("hex");
  return `${base.replace(/\/$/, "")}/${key}`;
}

function ownerKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

export function probeCodex(): { available: boolean; version: string | null; command: string } {
  const command = codexBinary();
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 2500,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    available: result.status === 0,
    version: result.status === 0 ? (result.stdout.trim().slice(0, 80) || null) : null,
    command,
  };
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? address;
  if (normalized.startsWith("::ffff:")) {
    const ipv4 = normalized.slice(7);
    if (isIP(ipv4) === 4) return privateIpv4(ipv4);
  }
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return normalized === "::" || normalized === "::1" ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    normalized.startsWith("2001:db8:") ||
    (first & 0xe000) !== 0x2000;
}

function endpointProtocolAllowed(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.username || url.password || url.search || url.hash) return false;
  if (["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    return process.env.NODE_ENV !== "production";
  }
  if (url.protocol !== "https:") return false;
  if (isIP(host) === 4) return !privateIpv4(host);
  if (isIP(host) === 6) return !privateIpv6(host);
  return host.includes(".") && !host.endsWith(".internal");
}

export function normalizeOpenCodeEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (!endpointProtocolAllowed(url)) {
    throw new Error("Use a public HTTPS OpenCode server address. Local servers are allowed in development only.");
  }
  return url.toString().replace(/\/$/, "");
}

async function publicAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const localDev = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "::1"].includes(host);
  const resolved = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error("The OpenCode server address did not resolve.");
  const unsafe = resolved.some(({ address, family }) => family === 4 ? privateIpv4(address) : privateIpv6(address));
  if (unsafe && !localDev) throw new Error("The OpenCode address resolves to a private network, which is blocked for security.");
  return resolved;
}

export async function requestOpenCode(
  endpoint: string,
  credential: OpenCodeCredential,
  pathname: string,
  options: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${endpoint}${pathname}`);
  const addresses = await publicAddresses(url.hostname);
  const selected = addresses[0]!;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const authority = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
    accept: "application/json",
    ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}),
    host: authority,
  };
  const transport = url.protocol === "http:" ? http : https;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: selected.address,
      family: selected.family,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers,
      ...(url.protocol === "https:" && isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: true,
    }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_REMOTE_RESPONSE_BYTES) {
          req.destroy(new Error("OpenCode response exceeded the size limit."));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* keep non-JSON details out of the caller response */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("OpenCode server timed out.")));
    req.on("error", reject);
    if (options.signal?.aborted) {
      req.destroy(new Error("The coding-plan request was cancelled."));
      return;
    }
    const abort = () => req.destroy(new Error("The coding-plan request was cancelled."));
    options.signal?.addEventListener("abort", abort, { once: true });
    req.on("close", () => options.signal?.removeEventListener("abort", abort));
    if (payload) req.write(payload);
    req.end();
  });
}

export function signToolAccessToken(
  claims: Omit<ToolAccessClaims, "aud" | "iat" | "exp" | "allowedTools"> & { allowedTools?: string[] },
  now = Date.now(),
): string {
  const iat = Math.floor(now / (TOKEN_DAY_SECONDS * 1000)) * TOKEN_DAY_SECONDS;
  const payload: ToolAccessClaims = { ...claims, allowedTools: claims.allowedTools ?? [], aud: "chaste-mcp", iat, exp: iat + TOKEN_DAY_SECONDS * 2 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = process.env.AI_CONFIG_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!key) throw new Error("Coding agent access tokens require the AI encryption secret.");
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyToolAccessToken(token: string, now = Date.now()): ToolAccessClaims | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const key = process.env.AI_CONFIG_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!key) return null;
  const expected = createHmac("sha256", key).update(encoded).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ToolAccessClaims;
    if (parsed.aud !== "chaste-mcp" || parsed.exp <= Math.floor(now / 1000) || !parsed.orgId || !parsed.userId || !parsed.connectionId || !Array.isArray(parsed.allowedTools)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function listUserCodingAgentConnections(
  db: Database["db"],
  orgId: string,
  userId: string,
): Promise<PublicCodingAgentConnection[]> {
  const rows = await db.select().from(codingAgentConnections).where(and(
    eq(codingAgentConnections.orgId, orgId),
    eq(codingAgentConnections.userId, userId),
  ));
  return rows.map(publicConnection);
}

export async function getDefaultCodingAgentConnection(db: Database["db"], orgId: string, userId: string) {
  const [row] = await db.select().from(codingAgentConnections).where(and(
    eq(codingAgentConnections.orgId, orgId),
    eq(codingAgentConnections.userId, userId),
    eq(codingAgentConnections.isDefault, true),
    eq(codingAgentConnections.status, CONNECTION_STATUS.connected),
  )).limit(1);
  return row ?? null;
}

export async function configureOpenCodeMcp(
  endpoint: string,
  credential: OpenCodeCredential,
  connection: { id: string; orgId: string; userId: string; sessionId?: string; allowedTools?: string[] },
  appUrl: string,
): Promise<void> {
  const name = `chaste_${connection.id.replaceAll("-", "").slice(0, 12)}`;
  const accessToken = signToolAccessToken({
    connectionId: connection.id,
    orgId: connection.orgId,
    userId: connection.userId,
    ...(connection.sessionId ? { sessionId: connection.sessionId } : {}),
    allowedTools: connection.allowedTools ?? [],
  });
  const result = await requestOpenCode(endpoint, credential, "/mcp", {
    method: "POST",
    body: {
      name,
      config: {
        type: "remote",
        url: `${appUrl.replace(/\/$/, "")}/api/ai-tools/mcp`,
        oauth: false,
        disabled: false,
        codemode: false,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  });
  const data = result.body as { status?: string; error?: { message?: string } } | null;
  if (result.status < 200 || result.status >= 300 || data?.status === "failed") {
    throw new Error(data?.error?.message ?? "OpenCode could not connect to Chaste tools.");
  }
}

export async function connectOpenCode(
  db: Database["db"],
  input: { orgId: string; userId: string; endpoint: string; username: string; password: string; modelId?: string; makeDefault?: boolean },
): Promise<PublicCodingAgentConnection> {
  const endpoint = normalizeOpenCodeEndpoint(input.endpoint);
  const credential = { username: input.username.trim() || "opencode", password: input.password };
  const health = await requestOpenCode(endpoint, credential, "/global/health");
  if (health.status < 200 || health.status >= 300 || !(health.body as { healthy?: unknown } | null)?.healthy) {
    throw new Error(health.status === 401 ? "OpenCode rejected the server password." : "This address did not respond as a healthy OpenCode server.");
  }
  const provider = await requestOpenCode(endpoint, credential, "/provider");
  if (provider.status < 200 || provider.status >= 300) throw new Error("OpenCode could not read its connected providers.");
  const providerData = provider.body as { connected?: unknown } | null;
  if (!Array.isArray(providerData?.connected) || providerData.connected.length === 0) {
    throw new Error("Sign in to a model provider in OpenCode before connecting it to Chaste.");
  }

  const [existing] = await db.select({ id: codingAgentConnections.id }).from(codingAgentConnections).where(and(
    eq(codingAgentConnections.orgId, input.orgId),
    eq(codingAgentConnections.userId, input.userId),
    eq(codingAgentConnections.provider, "opencode"),
  )).limit(1);
  const id = existing?.id ?? randomUUID();
  const row = {
    orgId: input.orgId,
    userId: input.userId,
    provider: "opencode",
    endpoint,
    encryptedCredential: encryptProviderKey(JSON.stringify(credential)),
    modelId: input.modelId?.trim() || null,
    status: CONNECTION_STATUS.connected,
    isDefault: input.makeDefault ?? !existing,
    updatedAt: new Date(),
  } as const;
  await db.transaction(async (tx) => {
    if (row.isDefault) await tx.update(codingAgentConnections).set({ isDefault: false }).where(and(
      eq(codingAgentConnections.orgId, input.orgId),
      eq(codingAgentConnections.userId, input.userId),
    ));
    await tx.insert(codingAgentConnections).values({ id, ...row }).onConflictDoUpdate({
      target: [codingAgentConnections.orgId, codingAgentConnections.userId, codingAgentConnections.provider],
      set: {
        endpoint: row.endpoint,
        encryptedCredential: row.encryptedCredential,
        modelId: row.modelId,
        status: row.status,
        isDefault: row.isDefault,
        updatedAt: row.updatedAt,
      },
    });
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    await configureOpenCodeMcp(endpoint, credential, { id, orgId: input.orgId, userId: input.userId }, appUrl);
  } catch (error) {
    await db.update(codingAgentConnections).set({ status: CONNECTION_STATUS.attention, isDefault: false, updatedAt: new Date() }).where(eq(codingAgentConnections.id, id));
    throw error;
  }
  const [saved] = await db.select().from(codingAgentConnections).where(eq(codingAgentConnections.id, id)).limit(1);
  if (!saved) throw new Error("OpenCode connection was saved but could not be reloaded.");
  return publicConnection(saved);
}

function parseCodexLoginOutput(text: string): { verificationUrl: string | null; userCode: string | null } {
  const ansiEscape = String.fromCharCode(27);
  const plain = text.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g"), "");
  const verificationUrl = plain.match(/https:\/\/[a-z0-9./_-]*(?:device|activate|login)[a-z0-9./?=_-]*/i)?.[0] ?? null;
  const userCode = plain.match(/(?:code\s*[:：]?\s*)([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i)?.[1] ?? null;
  return { verificationUrl, userCode };
}

export async function startCodexDeviceLogin(input: { orgId: string; userId: string }): Promise<{ verificationUrl: string | null; userCode: string | null; waitingForPrompt: boolean }> {
  const probe = probeCodex();
  if (!probe.available) throw new Error("Codex CLI is not installed for this server. Set CODEX_BIN to its executable path.");
  if (process.env.VERCEL) throw new Error("Codex plan connections need a persistent server runtime. Connect through a dedicated OpenCode server on this deployment.");
  const home = codexHome(input.orgId, input.userId);
  await import("node:fs/promises").then(({ mkdir, chmod }) => mkdir(home, { recursive: true, mode: 0o700 }).then(() => chmod(home, 0o700)));
  const key = ownerKey(input.orgId, input.userId);
  const current = codexLoginProcesses.get(key);
  if (current && current.exitCode === null) current.kill("SIGTERM");
  const child = spawn(codexBinary(), ["login", "--device-auth"], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  codexLoginProcesses.set(key, child);
  const state = { verificationUrl: null as string | null, userCode: null as string | null };
  codexLoginStates.set(key, state);
  let buffer = "";
  const updateOutput = (chunk: Buffer) => {
    buffer = `${buffer}${chunk.toString("utf8")}`.slice(-8000);
    const parsed = parseCodexLoginOutput(buffer);
    state.verificationUrl = parsed.verificationUrl ?? state.verificationUrl;
    state.userCode = parsed.userCode ?? state.userCode;
  };
  child.stdout?.on("data", updateOutput);
  child.stderr?.on("data", updateOutput);
  child.on("exit", () => { if (codexLoginProcesses.get(key) === child) codexLoginProcesses.delete(key); });
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (child.exitCode !== null) throw new Error("Codex closed the login flow before returning a device code.");
  return { ...state, waitingForPrompt: !state.verificationUrl || !state.userCode };
}

export async function pollCodexDeviceLogin(
  db: Database["db"],
  input: { orgId: string; userId: string; makeDefault?: boolean },
): Promise<{ connected: boolean; message: string; verificationUrl?: string | null; userCode?: string | null; connection?: PublicCodingAgentConnection }> {
  const home = codexHome(input.orgId, input.userId);
  const result = spawnSync(codexBinary(), ["login", "status"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const statusText = result.stdout ?? "";
  if (result.status !== 0 || !/logged in|authenticated/i.test(statusText) || /not logged in|not authenticated/i.test(statusText)) {
    const state = codexLoginStates.get(ownerKey(input.orgId, input.userId));
    return {
      connected: false,
      message: "Waiting for you to finish sign-in in the browser.",
      verificationUrl: state?.verificationUrl ?? null,
      userCode: state?.userCode ?? null,
    };
  }
  codexLoginStates.delete(ownerKey(input.orgId, input.userId));
  const owner = { orgId: input.orgId, userId: input.userId };
  const [existing] = await db.select({ id: codingAgentConnections.id }).from(codingAgentConnections).where(and(
    eq(codingAgentConnections.orgId, owner.orgId),
    eq(codingAgentConnections.userId, owner.userId),
    eq(codingAgentConnections.provider, "codex"),
  )).limit(1);
  const id = existing?.id ?? randomUUID();
  const isDefault = input.makeDefault ?? !existing;
  await db.transaction(async (tx) => {
    if (isDefault) await tx.update(codingAgentConnections).set({ isDefault: false }).where(and(
      eq(codingAgentConnections.orgId, owner.orgId),
      eq(codingAgentConnections.userId, owner.userId),
    ));
    await tx.insert(codingAgentConnections).values({
      id,
      ...owner,
      provider: "codex",
      endpoint: null,
      encryptedCredential: null,
      modelId: null,
      status: CONNECTION_STATUS.connected,
      isDefault,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [codingAgentConnections.orgId, codingAgentConnections.userId, codingAgentConnections.provider],
      set: { status: CONNECTION_STATUS.connected, isDefault, updatedAt: new Date() },
    });
  });
  const [saved] = await db.select().from(codingAgentConnections).where(eq(codingAgentConnections.id, id)).limit(1);
  if (!saved) return { connected: false, message: "Codex signed in, but its workspace connection could not be saved." };
  return { connected: true, message: "Codex plan connected.", connection: publicConnection(saved) };
}

export async function chooseDefaultCodingAgent(
  db: Database["db"],
  orgId: string,
  userId: string,
  connectionId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(codingAgentConnections).set({ isDefault: false, updatedAt: new Date() }).where(and(
      eq(codingAgentConnections.orgId, orgId),
      eq(codingAgentConnections.userId, userId),
    ));
    if (connectionId) {
      const [connection] = await tx.select({ id: codingAgentConnections.id }).from(codingAgentConnections).where(and(
        eq(codingAgentConnections.id, connectionId),
        eq(codingAgentConnections.orgId, orgId),
        eq(codingAgentConnections.userId, userId),
        eq(codingAgentConnections.status, CONNECTION_STATUS.connected),
      )).limit(1);
      if (!connection) throw new Error("Choose a connected account that belongs to you.");
      await tx.update(codingAgentConnections).set({ isDefault: true, updatedAt: new Date() }).where(eq(codingAgentConnections.id, connectionId));
    }
  });
}

export async function disconnectCodingAgent(
  db: Database["db"],
  orgId: string,
  userId: string,
  provider: CodingAgentProvider,
): Promise<void> {
  const [row] = await db.select().from(codingAgentConnections).where(and(
    eq(codingAgentConnections.orgId, orgId),
    eq(codingAgentConnections.userId, userId),
    eq(codingAgentConnections.provider, provider),
  )).limit(1);
  if (!row) return;
  if (provider === "codex") {
    const home = codexHome(orgId, userId);
    const child = codexLoginProcesses.get(ownerKey(orgId, userId));
    if (child && child.exitCode === null) child.kill("SIGTERM");
    codexLoginStates.delete(ownerKey(orgId, userId));
    spawnSync(codexBinary(), ["logout"], { encoding: "utf8", timeout: 5000, env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "ignore", "ignore"] });
    const { rm } = await import("node:fs/promises");
    await rm(home, { recursive: true, force: true });
  }
  await db.update(codingAgentConnections).set({ status: CONNECTION_STATUS.disconnected, isDefault: false, encryptedCredential: null, updatedAt: new Date() }).where(eq(codingAgentConnections.id, row.id));
}

export async function trackCodingAgentUsage(
  db: Database["db"],
  connectionId: string,
  usage: { input: number; output: number },
): Promise<void> {
  await db.update(codingAgentConnections).set({
    runCount: sql`${codingAgentConnections.runCount} + 1`,
    inputTokens: sql`${codingAgentConnections.inputTokens} + ${Math.max(0, Math.floor(usage.input))}`,
    outputTokens: sql`${codingAgentConnections.outputTokens} + ${Math.max(0, Math.floor(usage.output))}`,
    lastUsedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(codingAgentConnections.id, connectionId), eq(codingAgentConnections.status, CONNECTION_STATUS.connected)));
}

export async function resolveOpenCodeCredential(row: typeof codingAgentConnections.$inferSelect): Promise<OpenCodeCredential> {
  if (!row.encryptedCredential) throw new Error("OpenCode sign-in details are missing. Reconnect this account.");
  try {
    const value = JSON.parse(decryptProviderKey(row.encryptedCredential)) as OpenCodeCredential;
    if (!value.username || !value.password) throw new Error("missing credential");
    return value;
  } catch {
    throw new Error("OpenCode connection secret could not be decrypted. Reconnect this account.");
  }
}

export async function codingAgentConnectionById(db: Database["db"], id: string) {
  const [row] = await db.select().from(codingAgentConnections).where(and(eq(codingAgentConnections.id, id), eq(codingAgentConnections.status, "connected"))).limit(1);
  return row ?? null;
}
