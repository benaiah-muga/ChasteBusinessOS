import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessagesPage,
  activeMentionQuery,
  applyMentionAlias,
  bubbleTone,
  conversationCounts,
  extractMentions,
  formatFileSize,
  insertIntoText,
  isGroupedWith,
  isNearBottom,
  personAlias,
  reconcileOlderMessages,
  seenByReaders,
  visibleConversations,
} from "./MessagesPage";
import {
  MAX_ATTACHMENT_BYTES,
  deleteMessage,
  getPendingMessageDelete,
  getPendingMessageEdit,
  type Conversation,
  type Message,
  type MessageReader,
  type Person,
} from "../api/messaging";

const me = "user-1";
const other = "user-2";
const channelId = "6f1c1f4a-2f6f-4a2a-9d0a-0b9a5f1c1f4a";
const dmId = "7a2b2c5b-3a7a-4b3b-8e1b-1c0b6a2d3e5f";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: channelId,
    kind: "channel",
    title: "general",
    agentEnabled: true,
    archivedAt: null,
    createdByMe: true,
    unreadCount: 0,
    lastMessage: { at: "2026-10-01T09:00:00.000Z", body: "Morning all" },
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    senderType: "human",
    senderUserId: me,
    body: "Morning all",
    createdAt: "2026-10-01T09:00:00.000Z",
    editedAt: null,
    parentMessageId: null,
    pinnedAt: null,
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

const people: Person[] = [
  { type: "user", id: me, name: "Ada Lovelace" },
  { type: "user", id: other, name: "Grace Hopper" },
  { type: "agent", id: "agent-1", name: "Chaste" },
];

