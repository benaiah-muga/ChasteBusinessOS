import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  LifeBuoy,
  Loader2,
  Plus,
  RotateCcw,
  Settings,
  WifiOff,
} from "lucide-react";
import { Button } from "../../ui/button";
import { navigate } from "../../navigation";
import { SUPPORT_APP, isAppTabActive } from "../../shell/apps";
import { appTabForPath } from "../../shell/apps";
import { SupportDeskProvider, useSupportDesk } from "./SupportDeskContext";
import { NewConversationDialog } from "./SupportDialogs";
import { SupportInbox } from "./SupportInbox";
import { SupportOverview } from "./SupportOverview";
import { SupportKnowledge } from "./SupportKnowledge";
import { SupportChannels } from "./SupportChannels";
import { SupportSettings } from "./SupportSettings";
import { parseSupportRoute, pendingActionDescription } from "./support-model";
import "./support-app.css";

export function SupportApp({
  pathname,
  baseCurrency,
  actorId,
  organizationId,
}: {
  pathname: string;
  baseCurrency: string | null;
  actorId: string | null;
  organizationId: string | null;
}) {
  const [newOpen, setNewOpen] = useState(false);
  return (
    <SupportDeskProvider
      actorId={actorId}
      organizationId={organizationId}
      baseCurrency={baseCurrency}
      pathname={pathname}
      onNewConversation={() => setNewOpen(true)}
    >
      <SupportAppFrame
        pathname={pathname}
        newOpen={newOpen}
        onNewOpenChange={setNewOpen}
      />
    </SupportDeskProvider>
  );
}

function SupportAppFrame({
  pathname,
  newOpen,
  onNewOpenChange,
}: {
  pathname: string;
  newOpen: boolean;
  onNewOpenChange: (open: boolean) => void;
}) {
  const desk = useSupportDesk();
  const route = parseSupportRoute(pathname);
  const activeTab = appTabForPath(SUPPORT_APP, pathname);
  const counts = desk.conversations.reduce(
    (total, conversation) => {
      if (conversation.status === "open") total.open += 1;
      if (conversation.status === "escalated") total.awaiting += 1;
      return total;
    },
    { open: 0, awaiting: 0 },
  );

  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  const activeTabRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    setTopbarSlot(document.getElementById("support-topbar-slot"));
  }, []);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [pathname, desk.status]);

  useEffect(() => {
    if (
      pathname !== "/support" ||
      desk.status !== "ready" ||
      desk.selectedId ||
      desk.conversations.length === 0
    )
      return;
    if (
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(min-width: 900px)").matches
    )
      return;
    desk.selectConversation(desk.conversations[0]!.id, { replace: true });
  }, [desk, pathname]);

  const pendingText = desk.pending
    ? pendingActionDescription(desk.pending.capabilityId, desk.pending.input)
    : null;

  return (
    <main className="support-app" data-tab={activeTab.id}>
      {topbarSlot &&
        createPortal(
          <div className="support-topbar-actions">
            {desk.status === "ready" ? (
              <span
                className="support-live support-topbar-waiting"
                title="The queue refreshes while this tab is visible"
              >
                <span className="support-live-dot" aria-hidden="true" />
                {counts.open + counts.awaiting} waiting
              </span>
            ) : (
              <span
                className="support-live support-live-muted support-topbar-waiting"
                aria-hidden="true"
              >
                {desk.status === "disabled"
                  ? "Not installed"
                  : desk.status === "failed"
                    ? "Unavailable"
                    : "Connecting"}
              </span>
            )}
            <Button
              variant="primary"
              size="sm"
              className="topbar-create"
              aria-label="New conversation"
              onClick={() => onNewOpenChange(true)}
              disabled={desk.status !== "ready"}
            >
              <Plus size={14} aria-hidden="true" />{" "}
              <span className="support-new-label">New conversation</span>
            </Button>
          </div>,
          topbarSlot,
        )}

      {desk.status === "ready" && (
        <nav
          className="support-app-tabs"
          aria-label="Customer support sections"
        >
          {SUPPORT_APP.tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isAppTabActive(tab, pathname);
            const count =
              tab.id === "inbox" ? counts.open + counts.awaiting : null;
            return (
              <a
                key={tab.id}
                ref={active ? activeTabRef : undefined}
                href={tab.href}
                className="support-app-tab"
                aria-current={active ? "page" : undefined}
                title={tab.description}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(tab.href);
                }}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{tab.label}</span>
                {count !== null && count > 0 && (
                  <span className="support-app-tab-count">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </a>
            );
          })}
          <span className="support-app-tab-spacer" />
          <span className="support-app-tab-note">
            Human decisions stay on the record
          </span>
        </nav>
      )}

      {pendingText && (
        <div className="support-pending-banner" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <div>
            <strong>An action is waiting to be confirmed.</strong>
            <span>
              {pendingText}
              {desk.pendingReason ? ` ${desk.pendingReason}` : ""}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void desk.retryPending()}
            disabled={desk.busy !== null}
          >
            {desk.busy ? (
              <Loader2 size={13} className="support-spin" aria-hidden="true" />
            ) : (
              <RotateCcw size={13} aria-hidden="true" />
            )}
            Retry saved action
          </Button>
        </div>
      )}

      <div className="support-app-body">
        {desk.status === "loading" && <SupportAppSkeleton />}
        {desk.status === "disabled" && (
          <SupportDisabled onRetry={desk.reload} />
        )}
        {desk.status === "failed" && (
          <SupportUnavailable message={desk.loadError} onRetry={desk.reload} />
        )}
        {desk.status === "ready" && route.tab === "inbox" && <SupportInbox />}
        {desk.status === "ready" && route.tab === "overview" && (
          <SupportOverview />
        )}
        {desk.status === "ready" && route.tab === "knowledge" && (
          <SupportKnowledge />
        )}
        {desk.status === "ready" && route.tab === "channels" && (
          <SupportChannels />
        )}
        {desk.status === "ready" && route.tab === "settings" && (
          <SupportSettings />
        )}
        {desk.status === "ready" && route.tab === "not-found" && (
          <SupportNotFound />
        )}
      </div>

      <NewConversationDialog open={newOpen} onOpenChange={onNewOpenChange} />
    </main>
  );
}

