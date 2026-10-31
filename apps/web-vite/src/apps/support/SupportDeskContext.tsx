import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { navigate } from "../../navigation";
import {
  fetchSupportConversations,
  fetchSupportDraft,
  fetchSupportEnabled,
  fetchSupportThread,
  readPendingSupportConversationWrite,
  submitSupportConversationAction,
  supportWriteActionFromPending,
  type PendingSupportConversationWrite,
  type SupportConversation,
  type SupportConversationWriteRetryScope,
  type SupportMessage,
  type SupportWriteAction,
} from "../../api/support";
import { parseSupportRoute } from "./support-model";

type DeskStatus = "loading" | "ready" | "disabled" | "failed";
type ThreadStatus = "idle" | "loading" | "ready" | "failed";
type BusyAction =
  | "message"
  | "ticket"
  | "escalate"
  | "resolve"
  | "reopen"
  | "create"
  | "draft"
  | null;

export type TicketPatch = {
  priority?: "low" | "normal" | "high" | "urgent";
  category?: string | null;
  assigneeUserId?: string | null;
  slaDueAt?: string | null;
};

type ActionOutcome = { ok: boolean; data: Record<string, unknown> | null };

export type SupportDeskValue = {
  actorId: string | null;
  organizationId: string | null;
  baseCurrency: string | null;
  status: DeskStatus;
  loadError: string | null;
  conversations: SupportConversation[];
  conversationsLoading: boolean;
  refreshConversations: () => Promise<void>;
  reload: () => void;
  selectedId: string | null;
  selectConversation: (
    conversationId: string | null,
    options?: { replace?: boolean },
  ) => void;
  threadStatus: ThreadStatus;
  conversation: SupportConversation | null;
  messages: SupportMessage[];
  threadError: string | null;
  refreshThread: () => Promise<void>;
  busy: BusyAction;
  actionError: string | null;
  clearActionError: () => void;
  sendMessage: (body: string, from: "staff" | "customer") => Promise<boolean>;
  updateTicket: (patch: TicketPatch) => Promise<boolean>;
  escalate: (reason: string) => Promise<boolean>;
  setConversationStatus: (action: "resolve" | "reopen") => Promise<boolean>;
  draftReply: () => Promise<string | null>;
  createConversation: (
    customerId: string,
    subject: string,
  ) => Promise<string | null>;
  pending: PendingSupportConversationWrite | null;
  pendingReason: string | null;
  retryPending: () => Promise<void>;
  openNewConversation: () => void;
};

const SupportDeskContext = createContext<SupportDeskValue | null>(null);

export function useSupportDesk(): SupportDeskValue {
  const value = useContext(SupportDeskContext);
  if (!value)
    throw new Error("useSupportDesk must be used inside SupportDeskProvider");
  return value;
}

function friendlyError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The support service is unavailable. Try again.";
}

