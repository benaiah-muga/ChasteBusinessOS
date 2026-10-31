import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Globe2,
  Code2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { navigate } from "../../navigation";
import {
  fetchSupportChannels,
  updateSupportChannels,
  type SupportChannels,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";

type Notice = { tone: "pending" | "error" | "success"; text: string };

export function SupportChannels({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { actorId, organizationId } = useSupportDesk();
  const { toast } = useToast();
  const [channels, setChannels] = useState<SupportChannels | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [greeting, setGreeting] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void fetchSupportChannels(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setChannels(result);
        setGreeting(result.greeting);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Channel settings are unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadVersion]);

  async function patch(update: {
    autoReplyEnabled?: boolean;
    greeting?: string;
    regenerateToken?: true;
  }) {
    if (!actorId || !organizationId) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await updateSupportChannels(update, {
        actorId,
        organizationId,
      });
      if (result.status === "pending") {
        setNotice({
          tone: "pending",
          text: `This channel change is waiting for approval (${result.approvalId}). Retry the exact change to recover its status.`,
        });
        return;
      }
      setChannels(result.channels);
      setGreeting(result.channels.greeting);
      toast({ title: "Channel settings saved", tone: "success" });
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The channel settings could not be saved.",
      });
    } finally {
      setBusy(false);
    }
  }

  function copy(value: string, label: string) {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(label);
        window.setTimeout(() => setCopied(null), 1600);
      },
      () =>
        setNotice({
          tone: "error",
          text: "Could not copy. Select the text and copy it manually.",
        }),
    );
  }

  if (loading) {
    return (
      <div className={embedded ? "support-settings-channels" : "support-page"}>
        <p className="support-panel-note" role="status">
          <Loader2 size={13} className="support-spin" aria-hidden="true" />{" "}
          Loading channel settings...
        </p>
      </div>
    );
  }
  if (loadError || !channels) {
    return (
      <div className={embedded ? "support-settings-channels" : "support-page"}>
        <div className="support-panel-error" role="alert">
          <span>{loadError ?? "Channel settings are unavailable."}</span>
          <button
            type="button"
            onClick={() => setReloadVersion((version) => version + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const origin = window.location.origin;
  const snippet = channels.embedToken
    ? `<script src="${origin}/widget.js" data-chaste="${channels.embedToken}" async></script>`
    : null;
  const link = channels.embedToken
    ? `${origin}/widget/${channels.embedToken}`
    : null;
  const greetingChanged = greeting.trim() !== channels.greeting;

  return (
    <div className={embedded ? "support-settings-channels" : "support-page"}>
      {!embedded && (
        <header className="support-page-head">
          <div>
            <p className="support-eyebrow">Channels</p>
            <h1>Where customers reach you</h1>
            <p>
              The website widget and the desk share one governed inbox.
              Auto-replies are explicit, grounded, and always hand off when a
              person is needed.
            </p>
          </div>
          <div className="support-page-actions">
            <span
              className={`support-channel-state${channels.autoReplyEnabled ? " is-on" : ""}`}
            >
              <span className="support-live-dot" aria-hidden="true" />
              {channels.autoReplyEnabled ? "Auto-replies on" : "Auto-replies off"}
            </span>
          </div>
        </header>
      )}

      {notice && (
        <div
          className={`support-inline-notice support-inline-notice-${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </div>
      )}

      <div className="support-channel-grid">
        <section
          className="support-overview-panel support-channel-widget"
          aria-labelledby="support-widget"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-widget">Website widget</h2>
              <p>
                Paste this before the closing body tag. Conversations land in
                the same inbox as desk-created ones.
              </p>
            </div>
            <Globe2 size={17} aria-hidden="true" />
          </header>
          {snippet ? (
            <>
              <div className="support-code-block">
                <span className="support-code-label">Embed snippet</span>
                <pre>{snippet}</pre>
                <button
                  type="button"
                  className="support-code-copy"
                  onClick={() => copy(snippet, "snippet")}
                  aria-label="Copy embed snippet"
                >
                  {copied === "snippet" ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    <Copy size={13} aria-hidden="true" />
                  )}
                  {copied === "snippet" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="support-channel-actions">
                {link && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => copy(link, "link")}
                  >
                    {copied === "link" ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Copy size={13} aria-hidden="true" />
                    )}
                    {copied === "link" ? "Link copied" : "Copy standalone link"}
                  </Button>
                )}
                {link && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      window.open(link, "_blank", "noopener,noreferrer")
                    }
                  >
                    <ExternalLink size={13} aria-hidden="true" /> Open chat page
                  </Button>
                )}
                {channels.canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void patch({ regenerateToken: true })}
                    disabled={busy}
                  >
                    <RefreshCw size={13} aria-hidden="true" /> Regenerate token
                  </Button>
                )}
              </div>
              <p className="support-panel-hint">
                The token identifies this workspace's widget. Regenerating it
                immediately retires the old snippet.
              </p>
            </>
          ) : (
            <div className="support-channel-empty">
              <Code2 size={20} aria-hidden="true" />
              <div>
                <strong>No embed token yet.</strong>
                <p>
                  {channels.canManage
                    ? "Generate a token to put the widget on your site. The first settings save also creates one."
                    : "An organization admin can generate the embed token."}
                </p>
              </div>
              {channels.canManage && (
                <Button
                  size="sm"
                  onClick={() =>
                    void patch({ autoReplyEnabled: channels.autoReplyEnabled })
                  }
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2
                      size={13}
                      className="support-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Globe2 size={13} aria-hidden="true" />
                  )}
                  Generate embed token
                </Button>
              )}
            </div>
          )}
        </section>

        <section
          className="support-overview-panel"
          aria-labelledby="support-ai-behavior"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-ai-behavior">AI behavior</h2>
              <p>
                Auto-replies answer widget visitors only. A handoff still waits
                for a person.
              </p>
            </div>
            <Sparkles size={17} aria-hidden="true" />
          </header>
          <label className="support-toggle">
            <input
              type="checkbox"
              checked={channels.autoReplyEnabled}
              disabled={busy || !channels.canManage}
              onChange={(event) =>
                void patch({ autoReplyEnabled: event.target.checked })
              }
            />
            <span>
              <strong>Answer widget visitors automatically</strong>
              <small>
                Replies are grounded in the knowledge library and the visitor's
                own conversation. Turning this off sends every new message to
                the desk.
              </small>
            </span>
          </label>
          <label className="support-field">
            <span>First message visitors see</span>
            <textarea
              value={greeting}
              onChange={(event) => setGreeting(event.target.value)}
              rows={3}
              maxLength={300}
              disabled={busy || !channels.canManage}
              placeholder="Hi - ask us anything and we'll get right back to you."
            />
          </label>
          <div className="support-channel-actions">
            <Button
              size="sm"
              onClick={() => void patch({ greeting: greeting.trim() })}
              disabled={
                busy ||
                !channels.canManage ||
                !greeting.trim() ||
                !greetingChanged
              }
            >
              {busy ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : null}
              {busy ? "Saving..." : "Save greeting"}
            </Button>
            <span className="support-field-hint">{greeting.length}/300</span>
          </div>
          {!channels.canManage && (
            <p className="support-panel-hint">
              Your role can read these settings. An organization admin can
              change them.
            </p>
          )}
        </section>

        <section
          className="support-overview-panel support-grounding-panel"
          aria-labelledby="support-reach"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-reach">What the AI can reach</h2>
              <p>A short, explicit boundary.</p>
            </div>
            <ShieldCheck size={17} aria-hidden="true" />
          </header>
          <ul>
            <li>
              <span>
                <Check size={11} aria-hidden="true" />
              </span>
              <p>The public articles in this support knowledge library.</p>
            </li>
            <li>
              <span>
                <Check size={11} aria-hidden="true" />
              </span>
              <p>
                The asking visitor's own conversation and order status, nothing
                about another customer.
              </p>
            </li>
            <li>
              <span>
                <Check size={11} aria-hidden="true" />
              </span>
              <p>Nothing else. A handoff thread is answered only by people.</p>
            </li>
          </ul>
          <p className="support-grounding-note">
            Auto-replies are a channel setting, not a hidden default. Every
            handoff and release is on the conversation record and the audit
            ledger.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate("/support/knowledge")}
          >
            Review knowledge
          </Button>
        </section>

        <section
          className="support-overview-panel support-channel-record"
          aria-labelledby="support-channel-record"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-channel-record">Channel record</h2>
              <p>Every settings change is governed and reversible.</p>
            </div>
          </header>
          <dl className="support-record-list">
            <div>
              <dt>Widget status</dt>
              <dd>
                {channels.embedToken ? "Embed token issued" : "Not configured"}
              </dd>
            </div>
            <div>
              <dt>Auto-replies</dt>
              <dd>{channels.autoReplyEnabled ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt>Your access</dt>
              <dd>{channels.canManage ? "Manage" : "Read only"}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