function threadBody(overrides: Record<string, unknown> = {}) {
  return {
    conversation: {
      id: channelId,
      orgId: "8e5cb82c-5b5c-47f5-9e8a-089f6f482126",
      kind: "channel",
      title: "general",
      agentEnabled: true,
      createdByUserId: me,
      createdAt: "2026-10-01T08:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    },
    messages: [message()],
    me,
    readers: [{ userId: me, name: "Ada Lovelace", lastReadAt: "2026-10-01T09:00:00.000Z" }] as MessageReader[],
    pinnedMessages: [],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

type Route = { match: (path: string, init?: RequestInit) => Response | null };

function capabilityId(path: string, init?: RequestInit): string | null {
  if (path !== "/api/capabilities/execute" || init?.method !== "POST") return null;
  try {
    const id = (JSON.parse(String(init.body ?? "{}")) as { capabilityId?: unknown }).capabilityId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function isGoCapability(path: string, init: RequestInit | undefined, id: string): boolean {
  return capabilityId(path, init) === id;
}

function capabilityResponse(data: unknown): Response {
  return Response.json({ ok: true, data });
}

function peopleCapabilityResponse(found: Person[]): Response {
  return capabilityResponse({ people: found });
}

function router(routes: Route[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    for (const route of routes) {
      const response = route.match(path, init);
      if (response) return response;
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
}

const moduleRoute: Route = { match: (path) => (path === "/api/modules" ? Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] }) : null) };
const peopleRoute: Route = { match: (path, init) => (isGoCapability(path, init, "messaging.listPeople") ? peopleCapabilityResponse(people) : null) };
const presenceRoute: Route = { match: (path, init) => (path.includes("/presence") && init?.method !== "POST" ? Response.json({ people: [] }) : path.includes("/presence") ? Response.json({ ok: true }) : null) };
const emptyList = (conversations: Conversation[] = [conversation()]): Route => ({
  match: (path, init) => (isGoCapability(path, init, "messaging.listConversations") ? capabilityResponse({ conversations, me }) : null),
});
const threadRoute = (overrides: Record<string, unknown> = {}): Route => ({
  match: (path, init) => (isGoCapability(path, init, "messaging.readMessages") ? capabilityResponse(threadBody(overrides)) : null),
});

/** jsdom always reports a narrow viewport; the page needs a wide one to auto open a channel. */
function stubWideViewport() {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ media: query, matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
  });
}

beforeEach(() => {
  stubWideViewport();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("messages page pure logic", () => {
  it("resolves a mention alias for a person and for the agent", () => {
    expect(personAlias(people[0]!)).toBe("Ada");
    expect(personAlias(people[2]!)).toBe("Chaste");
  });

  it("extracts only mentions that resolve to a known person or agent", () => {
    const mentions = extractMentions("@Ada and @Chaste and @Nobody asked", people);
    expect(mentions).toEqual([{ type: "user", id: me }, { type: "agent", id: "agent-1" }]);
    expect(extractMentions("no mentions here", people)).toEqual([]);
  });

  it("detects the mention token immediately before the caret", () => {
    expect(activeMentionQuery("hello @gr", 9)).toBe("gr");
    expect(activeMentionQuery("hello @", 7)).toBe("");
    expect(activeMentionQuery("hello @gr", 5)).toBeNull();
    expect(activeMentionQuery("hello world", 11)).toBeNull();
  });

  it("replaces the mention token and leaves the caret after the inserted alias", () => {
    expect(applyMentionAlias("hello @gr", 9, "Grace")).toEqual({ text: "hello @Grace ", caret: 13 });
    expect(insertIntoText("ship it", 0, 0, "✅ ")).toEqual({ text: "✅ ship it", caret: 2 });
  });

  it("separates customer, agent, and system bubbles", () => {
    expect(bubbleTone(message({ senderType: "agent", senderUserId: null }), me)).toBe("agent");
    expect(bubbleTone(message(), me)).toBe("mine");
    expect(bubbleTone(message({ senderUserId: other }), me)).toBe("colleague");
    expect(bubbleTone(message({ senderType: "system", senderUserId: null }), me)).toBe("system");
    expect(bubbleTone(message(), null)).toBe("colleague");
  });

  it("groups only consecutive messages from the same sender inside five minutes", () => {
    const first = message({ id: "a", createdAt: "2026-10-01T09:00:00.000Z" });
    expect(isGroupedWith(first, message({ id: "b", createdAt: "2026-10-01T09:02:00.000Z" }))).toBe(true);
    expect(isGroupedWith(first, message({ id: "c", createdAt: "2026-10-01T09:06:00.000Z" }))).toBe(false);
    expect(isGroupedWith(first, message({ id: "d", senderUserId: other, createdAt: "2026-10-01T09:01:00.000Z" }))).toBe(false);
    expect(isGroupedWith(first, message({ id: "e", parentMessageId: "a", createdAt: "2026-10-01T09:01:00.000Z" }))).toBe(false);
    expect(isGroupedWith(first, message({ id: "f", createdAt: "2026-10-02T09:01:00.000Z" }))).toBe(false);
    expect(isGroupedWith(undefined, message())).toBe(false);
  });

  it("reports read receipts only for your own messages", () => {
    const readers: MessageReader[] = [
      { userId: me, name: "Ada", lastReadAt: "2026-10-01T09:30:00.000Z" },
      { userId: other, name: "Grace", lastReadAt: "2026-10-01T09:30:00.000Z" },
    ];
    expect(seenByReaders(message(), readers, me)).toEqual(["Grace"]);
    expect(seenByReaders(message({ senderUserId: other }), readers, me)).toEqual([]);
  });

  it("keeps the thread pinned only while the reader is at the end", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 760, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 })).toBe(false);
  });

  it("prepends an older page without duplicating messages the thread already holds", () => {
    const current = [message({ id: "b" }), message({ id: "c" })];
    const merged = reconcileOlderMessages(current, [message({ id: "a" }), message({ id: "b" })]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("filters the conversation list by archive state and search text", () => {
    const conversations = [
      conversation(),
      conversation({ id: dmId, kind: "dm", title: "Grace Hopper", lastMessage: { at: "2026-10-01T09:00:00.000Z", body: "Ship review" } }),
      conversation({ id: "arch", title: "old", archivedAt: "2026-09-01T09:00:00.000Z" }),
    ];
    expect(conversationCounts(conversations)).toEqual({ active: 2, archived: 1 });
    expect(visibleConversations(conversations, "archived", "").map((entry) => entry.title)).toEqual(["old"]);
    expect(visibleConversations(conversations, "active", "ship").map((entry) => entry.title)).toEqual(["Grace Hopper"]);
    expect(visibleConversations(conversations, "active", "").map((entry) => entry.title)).toEqual(["general", "Grace Hopper"]);
  });

  it("formats attachment sizes for the file chip", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("keeps the legacy five megabyte attachment ceiling", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("messages page states", () => {
  it("prefills the active Messages composer from a dashboard workmate prompt", async () => {
    const prompt = "Draft an invoice for a customer. Ask me for the details you need.";
    window.history.replaceState(null, "", `/messages?workmatePrompt=${encodeURIComponent(prompt)}`);
    vi.stubGlobal("fetch", router([
      moduleRoute,
      emptyList(),
      threadRoute(),
      peopleRoute,
      presenceRoute,
    ]));

    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general") as HTMLTextAreaElement;
    expect(composer.value).toBe(prompt);
    expect(window.location.search).toBe("");
    expect(window.localStorage.getItem(`chaste:message-draft:${me}:${channelId}`)).toBe(prompt);
  });

  it("keeps a dashboard prompt visible beside an existing draft until the user appends it", async () => {
    const prompt = "Draft an invoice for a customer. Ask me for the details you need.";
    const savedDraft = "I was already writing a reply.";
    window.localStorage.setItem(`chaste:message-draft:${me}:${channelId}`, savedDraft);
    window.history.replaceState(null, "", `/messages?workmatePrompt=${encodeURIComponent(prompt)}`);
    vi.stubGlobal("fetch", router([
      moduleRoute,
      emptyList(),
      threadRoute(),
      peopleRoute,
      presenceRoute,
    ]));

    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general") as HTMLTextAreaElement;
    expect(composer.value).toBe(savedDraft);
    expect(screen.getByRole("group", { name: "Dashboard prompt" }).textContent).toContain(prompt);
    expect(window.location.search).toContain("workmatePrompt=");

    fireEvent.click(screen.getByRole("button", { name: "Append to draft" }));
    const combinedDraft = `${savedDraft}\n\n${prompt}`;
    await waitFor(() => expect(composer.value).toBe(combinedDraft));
    expect(window.localStorage.getItem(`chaste:message-draft:${me}:${channelId}`)).toBe(combinedDraft);
    expect(window.location.search).toBe("");

    cleanup();
    render(<MessagesPage />);
    expect((await screen.findByLabelText("Message general") as HTMLTextAreaElement).value).toBe(combinedDraft);
  });

  it("keeps the composer unchanged when dashboard prompt persistence fails, then recovers on append", async () => {
    const prompt = "Draft an invoice for a customer. Ask me for the details you need.";
    const storageKey = `chaste:message-draft:${me}:${channelId}`;
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    let failFirstWrite = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      if (key === storageKey && failFirstWrite) {
        failFirstWrite = false;
        throw new DOMException("storage unavailable", "QuotaExceededError");
      }
      setItem(key, value);
    });
    window.history.replaceState(null, "", `/messages?workmatePrompt=${encodeURIComponent(prompt)}`);
    vi.stubGlobal("fetch", router([moduleRoute, emptyList(), threadRoute(), peopleRoute, presenceRoute]));

    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general") as HTMLTextAreaElement;
    expect(composer.value).toBe("");
    expect(screen.getByRole("group", { name: "Dashboard prompt" }).textContent).toContain(prompt);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(window.location.search).toContain("workmatePrompt=");

    fireEvent.click(screen.getByRole("button", { name: "Append to draft" }));

    await waitFor(() => expect(composer.value).toBe(prompt));
    expect(window.localStorage.getItem(storageKey)).toBe(prompt);
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("group", { name: "Dashboard prompt" })).toBeNull();
  });

  it("keeps a dashboard prompt queued when URL cleanup fails and appends idempotently", async () => {
    const prompt = "Draft an invoice for a customer. Ask me for the details you need.";
    const storageKey = `chaste:message-draft:${me}:${channelId}`;
    const replaceState = window.history.replaceState.bind(window.history);
    replaceState(null, "", `/messages?workmatePrompt=${encodeURIComponent(prompt)}`);
    const replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("history unavailable", "SecurityError");
    });
    vi.stubGlobal("fetch", router([moduleRoute, emptyList(), threadRoute(), peopleRoute, presenceRoute]));

    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general") as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toBe(prompt));
    expect(screen.getByRole("group", { name: "Dashboard prompt" })).not.toBeNull();
    expect(window.location.search).toContain("workmatePrompt=");

    fireEvent.click(screen.getByRole("button", { name: "Append to draft" }));

    expect(composer.value).toBe(prompt);
    expect(window.localStorage.getItem(storageKey)).toBe(prompt);
    expect(screen.getByRole("group", { name: "Dashboard prompt" })).not.toBeNull();

    replaceStateSpy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Append to draft" }));
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("group", { name: "Dashboard prompt" })).toBeNull();
    expect(composer.value).toBe(prompt);
    replaceState(null, "", "/");
  });

  it("explains that the module is switched off instead of rendering the thread", async () => {
    vi.stubGlobal("fetch", router([
      { match: (path) => (path === "/api/modules" ? Response.json({ catalog: [{ id: "crm" }, { id: "messaging" }], enabledModules: ["crm"] }) : null) },
    ]));
    render(<MessagesPage />);
    expect(await screen.findByText("Messages is turned off")).not.toBeNull();
    expect(screen.queryByLabelText("Conversations")).toBeNull();
  });

  it("surfaces a load failure with a retry that reloads the list", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) {
        attempts += 1;
        return attempts === 1 ? Response.json({}, { status: 500 }) : capabilityResponse({ conversations: [conversation()], me });
      }
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load your conversations");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Morning all")).not.toBeNull();
  });

  it("renders the initial thread returned by the selected Go read capability", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) {
        const request = JSON.parse(String(init?.body)) as { input?: { conversationId?: string; limit?: number } };
        expect(request.input).toEqual({ conversationId: channelId, limit: 60 });
        return Response.json({ ok: true, data: threadBody({ messages: [message({ body: "Go thread from the selected capability" })] }) });
      }
      return Response.json({ error: "unexpected legacy thread read" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MessagesPage />);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/capabilities/execute")).toBe(true);
    });
    const thread = await screen.findByLabelText("Messages in general");
    expect(await within(thread).findByText("Go thread from the selected capability")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/conversations/${channelId}/messages`)).toBe(false);
  });

  it("shows Go mention-people failures instead of silently using an empty list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Response.json({ error: "disabled" }, { status: 503 });
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) return Response.json({ error: "disabled" }, { status: 503 });
      return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("disabled");
    const peopleLookup = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.listPeople",
    );
    expect(JSON.parse(String(peopleLookup?.[1]?.body))).toMatchObject({ input: { limit: 100 } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/conversations/people"))).toBe(false);
  });

  it("shows Go add-member lookup failures in the conversation settings dialog", async () => {
    let capabilityCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) {
        capabilityCalls += 1;
        if (capabilityCalls === 1) return Response.json({ ok: true, data: { people } });
        return Response.json({ error: "service unavailable" }, { status: 503 });
      }
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        capabilityCalls += 1;
        if (capabilityCalls === 1) return Response.json({ ok: true, data: { people } });
        return Response.json({ error: "service unavailable" }, { status: 503 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      if (path.includes("/presence")) return Response.json({ people: [] });
      return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("option", { name: /general/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a colleague by name" }), { target: { value: "Grace" } });

    const dialog = await screen.findByRole("dialog", { name: /#general/ });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("service unavailable");
    expect(fetchMock.mock.calls.some(([path, init]) => {
      if (String(path) !== "/api/capabilities/execute") return false;
      const body = JSON.parse(String(init?.body)) as { capabilityId?: string; input?: { query?: string; limit?: number } };
      return body.capabilityId === "messaging.listPeople" && body.input?.query === "Grace" && body.input.limit === 30;
    })).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/conversations/people"))).toBe(false);
  });

  it("shows the empty state and creates a channel through the Go capability", async () => {
    const created: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.createConversation")) {
        created.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return capabilityResponse({ conversationId: channelId });
      }
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Create your first channel" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "operations" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ capabilityId: "messaging.createConversation", input: { title: "operations", agentEnabled: true }, intentId: expect.any(String) });
  });

  it("locks duplicate Go creates, retries errors with the same intent, and never falls back", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_CREATE__", true);
    const creates: Record<string, unknown>[] = [];
    const legacyPosts: string[] = [];
    let releaseFirst: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations" && init?.method === "POST") {
        legacyPosts.push(path);
        return Response.json({ error: "unexpected legacy create" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        creates.push(body);
        if (creates.length === 1) {
          return new Promise<Response>((resolve) => { releaseFirst = resolve; });
        }
        if (creates.length === 2) return Response.json({ error: "Go service unavailable." }, { status: 503 });
        return Response.json({ ok: true, data: { conversationId: dmId } });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      if (path.includes("/presence")) return Response.json({ people: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="6a7c5482-c5a6-4fcb-8b69-a06d4820238a" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create a conversation" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "ops" } });
    const form = screen.getByLabelText("New channel name").closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      capabilityId: "messaging.createConversation",
      input: { title: "ops", agentEnabled: true },
      intentId: expect.any(String),
    });

    await act(async () => {
      releaseFirst?.(Response.json({ error: "Go service unavailable." }, { status: 503 }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Go service unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(creates).toHaveLength(2));
    expect(creates[1]?.intentId).toBe(creates[0]?.intentId);
    expect(legacyPosts).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "operations" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(creates).toHaveLength(3));
    expect(creates[2]?.input).toEqual({ title: "operations", agentEnabled: true });
    expect(creates[2]?.intentId).not.toBe(creates[0]?.intentId);
    expect(legacyPosts).toHaveLength(0);
  });

  it("restores an unresolved create only for the same actor and organization", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_CREATE__", true);
    const creates: Record<string, unknown>[] = [];
    let requestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations")) {
        creates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        requestCount += 1;
        if (requestCount === 1) return Response.json({ error: "Connection lost after submission." }, { status: 503 });
        return Response.json({ ok: true, data: { conversationId: dmId } });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      if (path.includes("/presence")) return Response.json({ people: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = { actorId: "actor-1", organizationId: "org-1" };
    const firstMount = render(<MessagesPage {...scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a conversation" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "private ops" } });
    fireEvent.click(screen.getByLabelText("Include Chaste (AI workmate)"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Connection lost after submission.");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ input: { title: "private ops", agentEnabled: false }, intentId: expect.any(String) });
    firstMount.unmount();

    const otherActor = render(<MessagesPage actorId="actor-2" organizationId="org-1" />);
    await screen.findByRole("button", { name: "Create a conversation" });
    expect(screen.queryByLabelText("New channel name")).toBeNull();
    otherActor.unmount();
    const otherOrganization = render(<MessagesPage actorId="actor-1" organizationId="org-2" />);
    await screen.findByRole("button", { name: "Create a conversation" });
    expect(screen.queryByLabelText("New channel name")).toBeNull();
    otherOrganization.unmount();

    const restoredMount = render(<MessagesPage {...scope} />);
    const titleInput = await screen.findByLabelText("New channel name");
    expect((titleInput as HTMLInputElement).value).toBe("private ops");
    expect((screen.getByLabelText("Include Chaste (AI workmate)") as HTMLInputElement).checked).toBe(false);
    expect((await screen.findByRole("status")).textContent).toMatch(/earlier channel creation is unresolved.*same request/i);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(creates).toHaveLength(2));
    expect(creates[1]?.intentId).toBe(creates[0]?.intentId);
    expect(creates[1]?.input).toEqual({ title: "private ops", agentEnabled: false });
    await screen.findByRole("button", { name: "Create a conversation" });
    restoredMount.unmount();
    render(<MessagesPage {...scope} />);
    await screen.findByRole("button", { name: "Create a conversation" });
    expect(screen.queryByLabelText("New channel name")).toBeNull();
  });

  it("continues a Go create when session storage is unavailable", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_CREATE__", true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
    const creates: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        creates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ pendingApproval: true, reason: "Manager approval is required." }, { status: 202 });
      }
      if (path.includes("/presence")) return Response.json({ people: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId="actor-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create a conversation" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("status")).textContent).toContain("Manager approval is required.");
    expect(creates).toHaveLength(1);
  });

  it("keeps a pending channel creation visible as pending, never as success or error", async () => {
    const posts: Record<string, unknown>[] = [];
    let listReads = 0;
    const fetchMock = router([
      moduleRoute,
      peopleRoute,
      presenceRoute,
      {
        match: (path, init) => {
          if (isGoCapability(path, init, "messaging.createConversation")) {
            posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval is required." }, { status: 202 });
          }
          if (!isGoCapability(path, init, "messaging.listConversations")) return null;
          listReads += 1;
          return capabilityResponse({ conversations: [], me });
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Create your first channel" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/approval.*details are saved.*same request/i);
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(listReads).toBeGreaterThan(1));
    expect(screen.getByLabelText("New channel name")).toHaveProperty("value", "ops");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.intentId).toBe(posts[0]?.intentId);
  });

  it("advances the read cursor for the newest message and reconciles the list", async () => {
    const readCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        const body = JSON.parse(String(init?.body)) as { capabilityId?: string };
        if (body.capabilityId === "messaging.advanceReadCursor") {
          readCalls.push(String(init?.body));
          return Response.json({ ok: true, data: { conversationId: conversation().id, previousReadAt: null } });
        }
      }
      if (path.endsWith("/read")) {
        readCalls.push(String(init?.body));
        return Response.json({ ok: true });
      }
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody({ readers: [] }));
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_MESSAGING_READ_CURSOR__", true);
    render(<MessagesPage />);

    await waitFor(() => expect(readCalls).toHaveLength(1));
    expect(JSON.parse(readCalls[0]!)).toMatchObject({
      capabilityId: "messaging.advanceReadCursor",
      input: { conversationId: conversation().id, readAt: "2026-10-01T09:00:00.000Z" },
      intentId: expect.any(String),
    });
  });

  it("marks a message pending rather than sent when the governed write returns 202", async () => {
    const posts: string[] = [];
    vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async () => new ArrayBuffer(32));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.sendMessage")) {
        posts.push(String(init?.body));
        return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="8e5cb82c-5b5c-47f5-9e8a-089f6f482126" />);

    const composer = await screen.findByLabelText("Message general");
    await screen.findAllByText("Morning all");
    fireEvent.change(composer, { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(posts.length > 0 || screen.queryByRole("alert") !== null).toBe(true));
    expect(posts, screen.queryByRole("alert")?.textContent).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toMatchObject({ capabilityId: "messaging.sendMessage", input: { body: "Ship it" }, intentId: expect.any(String) });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Manager review required"), { timeout: 5_000 });
    expect(screen.getByRole("status").textContent).toContain("Your draft is still in this composer");
    expect((composer as HTMLTextAreaElement).value).toBe("Ship it");
    expect(screen.queryByRole("alert")).toBeNull();
  }, 15_000);

  it("restores the exact Go message edit after approval is pending and the page reloads", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    const first = render(<MessagesPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    const editor = await screen.findByLabelText("Edit message");
    fireEvent.change(editor, { target: { value: "Corrected after reload" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(paths).toContain("/api/capabilities/execute"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Manager review required"));
    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("Corrected after reload");
    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    first.unmount();
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", false);
    render(<MessagesPage {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("Corrected after reload"));
    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).readOnly).toBe(true);
    const editRequests = () => fetchMock.mock.calls.filter(([path, init]) => {
      if (String(path) !== "/api/capabilities/execute") return false;
      return (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.editMessage";
    });
    const priorEditRequest = JSON.parse(String(editRequests()[0]?.[1]?.body)) as { intentId: string };
    const editRequestCount = editRequests().length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("status")).textContent).toContain("Manager review required");
    await waitFor(() => expect(editRequests()).toHaveLength(editRequestCount + 1));
    const goBody = JSON.parse(String(fetchMock.mock.calls.find(([path, init]) =>
      String(path) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.editMessage",
    )?.[1]?.body)) as Record<string, unknown>;
    expect(goBody).toMatchObject({ capabilityId: "messaging.editMessage", input: { body: "Corrected after reload" }, intentId: priorEditRequest.intentId });
  });

  it("keeps a Go edit 404 locked across selector rollback without calling legacy PATCH", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) return Response.json({ error: "route unavailable" }, { status: 404 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    const first = render(<MessagesPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    fireEvent.change(await screen.findByLabelText("Edit message"), { target: { value: "Retry after route recovery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByLabelText("Edit message")).toHaveProperty("readOnly", true));
    expect(await getPendingMessageEdit({ actorId: me, organizationId: props.organizationId }))
      .toMatchObject({ messageId: "m1", body: "Retry after route recovery", intentId: expect.any(String) });
    expect(paths).not.toContain("/api/messages/m1");
    expect(paths.some((path) => path.startsWith("/api/messages/m1?"))).toBe(false);

    first.unmount();
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", false);
    render(<MessagesPage {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).readOnly).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("route unavailable");
    expect(paths).not.toContain("/api/messages/m1");
    expect(paths.some((path) => path.startsWith("/api/messages/m1?"))).toBe(false);
  });

  it("blocks message edits until the Go actor, organization, and conversation scope is resolved", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "PATCH" || (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages"))) writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    fireEvent.change(await screen.findByLabelText("Edit message"), { target: { value: "Must wait for scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("actor, organization, and conversation are resolved");
    expect(writes).toEqual([]);
    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("Must wait for scope");
  });

  it("blocks selector-off edits until actor and organization scope can check recovery", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", false);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "PATCH") writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    fireEvent.change(await screen.findByLabelText("Edit message"), { target: { value: "Must not send without scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("actor, organization, and conversation are resolved");
    expect(writes).toEqual([]);
  });

  it("does not let a stale Go edit response clear the next scope's editor state", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    let finishRequest: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        return new Promise((resolve) => { finishRequest = resolve; });
      }
      if (path === "/api/modules") return Promise.resolve(Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] }));
      if (isGoCapability(path, init, "messaging.listConversations")) return Promise.resolve(capabilityResponse({ conversations: [conversation()], me }));
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Promise.resolve(Response.json({ people: [] }));
      if (isGoCapability(path, init, "messaging.readMessages")) return Promise.resolve(capabilityResponse(threadBody()));
      return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const scopeA = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    const view = render(<MessagesPage {...scopeA} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    fireEvent.change(await screen.findByLabelText("Edit message"), { target: { value: "Scope A edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything()));

    view.rerender(<MessagesPage actorId={other} organizationId="7d15d9ac-d8b6-4f49-8ca5-387adf08b8e5" />);
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "Scope B draft" } });
    await act(async () => { finishRequest(Response.json({
      ok: true,
      data: { messageId: "m1", body: "Morning all", expectedBody: "Scope A edit", expectedEditedAt: "2026-10-01T09:00:00.000Z", editedAt: "2026-10-01T09:00:00.000Z" },
    })); });

    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("Scope B draft");
    expect(screen.queryByText("Message updated.")).toBeNull();
  });

  it("restores the Go message deletion confirmation and intent after reload", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const capabilityBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        capabilityBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      }
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { ...props, conversationId: channelId });
    expect(capabilityBodies).toHaveLength(1);
    expect(capabilityBodies[0]).toMatchObject({ capabilityId: "messaging.deleteMessage", input: { messageId: "m1" }, intentId: expect.any(String) });
    render(<MessagesPage {...props} />);
    const restoredDialog = await screen.findByRole("alertdialog", { name: "Delete this message?" });
    expect((within(restoredDialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(restoredDialog).getByRole("button", { name: "Delete message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(restoredDialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(restoredDialog.parentElement!);
    expect(screen.getByRole("alertdialog", { name: "Delete this message?" })).not.toBeNull();
    fireEvent.click(within(restoredDialog).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(capabilityBodies).toHaveLength(2));
    expect(capabilityBodies[1]?.intentId).toBe(capabilityBodies[0]?.intentId);
  });

  it("restores and retries an unresolved Go deletion with the same intent", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) || path.startsWith("/api/messages/")) writes.push(path);
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) return Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { ...props, conversationId: channelId });
    const originalIntent = JSON.parse(String(fetchMock.mock.calls.find(([path, init]) =>
      String(path) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.deleteMessage",
    )?.[1]?.body)) as { intentId?: string };

    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    render(<MessagesPage {...props} />);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this message?" });
    expect((within(dialog).getByRole("button", { name: "Delete message" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    const retried = JSON.parse(String(fetchMock.mock.calls.filter(([path, init]) =>
      String(path) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.deleteMessage",
    )[1]?.[1]?.body)) as { intentId?: string };
    expect(retried.intentId).toBe(originalIntent.intentId);
  });

  it("recovers a transient Go deletion failure with the same intent", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    let serviceRestored = false;
    let deleteAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isGoCapability(path, init, "messaging.deleteMessage")) {
        deleteAttempts += 1;
        if (!serviceRestored) return Response.json({ error: "service unavailable" }, { status: 503 });
        return capabilityResponse({ deleted: true, messageId: "m1", deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z" });
      }
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    render(<MessagesPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));
    const scope = { actorId: me, organizationId: props.organizationId };
    await waitFor(async () => expect(await getPendingMessageDelete(scope)).toMatchObject({ messageId: "m1", conversationId: channelId, retryLocked: false }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this message?" });
    const deleteButton = within(dialog).getByRole("button", { name: "Delete message" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);

    const initialAttempt = fetchMock.mock.calls.find(([, init]) => isGoCapability("/api/capabilities/execute", init, "messaging.deleteMessage"));
    const originalIntentId = (JSON.parse(String(initialAttempt?.[1]?.body)) as { intentId: string }).intentId;
    serviceRestored = true;
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteAttempts).toBe(2));
    await waitFor(async () => expect(await getPendingMessageDelete(scope)).toBeNull());
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => isGoCapability("/api/capabilities/execute", init, "messaging.deleteMessage"));
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls.map(([, init]) => (JSON.parse(String(init?.body)) as { intentId: string }).intentId)).toEqual([originalIntentId, originalIntentId]);
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).startsWith("/api/messages/") && init?.method === "DELETE")).toBe(false);
  });

  it("blocks selector-off deletion when a pending Go marker cannot be checked for missing scope", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const scope = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await deleteMessage("m1", undefined, { ...scope, conversationId: channelId });
    expect(await getPendingMessageDelete(scope)).toMatchObject({ messageId: "m1", conversationId: channelId });

    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) || (path.startsWith("/api/messages/") && init?.method === "DELETE")) writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("actor, organization, and conversation are resolved");
    expect(writes).toEqual([]);
    await expect(getPendingMessageDelete(scope)).resolves.toMatchObject({ messageId: "m1", conversationId: channelId });
  });

  it.each([true, false])("blocks message deletion until actor and organization scope resolve when Go selector is %s", async (goDeleteEnabled) => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", goDeleteEnabled);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) || path.startsWith("/api/messages/")) writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("actor, organization, and conversation are resolved");
    expect(writes).toEqual([]);
  });

  it("ignores a stale Go deletion response after the active actor or organization changes", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const finishRequests: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        return new Promise((resolve) => { finishRequests.push(resolve); });
      }
      if (path === "/api/modules") return Promise.resolve(Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] }));
      if (isGoCapability(path, init, "messaging.listConversations")) return Promise.resolve(capabilityResponse({ conversations: [conversation()], me }));
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Promise.resolve(Response.json({ people: [] }));
      if (isGoCapability(path, init, "messaging.readMessages")) return Promise.resolve(capabilityResponse(threadBody()));
      return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const scopeA = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    const view = render(<MessagesPage {...scopeA} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(finishRequests).toHaveLength(1));

    view.rerender(<MessagesPage actorId={other} organizationId="7d15d9ac-d8b6-4f49-8ca5-387adf08b8e5" />);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Delete this message?" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(finishRequests).toHaveLength(2));
    await act(async () => {
      finishRequests[1]?.(Response.json({ pendingApproval: true, reason: "B review required." }, { status: 202 }));
    });
    expect(screen.getByRole("alertdialog", { name: "Delete this message?" })).not.toBeNull();

    await act(async () => {
      finishRequests[0]?.(Response.json({ ok: true, data: { deleted: true } }));
    });
    expect(screen.getByRole("alertdialog", { name: "Delete this message?" })).not.toBeNull();
    expect(screen.queryByText("Message deleted.")).toBeNull();
  });

  it("closes a restored deletion confirmation when the actor or organization changes", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const capabilityBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        capabilityBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 });
      }
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scopeA = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { ...scopeA, conversationId: channelId });
    const view = render(<MessagesPage {...scopeA} />);
    expect(await screen.findByRole("alertdialog", { name: "Delete this message?" })).not.toBeNull();

    view.rerender(<MessagesPage actorId={other} organizationId="7d15d9ac-d8b6-4f49-8ca5-387adf08b8e5" />);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Delete this message?" })).toBeNull());
    expect(capabilityBodies).toHaveLength(1);
  });

  it("does not send a restored Go deletion after its actor and organization become unresolved", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const deleteRequests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) || path.startsWith("/api/messages/m1?intentId=")) deleteRequests.push(path);
      if (path === "/api/capabilities/execute" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) return Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scopeA = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { ...scopeA, conversationId: channelId });
    const view = render(<MessagesPage {...scopeA} />);
    expect(await screen.findByRole("alertdialog", { name: "Delete this message?" })).not.toBeNull();
    expect(deleteRequests).toHaveLength(1);

    view.rerender(<MessagesPage actorId={null} organizationId={null} />);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Delete this message?" })).toBeNull());
    expect(deleteRequests).toHaveLength(1);
  });

  it("keeps the draft and raises an alert when the send fails", async () => {
    const fetchMock = router([
      moduleRoute,
      peopleRoute,
      presenceRoute,
      emptyList(),
      {
        match: (path, init) => (isGoCapability(path, init, "messaging.readMessages") && init?.method === "POST"
          ? Response.json({ error: "no capacity" }, { status: 422 })
          : isGoCapability(path, init, "messaging.readMessages") ? capabilityResponse(threadBody()) : null),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    fireEvent.change(composer, { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("no capacity");
    expect((composer as HTMLTextAreaElement).value).toBe("Ship it");
  });

  it("persists the draft per conversation and per user", async () => {
    window.localStorage.clear();
    const fetchMock = router([
      moduleRoute,
      peopleRoute,
      presenceRoute,
      {
        match: (path, init) => (isGoCapability(path, init, "messaging.listConversations")
          ? capabilityResponse({ conversations: [conversation(), conversation({ id: dmId, kind: "dm", title: "Grace Hopper" })], me })
          : null),
      },
      {
        match: (path, init) => (isGoCapability(path, init, "messaging.readMessages")
          ? capabilityResponse(threadBody())
          : null),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    fireEvent.change(composer, { target: { value: "half written" } });
    await waitFor(
      () => expect(window.localStorage.getItem(`chaste:message-draft:${me}:${channelId}`)).toBe("half written"),
      { timeout: 5_000 },
    );
  });

it("reports typing presence after the debounce and clears it on the mount heartbeat", async () => {
    const typingBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence") && init?.method === "POST") { typingBodies.push(String(init?.body)); return Response.json({ ok: true }); }
      if (path.includes("/presence")) return Response.json({ people: [{ userId: other, name: "Grace", typing: true }] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    expect((await screen.findAllByText(/Grace is typing/)).length).toBeGreaterThan(0);

    fireEvent.change(composer, { target: { value: "typing now" } });
    await waitFor(() => expect(typingBodies.map((body) => JSON.parse(body).typing)).toContain(true));
    expect(typingBodies.every((body) => JSON.parse(body).intentId)).toBe(true);
    // The mount heartbeat tells the server the composer started empty.
    expect(JSON.parse(typingBodies[0]!).typing).toBe(false);
  });

it("sends page presence heartbeats and typing updates through the Go session route", async () => {
    const presenceWrites: { path: string; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path === `/api/conversations/${channelId}/presence` && init?.method === "POST") {
        presenceWrites.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({ ok: true, data: { previousLastSeenAt: null, previousTypingUntil: null } });
      }
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    await waitFor(() => expect(presenceWrites.some(({ body }) => body.typing === false)).toBe(true));
    fireEvent.change(composer, { target: { value: "typing now" } });
    await waitFor(() => expect(presenceWrites.some(({ body }) => body.typing === true)).toBe(true));
    expect(presenceWrites.every(({ path }) => path === `/api/conversations/${channelId}/presence`)).toBe(true);
    expect(presenceWrites.every(({ body }) => typeof body.intentId === "string" && body.intentId.length > 0)).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/presence") && String(path).endsWith("/presence"))).toBe(true);
  });

  it("polls the thread on the legacy five second cadence and pins to the newest message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let threadCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
        if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
        if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
        if (path.includes("/presence")) return Response.json({ people: [] });
        if (isGoCapability(path, init, "messaging.readMessages")) { threadCalls += 1; return capabilityResponse(threadBody({ messages: [message({ id: `m${threadCalls}` })] })); }
        return Response.json({ error: "not found" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { container } = render(<MessagesPage />);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      const scroller = screen.getByLabelText("Messages in general");
      let pinnedTo: number | null = null;
      Object.defineProperty(scroller, "scrollHeight", { get: () => 900, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { get: () => 300, configurable: true });
      Object.defineProperty(scroller, "scrollTop", { get: () => 620, set: (value: number) => { pinnedTo = value; }, configurable: true });

      const before = threadCalls;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(threadCalls).toBeGreaterThan(before);
      expect(pinnedTo).toBe(900);
      expect(container.querySelector(".messages-thread-scroll")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an around and older thread window stable during polling away from the bottom", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const threadInputs: Array<Record<string, unknown>> = [];
      let presenceReads = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
        if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
        if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
        if (path.includes("/presence")) {
          presenceReads += 1;
          return Response.json({ people: [] });
        }
        if (isGoCapability(path, init, "messaging.searchMessages")) {
          return capabilityResponse({ results: [{ id: "hit-1", conversationId: channelId, conversationTitle: "general", body: "the needle", createdAt: "2026-10-01T09:00:00.000Z", senderType: "human", senderUserId: other }] });
        }
        if (isGoCapability(path, init, "messaging.readMessages")) {
          const request = JSON.parse(String(init?.body)) as { input?: Record<string, unknown> };
          const input = request.input ?? {};
          threadInputs.push(input);
          if (input.around === "hit-1") {
            return capabilityResponse(threadBody({ messages: [message({ id: "hit-1", body: "the needle" })], hasMore: true, nextCursor: "history-before" }));
          }
          if (input.before === "history-before") {
            return capabilityResponse(threadBody({
              messages: [message({ id: "old-1", body: "last month" }), message({ id: "hit-1", body: "the needle" })],
              hasMore: false,
              nextCursor: null,
            }));
          }
          return capabilityResponse(threadBody({ messages: [message({ id: "latest-1", body: "newest message" })] }));
        }
        return Response.json({ error: "not found" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<MessagesPage />);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      await screen.findByText("newest message");

      fireEvent.click(await screen.findByRole("button", { name: "All messages" }));
      fireEvent.change(screen.getByLabelText("Search all messages"), { target: { value: "needle" } });
      fireEvent.click(await screen.findByRole("button", { name: /the needle/ }));
      await waitFor(() => expect(threadInputs.some((input) => input.around === "hit-1")).toBe(true));

      const scroller = screen.getByLabelText("Messages in general");
      fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
      expect(await screen.findByText("last month")).not.toBeNull();

      Object.defineProperty(scroller, "scrollHeight", { get: () => 1200, configurable: true });
      Object.defineProperty(scroller, "clientHeight", { get: () => 300, configurable: true });
      Object.defineProperty(scroller, "scrollTop", { get: () => 0, configurable: true });
      const readsBeforePoll = threadInputs.length;
      const presenceReadsBeforePoll = presenceReads;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });

      expect(threadInputs).toHaveLength(readsBeforePoll);
      expect(presenceReads).toBeGreaterThan(presenceReadsBeforePoll);
      expect(threadInputs.some((input) => input.around === "hit-1")).toBe(true);
      expect(threadInputs.some((input) => input.before === "history-before")).toBe(true);
      expect(document.querySelector("#message-old-1")).not.toBeNull();
      expect(document.querySelector("#message-hit-1")).not.toBeNull();
      expect(document.querySelector("#message-latest-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows agent, customer, and system bubbles as visually distinct regions", async () => {
    const fetchMock = router([
      moduleRoute,
      peopleRoute,
      presenceRoute,
      emptyList(),
      threadRoute({
        messages: [
          message({ id: "sys", senderType: "system", senderUserId: null, body: "Grace joined the channel" }),
          message({ id: "agent", senderType: "agent", senderUserId: null, body: "On it @Ada" }),
          message({ id: "human", senderUserId: other, body: "Thanks" }),
        ],
      }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);
    await screen.findByText("On it");

    expect(container.querySelector(".messages-bubble-system")).not.toBeNull();
    expect(container.querySelector(".messages-bubble-agent")).not.toBeNull();
    expect(container.querySelector(".messages-bubble-colleague")).not.toBeNull();
    expect(container.querySelector(".messages-mention")?.textContent).toBe("@Ada");
    expect(screen.getByText("Grace joined the channel")).not.toBeNull();
  });

  it("opens the mention picker from an alias and sends the mention through Go", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.sendMessage")) { posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ ok: true, data: { messageId: "11111111-1111-4111-8111-111111111111" } }); }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = (await screen.findByLabelText("Message general")) as HTMLTextAreaElement;
    await screen.findAllByText("Morning all", {}, { timeout: 5_000 });
    fireEvent.change(composer, { target: { value: "@Gra", selectionStart: 4 } });
    const option = await screen.findByRole("option", { name: /@Grace/ });
    fireEvent.click(option);
    expect(composer.value).toBe("@Grace ");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 5_000 });
    expect(posts[0]).toMatchObject({ capabilityId: "messaging.sendMessage", input: { body: "@Grace", mentions: [{ type: "user", id: other }] }, intentId: expect.any(String) });
  });

  it("sends agent-enabled and @agent messages and replies through Go", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const paths: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.sendMessage")) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { messageId: "11111111-1111-4111-8111-111111111111" } });
      }
      if (path.endsWith("/agent-reply") && init?.method === "POST") return Response.json({ ok: true, messageId: "22222222-2222-4222-8222-222222222222", reply: "On it", replayed: false });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = (await screen.findByLabelText("Message general")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "@Chas", selectionStart: 5 } });
    fireEvent.click(await screen.findByRole("option", { name: /@Chaste/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(fetchMock.mock.calls.some(([path, init]) =>
      String(path) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.sendMessage",
    )).toBe(true);
    expect(posts[0]).toMatchObject({ capabilityId: "messaging.sendMessage", input: { body: "@Chaste", mentions: [{ type: "agent", id: "agent-1" }] } });
    expect(paths.some((path) => path.endsWith("/agent-reply"))).toBe(true);
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/messages") && init?.method === "POST")).toBe(false);
  });

  it("retries a failed Go agent reply with the same human message and intent", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const humanWrites: Array<Record<string, unknown>> = [];
    const replyRequests: Array<Record<string, unknown>> = [];
    let replyAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: true })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.sendMessage")) {
        humanWrites.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { messageId: "11111111-1111-4111-8111-111111111111" } });
      }
      if (path.endsWith("/agent-reply") && init?.method === "POST") {
        replyAttempts += 1;
        replyRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (replyAttempts === 1) return Response.json({ error: "provider unavailable" }, { status: 502 });
        return Response.json({ ok: true, messageId: "22222222-2222-4222-8222-222222222222", reply: "On it", replayed: false });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    fireEvent.change(composer, { target: { value: "Please check the report" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect((await screen.findByRole("alert")).textContent).toContain("provider unavailable");
    expect((composer as HTMLTextAreaElement).value).toBe("Please check the report");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(replyAttempts).toBe(2));
    expect(humanWrites).toHaveLength(2);
    expect(humanWrites[1]).toEqual(humanWrites[0]);
    expect(replyRequests[1]).toEqual(replyRequests[0]);
    expect(replyRequests[0]).toMatchObject({ messageId: "11111111-1111-4111-8111-111111111111", intentId: humanWrites[0]?.intentId });
  }, 15_000);

  it("sends mentions, replies, and uploaded attachments through Go when the slice is enabled", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const actionBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/attachments")) return Response.json({ attachmentId: "72b99920-8c21-463a-9c5b-479216017501", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 10 });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        const request = JSON.parse(String(init?.body)) as { capabilityId?: string };
        if (request.capabilityId === "messaging.uploadMessageAttachment") {
          return Response.json({ ok: true, data: { attachmentId: "72b99920-8c21-463a-9c5b-479216017501" } });
        }
        if (request.capabilityId === "messaging.sendMessage") {
          actionBodies.push(request as Record<string, unknown>);
          return Response.json({ ok: true, data: { messageId: "11111111-1111-4111-8111-111111111111" } });
        }
        return Response.json({ error: "unexpected capability" }, { status: 400 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);
    const composer = (await screen.findByLabelText("Message general")) as HTMLTextAreaElement;

    await screen.findAllByText("Morning all");
    const replyButton = await screen.findByRole("button", { name: "Reply" });
    const originalMessage = replyButton.closest<HTMLElement>(".messages-message");
    expect(originalMessage).not.toBeNull();
    fireEvent.click(within(originalMessage!).getByRole("button", { name: "Reply" }));
    fireEvent.change(composer, { target: { value: "@Gra" , selectionStart: 4 } });
    fireEvent.click(await screen.findByRole("option", { name: /@Grace/ }));
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["brief"], "brief.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(actionBodies).toHaveLength(1));
    expect(actionBodies[0]).toMatchObject({
      capabilityId: "messaging.sendMessage",
      input: {
        body: "@Grace",
        mentions: [{ type: "user", id: other }],
        parentMessageId: "m1",
        attachmentIds: ["72b99920-8c21-463a-9c5b-479216017501"],
      },
      intentId: expect.any(String),
    });
    expect(composer.value).toBe("");
  });

  it("keeps the attachment draft and shows an error when the selected Go upload fails", async () => {
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_UPLOAD__", true);
    const requests: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isGoCapability(path, init, "messaging.listPeople")) return peopleCapabilityResponse(people);
      const method = init?.method;
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ path, method, body });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && body?.capabilityId === "messaging.uploadMessageAttachment") {
        return Response.json({ error: "Go upload unavailable." }, { status: 503 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "unexpected legacy request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);

    expect(await screen.findByLabelText("Message general")).not.toBeNull();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["brief"], "brief.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("brief.txt")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Go upload unavailable.");
    expect(screen.getByText("brief.txt")).not.toBeNull();
    expect(requests.filter(({ body }) => body?.capabilityId === "messaging.uploadMessageAttachment")).toHaveLength(1);
    expect(requests.some(({ path, method }) => path.endsWith("/attachments") && method === "POST")).toBe(false);
    expect(requests.some(({ body }) => body?.capabilityId === "messaging.sendMessage")).toBe(false);
  });

  it("keeps a Go upload pending approval visible and tells the user to retry after approval", async () => {
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_UPLOAD__", true);
    const requests: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isGoCapability(path, init, "messaging.listPeople")) return peopleCapabilityResponse(people);
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ path, method: init?.method, body });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && body?.capabilityId === "messaging.uploadMessageAttachment") {
        return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "unexpected legacy request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);

    expect(await screen.findByLabelText("Message general")).not.toBeNull();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["brief"], "brief.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("brief.txt")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/waiting for approval.*remains in your draft.*retry after approval/i);
    expect(screen.getByText("brief.txt")).not.toBeNull();
    expect(requests.filter(({ body }) => body?.capabilityId === "messaging.uploadMessageAttachment")).toHaveLength(1);
    expect(requests.some(({ path, method }) => path.endsWith("/attachments") && method === "POST")).toBe(false);
    expect(requests.some(({ body }) => body?.capabilityId === "messaging.sendMessage")).toBe(false);
  });

  it("removes an uploaded draft attachment through Go without legacy DELETE traffic", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_DELETE__", true);
    const requests: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isGoCapability(path, init, "messaging.listPeople")) return peopleCapabilityResponse(people);
      const method = init?.method;
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ path, method, body });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.uploadMessageAttachment")) return Response.json({ ok: true, data: { attachmentId: "72b99920-8c21-463a-9c5b-479216017501" } });
      if (path === "/api/capabilities/execute" && body?.capabilityId === "messaging.sendMessage") return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      if (path === "/api/capabilities/execute" && body?.capabilityId === "messaging.deletePendingAttachment") return Response.json({ ok: true, data: { removed: true } });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "unexpected legacy request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);

    expect(await screen.findByLabelText("Message general")).not.toBeNull();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["brief"], "brief.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("brief.pdf")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect((await screen.findByRole("status")).textContent).toContain("Manager review required.");
    await waitFor(() => expect(requests.some(({ body }) => body?.capabilityId === "messaging.uploadMessageAttachment")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove brief.pdf" }));

    await waitFor(() => expect(requests.some(({ body }) => body?.capabilityId === "messaging.deletePendingAttachment")).toBe(true));
    const deletion = requests.find(({ body }) => body?.capabilityId === "messaging.deletePendingAttachment")!;
    expect(deletion).toMatchObject({
      path: "/api/capabilities/execute",
      method: "POST",
      body: { input: { attachmentId: "72b99920-8c21-463a-9c5b-479216017501" }, intentId: expect.any(String) },
    });
    expect(requests.some(({ path, method }) => path.includes("/attachments") && method === "DELETE")).toBe(false);
    expect(screen.queryByText("brief.pdf")).toBeNull();
  });

  it("keeps an uploaded draft attachment when Go deletion fails", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    vi.stubGlobal("__GO_MESSAGING_ATTACHMENT_DELETE__", true);
    const requests: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isGoCapability(path, init, "messaging.listPeople")) return peopleCapabilityResponse(people);
      const method = init?.method;
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push({ path, method, body });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.uploadMessageAttachment")) return Response.json({ ok: true, data: { attachmentId: "72b99920-8c21-463a-9c5b-479216017501" } });
      if (path === "/api/capabilities/execute" && body?.capabilityId === "messaging.sendMessage") return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      if (path === "/api/capabilities/execute" && body?.capabilityId === "messaging.deletePendingAttachment") return Response.json({ error: "Attachment could not be removed." }, { status: 500 });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "unexpected legacy request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);

    expect(await screen.findByLabelText("Message general")).not.toBeNull();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["brief"], "brief.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("brief.pdf")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect((await screen.findByRole("status")).textContent).toContain("Manager review required.");
    await waitFor(() => expect(requests.some(({ body }) => body?.capabilityId === "messaging.uploadMessageAttachment")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Remove brief.pdf" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Attachment could not be removed.");
    expect(screen.getByText("brief.pdf")).not.toBeNull();
    expect(requests.some(({ path, method }) => path.includes("/attachments") && method === "DELETE")).toBe(false);
    expect(requests.some(({ body }) => body?.capabilityId === "messaging.deletePendingAttachment")).toBe(true);
  });

  it("keeps the draft visible when a Go message is pending approval", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const intentIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        intentIds.push((JSON.parse(String(init?.body)) as { intentId: string }).intentId);
        return Response.json({ ok: false, pendingApproval: true, approvalId: "550e8400-e29b-41d4-a716-446655440000", reason: "Manager review required." }, { status: 202 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    await screen.findAllByText("Morning all", {}, { timeout: 5_000 });
    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect((await screen.findByRole("status", {}, { timeout: 5_000 })).textContent).toContain("Manager review required.");
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(intentIds).toHaveLength(2), { timeout: 5_000 });
    expect(intentIds[1]).toBe(intentIds[0]);
  }, 15_000);

  it("reuses a Go message intent after an uncertain transport failure and clears it on success", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const sent: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ agentEnabled: false })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (sent.length === 1) throw new TypeError("connection reset");
        return Response.json({ ok: true, data: { messageId: "sent-message-id" } });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    fireEvent.change(composer, { target: { value: "Resilient send" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("alert", {}, { timeout: 5_000 });

    const storageKey = Object.keys(window.localStorage).find((key) => key.startsWith(`chaste:message-send-intent:${me}:${channelId}:`));
    expect(storageKey).toMatch(/:[0-9a-f]{64}$/);
    expect(window.localStorage.getItem(storageKey!)).not.toContain("Resilient send");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.intentId).toBe(sent[0]?.intentId);
    await waitFor(() => expect(window.localStorage.getItem(storageKey!)).toBeNull());
  });

  it("rejects a sixth attachment and uploads through Go before sending", async () => {
    const uploads: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.uploadMessageAttachment")) { uploads.push(String(init?.body)); return Response.json({ ok: true, data: { attachmentId: "72b99920-8c21-463a-9c5b-479216017501" } }); }
      if (isGoCapability(path, init, "messaging.sendMessage")) { posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ ok: true, data: { messageId: "11111111-1111-4111-8111-111111111111" } }); }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);
    await screen.findByLabelText("Message general");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const six = Array.from({ length: 6 }, () => new File(["a"], "a.txt", { type: "text/plain" }));
    fireEvent.change(input!, { target: { files: six } });
    expect((await screen.findByRole("alert")).textContent).toContain("Add up to five files to one message.");

    fireEvent.change(input!, { target: { files: [new File(["a"], "brief.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(uploads).toHaveLength(1);
    expect(posts[0]).toMatchObject({ capabilityId: "messaging.sendMessage", input: { attachmentIds: ["72b99920-8c21-463a-9c5b-479216017501"] } });
  });

  it("confirms a Go conversation change and reports it as pending, not done", async () => {
    const patches: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.archiveConversation")) {
        patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: false, pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." }, { status: 202 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="6a7c5482-c5a6-4fcb-8b69-a06d4820238a" />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect((await screen.findByRole("status")).textContent).toContain("waits for approval in the Approvals inbox");
    expect(patches[0]).toMatchObject({ capabilityId: "messaging.archiveConversation", input: { conversationId: channelId, archived: true }, intentId: expect.any(String) });
    expect(screen.getByRole("dialog", { name: /general/ })).not.toBeNull();
  });

  it("clears a completed Go member request before reporting a failed conversation refresh", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ADD_MEMBER__", true);
    const scope = { actorId: me, organizationId: "conversation-member-refresh-org" };
    const addedUserId = "4d814ec3-71a2-40e1-8c53-3e81068c1f0d";
    const requests: Record<string, unknown>[] = [];
    let conversationReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) {
        conversationReads += 1;
        if (conversationReads > 1) return Response.json({ error: "refresh failed" }, { status: 503 });
        return capabilityResponse({ conversations: [conversation()], me });
      }
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people.map((person) => person.id === other ? { ...person, id: addedUserId } : person)));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { added: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage {...scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a colleague by name" }), { target: { value: "Grace" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) =>
      String(path) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string; input?: { query?: string } }).capabilityId === "messaging.listPeople" &&
      (JSON.parse(String(init?.body)) as { input?: { query?: string } }).input?.query === "Grace",
    )).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      capabilityId: "messaging.addMember",
      input: { conversationId: channelId, userId: addedUserId },
      intentId: expect.any(String),
    });
    const storageKey = `chaste:conversation-member:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
    expect((await screen.findByRole("alert")).textContent).toContain("refresh failed");
    expect(fetchMock.mock.calls.some(([path]) => String(path) === `/api/conversations/${channelId}`)).toBe(false);
  });

  it("uses Go people search and Go member writes", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ADD_MEMBER__", true);
    const writes: Record<string, unknown>[] = [];
    const addedUserId = "4d814ec3-71a2-40e1-8c53-3e81068c1f0d";
    const candidates = people.map((person) => person.id === other ? { ...person, id: addedUserId } : person);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(candidates));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.addMember")) {
        writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { added: true } });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="8e5cb82c-5b5c-47f5-9e8a-089f6f482126" />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a colleague by name" }), { target: { value: "Grace" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => {
      if (String(path) !== "/api/capabilities/execute") return false;
      const body = JSON.parse(String(init?.body)) as { capabilityId?: string; input?: { query?: string } };
      return body.capabilityId === "messaging.listPeople" && body.input?.query === "Grace";
    })).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ capabilityId: "messaging.addMember", input: { conversationId: channelId, userId: addedUserId }, intentId: expect.any(String) });
    const peopleLookup = fetchMock.mock.calls.find(([path, init]) => {
      if (String(path) !== "/api/capabilities/execute") return false;
      const body = JSON.parse(String(init?.body)) as { capabilityId?: string; input?: { query?: string } };
      return body.capabilityId === "messaging.listPeople" && body.input?.query === "Grace";
    });
    expect(peopleLookup).toBeDefined();
    expect(JSON.parse(String(peopleLookup?.[1]?.body))).toMatchObject({ input: { query: "Grace", limit: 30 } });
    expect(fetchMock.mock.calls.some(([path, init]) =>
      String(path) === "/api/capabilities/execute" &&
      (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "messaging.addMember",
    )).toBe(true);
  });

  it("clears a terminal Go member rejection so a different member can be added", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ADD_MEMBER__", true);
    const scope = { actorId: me, organizationId: "conversation-member-terminal-org" };
    const firstUserId = "4d814ec3-71a2-40e1-8c53-3e81068c1f0d";
    const secondUserId = "985a615b-24b4-42db-a69e-0327ea303c09";
    const requests: Record<string, unknown>[] = [];
    const candidates: Person[] = [
      { type: "user", id: firstUserId, name: "Grace Hopper" },
      { type: "user", id: secondUserId, name: "Linus Torvalds" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(candidates));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requests.length === 1) return Response.json({ error: "You cannot add members to this channel." }, { status: 403 });
        return Response.json({ ok: true, data: { added: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage {...scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    const memberSearch = screen.getByRole("textbox", { name: "Find a colleague by name" });
    fireEvent.change(memberSearch, { target: { value: "Grace" } });
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect((await screen.findByRole("alert")).textContent).toContain("cannot add members");
    const storageKey = `chaste:conversation-member:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry member addition" })).toBeNull();

    fireEvent.change(memberSearch, { target: { value: "Linus" } });
    fireEvent.click(await screen.findByRole("button", { name: /Linus Torvalds/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]).toMatchObject({ capabilityId: "messaging.addMember", input: { userId: firstUserId }, intentId: expect.any(String) });
    expect(requests[1]).toMatchObject({ capabilityId: "messaging.addMember", input: { userId: secondUserId }, intentId: expect.any(String) });
    expect(requests[1]?.intentId).not.toBe(requests[0]?.intentId);
  });

  it("restores and retries a pending Go member addition with its original intent after selector rollback", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ADD_MEMBER__", true);
    const scope = { actorId: me, organizationId: "conversation-member-retry-org" };
    const addedUserId = "4d814ec3-71a2-40e1-8c53-3e81068c1f0d";
    const requests: Record<string, unknown>[] = [];
    const legacyPatches: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people.map((person) => person.id === other ? { ...person, id: addedUserId } : person)));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requests.length === 1) return Response.json({ pendingApproval: true, hint: "Member addition is waiting for approval." }, { status: 202 });
        if (requests.length === 2) return Response.json({ error: "Temporary member-add failure." }, { status: 503 });
        return Response.json({ ok: true, data: { added: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        legacyPatches.push(path);
        return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstMount = render(<MessagesPage {...scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a colleague by name" }), { target: { value: "Grace" } });
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect((await screen.findByRole("status")).textContent).toContain("waiting for approval");
    expect(requests[0]).toMatchObject({
      capabilityId: "messaging.addMember",
      input: { conversationId: channelId, userId: addedUserId },
      intentId: expect.any(String),
    });
    const storageKey = `chaste:conversation-member:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    const pending = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as { action?: unknown; intentId?: unknown };
    expect(pending).toMatchObject({ action: { action: "addMember", userId: addedUserId }, intentId: requests[0]?.intentId });
    firstMount.unmount();

    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ADD_MEMBER__", false);
    render(<MessagesPage {...scope} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/earlier member addition is unresolved/i);
    const retry = screen.getByRole("button", { name: "Retry member addition" });
    fireEvent.click(retry);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[1]?.input).toEqual({ conversationId: channelId, userId: addedUserId });
    expect((await screen.findByRole("alert")).textContent).toContain("Temporary member-add failure.");
    const retained = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as { intentId?: unknown };
    expect(retained.intentId).toBe(requests[0]?.intentId);

    fireEvent.click(screen.getByRole("button", { name: "Retry member addition" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[2]?.input).toEqual({ conversationId: channelId, userId: addedUserId });
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
    expect(legacyPatches).toHaveLength(0);
  });

  it.each([
    { failure: "408", status: 408 },
    { failure: "409", status: 409 },
    { failure: "425", status: 425 },
    { failure: "429", status: 429 },
    { failure: "network rejection", status: null },
  ])("retains a Go add-member intent after $failure and retries without legacy fallback", async ({ status }) => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ADD_MEMBER__", true);
    const scope = { actorId: me, organizationId: `conversation-member-retry-${status ?? "network"}-org` };
    const addedUserId = "4d814ec3-71a2-40e1-8c53-3e81068c1f0d";
    const requests: Record<string, unknown>[] = [];
    const legacyPatches: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse([{ type: "user", id: addedUserId, name: "Grace Hopper" }]));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requests.length === 1) {
          if (status === null) throw new TypeError("Network unavailable");
          return Response.json({ error: `Temporary ${status} failure.` }, { status });
        }
        return Response.json({ ok: true, data: { added: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        legacyPatches.push(path);
        return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage {...scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find a colleague by name" }), { target: { value: "Grace" } });
    fireEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    const storageKey = `chaste:conversation-member:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    const firstIntentId = requests[0]?.intentId;
    expect(firstIntentId).toEqual(expect.any(String));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null")).toMatchObject({ intentId: firstIntentId }));

    fireEvent.click(await screen.findByRole("button", { name: "Retry member addition" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      capabilityId: "messaging.addMember",
      input: { conversationId: channelId, userId: addedUserId },
      intentId: firstIntentId,
    });
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
    expect(legacyPatches).toHaveLength(0);
  });

  it("keeps a Go conversation update pending and retries the saved details with one stable intent", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_UPDATE__", true);
    const updates: Record<string, unknown>[] = [];
    const legacyPatches: string[] = [];
    let releaseFirst: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) {
        const title = updates.length >= 2 ? "operations" : "general";
        return capabilityResponse({ conversations: [conversation({ title })], me });
      }
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        updates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (updates.length === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
        return Response.json({ ok: true, data: { conversationId: channelId } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        legacyPatches.push(path);
        return Response.json({ error: "unexpected legacy update" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = { actorId: me, organizationId: "conversation-update-org" };
    const firstMount = render(<MessagesPage {...scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "operations" } });
    const rename = screen.getByRole("button", { name: "Rename" });
    await act(async () => {
      fireEvent.click(rename);
      fireEvent.click(rename);
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      capabilityId: "messaging.updateConversation",
      input: { conversationId: channelId, title: "operations" },
      intentId: expect.any(String),
    });
    await act(async () => {
      releaseFirst?.(Response.json({ pendingApproval: true, hint: "Waiting for approval." }, { status: 202 }));
    });
    expect((await screen.findByRole("status")).textContent).toContain("Waiting for approval.");
    expect((screen.getByLabelText("Channel name") as HTMLInputElement).value).toBe("operations");
    firstMount.unmount();

    render(<MessagesPage {...scope} />);
    const restoredName = await screen.findByLabelText("Channel name");
    expect((restoredName as HTMLInputElement).value).toBe("operations");
    expect((await screen.findByRole("status")).textContent).toMatch(/earlier conversation update is unresolved/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry update" }));
    await waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]?.intentId).toBe(updates[0]?.intentId);
    expect(updates[1]?.input).toEqual({ conversationId: channelId, title: "operations" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: /#operations/ })).not.toBeNull());
    expect(legacyPatches).toHaveLength(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("retries the exact Go archive action after selector rollback, blocks duplicates, then refreshes and clears", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ARCHIVE__", true);
    const scope = { actorId: me, organizationId: "conversation-archive-org" };
    const requests: Record<string, unknown>[] = [];
    const legacyPatches: string[] = [];
    let archived = false;
    let releaseFirst: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation({ archivedAt: archived ? "2026-10-10T08:00:00.000Z" : null })], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requests.length === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
        if (requests.length === 2) return Response.json({ error: "Temporary archive failure." }, { status: 503 });
        archived = true;
        return Response.json({ ok: true, data: { conversationId: channelId, archived: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        legacyPatches.push(path);
        return Response.json({ error: "unexpected legacy archive" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstMount = render(<MessagesPage {...scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    const archive = screen.getByRole("button", { name: "Archive" });
    await act(async () => {
      fireEvent.click(archive);
      fireEvent.click(archive);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      capabilityId: "messaging.archiveConversation",
      input: { conversationId: channelId, archived: true },
      intentId: expect.any(String),
    });
    const storageKey = `chaste:conversation-archive:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    const pending = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as { action?: unknown; intentId?: unknown };
    expect(pending).toMatchObject({ action: { action: "archive", archived: true }, intentId: requests[0]?.intentId });
    await act(async () => {
      releaseFirst?.(Response.json({ pendingApproval: true, hint: "Archive is waiting for approval." }, { status: 202 }));
    });
    expect((await screen.findByRole("status")).textContent).toContain("Archive is waiting for approval.");
    firstMount.unmount();

    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_ARCHIVE__", false);
    render(<MessagesPage {...scope} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/earlier archive change is unresolved/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry archive" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[1]?.input).toEqual({ conversationId: channelId, archived: true });
    expect((await screen.findByRole("alert")).textContent).toContain("Temporary archive failure.");
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry archive" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[2]?.input).toEqual({ conversationId: channelId, archived: true });
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
    expect(legacyPatches).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: /#general/ })).toBeNull();
  });

  it("confirms Go channel deletion, retries the saved intent after rollback, and clears it before a failed list refresh", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_DELETE__", true);
    const scope = { actorId: me, organizationId: "conversation-delete-org" };
    const requests: Record<string, unknown>[] = [];
    const legacyPatches: string[] = [];
    let refreshAfterDelete = false;
    let markerWasClearedBeforeRefresh = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) {
        if (refreshAfterDelete) {
          markerWasClearedBeforeRefresh = window.sessionStorage.getItem(storageKey) === null;
          return Response.json({ error: "list unavailable" }, { status: 503 });
        }
        if (requests.length > 0) return capabilityResponse({ conversations: [], me });
        return capabilityResponse({ conversations: [conversation()], me });
      }
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requests.length === 1) return Response.json({ pendingApproval: true, hint: "Deletion is waiting for approval." }, { status: 202 });
        if (requests.length === 2) return Response.json({ error: "Temporary delete failure." }, { status: 503 });
        refreshAfterDelete = true;
        return Response.json({ ok: true, data: { deleted: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        legacyPatches.push(path);
        return Response.json({ error: "unexpected legacy delete" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const storageKey = `chaste:conversation-delete:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    vi.stubGlobal("fetch", fetchMock);

    const firstMount = render(<MessagesPage {...scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    const confirmation = await screen.findByRole("alertdialog", { name: /Delete #general\?/ });
    const confirmButton = within(confirmation).getByRole("button", { name: "Delete channel" });
    await act(async () => {
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      capabilityId: "messaging.deleteConversation",
      input: { conversationId: channelId },
      intentId: expect.any(String),
    });
    const firstIntentId = requests[0]?.intentId;
    expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null")).toMatchObject({
      conversationId: channelId,
      action: { action: "delete" },
      intentId: firstIntentId,
    });
    expect((await screen.findByRole("status")).textContent).toContain("Deletion is waiting for approval.");
    firstMount.unmount();

    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_DELETE__", false);
    render(<MessagesPage {...scope} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/earlier channel deletion is unresolved/i);
    const retryButton = await screen.findByRole("button", { name: "Retry channel deletion" });
    fireEvent.click(retryButton);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      capabilityId: "messaging.deleteConversation",
      input: { conversationId: channelId },
      intentId: firstIntentId,
    });
    expect((await screen.findByRole("status")).textContent).toContain("Temporary delete failure.");
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry channel deletion" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toMatchObject({
      capabilityId: "messaging.deleteConversation",
      input: { conversationId: channelId },
      intentId: firstIntentId,
    });
    await waitFor(() => expect(markerWasClearedBeforeRefresh).toBe(true));
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("The channel was deleted");
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    expect(legacyPatches).toHaveLength(0);
  });

  it("keeps channel deletion on the Go capability route", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_DELETE__", true);
    const deletes: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.deleteConversation")) {
        deletes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { deleted: true } });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="conversation-delete-legacy-org" />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    const confirmation = await screen.findByRole("alertdialog", { name: /Delete #general\?/ });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete channel" }));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toMatchObject({ capabilityId: "messaging.deleteConversation", input: { conversationId: channelId }, intentId: expect.any(String) });
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps a Go leave request across reload and selector rollback, then clears only after receipt and refresh", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_LEAVE__", true);
    const scope = { actorId: me, organizationId: "conversation-leave-org" };
    const requests: Record<string, unknown>[] = [];
    const legacyPatches: string[] = [];
    let left = false;
    let releaseFirst: ((response: Response) => void) | null = null;
    let releaseRetry: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: left ? [] : [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requests.length === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
        if (requests.length === 2) return new Promise<Response>((resolve) => { releaseRetry = resolve; });
        left = true;
        return Response.json({ ok: true, data: { left: true } });
      }
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        legacyPatches.push(path);
        return Response.json({ error: "unexpected legacy leave" }, { status: 500 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstMount = render(<MessagesPage {...scope} />);
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Leave #general?" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Leave conversation" }));
      await Promise.resolve();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      capabilityId: "messaging.leaveConversation",
      input: { conversationId: channelId },
      intentId: expect.any(String),
    });
    const storageKey = `chaste:conversation-leave:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    const pending = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as { action?: unknown; intentId?: unknown };
    expect(pending).toMatchObject({ action: { action: "leave" }, intentId: requests[0]?.intentId });
    await act(async () => {
      releaseFirst?.(Response.json({ pendingApproval: true, hint: "Leave is waiting for approval." }, { status: 202 }));
    });
    expect((await screen.findByRole("status")).textContent).toContain("Leave is waiting for approval.");
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    firstMount.unmount();

    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_LEAVE__", false);
    render(<MessagesPage {...scope} />);
    expect((await screen.findByRole("status")).textContent).toMatch(/earlier leave request is unresolved/i);
    const retry = screen.getByRole("button", { name: "Retry leave" });
    await act(async () => {
      fireEvent.click(retry);
      fireEvent.click(retry);
      await Promise.resolve();
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[1]?.input).toEqual({ conversationId: channelId });
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
    await act(async () => {
      releaseRetry?.(Response.json({ error: "Temporary leave failure." }, { status: 503 }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Temporary leave failure.");
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry leave" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.intentId).toBe(requests[0]?.intentId);
    expect(requests[2]?.input).toEqual({ conversationId: channelId });
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
    expect(legacyPatches).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: /#general/ })).toBeNull();
  });

  it("uses the Go leave capability when no request is pending", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_LEAVE__", true);
    const leaves: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.leaveConversation")) {
        leaves.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { left: true } });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="8e5cb82c-5b5c-47f5-9e8a-089f6f482126" />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Leave #general?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Leave conversation" }));
    await waitFor(() => expect(leaves).toHaveLength(1));
    expect(leaves[0]).toMatchObject({ capabilityId: "messaging.leaveConversation", input: { conversationId: channelId }, intentId: expect.any(String) });
  });

  it("clears a completed Go leave before a failed list refresh and allows leaving another conversation", async () => {
    vi.stubGlobal("__GO_MESSAGING_CONVERSATION_LEAVE__", true);
    const scope = { actorId: me, organizationId: "conversation-leave-refresh-org" };
    const otherConversationId = "8b3c4d6e-5f8a-4c1b-9e2d-3f4a5b6c7d8e";
    const requests: Record<string, unknown>[] = [];
    let listAttempts = 0;
    const storageKey = `chaste:conversation-leave:${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(channelId)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) {
        listAttempts += 1;
        if (listAttempts === 1) return capabilityResponse({ conversations: [conversation()], me });
        if (listAttempts === 2) {
          expect(window.sessionStorage.getItem(storageKey)).toBeNull();
          return Response.json({ error: "temporary list failure" }, { status: 503 });
        }
        return capabilityResponse({ conversations: [conversation({ id: otherConversationId, title: "support" })], me });
      }
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations") && !isGoCapability(path, init, "messaging.readMessages")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return requests.length === 1
          ? Response.json({ ok: true, data: { left: true } })
          : Response.json({ pendingApproval: true, hint: "Support leave is waiting for approval." }, { status: 202 });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage {...scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    const confirmFirst = await screen.findByRole("alertdialog", { name: "Leave #general?" });
    fireEvent.click(within(confirmFirst).getByRole("button", { name: "Leave conversation" }));

    const refreshAlert = await screen.findByRole("alert");
    expect(refreshAlert.textContent).toContain("You left this conversation");
    expect(within(refreshAlert).getByRole("button", { name: "Retry" })).not.toBeNull();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry leave" })).toBeNull();
    expect(requests).toHaveLength(1);

    fireEvent.click(within(refreshAlert).getByRole("button", { name: "Retry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    expect(screen.getByRole("button", { name: "Leave" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry leave" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    const confirmSecond = await screen.findByRole("alertdialog", { name: "Leave #support?" });
    fireEvent.click(within(confirmSecond).getByRole("button", { name: "Leave conversation" }));

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.input).toEqual({ conversationId: channelId });
    expect(requests[1]?.input).toEqual({ conversationId: otherConversationId });
    expect(requests[1]?.intentId).not.toBe(requests[0]?.intentId);
    expect((await screen.findByRole("status")).textContent).toContain("Support leave is waiting for approval.");
  });

  it("deletes a message through the governed route after a confirmation", async () => {
    const deletes: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.deleteMessage")) {
        deletes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return capabilityResponse({ deleted: true, messageId: "m1", deletedAt: null, expectedDeletedAt: "2026-10-01T09:00:00.000Z" });
      }
      if (isGoCapability(path, init, "messaging.readMessages")) return capabilityResponse(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="legacy-delete-org" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this message?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toMatchObject({ capabilityId: "messaging.deleteMessage", input: { messageId: "m1" }, intentId: expect.any(String) });
  });

  it("runs a full message history search and loads the hit through Go around the selected message", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const threadInputs: Array<Record<string, unknown>> = [];
    const legacyThreadReads: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST" && !isGoCapability(path, init, "messaging.listPeople") && !isGoCapability(path, init, "messaging.listConversations")) {
        const request = JSON.parse(String(init?.body)) as { capabilityId?: string; input?: Record<string, unknown> };
        if (request.capabilityId === "messaging.searchMessages") {
          return Response.json({ ok: true, data: { results: [{ id: "hit-1", conversationId: channelId, conversationTitle: "general", body: "the needle", createdAt: "2026-10-01T09:00:00.000Z", senderType: "human", senderUserId: other }] } });
        }
        if (request.capabilityId === "messaging.readMessages" && request.input) {
          threadInputs.push(request.input);
          return Response.json({ ok: true, data: threadBody({ messages: [message({ id: "hit-1", body: "the needle" })] }) });
        }
      }
      if (/^\/api\/conversations\/[^/]+\/messages(?:\?|$)/.test(path)) legacyThreadReads.push(path);
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "All messages" }));
    fireEvent.change(screen.getByLabelText("Search all messages"), { target: { value: "needle" } });
    fireEvent.click(await screen.findByRole("button", { name: /the needle/ }));

    await waitFor(() => expect(threadInputs.some((input) => input.around === "hit-1")).toBe(true));
    expect(threadInputs).toContainEqual({ conversationId: channelId, limit: 60 });
    expect(threadInputs).toContainEqual({ conversationId: channelId, limit: 60, around: "hit-1" });
    expect(legacyThreadReads).toEqual([]);
  });

  it("scrolls to the top of the thread to prepend an older page without duplicating rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) {
        const request = JSON.parse(String(init?.body)) as { input?: { before?: string } };
        return request.input?.before
          ? capabilityResponse(threadBody({ messages: [message({ id: "old", body: "from last week" }), message({ id: "m1" })], hasMore: false, nextCursor: null }))
          : capabilityResponse(threadBody({ hasMore: true, nextCursor: "m1" }));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);
    await waitFor(() => expect(document.querySelector("#message-m1")).not.toBeNull());

    const scroller = screen.getByLabelText("Messages in general");
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });

    expect(await screen.findByText("from last week")).not.toBeNull();
    expect(document.querySelectorAll("#message-m1")).toHaveLength(1);
    expect(document.querySelectorAll("#message-old")).toHaveLength(1);
  });

  it("loads older messages through the selected Go thread capability", async () => {
    vi.stubGlobal("__GO_MESSAGING_THREAD_READ__", true);
    const capabilityInputs: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (isGoCapability(path, init, "messaging.listConversations")) return capabilityResponse({ conversations: [conversation()], me });
      if (isGoCapability(path, init, "messaging.listPeople")) return Promise.resolve(peopleCapabilityResponse(people));
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (isGoCapability(path, init, "messaging.readMessages")) {
        const request = JSON.parse(String(init?.body)) as { input?: Record<string, unknown> };
        if (!request.input) return Response.json({ error: "unexpected capability" }, { status: 400 });
        capabilityInputs.push(request.input);
        return Response.json({ ok: true, data: request.input.before
          ? threadBody({ messages: [message({ id: "old", body: "from last week" }), message({ id: "m1" })], hasMore: false, nextCursor: null })
          : threadBody({ hasMore: true, nextCursor: "m1" }) });
      }
      return Response.json({ error: "unexpected legacy thread read" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);
    await waitFor(() => expect(document.querySelector("#message-m1")).not.toBeNull());

    fireEvent.scroll(screen.getByLabelText("Messages in general"), { target: { scrollTop: 0 } });

    expect(await screen.findByText("from last week")).not.toBeNull();
    expect(capabilityInputs).toContainEqual({ conversationId: channelId, limit: 60 });
    expect(capabilityInputs).toContainEqual({ conversationId: channelId, limit: 60, before: "m1" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("before="))).toBe(false);
  });
});