export function SupportDeskProvider({
  actorId,
  organizationId,
  baseCurrency,
  pathname,
  onNewConversation,
  children,
}: {
  actorId: string | null;
  organizationId: string | null;
  baseCurrency: string | null;
  pathname: string;
  onNewConversation: () => void;
  children: ReactNode;
}) {
  const route = parseSupportRoute(pathname);
  const selectedId = route.conversationId;
  const [status, setStatus] = useState<DeskStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [threadStatus, setThreadStatus] = useState<ThreadStatus>("idle");
  const [threadConversation, setThreadConversation] =
    useState<SupportConversation | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] =
    useState<PendingSupportConversationWrite | null>(null);
  const [pendingReason, setPendingReason] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const threadRequestRef = useRef(0);
  const loadedThreadRef = useRef<string | null>(null);

  const retryScope = useMemo<SupportConversationWriteRetryScope>(
    () => ({ actorId, organizationId }),
    [actorId, organizationId],
  );

  const refreshConversations = useCallback(async () => {
    if (!organizationId) return;
    setConversationsLoading(true);
    try {
      const next = await fetchSupportConversations(organizationId);
      setConversations(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(friendlyError(error));
    } finally {
      setConversationsLoading(false);
    }
  }, [organizationId]);

  const refreshThread = useCallback(async () => {
    const conversationId = selectedRef.current;
    if (!conversationId || !organizationId) {
      loadedThreadRef.current = null;
      setThreadStatus("idle");
      setThreadConversation(null);
      setMessages([]);
      setThreadError(null);
      return;
    }
    const request = ++threadRequestRef.current;
    const alreadyLoaded = loadedThreadRef.current === conversationId;
    if (!alreadyLoaded) setThreadStatus("loading");
    setThreadError(null);
    try {
      const thread = await fetchSupportThread(conversationId, organizationId);
      if (request !== threadRequestRef.current) return;
      loadedThreadRef.current = conversationId;
      setThreadConversation(thread.conversation);
      setMessages(thread.messages);
      setThreadStatus("ready");
    } catch (error) {
      if (request !== threadRequestRef.current) return;
      setThreadError(friendlyError(error));
      if (!alreadyLoaded) setThreadStatus("failed");
    }
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setLoadError(null);
    void (async () => {
      try {
        const enabled = await fetchSupportEnabled();
        if (cancelled) return;
        if (!enabled) {
          setStatus("disabled");
          return;
        }
        const next = await fetchSupportConversations(organizationId);
        if (cancelled) return;
        setConversations(next);
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setLoadError(friendlyError(error));
        setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, reloadVersion]);

  useEffect(() => {
    if (!organizationId || !actorId) return;
    try {
      setPending(
        readPendingSupportConversationWrite({ actorId, organizationId }),
      );
    } catch {
      setPending(null);
    }
  }, [actorId, organizationId]);

  useEffect(() => {
    void refreshThread();
  }, [refreshThread, selectedId]);

  useEffect(() => {
    if (status !== "ready" || !organizationId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshConversations();
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [organizationId, refreshConversations, status]);

  const selectConversation = useCallback(
    (conversationId: string | null, options?: { replace?: boolean }) => {
      navigate(
        conversationId ? `/support/inbox/${conversationId}` : "/support/inbox",
        options?.replace ?? false,
      );
    },
    [],
  );

  const applyAction = useCallback(
    async (action: SupportWriteAction): Promise<ActionOutcome> => {
      const busyKind: BusyAction =
        action.action === "create"
          ? "create"
          : action.action === "message" || action.action === "send"
            ? "message"
            : action.action === "updateTicket"
              ? "ticket"
              : action.action === "escalate"
                ? "escalate"
                : action.action === "resolve"
                  ? "resolve"
                  : action.action === "reopen"
                    ? "reopen"
                    : null;
      setBusy(busyKind);
      setActionError(null);
      try {
        const outcome = await submitSupportConversationAction(
          action,
          retryScope,
        );
        if (outcome.kind === "pending") {
          setPendingReason(outcome.reason);
          try {
            setPending(readPendingSupportConversationWrite(retryScope));
          } catch {
            // The pending notice is still shown even if the local record cannot be read back.
          }
          return { ok: false, data: null };
        }
        setPending(null);
        setPendingReason(null);
        await refreshConversations();
        if (selectedRef.current) await refreshThread();
        return { ok: true, data: outcome.data as Record<string, unknown> };
      } catch (error) {
        try {
          const restored = readPendingSupportConversationWrite(retryScope);
          if (restored) setPending(restored);
        } catch {
          // Keep the original failure visible when retry state cannot be inspected.
        }
        setActionError(friendlyError(error));
        return { ok: false, data: null };
      } finally {
        setBusy(null);
      }
    },
    [refreshConversations, refreshThread, retryScope],
  );

  const sendMessage = useCallback(
    async (body: string, from: "staff" | "customer") => {
      const conversationId = selectedRef.current;
      if (!conversationId || body.trim().length === 0) return false;
      const outcome = await applyAction({
        action: "message",
        conversationId,
        body: body.trim(),
        from,
      });
      return outcome.ok;
    },
    [applyAction],
  );

  const updateTicket = useCallback(
    async (patch: TicketPatch) => {
      const conversationId = selectedRef.current;
      if (!conversationId) return false;
      const outcome = await applyAction({
        action: "updateTicket",
        conversationId,
        ...patch,
      });
      return outcome.ok;
    },
    [applyAction],
  );

  const escalate = useCallback(
    async (reason: string) => {
      const conversationId = selectedRef.current;
      if (!conversationId || reason.trim().length < 3) return false;
      const outcome = await applyAction({
        action: "escalate",
        conversationId,
        reason: reason.trim(),
      });
      return outcome.ok;
    },
    [applyAction],
  );

  const setConversationStatus = useCallback(
    async (action: "resolve" | "reopen") => {
      const conversationId = selectedRef.current;
      if (!conversationId) return false;
      const outcome = await applyAction({ action, conversationId });
      return outcome.ok;
    },
    [applyAction],
  );

  const draftReply = useCallback(async () => {
    const conversationId = selectedRef.current;
    if (!conversationId) return null;
    setBusy("draft");
    setActionError(null);
    try {
      const draft = await fetchSupportDraft(conversationId);
      return draft.draft;
    } catch (error) {
      setActionError(friendlyError(error));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const createConversation = useCallback(
    async (customerId: string, subject: string) => {
      const outcome = await applyAction({
        action: "create",
        customerId,
        subject,
      });
      if (!outcome.ok) return null;
      const conversationId =
        typeof outcome.data?.conversationId === "string"
          ? outcome.data.conversationId
          : null;
      if (conversationId) selectConversation(conversationId);
      return conversationId;
    },
    [applyAction, selectConversation],
  );

  const retryPending = useCallback(async () => {
    if (!pending) return;
    const action = supportWriteActionFromPending(pending);
    const outcome = await applyAction(action);
    if (outcome.ok) setPending(null);
  }, [applyAction, pending]);

  const reload = useCallback(
    () => setReloadVersion((version) => version + 1),
    [],
  );
  const clearActionError = useCallback(() => setActionError(null), []);

  const value = useMemo<SupportDeskValue>(
    () => ({
      actorId,
      organizationId,
      baseCurrency,
      status,
      loadError,
      conversations,
      conversationsLoading,
      refreshConversations,
      reload,
      selectedId,
      selectConversation,
      threadStatus,
      conversation: threadConversation,
      messages,
      threadError,
      refreshThread,
      busy,
      actionError,
      clearActionError,
      sendMessage,
      updateTicket,
      escalate,
      setConversationStatus,
      draftReply,
      createConversation,
      pending,
      pendingReason,
      retryPending,
      openNewConversation: onNewConversation,
    }),
    [
      actionError,
      actorId,
      clearActionError,
      baseCurrency,
      busy,
      conversations,
      conversationsLoading,
      createConversation,
      draftReply,
      escalate,
      loadError,
      messages,
      onNewConversation,
      organizationId,
      pending,
      pendingReason,
      refreshConversations,
      refreshThread,
      reload,
      retryPending,
      selectConversation,
      selectedId,
      sendMessage,
      setConversationStatus,
      status,
      threadConversation,
      threadError,
      threadStatus,
      updateTicket,
    ],
  );

  return (
    <SupportDeskContext.Provider value={value}>
      {children}
    </SupportDeskContext.Provider>
  );
}
