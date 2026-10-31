import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  Building2,
  Gauge,
  Radio,
  ScrollText,
  Users,
} from "lucide-react";
import { Button } from "../../ui/button";
import { navigate } from "../../navigation";
import {
  fetchNotificationPreferences,
  saveNotificationPreferences,
  NotificationPreferencesError,
} from "../../api/notification-preferences";
import {
  SettingsWorkspace,
  type SettingsNavGroup,
} from "../../components/SettingsWorkspace";
import { useSupportDesk } from "./SupportDeskContext";
import { SupportChannels } from "./SupportChannels";
import "./SupportSettings.css";

type SupportSettingsSection =
  "overview" | "channels" | "notifications" | "workspace" | "audit";

const SECTIONS: Array<{
  id: SupportSettingsSection;
  label: string;
  description: string;
  group: "Desk" | "Configuration";
  icon: typeof Gauge;
}> = [
  {
    id: "overview",
    label: "Overview",
    description: "Desk status and the short path to every setting.",
    group: "Desk",
    icon: Gauge,
  },
  {
    id: "channels",
    label: "Channels",
    description: "Widget, greeting, auto-reply, and the AI boundary.",
    group: "Desk",
    icon: Radio,
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Your support ticket notifications.",
    group: "Desk",
    icon: Bell,
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Shared organization, modules, AI, and team settings.",
    group: "Configuration",
    icon: Building2,
  },
  {
    id: "audit",
    label: "Audit",
    description: "Support evidence and the immutable event trail.",
    group: "Configuration",
    icon: ScrollText,
  },
];

export function SupportSettings() {
  const desk = useSupportDesk();
  const [active, setActive] = useState<SupportSettingsSection>("overview");
  const counts = desk.conversations.reduce(
    (total, conversation) => {
      if (conversation.status === "open") total.open += 1;
      if (conversation.status === "escalated") total.awaiting += 1;
      if (conversation.status === "resolved") total.resolved += 1;
      return total;
    },
    { open: 0, awaiting: 0, resolved: 0 },
  );
  const groups: SettingsNavGroup[] = (["Desk", "Configuration"] as const).map(
    (label) => ({
      label,
      items: SECTIONS.filter((section) => section.group === label).map(
        (section) => ({
          id: section.id,
          label: section.label,
          description: section.description,
          icon: section.icon,
          onSelect: () => setActive(section.id),
        }),
      ),
    }),
  );

  return (
    <div className="support-page support-settings-page">
      <SettingsWorkspace
        embedded
        eyebrow="Customer support / Configuration"
        title="Support settings"
        lede="The desk's own settings sit here. Shared organization, AI, and access settings stay in CBOS Settings, and every write remains governed, auditable, and reversible where policy allows."
        status={
          <>
            <span className="settings-status-dot" aria-hidden="true" />
            <strong>
              {desk.status === "ready"
                ? "Desk connected"
                : desk.status === "disabled"
                  ? "Not installed"
                  : desk.status === "failed"
                    ? "Unavailable"
                    : "Connecting"}
            </strong>
            <span>{counts.open + counts.awaiting} waiting</span>
            <span>Human decisions on record</span>
          </>
        }
        groups={groups}
        activeId={active}
        note={
          <>
            <strong>
              <Users size={12} aria-hidden="true" /> People stay accountable
            </strong>
            <p>
              Assignment, approval, and escalation stay human decisions. The
              support app records who did what on every thread.
            </p>
          </>
        }
      >
        {active === "overview" && (
          <SupportSettingsOverview counts={counts} onOpen={setActive} />
        )}
        {active === "channels" && <SupportChannels embedded />}
        {active === "notifications" && <SupportNotificationSettings />}
        {active === "workspace" && <SupportWorkspaceSettings />}
        {active === "audit" && <SupportAuditSettings />}
      </SettingsWorkspace>
    </div>
  );
}

