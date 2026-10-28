import { useSyncExternalStore } from "react";
import { fetchCreatorEnabled } from "./api/proposals";
import {
  CHAT_MESSAGE_MAX_UNITS,
  ChatCardSchema,
  ChatStreamError,
  isChatAbortError,
  steerChat,
  streamChat,
  type ChatAttachment,
  type ChatCard,
  type ChatUsage,
} from "./api/chat";
import { fetchSessionDetail, type TrajectoryEvent } from "./api/sessions";

/**
 * One shared conversation for the full chat page and the floating dock, so
 * shrinking or expanding never loses history or an in-flight stream.
 */

export interface AskPayload {
  id: string;
  question: string;
  options: string[];
  allowOther: boolean;
}

export interface ChatProposal {
  approvalId: string;
  capabilityId: string;
  rationale: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  activity?: string[];
  attachments?: ChatAttachment[];
  error?: boolean;
  /** Mid-run steering accepted by the server: this bubble joined the running turn. */
  steered?: boolean;
  /** Set when the model asked a clarification question in this message. */
  ask?: AskPayload;
  /** A pending human approval produced by this turn, rendered as a proposal card. */
  proposal?: ChatProposal;
  /** A structured record attached to a tool result, rendered as a record card. */
  card?: ChatCard;
  /** The option (or free text) the user answered with, once answered. */
  answered?: string;
  /** Token usage for this assistant turn, from the provider's own report. */
  usage?: ChatUsage;
  /** Set when the loop summarized older context during this turn. */
  compactedToMessages?: number;
}

export interface ChatState {
  messages: ChatMsg[];
  busy: boolean;
  creator: boolean;
  /** False while the creator module is off or its availability is unknown. */
  creatorAvailable: boolean;
  /** Fallback queue used only when steering is refused or unreachable. */
  queue: string[];
  /** Current loop position, for the live console strip. */
  step: { step: number; maxSteps: number } | null;
  /** Last tool the agent called, for the live status line. */
  lastTool: string | null;
  /** Cumulative tokens for this conversation (server-reported). */
  sessionUsage: ChatUsage;
  /** Server session id, present after the first turn or after a resume. */
  sessionId: string | null;
  /** Title of the resumed conversation, when the server recorded one. */
  sessionTitle: string | null;
  /** True when this thread was reopened from storage or a session link. */
  resumed: boolean;
}

const GREETING: ChatMsg = {
  role: "assistant",
  text: "Hi, I'm your business workmate. Ask me to do things, or ask about your books. Everything I do goes through the same governed path as you.",
};

const zeroUsage: ChatUsage = { input: 0, output: 0, cachedInput: 0 };

