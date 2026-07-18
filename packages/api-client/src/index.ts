import { chatMessageSchema, type ChatMessage, type UiPart } from "@chaste/ui-schema";
import { z } from "zod";

export { chatMessageSchema };
export type { ChatMessage, UiPart };

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
});

export const commandResultSchema = z.object({
  ok: z.literal(true),
  command: z.string(),
  requestId: z.string(),
  data: z.unknown(),
});

export const queryResultSchema = z.object({
  ok: z.literal(true),
  query: z.string(),
  requestId: z.string(),
  data: z.unknown(),
});

export const customerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  email: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  status: z.string().optional(),
  createdAt: z.string(),
});

export type Customer = z.infer<typeof customerSchema>;

export const customerListSchema = z.object({
  items: z.array(customerSchema),
});

export const sessionSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  email: z.string(),
  displayName: z.string(),
  permissions: z.array(z.string()),
  autonomy: z.enum(["recommend", "confirm", "guarded_auto", "full_autonomous"]),
  orgName: z.string().optional(),
  region: z.string().optional(),
  fullAutonomousWarning: z.string().optional(),
  allowFullAutonomous: z.boolean().optional(),
  aiProvider: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

export const chatResponseSchema = z.object({
  sessionId: z.string(),
  messages: z.array(chatMessageSchema),
  pendingConfirmationId: z.string().optional(),
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ChasteApiClientOptions {
  baseUrl: string;
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

export function createChasteApiClient(options: ChasteApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit,
    parse: (data: unknown) => T,
  ): Promise<T> {
    const extra = options.getHeaders ? await options.getHeaders() : {};
    const res = await fetchImpl(new URL(path, options.baseUrl).toString(), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...extra,
        ...(init.headers ?? {}),
      },
    });

    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as { message?: string; code?: string; details?: unknown };
      throw new ApiError(err.message ?? res.statusText, res.status, err.code, err.details);
    }
    return parse(body);
  }

  return {
    health() {
      return request("/health", { method: "GET" }, (d) => healthResponseSchema.parse(d));
    },
    session() {
      return request("/api/v1/session", { method: "GET" }, (d) => sessionSchema.parse(d));
    },
    listModules() {
      return request("/api/v1/modules", { method: "GET" }, (d) => d as {
        registered: { id: string; name: string; version: string }[];
        installed: { moduleId: string; version: string; enabled: boolean }[];
      });
    },
    executeCommand(name: string, input: unknown) {
      return request(
        `/api/v1/commands/${encodeURIComponent(name)}`,
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    executeQuery(name: string, input: unknown = {}) {
      return request(
        `/api/v1/queries/${encodeURIComponent(name)}`,
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => queryResultSchema.parse(d),
      );
    },
    listCustomers() {
      return request("/api/v1/crm/customers", { method: "GET" }, (d) =>
        customerListSchema.parse(d),
      );
    },
    createCustomer(input: { name: string; email?: string; city?: string; country?: string }) {
      return request(
        "/api/v1/crm/customers",
        { method: "POST", body: JSON.stringify(input) },
        (d) => customerSchema.parse(d),
      );
    },
    chat(body: {
      sessionId?: string;
      message?: string;
      confirmId?: string;
      cancelId?: string;
    }) {
      return request(
        "/api/v1/ai/chat",
        { method: "POST", body: JSON.stringify(body) },
        (d) => chatResponseSchema.parse(d),
      );
    },
    getRbac() {
      return request("/api/v1/rbac", { method: "GET" }, (d) => d);
    },
    getMarketplace() {
      return request("/api/v1/marketplace", { method: "GET" }, (d) => d);
    },
    setAutonomy(body: {
      autonomy: "recommend" | "confirm" | "guarded_auto" | "full_autonomous";
      acknowledgeFullAutonomous?: boolean;
    }) {
      return request("/api/v1/autonomy", { method: "POST", body: JSON.stringify(body) }, (d) => d);
    },
  };
}

export type ChasteApiClient = ReturnType<typeof createChasteApiClient>;