function SupportSettingsOverview({
  counts,
  onOpen,
}: {
  counts: { open: number; awaiting: number; resolved: number };
  onOpen: (section: SupportSettingsSection) => void;
}) {
  return (
    <div className="support-settings-overview">
      <div
        className="support-settings-stat-grid"
        aria-label="Loaded support queue"
      >
        <div className="support-settings-stat">
          <span>Open</span>
          <strong>{counts.open}</strong>
          <small>Loaded queue</small>
        </div>
        <div className="support-settings-stat">
          <span>Awaiting human</span>
          <strong>{counts.awaiting}</strong>
          <small>Needs a person</small>
        </div>
        <div className="support-settings-stat">
          <span>Resolved</span>
          <strong>{counts.resolved}</strong>
          <small>Loaded queue</small>
        </div>
      </div>

      <div className="support-settings-grid">
        <section className="support-settings-card">
          <div className="support-settings-card-head">
            <div>
              <p className="support-settings-eyebrow">Channel</p>
              <h3>Website widget and auto-replies</h3>
            </div>
            <Radio size={16} aria-hidden="true" />
          </div>
          <p>
            The widget, first message, auto-reply switch, and the explicit AI
            reach boundary are all desk settings.
          </p>
          <Button size="sm" onClick={() => onOpen("channels")}>
            Configure channels
          </Button>
        </section>

        <section className="support-settings-card">
          <div className="support-settings-card-head">
            <div>
              <p className="support-settings-eyebrow">Notifications</p>
              <h3>Support ticket alerts</h3>
            </div>
            <Bell size={16} aria-hidden="true" />
          </div>
          <p>
            Choose whether filed support tickets reach your in-app bell. The
            support queue itself stays the source of truth.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onOpen("notifications")}
          >
            Review notifications
          </Button>
        </section>
      </div>

      <section className="support-settings-card">
        <div className="support-settings-card-head">
          <div>
            <p className="support-settings-eyebrow">Shortcuts</p>
            <h3>Related surfaces</h3>
          </div>
        </div>
        <div className="support-settings-link-grid">
          <SupportSettingsLink
            title="Knowledge library"
            detail="Quick replies and public articles"
            onClick={() => navigate("/support/knowledge")}
          />
          <SupportSettingsLink
            title="Team & access"
            detail="People, roles, and invitations"
            onClick={() => navigate("/team")}
          />
          <SupportSettingsLink
            title="Workspace settings"
            detail="Organization facts, currency, and print branding"
            onClick={() => navigate("/settings/workspace")}
          />
          <SupportSettingsLink
            title="AI providers"
            detail="Providers, models, and coding agents"
            onClick={() => navigate("/settings/ai")}
          />
          <SupportSettingsLink
            title="Agent persona"
            detail="Persona and organization memory"
            onClick={() => navigate("/settings/agent")}
          />
        </div>
      </section>
    </div>
  );
}