let state: ChatState = {
  messages: [GREETING],
  busy: false,
  creator: false,
  creatorAvailable: false,
  queue: [],
  step: null,
  lastTool: null,
  sessionUsage: zeroUsage,
  sessionId: null,
  sessionTitle: null,
  resumed: false,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function patch(part: Partial<ChatState>) {
  state = { ...state, ...part };
  emit();
}

let sessionId: string | null = null;
let abortRef: AbortController | null = null;
let chatScope: { organizationId: string; userId: string } | null = null;

const CHAT_SESSION_STORAGE_KEY = "chaste:chat:session:v1";

interface StoredChatSession {
  organizationId: string;
  userId: string;
  sessionId: string;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function clearStoredSession() {
  try {
    browserStorage()?.removeItem(CHAT_SESSION_STORAGE_KEY);
  } catch {
    // A blocked storage API must not break the conversation.
  }
}

function rememberSession(id: string) {
  if (!chatScope) return;
  try {
    browserStorage()?.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify({
      organizationId: chatScope.organizationId,
      userId: chatScope.userId,
      sessionId: id,
    } satisfies StoredChatSession));
  } catch {
    // Quota and privacy errors are non-fatal; the server session still exists.
  }
}

function storedSession(): string | null {
  if (!chatScope) return null;
  try {
    const raw = browserStorage()?.getItem(CHAT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredChatSession>;
    if (value.organizationId !== chatScope.organizationId || value.userId !== chatScope.userId) return null;
    return typeof value.sessionId === "string" && value.sessionId.length > 0 ? value.sessionId : null;
  } catch {
    return null;
  }
}

function setChatScope(organizationId: string, userId: string) {
  if (chatScope?.organizationId === organizationId && chatScope.userId === userId) return;
  const changed = chatScope !== null;
  chatScope = { organizationId, userId };
  if (changed) clearStoredSession();
}

function syncSession(id: string | null, title: string | null = state.sessionTitle) {
  sessionId = id;
  patch({ sessionId: id, sessionTitle: id ? title : null, ...(id ? {} : { resumed: false }) });
  if (id) rememberSession(id);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textField(value: Record<string, unknown> | null, key: string): string | null {
  return value && typeof value[key] === "string" ? value[key] as string : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Rebuild the visible conversation from the persisted trajectory. Tool activity
 * and record cards belong to the next assistant message because the loop
 * records the final assistant text after its tool calls.
 */
export function transcriptFromEvents(events: TrajectoryEvent[]): ChatMsg[] {
  const messages: ChatMsg[] = [];
  let activity: string[] = [];
  let card: ChatCard | undefined;
  let proposal: ChatProposal | undefined;
  let ask: AskPayload | undefined;

  const flushPending = (text: string) => {
    if (!text.trim() && activity.length === 0 && !card && !proposal && !ask) return;
    messages.push({
      role: "assistant",
      text: text.trim() ? text : "This turn ended before writing a reply.",
      ...(activity.length > 0 ? { activity } : {}),
      ...(card ? { card } : {}),
      ...(proposal ? { proposal } : {}),
      ...(ask ? { ask } : {}),
    });
    activity = [];
    card = undefined;
    proposal = undefined;
    ask = undefined;
  };

  for (const event of events) {
    const content = record(event.content);
    switch (event.role) {
      case "user": {
        const text = textField(content, "text") ?? "";
        if (text.trim()) messages.push({ role: "user", text });
        break;
      }
      case "tool_call": {
        const name = textField(content, "name");
        if (name) activity.push(name);
        break;
      }
      case "tool_result": {
        if (content?.card) {
          const parsed = ChatCardSchema.safeParse(content.card);
          if (parsed.success) card = parsed.data;
        }
        const approvalId = textField(content, "approvalId");
        if (content?.pendingApproval === true && approvalId) {
          proposal = {
            approvalId,
            capabilityId: textField(content, "capabilityId") ?? textField(content, "name") ?? "governed action",
            rationale: textField(content, "approvalRationale") ?? "This action needs your approval before it can run.",
          };
        }
        break;
      }
      case "ask": {
        const id = textField(content, "id");
        const question = textField(content, "question");
        if (id && question) {
          ask = {
            id,
            question,
            options: stringList(content?.options),
            allowOther: content?.allowOther === true,
          };
        }
        break;
      }
      case "assistant": {
        flushPending(textField(content, "text") ?? "");
        break;
      }
    }
  }
  flushPending("");
  return messages;
}
// Bumped by resetChat so an in-flight steering request cannot outlive the
// conversation it was queued for.
let storeGeneration = 0;
/**
 * Index of the assistant message for the in-flight turn. Deliberately not
 * "last message": an accepted steering bubble is appended after it while the
 * turn keeps streaming, and deltas must keep landing on the reply.
 */
let activeAssistant: number | null = null;

function updateActive(mutate: (message: ChatMsg) => void) {
  if (activeAssistant === null || activeAssistant >= state.messages.length) return;
  const messages = [...state.messages];
  const message = { ...messages[activeAssistant]! };
  mutate(message);
  messages[activeAssistant] = message;
  patch({ messages });
}

async function runTurn(text: string, attachments?: ChatAttachment[]) {
  const generation = storeGeneration;
  const messages = [...state.messages, { role: "user" as const, text, ...(attachments?.length ? { attachments } : {}) }, { role: "assistant" as const, text: "" }];
  activeAssistant = messages.length - 1;
  patch({ messages, busy: true, step: null, lastTool: null });

  const controller = new AbortController();
  abortRef = controller;
  try {
    await streamChat(
      {
        message: text,
        ...(sessionId ? { sessionId } : {}),
        mode: state.creator ? "creator" : "assist",
        ...(attachments?.length ? { attachments } : {}),
        signal: controller.signal,
        onSession: (id) => {
          if (generation === storeGeneration) syncSession(id);
        },
      },
      (event) => {
        switch (event.type) {
          case "delta":
            updateActive((message) => {
              message.text += event.text;
            });
            break;
          case "tool":
            patch({ lastTool: event.name });
            updateActive((message) => {
              message.activity = [...(message.activity ?? []), event.name];
            });
            break;
          case "tool_result":
            if (event.card) {
              const card = event.card;
              updateActive((message) => {
                message.card = card;
              });
            }
            if (event.pendingApproval && event.approvalId) {
              updateActive((message) => {
                message.proposal = {
                  approvalId: event.approvalId!,
                  capabilityId: event.name,
                  rationale: event.approvalRationale || "This action needs your approval before it can run.",
                };
              });
            }
            break;
          case "step":
            patch({ step: { step: event.step, maxSteps: event.maxSteps } });
            break;
          case "ask":
            updateActive((message) => {
              message.ask = {
                id: event.id,
                question: event.question,
                options: event.options,
                allowOther: event.allowOther,
              };
            });
            break;
          case "done":
            if (generation === storeGeneration && event.sessionId) syncSession(event.sessionId);
            if (event.turnUsage) {
              updateActive((message) => {
                message.usage = event.turnUsage ?? undefined;
              });
            }
            if (event.sessionUsage) patch({ sessionUsage: event.sessionUsage });
            updateActive((message) => {
              // The server's final reply is authoritative. It can carry a
              // deterministic correction or a pending-approval notice that was
              // appended after the streamed text, and the stored transcript
              // already holds that same text.
              if (event.reply) message.text = event.reply;
            });
            break;
          case "stopped":
            if (generation === storeGeneration && event.sessionId) syncSession(event.sessionId);
            updateActive((message) => {
              if (!message.text) message.text = "Stopped.";
            });
            break;
          case "error":
            updateActive((message) => {
              message.text = `Error: ${event.error}`;
              message.error = true;
            });
            break;
          case "compaction":
            updateActive((message) => {
              message.compactedToMessages = event.compactedToMessages;
            });
            break;
        }
      },
    );
  } catch (error) {
    if (isChatAbortError(error) || controller.signal.aborted) {
      updateActive((message) => {
        if (!message.text) message.text = "Stopped.";
      });
    } else if (error instanceof ChatStreamError) {
      // A vanished session must not poison every later turn: drop the id so
      // the next message starts a fresh server conversation.
      if (error.status === 404 && generation === storeGeneration) syncSession(null, null);
      updateActive((message) => {
        message.text = error.message;
        message.error = true;
      });
    } else {
      updateActive((message) => {
        message.text = "Connection interrupted, your message may not have been delivered. Check your connection and try again.";
        message.error = true;
      });
    }
  } finally {
    // A reset or resume started a different conversation while this stream
    // was settling. Do not let the stale turn clear the new run's controls or
    // drain its queue.
    if (generation === storeGeneration) {
      abortRef = null;
      activeAssistant = null;
      patch({ busy: false, step: null, lastTool: null });
      // Steering fallback: anything queued because the server refused steering
      // goes out right after the current run settles, in order.
      const next = state.queue[0];
      if (next !== undefined) {
        patch({ queue: state.queue.slice(1) });
        void runTurn(next);
      }
    }
  }
}

async function steerOrQueue(text: string) {
  // Mid-run messages become steering when the server will take them: they
  // join the running turn at its next loop step. Only when steering is
  // refused or unreachable do we fall back to the visible local queue.
  const generation = storeGeneration;
  const targetSession = sessionId;
  if (targetSession) {
    const outcome = await steerChat({ sessionId: targetSession, message: text });
    // A reset or org switch while steering was in flight must not leak this
    // message into the fresh conversation.
    if (generation !== storeGeneration || sessionId !== targetSession) return;
    if (outcome === "accepted") {
      patch({ messages: [...state.messages, { role: "user", text, steered: true }] });
      return;
    }
  }
  patch({ queue: [...state.queue, text] });
}

export async function sendChatMessage(raw?: string, attachments?: ChatAttachment[]): Promise<void> {
  const text = (raw ?? "").trim().slice(0, CHAT_MESSAGE_MAX_UNITS);
  if (!text) return;
  if (state.busy) {
    await steerOrQueue(text);
    return;
  }
  await runTurn(text, attachments);
}

export function stopChatRun() {
  abortRef?.abort();
}

/** Answers a pending clarification; the choice becomes the next user turn. */
export function answerChatAsk(questionId: string, choice: string) {
  const messages = [...state.messages];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = { ...messages[index]! };
    if (message.role === "assistant" && message.ask?.id === questionId) {
      message.answered = choice;
      messages[index] = message;
      patch({ messages });
      void sendChatMessage(choice);
      return;
    }
  }
}

export function removeQueuedChatMessage(index: number) {
  patch({ queue: state.queue.filter((_, position) => position !== index) });
}

export function setChatCreator(value: boolean) {
  if (value && !state.creatorAvailable) return;
  patch({ creator: value });
}

/**
 * Reopen a server conversation in this tab. The next message appends to the
 * same session, and the server reloads the text and tool history it needs.
 */
export async function resumeChat(id: string, scope?: { organizationId: string; userId: string }): Promise<void> {
  if (scope) setChatScope(scope.organizationId, scope.userId);
  const detail = await fetchSessionDetail(id);
  storeGeneration += 1;
  abortRef?.abort();
  abortRef = null;
  activeAssistant = null;
  const messages = transcriptFromEvents(detail.events);
  const usage = detail.session.tokenUsage
    ? { input: detail.session.tokenUsage.input, output: detail.session.tokenUsage.output, cachedInput: detail.session.tokenUsage.cachedInput ?? 0 }
    : zeroUsage;
  sessionId = id;
  patch({
    messages: messages.length > 0 ? messages : [GREETING],
    busy: false,
    queue: [],
    step: null,
    lastTool: null,
    sessionUsage: usage,
    sessionId: id,
    sessionTitle: detail.session.title,
    resumed: true,
  });
  rememberSession(id);
}

/**
 * Restore the last conversation for this organization and user after a reload.
 * It returns false when there is nothing to restore or the stored session is
 * gone, and it never replaces a conversation that is already on screen.
 */
export async function restoreChatSession(organizationId: string, userId: string): Promise<boolean> {
  if (!organizationId || !userId) return false;
  setChatScope(organizationId, userId);
  if (state.busy || state.messages.length > 1) return false;
  const id = storedSession();
  if (!id) return false;
  try {
    await resumeChat(id);
    return true;
  } catch {
    clearStoredSession();
    return false;
  }
}

/** Start a fresh conversation; the old one remains in the session log. */
export function resetChat() {
  storeGeneration += 1;
  abortRef?.abort();
  abortRef = null;
  sessionId = null;
  activeAssistant = null;
  clearStoredSession();
  patch({
    messages: [GREETING], busy: false, queue: [], step: null, lastTool: null,
    sessionUsage: zeroUsage, sessionId: null, sessionTitle: null, resumed: false,
  });
}

let creatorAvailabilityInFlight: Promise<void> | null = null;

/**
 * Creator mode needs the creator module on (the switchboard read that Vite's
 * Settings and Proposals surfaces use); if the read fails the toggle stays
 * hidden rather than offering a mode the server would refuse.
 */
export function refreshChatCreatorAvailability(): Promise<void> {
  creatorAvailabilityInFlight ??= fetchCreatorEnabled()
    .then((enabled) => {
      patch({ creatorAvailable: enabled });
    })
    .catch(() => {
      patch({ creatorAvailable: false });
    })
    .finally(() => {
      creatorAvailabilityInFlight = null;
    });
  return creatorAvailabilityInFlight;
}

export const chatStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: () => state,
  send: sendChatMessage,
  stop: stopChatRun,
  answerAsk: answerChatAsk,
  removeQueued: removeQueuedChatMessage,
  setCreator: setChatCreator,
  reset: resetChat,
  resume: resumeChat,
  restore: restoreChatSession,
};

export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getState, chatStore.getState);
}
