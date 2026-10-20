import { useSyncExternalStore } from "react";
import { fetchCreatorEnabled } from "./api/proposals";
import {
  CHAT_MESSAGE_MAX_UNITS,
  ChatStreamError,
  isChatAbortError,
  steerChat,
  streamChat,
  type ChatCard,
  type ChatUsage,
} from "./api/chat";

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

async function runTurn(text: string) {
  const messages = [...state.messages, { role: "user" as const, text }, { role: "assistant" as const, text: "" }];
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
        signal: controller.signal,
        onSession: (id) => {
          sessionId = id;
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
            if (event.sessionId) sessionId = event.sessionId;
            if (event.turnUsage) {
              updateActive((message) => {
                message.usage = event.turnUsage ?? undefined;
              });
            }
            if (event.sessionUsage) patch({ sessionUsage: event.sessionUsage });
            updateActive((message) => {
              if (!message.text && event.reply) message.text = event.reply;
            });
            break;
          case "stopped":
            if (event.sessionId) sessionId = event.sessionId;
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
            // The loop compacts its own transcript between steps; the visible
            // conversation is untouched, so there is nothing to render.
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
      if (error.status === 404) sessionId = null;
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

export async function sendChatMessage(raw?: string): Promise<void> {
  const text = (raw ?? "").trim().slice(0, CHAT_MESSAGE_MAX_UNITS);
  if (!text) return;
  if (state.busy) {
    await steerOrQueue(text);
    return;
  }
  await runTurn(text);
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

/** Start a fresh conversation; the old one remains in the session log. */
export function resetChat() {
  storeGeneration += 1;
  abortRef?.abort();
  abortRef = null;
  sessionId = null;
  activeAssistant = null;
  patch({ messages: [GREETING], busy: false, queue: [], step: null, lastTool: null, sessionUsage: zeroUsage });
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
};

export function useChat(): ChatState {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getState, chatStore.getState);
}