function SupportNotificationSettings() {
  const [kinds, setKinds] = useState<string[]>([]);
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<"loading" | "ready" | "saving" | "failed">(
    "loading",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchNotificationPreferences(controller.signal)
      .then((preferences) => {
        if (controller.signal.aborted) return;
        setKinds(preferences.kinds);
        setMuted(new Set(preferences.mutedKinds));
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof NotificationPreferencesError
            ? reason.message
            : "Notification preferences could not be loaded.",
        );
        setState("failed");
      });
    return () => controller.abort();
  }, []);

  const supported = kinds.includes("ticket.filed");

  function toggle() {
    setMuted((current) => {
      const next = new Set(current);
      if (next.has("ticket.filed")) next.delete("ticket.filed");
      else next.add("ticket.filed");
      return next;
    });
    setMessage(null);
  }

  async function save() {
    setState("saving");
    setError(null);
    try {
      const preferences = await saveNotificationPreferences([...muted]);
      setKinds(preferences.kinds);
      setMuted(new Set(preferences.mutedKinds));
      setState("ready");
      setMessage("Support notification preference saved.");
    } catch (reason) {
      setState("ready");
      setError(
        reason instanceof NotificationPreferencesError
          ? reason.message
          : "Notification preferences could not be saved.",
      );
    }
  }

  return (
    <section className="support-settings-card">
      <div className="support-settings-card-head">
        <div>
          <p className="support-settings-eyebrow">Your notifications</p>
          <h3>Support tickets</h3>
        </div>
        <Bell size={16} aria-hidden="true" />
      </div>
      <p>
        This is a personal preference, not a queue rule. Muted events stay in
        the audit record and approvals still need a decision.
      </p>
      {state === "loading" && (
        <p className="support-settings-muted" role="status">
          Loading notification preferences...
        </p>
      )}
      {state === "failed" && (
        <div className="support-settings-error" role="alert">
          {error}
        </div>
      )}
      {state !== "loading" && state !== "failed" && (
        <>
          {supported ? (
            <label className="support-toggle">
              <input
                type="checkbox"
                checked={!muted.has("ticket.filed")}
                disabled={state === "saving"}
                onChange={toggle}
              />
              <span>
                <strong>Notify me when a support ticket is filed</strong>
                <small>
                  Shows ticket events in the in-app bell and Inbox. The support
                  queue still shows every conversation.
                </small>
              </span>
            </label>
          ) : (
            <p className="support-settings-muted">
              Support ticket notifications are not available for this workspace.
            </p>
          )}
          {error && (
            <div className="support-settings-error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <p className="support-settings-success" role="status">
              {message}
            </p>
          )}
          <div className="support-settings-actions">
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={state === "saving" || !supported}
            >
              {state === "saving" ? "Saving..." : "Save preference"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate("/settings/notifications")}
            >
              All notification settings <ArrowUpRight size={13} />
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function SupportWorkspaceSettings() {
  return (
    <>
      <section className="support-settings-card">
        <div className="support-settings-card-head">
          <div>
            <p className="support-settings-eyebrow">Shared configuration</p>
            <h3>What lives outside the support app</h3>
          </div>
        </div>
        <p>
          Support shares the organization's people, models, branding, and module
          switchboard. Open the owning surface instead of editing a second copy
          here.
        </p>
        <div className="support-settings-link-grid">
          <SupportSettingsLink
            title="Workspace & branding"
            detail="Organization facts, base currency, and print branding"
            onClick={() => navigate("/settings/workspace")}
          />
          <SupportSettingsLink
            title="Email delivery"
            detail="SMTP status and a verified test send"
            onClick={() => navigate("/settings/email")}
          />
          <SupportSettingsLink
            title="Modules & apps"
            detail="Install or remove business modules"
            onClick={() => navigate("/settings/modules")}
          />
          <SupportSettingsLink
            title="AI providers"
            detail="Model provider, credentials, and coding agents"
            onClick={() => navigate("/settings/ai")}
          />
          <SupportSettingsLink
            title="Agent persona & memory"
            detail="Standing instructions and learned organization facts"
            onClick={() => navigate("/settings/agent")}
          />
          <SupportSettingsLink
            title="Team & access"
            detail="People, roles, and invitations"
            onClick={() => navigate("/team")}
          />
          <SupportSettingsLink
            title="Global notifications"
            detail="All workspace notification preferences"
            onClick={() => navigate("/settings/notifications")}
          />
        </div>
      </section>
    </>
  );
}

function SupportAuditSettings() {
  return (
    <div className="support-settings-grid">
      <section className="support-settings-card">
        <div className="support-settings-card-head">
          <div>
            <p className="support-settings-eyebrow">Local trail</p>
            <h3>Conversation activity</h3>
          </div>
          <ScrollText size={16} aria-hidden="true" />
        </div>
        <p>
          Each thread keeps the system and agent activity beside the messages.
          The Overview shows the queue's recent work and handoffs.
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => navigate("/support/overview")}
        >
          Open support overview
        </Button>
      </section>
      <section className="support-settings-card">
        <div className="support-settings-card-head">
          <div>
            <p className="support-settings-eyebrow">Immutable record</p>
            <h3>Audit ledger</h3>
          </div>
          <ScrollText size={16} aria-hidden="true" />
        </div>
        <p>
          Support writes use the governed capability pipeline, so their events
          live in the workspace ledger with the rest of the business record.
        </p>
        <Button size="sm" onClick={() => navigate("/ledger")}>
          Open audit ledger
        </Button>
      </section>
    </div>
  );
}

function SupportSettingsLink({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="support-settings-link" onClick={onClick}>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </button>
  );
}