function SupportAppSkeleton() {
  return (
    <div
      className="support-app-loading"
      role="status"
      aria-label="Loading the customer support desk"
    >
      <div className="support-skeleton support-skeleton-queue">
        <span className="support-skeleton-line support-skeleton-title" />
        <span className="support-skeleton-line" />
        <span className="support-skeleton-row" />
        <span className="support-skeleton-row" />
        <span className="support-skeleton-row" />
      </div>
      <div className="support-skeleton support-skeleton-thread">
        <span className="support-skeleton-line support-skeleton-title" />
        <span className="support-skeleton-bubble" />
        <span className="support-skeleton-bubble support-skeleton-bubble-short" />
        <span className="support-skeleton-bubble" />
      </div>
      <div className="support-skeleton support-skeleton-context">
        <span className="support-skeleton-line support-skeleton-title" />
        <span className="support-skeleton-line" />
        <span className="support-skeleton-line support-skeleton-short" />
      </div>
    </div>
  );
}

function SupportDisabled({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="support-state-card">
      <span className="support-state-icon" aria-hidden="true">
        <WifiOff size={22} />
      </span>
      <p className="support-eyebrow">Customer support</p>
      <h1>The support app is not installed.</h1>
      <p>
        This workspace has not enabled customer care. A workspace admin can
        install it from Settings under Modules, and this desk will use the same
        governed capability path as the rest of Chaste.
      </p>
      <div className="support-state-actions">
        <Button onClick={() => navigate("/settings")}>
          <Settings size={14} aria-hidden="true" /> Open settings
        </Button>
        <Button variant="ghost" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" /> Check again
        </Button>
      </div>
    </section>
  );
}

function SupportUnavailable({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="support-state-card">
      <span
        className="support-state-icon support-state-icon-danger"
        aria-hidden="true"
      >
        <AlertTriangle size={22} />
      </span>
      <p className="support-eyebrow">Customer support</p>
      <h1>The desk could not open.</h1>
      <p>
        {message ??
          "The support service did not respond. Your conversations are unchanged."}
      </p>
      <div className="support-state-actions">
        <Button onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" /> Try again
        </Button>
        <Button variant="ghost" onClick={() => navigate("/")}>
          Back to home <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

function SupportNotFound() {
  return (
    <section className="support-state-card">
      <span className="support-state-icon" aria-hidden="true">
        <LifeBuoy size={22} />
      </span>
      <p className="support-eyebrow">Customer support</p>
      <h1>That support view does not exist.</h1>
      <p>
        The address does not match a tab in this app. The desk and its
        conversations are unchanged.
      </p>
      <div className="support-state-actions">
        <Button onClick={() => navigate("/support/inbox")}>
          Open the inbox <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
