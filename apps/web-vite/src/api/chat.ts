import { z } from "zod";

/** Mirrors the Go route's message bound (chatMessageMaxUnits in chat_session.go). */
export const CHAT_MESSAGE_MAX_UNITS = 8000;

const ChatUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative(),
});

export type ChatUsage = z.infer<typeof ChatUsageSchema>;

const DeltaFrameSchema = z.object({ type: z.literal("delta"), text: z.string() });
const StepFrameSchema = z.object({
  type: z.literal("step"),
  step: z.number().int().nonnegative(),
  maxSteps: z.number().int().nonnegative(),
});
const ToolFrameSchema = z.object({ type: z.literal("tool"), name: z.string() });
const CompactionFrameSchema = z.object({
  type: z.literal("compaction"),
  compactedToMessages: z.number().int().nonnegative(),
});
const AskFrameSchema = z.object({
  type: z.literal("ask"),
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
  allowOther: z.boolean().optional(),
});
const DoneFrameSchema = z.object({
  type: z.literal("done"),
  sessionId: z.string().optional(),
  reply: z.string().optional(),
  usage: z.object({
    turn: ChatUsageSchema.optional(),
    session: ChatUsageSchema.optional(),
  }).optional(),
});
const StoppedFrameSchema = z.object({
  type: z.literal("stopped"),
  sessionId: z.string().optional(),
});
const ErrorFrameSchema = z.object({ type: z.literal("error"), error: z.string() });

const FrameSchema = z.discriminatedUnion("type", [
  DeltaFrameSchema,
  StepFrameSchema,
  ToolFrameSchema,
  CompactionFrameSchema,
  AskFrameSchema,
  DoneFrameSchema,
  StoppedFrameSchema,
  ErrorFrameSchema,
]);

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "step"; step: number; maxSteps: number }
  | { type: "tool"; name: string }
  | { type: "compaction"; compactedToMessages: number }
  | { type: "ask"; id: string; question: string; options: string[]; allowOther: boolean }
  | { type: "done"; sessionId: string | null; reply: string; turnUsage: ChatUsage | null; sessionUsage: ChatUsage | null }
  | { type: "stopped"; sessionId: string | null }
  | { type: "error"; error: string };

function toChatEvent(frame: z.infer<typeof FrameSchema>): ChatEvent | null {
  switch (frame.type) {
    case "delta":
      return { type: "delta", text: frame.text };
    case "step":
      return { type: "step", step: frame.step, maxSteps: frame.maxSteps };
    case "tool":
      return { type: "tool", name: frame.name };
    case "compaction":
      return { type: "compaction", compactedToMessages: frame.compactedToMessages };
    case "ask":
      return {
        type: "ask",
        id: frame.id,
        question: frame.question,
        options: frame.options ?? [],
        allowOther: frame.allowOther ?? true,
      };
    case "done":
      return {
        type: "done",
        sessionId: frame.sessionId ?? null,
        reply: frame.reply ?? "",
        turnUsage: frame.usage?.turn ?? null,
        sessionUsage: frame.usage?.session ?? null,
      };
    case "stopped":
      return { type: "stopped", sessionId: frame.sessionId ?? null };
    case "error":
      return { type: "error", error: frame.error };
    default:
      // Unknown frame types are protocol extensions from a newer server; the
      // stream keeps working because they are skipped, not fatal.
      return null;
  }
}

export class ChatStreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isChatAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}

async function chatRequestError(response: Response): Promise<ChatStreamError> {
  const retryHeader = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null;
  switch (response.status) {
    case 400:
      return new ChatStreamError(400, "The message could not be sent. It must be 1 to 8,000 characters.");
    case 401:
      return new ChatStreamError(401, "Your session has ended. Sign in again to continue.");
    case 403:
      return new ChatStreamError(403, "This request was refused. Your role may not allow it.");
    case 404:
      return new ChatStreamError(404, "This conversation no longer exists. Start a new chat.");
    case 428:
      return new ChatStreamError(428, "Finish setting up your workspace before chatting.");
    case 429:
      return new ChatStreamError(
        429,
        retryAfterSeconds === null
          ? "Too many messages in a short time. Try again shortly."
          : `Too many messages in a short time. Try again in ${retryAfterSeconds}s.`,
        retryAfterSeconds,
      );
    default:
      if (response.status >= 500) return new ChatStreamError(response.status, "Your workmate is unavailable right now. Try again.");
      return new ChatStreamError(response.status, "The chat request could not be completed. Try again.");
  }
}

export interface StreamChatOptions {
  message: string;
  sessionId?: string;
  mode?: "assist" | "creator";
  signal?: AbortSignal;
  onSession?: (sessionId: string) => void;
}

/**
 * Streams one workmate turn over the Go chat route's NDJSON protocol.
 *
 * Non-OK responses are plain JSON errors (the Go handler writes no NDJSON
 * before admission fails), so they map to a ChatStreamError; a 200 stream that
 * ends without a terminal frame is treated as an interrupted connection.
 */
export async function streamChat(options: StreamChatOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/x-ndjson", "content-type": "application/json" },
      body: JSON.stringify({
        message: options.message,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (isChatAbortError(error) || options.signal?.aborted) throw error;
    throw new ChatStreamError(0, "Could not reach your workmate. Check your connection and try again.");
  }
  if (!response.ok) throw await chatRequestError(response);
  const headerSession = response.headers.get("x-session-id");
  if (headerSession) options.onSession?.(headerSession);
  if (!response.body) throw new ChatStreamError(0, "Your workmate's reply could not be read. Try again.");

  let terminal = false;
  const handleLine = (line: string) => {
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      // A malformed line is dropped: one bad event must not kill the stream.
      return;
    }
    const frame = FrameSchema.safeParse(body);
    if (!frame.success) return;
    const event = toChatEvent(frame.data);
    if (!event) return;
    if (event.type === "done" || event.type === "stopped" || event.type === "error") terminal = true;
    onEvent(event);
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (options.signal?.aborted) throw abortError();
    buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) handleLine(line);
      newline = buffered.indexOf("\n");
    }
    if (done) break;
  }
  if (buffered.trim()) handleLine(buffered.trim());
  if (!terminal) throw new ChatStreamError(0, "Your workmate stopped responding before finishing. Try again.");
}

export type SteerOutcome = "accepted" | "rejected" | "unreachable";

/**
 * Queues a mid-run steering message. The server drains it between loop steps;
 * there is no stream frame for the injection itself, so the caller renders the
 * accepted message optimistically and falls back to a local queue otherwise.
 */
export async function steerChat(options: { sessionId: string; message: string }): Promise<SteerOutcome> {
  try {
    const response = await fetch("/api/chat/steer", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: options.sessionId, message: options.message }),
    });
    return response.ok ? "accepted" : "rejected";
  } catch {
    return "unreachable";
  }
}
