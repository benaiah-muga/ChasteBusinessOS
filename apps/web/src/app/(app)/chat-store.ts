"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared chat state so the console surface and the floating corner widget
 * render one continuous conversation: shrinking the console to the widget
 * (or expanding back) never loses history or an in-flight stream.
 */

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  activity?: string[];
  detail?: string;
  error?: boolean;
}

interface ChatState {
  messages: ChatMsg[];
  busy: boolean;
  creator: boolean;
}

const GREETING: ChatMsg = {
  role: "assistant",
  text: "Hi, I'm your business workmate. Ask me to do things, or ask about your books. Everything I do goes through the same governed path as you.",
};

let state: ChatState = { messages: [GREETING], busy: false, creator: false };

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

async function send(textRaw?: string) {
  const text = (textRaw ?? "").trim();
  if (!text || state.busy) return;
  patch({
    messages: [...state.messages, { role: "user", text }, { role: "assistant", text: "", activity: [] }],
    busy: true,
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
        };
        if (evt.type === "delta") {
          updateLast((m) => {
            m.text += evt.text ?? "";
          });
        } else if (evt.type === "tool") {
          updateLast((m) => {
            m.activity = [...(m.activity ?? []), evt.name ?? ""];
          });
        } else if (evt.type === "done") {
          sessionId = evt.sessionId ?? sessionId;
          updateLast((m) => {
            if (!m.text && evt.reply) m.text = evt.reply;
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
    patch({ busy: false });
  }
}

function reset() {
  abortRef?.abort();
  sessionId = undefined;
  patch({ messages: [GREETING], busy: false });
}

export const chatStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
  send,
  stop: () => abortRef?.abort(),
  setCreator: (v: boolean) => patch({ creator: v }),
  /** Start a fresh conversation; the old one remains in the session log. */
  reset,
};

export function useChat(): ChatState {
  // Server snapshot keeps SSR deterministic; hydration adopts the live store.
  return useSyncExternalStore(chatStore.subscribe, chatStore.getState, chatStore.getState);
}
