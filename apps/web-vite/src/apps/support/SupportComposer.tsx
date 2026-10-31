import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Loader2,
  MessageSquareText,
  Send,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { useToast } from "../../ui/toast";
import { navigate } from "../../navigation";
import {
  fetchSupportLibrary,
  type SupportConversation,
  type SupportLibrary,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";

type ComposerMode = "reply" | "customer";

function draftStorageKey(
  organizationId: string | null,
  conversationId: string,
): string {
  return `chaste.support.composer.v1:${organizationId ?? "org"}:${conversationId}`;
}

export function SupportComposer({
  conversation,
}: {
  conversation: SupportConversation;
}) {
  const {
    organizationId,
    busy,
    sendMessage,
    draftReply,
    actionError,
    clearActionError,
  } = useSupportDesk();
  const { toast } = useToast();
  const [mode, setMode] = useState<ComposerMode>("reply");
  const [value, setValue] = useState("");
  const [aiDrafted, setAiDrafted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [library, setLibrary] = useState<SupportLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryRetry, setLibraryRetry] = useState(0);
  const libraryRequestedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const storageKey = draftStorageKey(organizationId, conversation.id);
  const resolved = conversation.status === "resolved";
  const sending = busy === "message";
  const drafting = busy === "draft";
  const canned = useMemo(() => library?.canned ?? [], [library]);

  useEffect(() => {
    let draft = "";
    try {
      draft = window.localStorage.getItem(storageKey) ?? "";
    } catch {
      // Draft persistence is a convenience, not a requirement.
    }
    setValue(draft);
    setAiDrafted(false);
    setSaved(draft.trim().length > 0);
    setMode("reply");
    setQuickOpen(false);
    clearActionError();
  }, [clearActionError, storageKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        if (value.trim()) window.localStorage.setItem(storageKey, value);
        else window.localStorage.removeItem(storageKey);
        setSaved(value.trim().length > 0);
      } catch {
        // Ignore blocked storage; the message can still be sent.
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [storageKey, value]);

  const focus = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const draft = useCallback(async () => {
    if (resolved || drafting) return;
    const next = await draftReply();
    if (next === null) return;
    if (!next.trim()) {
      toast({
        title: "The copilot returned no draft",
        description: "Write the reply directly, or try again in a moment.",
        tone: "danger",
      });
      return;
    }
    setMode("reply");
    setValue(next);
    setAiDrafted(true);
    toast({
      title: "Draft ready",
      description:
        "Built from this customer's own record. Review it before sending.",
      tone: "success",
    });
    window.setTimeout(focus, 30);
  }, [draftReply, drafting, focus, resolved, toast]);

  useEffect(() => {
    function onFocus() {
      focus();
    }
    function onDraft() {
      void draft();
    }
    window.addEventListener("chaste:support-focus-composer", onFocus);
    window.addEventListener("chaste:support-draft", onDraft);
    return () => {
      window.removeEventListener("chaste:support-focus-composer", onFocus);
      window.removeEventListener("chaste:support-draft", onDraft);
    };
  }, [draft, focus]);

  useEffect(() => {
    if (!quickOpen || library || libraryLoading || libraryRequestedRef.current)
      return;
    const controller = new AbortController();
    libraryRequestedRef.current = true;
    setLibraryLoading(true);
    setLibraryError(null);
    void fetchSupportLibrary(organizationId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setLibrary(next);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLibraryError(
            error instanceof Error
              ? error.message
              : "Could not load quick replies.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLibraryLoading(false);
      });
    return () => controller.abort();
  }, [library, libraryRetry, organizationId, quickOpen]);

  function insertReply(body: string) {
    setMode("reply");
    setAiDrafted(false);
    setValue((current) =>
      current.trim() ? `${current.trimEnd()}\n\n${body}` : body,
    );
    setQuickOpen(false);
    window.setTimeout(focus, 30);
  }

  async function submit() {
    if (!value.trim() || sending || resolved) return;
    const body = value.trim();
    const fromCustomer = mode === "customer";
    const ok = await sendMessage(body, fromCustomer ? "customer" : "staff");
    if (!ok) return;
    setValue("");
    setAiDrafted(false);
    setSaved(false);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Optional persistence only.
    }
    window.dispatchEvent(new CustomEvent("chaste:support-scroll-latest"));
    toast({
      title: fromCustomer ? "Customer message recorded" : "Reply sent",
      description: fromCustomer
        ? "It is on the customer's thread as their words. This does not email them."
        : "It is recorded on the thread as a staff reply.",
      tone: "success",
    });
    window.setTimeout(focus, 30);
  }

  const disabled = resolved || busy !== null;

  return (
    <div className="support-composer">
      <div className="support-composer-top">
        <div
          className="support-composer-modes"
          role="group"
          aria-label="Message mode"
        >
          <button
            type="button"
            aria-pressed={mode === "reply"}
            onClick={() => setMode("reply")}
            disabled={resolved}
          >
            <MessageSquareText size={12} aria-hidden="true" /> Reply
          </button>
          <button
            type="button"
            aria-pressed={mode === "customer"}
            onClick={() => setMode("customer")}
            disabled={resolved}
          >
            <UserRound size={12} aria-hidden="true" /> Log customer message
          </button>
        </div>
        <div className="support-composer-status">
          {resolved && (
            <span className="support-composer-resolved">
              Reopen this conversation to reply
            </span>
          )}
          {!resolved && saved && <span>Draft saved</span>}
          {!resolved && !saved && (
            <span>
              {mode === "customer"
                ? "Recorded as the customer's words"
                : "Recorded on the conversation thread"}
            </span>
          )}
        </div>
      </div>

      {aiDrafted && (
        <div className="support-ai-draft" role="status">
          <Sparkles size={14} aria-hidden="true" />
          <span>
            AI draft, built from this customer's record. Review and edit before
            sending.
          </span>
          <button
            type="button"
            onClick={() => {
              setValue("");
              setAiDrafted(false);
            }}
          >
            <X size={12} aria-hidden="true" /> Discard
          </button>
        </div>
      )}

      {actionError && (
        <div className="support-composer-error" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={clearActionError}
            aria-label="Dismiss error"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className={`support-composer-box${resolved ? " is-disabled" : ""}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setAiDrafted(false);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            mode === "customer"
              ? "Paste what the customer wrote..."
              : "Write a reply to the customer..."
          }
          aria-label={
            mode === "customer"
              ? "Log the customer's message"
              : "Reply to the customer"
          }
          maxLength={4000}
          rows={3}
          disabled={disabled}
        />
        <div className="support-composer-tools">
          <div className="support-composer-tools-left">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void draft()}
              disabled={disabled}
              title="Draft a reply from this customer's record"
            >
              {drafting ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : (
                <Sparkles size={13} aria-hidden="true" />
              )}
              {drafting ? "Drafting..." : "Draft with copilot"}
            </Button>
            <Popover open={quickOpen} onOpenChange={setQuickOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || mode === "customer"}
                >
                  <BookOpen size={13} aria-hidden="true" /> Quick replies
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="support-quick-replies">
                <div className="support-quick-replies-head">
                  <span>Quick replies</span>
                  <button
                    type="button"
                    onClick={() => {
                      setQuickOpen(false);
                      navigate("/support/knowledge");
                    }}
                  >
                    Manage
                  </button>
                </div>
                {libraryLoading && (
                  <p className="support-quick-replies-note">
                    <Loader2
                      size={12}
                      className="support-spin"
                      aria-hidden="true"
                    />{" "}
                    Loading...
                  </p>
                )}
                {libraryError && (
                  <div className="support-quick-replies-error" role="alert">
                    <span>{libraryError}</span>
                    <button
                      type="button"
                      onClick={() => {
                        libraryRequestedRef.current = false;
                        setLibraryError(null);
                        setLibraryRetry((count) => count + 1);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!libraryLoading && !libraryError && canned.length === 0 && (
                  <p className="support-quick-replies-note">
                    No quick replies yet. Add one in Knowledge.
                  </p>
                )}
                {canned.map((reply) => (
                  <button
                    key={reply.id}
                    type="button"
                    className="support-quick-reply"
                    onClick={() => insertReply(reply.body)}
                  >
                    <span className="support-quick-reply-top">
                      <strong>{reply.shortcut}</strong>
                      <span>{reply.title}</span>
                    </span>
                    <span className="support-quick-reply-body">
                      {reply.body}
                    </span>
                    <span className="support-quick-reply-meta">
                      {reply.body.length} characters
                    </span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
          <div className="support-composer-tools-right">
            <span className="support-composer-count">{value.length}/4000</span>
            <span className="support-composer-send-hint">Ctrl/Cmd + Enter</span>
            <Button
              onClick={() => void submit()}
              disabled={disabled || !value.trim()}
              size="sm"
            >
              {sending ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : (
                <Send size={13} aria-hidden="true" />
              )}
              {sending
                ? "Sending..."
                : mode === "customer"
                  ? "Log message"
                  : "Send reply"}
            </Button>
          </div>
        </div>
      </div>
      <p className="support-composer-foot">
        <span>
          {mode === "customer"
            ? "Visible to the team, recorded as the customer's words"
            : "Drafts are never sent without a person releasing them"}
        </span>
        <span>
          {value.trim() ? "Unsaved typing is kept for this conversation" : ""}
        </span>
      </p>
    </div>
  );
}
