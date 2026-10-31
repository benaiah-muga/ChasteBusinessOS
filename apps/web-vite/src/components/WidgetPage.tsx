import { useCallback, useEffect, useRef, useState } from "react";
import "./WidgetPage.css";
import {
  escalateToHuman,
  pollWidgetThread,
  readStoredThread,
  sendWidgetMessage,
  startWidgetThread,
  storeThread,
  type WidgetMessage,
} from "../api/widget";

const POLL_INTERVAL_MS = 4000;

const STATUS_NOTE: Record<string, string> = {
  escalated: "A human is joining",
  resolved: "Resolved",
  open: "We reply fast",
};

function senderClass(senderType: string): string {
  switch (senderType) {
    case "customer":
      return "widget-bubble-customer";
    case "system":
      return "widget-bubble-system";
    default:
      return "widget-bubble-agent";
  }
}

function tokenFromPath(pathname: string): string {
  const match = /^\/widget\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/**
 * Standalone visitor chat for the embeddable widget. The thread secret is held
 * only in this browser, so a reload on the host site keeps the conversation
 * without the server ever being able to hand it to someone else.
 */
export function WidgetPage({ pathname }: { pathname: string }) {
  const token = tokenFromPath(pathname);
  const [savedThread, setSavedThread] = useState<{
    token: string;
    conversationId: string;
    secret: string;
  } | null>(null);
  const conversationId = savedThread?.token === token ? savedThread.conversationId : null;
  const secret = savedThread?.token === token ? savedThread.secret : null;
  const [threadMessages, setThreadMessages] = useState<{
    token: string;
    conversationId: string;
    messages: WidgetMessage[];
  } | null>(null);
  const activeMessages = threadMessages?.token === token && threadMessages.conversationId === conversationId
    ? threadMessages.messages
    : [];
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [threadStatus, setThreadStatus] = useState<{
    token: string;
    conversationId: string;
    status: string;
  } | null>(null);
  const status = threadStatus?.token === token && threadStatus.conversationId === conversationId
    ? threadStatus.status
    : "open";
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSavedThread(null);
    setThreadMessages(null);
    setThreadStatus(null);
    const stored = readStoredThread(token);
    if (stored) {
      setSavedThread({ token, ...stored });
    }
  }, [token]);

  useEffect(() => {
    if (!conversationId || !secret) return;
    let stop = false;
    const poll = async () => {
      const result = await pollWidgetThread(token, conversationId, secret);
      if (result.status === "ok" && !stop) {
        setThreadStatus({ token, conversationId, status: result.thread.status });
        setThreadMessages({ token, conversationId, messages: result.thread.messages });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [conversationId, secret, token]);

  useEffect(() => {
    const element = scroller.current;
    if (element && typeof element.scrollTo === "function") {
      element.scrollTo({ top: element.scrollHeight });
    }
  }, [activeMessages.length]);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await startWidgetThread(token, email, name || undefined);
      if (result.status === "started") {
        setSavedThread({ token, conversationId: result.conversationId, secret: result.secret });
        setThreadMessages({ token, conversationId: result.conversationId, messages: [] });
        setThreadStatus({ token, conversationId: result.conversationId, status: "open" });
        storeThread(token, { conversationId: result.conversationId, secret: result.secret });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, email, name, token]);

  const send = useCallback(async () => {
    if (busy || !conversationId || !secret || !text.trim() || status !== "open") return;
    setBusy(true);
    try {
      const sent = await sendWidgetMessage(token, conversationId, secret, text.trim());
      if (!sent) return;
      setText("");
      const result = await pollWidgetThread(token, conversationId, secret);
      if (result.status === "ok") {
        setThreadStatus({ token, conversationId, status: result.thread.status });
        setThreadMessages({ token, conversationId, messages: result.thread.messages });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, secret, status, text, token]);

  const callHuman = useCallback(async () => {
    if (busy || !conversationId || !secret || status !== "open") return;
    setBusy(true);
    try {
      if (await escalateToHuman(token, conversationId, secret)) {
        setThreadStatus({ token, conversationId, status: "escalated" });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, secret, status, token]);

  return (
    <div className="widget-root">
      <header className="widget-header">
        <span className="widget-header-title">Chat with us</span>
        <span className="widget-header-note">{STATUS_NOTE[status] ?? "We reply fast"}</span>
      </header>

      {!conversationId ? (
        <div className="widget-intro">
          <p className="widget-intro-copy">
            Leave your email and we&rsquo;ll pick it up from there, and the thread stays right here too.
          </p>
          <label className="widget-field">
            <span className="widget-label">Your name</span>
            <input
              aria-label="Your name"
              placeholder="Name (optional)"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="widget-field">
            <span className="widget-label">Your email</span>
            <input
              aria-label="Your email"
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !/.+@.+\..+/.test(email)}
            onClick={() => void start()}
          >
            Start chatting
          </button>
        </div>
      ) : (
        <>
          <div ref={scroller} className="widget-scroll">
            {activeMessages.map((message) => (
              <div key={message.id} className={`widget-bubble-row ${senderClass(message.senderType)}`}>
                <div className={senderClass(message.senderType)}>{message.body}</div>
              </div>
            ))}
          </div>
          <div className="widget-composer">
            {status === "open" && (
              <button type="button" className="widget-escalate" disabled={busy} onClick={() => void callHuman()}>
                Talk to a human instead
              </button>
            )}
            <div className="widget-composer-row">
              <label className="widget-field widget-field-inline">
                <span className="widget-label">Message</span>
                <input
                  aria-label="Message"
                  placeholder={status === "resolved" ? "This conversation is closed" : "Type your message…"}
                  disabled={busy || status !== "open"}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void send();
                  }}
                />
              </label>
              <button type="button" disabled={busy || status !== "open" || !text.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
