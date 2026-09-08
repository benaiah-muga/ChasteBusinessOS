"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared chat state so the console surface and the floating corner widget
 * render one continuous conversation: shrinking the console to the widget
 * (or expanding back) never loses history or an in-flight stream.
 */

export interface TokenUsage {
  input: number;
  output: number;
  cachedInput: number;
}

export interface AskPayload {
  id: string;
  question: string;
  options?: string[];
  allowOther: boolean;
}

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  activity?: string[];
  detail?: string;
  error?: boolean;
  /** Set when the model asked a clarification question in this message. */
  ask?: AskPayload;
  /** The option (or free text) the user answered with, once answered. */
  answered?: string;
  /** Token usage for this assistant turn, from the provider's own report. */
  usage?: TokenUsage;
}

interface ChatState {
  messages: ChatMsg[];
  busy: boolean;
  creator: boolean;
  /** Typed-but-not-sent messages while a run is in flight (auto-queued). */
  queue: string[];
  /** Current loop position, for the live console strip. */
  step: { step: number; maxSteps: number } | null;
  /** Last tool the agent called, for the live status line. */
  lastTool: string | null;
  /** Cumulative tokens for this conversation (server-reported). */
  sessionUsage: TokenUsage;
}

const GREETING: ChatMsg = {
  role: "assistant",
  text: "Hi, I'm your business workmate. Ask me to do things, or ask about your books. Everything I do goes through the same governed path as you.",
};

const zeroUsage: TokenUsage = { input: 0, output: 0, cachedInput: 0 };

let state: ChatState = {
  messages: [GREETING],
  busy: false,
  creator: false,
  queue: [],
  step: null,
  lastTool: null,
  sessionUsage: zeroUsage,
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function patch(part: Partial<ChatState>) {
  state = { ...state, ...part };
  emit();
}

function updateLast(mutate: (m: ChatMsg) => void) {
  const messages = [...state.messages];
  const last = { ...messages[messages.length - 1]! };
  mutate(last);
  messages[messages.length - 1] = last;
  patch({ messages });
}

let sessionId: string | undefined;
let abortRef: AbortController | null = null;

async function runTurn(text: string) {
  patch({
    messages: [...state.messages, { role: "user", text }, { role: "assistant", text: "", activity: [] }],
    busy: true,
    step: null,
    lastTool: null,
  });

  abortRef = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: text,
        ...(sessionId ? { sessionId } : {}),
        mode: state.creator ? "creator" : "assist",
      }),
      signal: abortRef.signal,
    });

    if (!res.body) throw new Error("no stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const evt = JSON.parse(line) as {
          type: string;
          text?: string;
          name?: string;
          reply?: string;
          sessionId?: string;
          error?: string;
          step?: number;
          maxSteps?: number;
          id?: string;
          question?: string;
          options?: string[];
          allowOther?: boolean;
          usage?: { turn?: TokenUsage; session?: TokenUsage };
        };
        if (evt.type === "delta") {
          updateLast((m) => {
            m.text += evt.text ?? "";
          });
        } else if (evt.type === "tool") {
          patch({ lastTool: evt.name ?? null });
          updateLast((m) => {
            m.activity = [...(m.activity ?? []), evt.name ?? ""];
          });
        } else if (evt.type === "step") {
          patch({
            step: { step: evt.step ?? 0, maxSteps: evt.maxSteps ?? 0 },
          });
        } else if (evt.type === "ask") {
          updateLast((m) => {
            m.ask = {
              id: evt.id ?? "",
              question: evt.question ?? "",
              options: evt.options,
              allowOther: evt.allowOther ?? true,
            };
          });
        } else if (evt.type === "done") {
          sessionId = evt.sessionId ?? sessionId;
          const turn = evt.usage?.turn;
          const session = evt.usage?.session;
          if (turn) {
            updateLast((m) => {
              m.usage = turn;
            });
          }
          if (session) patch({ sessionUsage: session });
          updateLast((m) => {
            if (!m.text && evt.reply) m.text = evt.reply;
          });
        } else if (evt.type === "stopped") {
          updateLast((m) => {
            if (!m.text) m.text = "Stopped.";
          });
        } else if (evt.type === "error") {
          updateLast((m) => {
            m.text = `Error: ${evt.error}`;
            m.error = true;
          });
        }
      }
    }
  } catch (err) {
    updateLast((m) => {
      if ((err as Error).name === "AbortError") {
        if (!m.text) m.text = "Stopped.";
      } else {
        m.text = "Connection interrupted, your message may not have been delivered. Check your connection and try again.";
        m.detail = String(err);
        m.error = true;
      }
    });
  } finally {
    abortRef = null;
    patch({ busy: false, step: null, lastTool: null });
    // Steering, chat-style: anything typed mid-run goes out right after the
    // current run settles, in order.
    const next = state.queue[0];
    if (next !== undefined) {
      patch({ queue: state.queue.slice(1) });
      void runTurn(next);
    }
  }
}

async function send(textRaw?: string) {
  const text = (textRaw ?? "").trim();
  if (!text) return;
  if (state.busy) {
    // Queue instead of dropping: the message visibly waits and auto-sends.
    patch({ queue: [...state.queue, text] });
    return;
  }
  await runTurn(text);
}

/** Answers a pending clarification; the choice becomes the next user turn. */
function answerAsk(questionId: string, choice: string) {
  const messages = [...state.messages];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = { ...messages[i]! };
    if (m.role === "assistant" && m.ask?.id === questionId) {
      m.answered = choice;
      messages[i] = m;
      patch({ messages });
      void send(choice);
      return;
    }
  }
}

function removeQueued(text: string) {
  patch({ queue: state.queue.filter((q) => q !== text) });
}

function reset() {
  abortRef?.abort();
  sessionId = undefined;
  patch({ messages: [GREETING], busy: false, queue: [], step: null, lastTool: null, sessionUsage: zeroUsage });
}

export const chatStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
  send,
  stop: () => abortRef?.abort(),
  answerAsk,
  removeQueued,
  setCreator: (v: boolean) => patch({ creator: v }),
  /** Start a fresh conversation; the old one remains in the session log. */
  reset,
};

export function useChat(): ChatState {
  // Server snapshot keeps SSR deterministic; hydration adopts the live store.
  return useSyncExternalStore(chatStore.subscribe, chatStore.getState, chatStore.getState);
}
