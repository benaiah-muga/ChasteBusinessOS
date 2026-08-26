"use client";

import { useCallback, useEffect, useRef, useState, use, type CSSProperties } from "react";

interface Msg {
  id: string;
  senderType: string;
  body: string;
  createdAt: string;
}

const SENDER_STYLE: Record<string, CSSProperties> = {
  customer: { background: "#38000a", color: "#fff", marginLeft: "auto" },
  agent: { background: "#f5f5f4", color: "#1c1917" },
  staff: { background: "#f5f5f4", color: "#1c1917" },
  system: { background: "transparent", color: "#78716c", textAlign: "center", fontSize: "12px", maxWidth: "100%" },
};

/**
 * Standalone visitor chat for the embeddable widget. State lives in
 * localStorage so a page navigation on the host site keeps the thread.
 */
export function WidgetChat({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [conversationId, setId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("open");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`chaste-widget:${token}`);
      if (saved) {
        const s = JSON.parse(saved) as { conversationId?: string };
        if (s.conversationId) setId(s.conversationId);
      }
    } catch {
      /* fresh visitor */
    }
  }, [token]);

  useEffect(() => {
    if (!conversationId) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/support/public?token=${encodeURIComponent(token)}&conversationId=${conversationId}`,
        );
        if (res.ok && !stop) {
          const data = (await res.json()) as { status: string; messages: Msg[] };
          setStatus(data.status);
          setMessages(data.messages);
        }
      } catch {
        /* transient network hiccup; next tick retries */
      }
    };
    void poll();
    const t = setInterval(poll, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [conversationId, token]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/support/public", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", token, email, name: name || undefined }),
      });
      if (res.ok) {
        const data = (await res.json()) as { conversationId: string };
        setId(data.conversationId);
        localStorage.setItem(`chaste-widget:${token}`, JSON.stringify({ conversationId: data.conversationId }));
      }
    } finally {
      setBusy(false);
    }
  }, [email, name, token]);

  const send = useCallback(async () => {
    if (!conversationId || !text.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/support/public", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "message", token, conversationId, body: text.trim() }),
      });
      setText("");
      const res = await fetch(
        `/api/support/public?token=${encodeURIComponent(token)}&conversationId=${conversationId}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { status: string; messages: Msg[] };
        setStatus(data.status);
        setMessages(data.messages);
      }
    } finally {
      setBusy(false);
    }
  }, [conversationId, text, token]);

  const callHuman = useCallback(async () => {
    if (!conversationId) return;
    await fetch("/api/support/public", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "human", token, conversationId }),
    });
  }, [conversationId, token]);

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex items-center gap-2 bg-[#38000a] px-4 py-3 text-white">
        <span className="text-sm font-semibold tracking-tight">Chat with us</span>
        <span className="ml-auto text-[11px] text-white/60">
          {status === "escalated" ? "A human is joining" : status === "resolved" ? "Resolved" : "We reply fast"}
        </span>
      </header>

      {!conversationId ? (
        <div className="flex flex-1 flex-col justify-center gap-3 px-5 pb-6">
          <p className="text-sm text-stone-600">
            Leave your email and we&rsquo;ll pick it up from there &mdash; the thread stays right here too.
          </p>
          <input
            aria-label="Your name"
            placeholder="Name (optional)"
            className="rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="Your email"
            type="email"
            placeholder="Email"
            className="rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !/.+@.+\..+/.test(email)}
            onClick={() => void start()}
            className="cursor-pointer rounded-lg bg-[#9b1313] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#7c0f0f] disabled:pointer-events-none disabled:opacity-40"
          >
            Start chatting
          </button>
        </div>
      ) : (
        <>
          <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
            {messages.map((m) => (
              <div key={m.id} className="flex" style={{ justifyContent: m.senderType === "customer" ? "flex-end" : "flex-start" }}>
                <div
                  style={SENDER_STYLE[m.senderType] ?? SENDER_STYLE.agent}
                  className="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed"
                >
                  {m.body}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-stone-100 p-3">
            {status === "open" && (
              <button
                type="button"
                onClick={() => void callHuman()}
                className="mb-2 cursor-pointer text-xs font-medium text-stone-500 underline underline-offset-2 hover:text-stone-700"
              >
                Talk to a human instead
              </button>
            )}
            <div className="flex gap-2">
              <input
                aria-label="Message"
                placeholder={status === "resolved" ? "This conversation is closed" : "Type your message…"}
                disabled={busy || status !== "open"}
                className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400 disabled:opacity-50"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
              />
              <button
                type="button"
                aria-label="Send message"
                disabled={busy || !text.trim() || status !== "open"}
                onClick={() => void send()}
                className="cursor-pointer rounded-lg bg-[#9b1313] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#7c0f0f] disabled:pointer-events-none disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
