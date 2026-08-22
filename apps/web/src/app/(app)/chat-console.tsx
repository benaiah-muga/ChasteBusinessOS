"use client";

import { useRef, useState } from "react";

interface Msg {
  role: "user" | "assistant";
  text: string;
  activity?: string[];
}

export function ChatConsole() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text: "Hi — I'm your business co-worker. Ask me to do things: “create a customer called Acme”, “invoice them for 20 lamps at $120 with $60 tax”, or ask me anything about your books.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "", activity: [] }]);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: sessionId.current }),
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
          const evt = JSON.parse(line);
          if (evt.type === "delta") {
            setMessages((m) => {
              const copy = [...m];
              const last = copy.at(-1)!;
              last.text += evt.text;
              return copy;
            });
            scrollToBottom();
          } else if (evt.type === "tool") {
            setMessages((m) => {
              const copy = [...m];
              const last = copy.at(-1)!;
              last.activity = [...(last.activity ?? []), evt.name];
              return copy;
            });
          } else if (evt.type === "done") {
            sessionId.current = evt.sessionId ?? sessionId.current;
            setMessages((m) => {
              const copy = [...m];
              const last = copy.at(-1)!;
              if (!last.text) last.text = evt.reply;
              last.activity = undefined;
              return copy;
            });
          } else if (evt.type === "error") {
            setMessages((m) => {
              const copy = [...m];
              const last = copy.at(-1)!;
              last.text = `Error: ${evt.error}`;
              last.activity = undefined;
              return copy;
            });
          }
        }
      }
    } catch (err) {
      setMessages((m) => {
        const copy = [...m];
        const last = copy.at(-1)!;
        last.text = `Connection error: ${String(err)}`;
        last.activity = undefined;
        return copy;
      });
    } finally {
      setBusy(false);
      scrollToBottom();
    }
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-6">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-emerald-700 px-4 py-2.5 text-white"
                  : "max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-4 py-2.5"
              }
            >
              {m.activity && m.activity.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {m.activity.map((a, j) => (
                    <span key={j} className="animate-pulse rounded-full bg-indigo-100 px-2 py-0.5 font-mono text-[10px] text-indigo-800">
                      {a}
                    </span>
                  ))}
                </div>
              )}
              {m.text || (m.activity?.length ? "" : <span className="animate-pulse text-neutral-400">thinking…</span>)}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-3 border-t border-neutral-200 p-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything, or describe what you need done…"
          className="flex-1 rounded-lg border border-neutral-300 px-4 py-2.5 focus:border-emerald-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-lg bg-emerald-700 px-5 py-2.5 font-medium text-white hover:bg-emerald-800 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
