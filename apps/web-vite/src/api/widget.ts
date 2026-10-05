import { z } from "zod";

/**
 * Public customer-care chat surface for the embeddable widget. The thread
 * secret lives only in this browser and is sent in request bodies, never URLs.
 */

const TokenSchema = z.string().min(16).max(512).refine((value) =>
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  }),
);
const ConversationIdSchema = z.string().uuid();
const SecretSchema = z.string().min(16).max(512);

const MessageSchema = z.object({
  id: z.string().uuid(),
  senderType: z.enum(["customer", "agent", "staff", "system"]),
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const ThreadSchema = z.object({
  status: z.enum(["open", "escalated", "resolved"]),
  messages: z.array(MessageSchema).max(100),
}).strict();

const StartedSchema = z.object({
  conversationId: ConversationIdSchema,
  secret: SecretSchema,
}).strict();

const StoredThreadSchema = z.object({
  conversationId: ConversationIdSchema,
  secret: SecretSchema,
}).strict();

const StartInputSchema = z.object({
  token: TokenSchema,
  email: z.string().email().max(320),
  name: z.string().min(1).max(80).optional(),
}).strict();

const ExistingThreadInputSchema = z.object({
  token: TokenSchema,
  conversationId: ConversationIdSchema,
  secret: SecretSchema,
}).strict();

export type WidgetMessage = z.infer<typeof MessageSchema>;

export type WidgetThread = z.infer<typeof ThreadSchema>;

export type WidgetStartResult =
  | { status: "started"; conversationId: string; secret: string }
  | { status: "rejected" };

export type WidgetThreadResult =
  | { status: "ok"; thread: WidgetThread }
  | { status: "unavailable" };

export function widgetStorageKey(token: string): string {
  return `chaste-widget:${token}`;
}

export function readStoredThread(token: string): { conversationId: string; secret: string } | null {
  if (!TokenSchema.safeParse(token).success) return null;
  try {
    const saved = localStorage.getItem(widgetStorageKey(token));
    if (!saved) return null;
    const parsed = StoredThreadSchema.safeParse(JSON.parse(saved));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    // A fresh visitor: an unreadable or absent entry just starts over.
    return null;
  }
}

export function storeThread(token: string, thread: { conversationId: string; secret: string }): void {
  const validToken = TokenSchema.safeParse(token);
  const validThread = StoredThreadSchema.safeParse(thread);
  if (!validToken.success || !validThread.success) return;
  try {
    localStorage.setItem(widgetStorageKey(token), JSON.stringify(validThread.data));
  } catch {
    // A browser that refuses storage still works, it just cannot resume.
  }
}

async function postAction(body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch("/api/support/public", {
      method: "POST",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return null;
  }
}

export async function startWidgetThread(
  token: string,
  email: string,
  name?: string,
): Promise<WidgetStartResult> {
  const input = StartInputSchema.safeParse({ token, email, ...(name ? { name } : {}) });
  if (!input.success) return { status: "rejected" };

  const response = await postAction({ action: "start", ...input.data });
  if (!response?.ok) return { status: "rejected" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "rejected" };
  }
  const parsed = StartedSchema.safeParse(body);
  if (!parsed.success) return { status: "rejected" };
  return { status: "started", conversationId: parsed.data.conversationId, secret: parsed.data.secret };
}

export async function pollWidgetThread(
  token: string,
  conversationId: string,
  secret: string,
): Promise<WidgetThreadResult> {
  const input = ExistingThreadInputSchema.safeParse({ token, conversationId, secret });
  if (!input.success) return { status: "unavailable" };

  const response = await postAction({ action: "poll", ...input.data });
  if (!response?.ok) return { status: "unavailable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable" };
  }
  const parsed = ThreadSchema.safeParse(body);
  if (!parsed.success) return { status: "unavailable" };
  return { status: "ok", thread: parsed.data };
}

export async function sendWidgetMessage(
  token: string,
  conversationId: string,
  secret: string,
  body: string,
): Promise<boolean> {
  const input = ExistingThreadInputSchema.safeParse({ token, conversationId, secret });
  const message = z.string().trim().min(1).max(2000).safeParse(body);
  if (!input.success || !message.success) return false;
  const response = await postAction({ action: "message", ...input.data, body: message.data });
  return response?.ok ?? false;
}

export async function escalateToHuman(
  token: string,
  conversationId: string,
  secret: string,
): Promise<boolean> {
  const input = ExistingThreadInputSchema.safeParse({ token, conversationId, secret });
  if (!input.success) return false;
  const response = await postAction({ action: "human", ...input.data });
  return response?.ok ?? false;
}
