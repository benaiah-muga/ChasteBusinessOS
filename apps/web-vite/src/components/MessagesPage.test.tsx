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
    readers: [] as MessageReader[],
    pinnedMessages: [],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

type Route = { match: (path: string, init?: RequestInit) => Response | null };

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
const peopleRoute: Route = { match: (path) => (path.startsWith("/api/conversations/people") ? Response.json({ people }) : null) };
const presenceRoute: Route = { match: (path, init) => (path.includes("/presence") && init?.method !== "POST" ? Response.json({ people: [] }) : path.includes("/presence") ? Response.json({ ok: true }) : null) };
const emptyList = (conversations: Conversation[] = [conversation()]): Route => ({
  match: (path) => (path === "/api/conversations" ? Response.json({ conversations, me }) : null),
});
const threadRoute = (overrides: Record<string, unknown> = {}): Route => ({
  match: (path) => (path === `/api/conversations/${channelId}/messages` ? Response.json(threadBody(overrides)) : null),
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
      if (path === "/api/conversations" && init?.method !== "POST") {
        attempts += 1;
        return attempts === 1 ? Response.json({}, { status: 500 }) : Response.json({ conversations: [conversation()], me });
      }
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
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
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as { capabilityId?: string; input?: { conversationId?: string; limit?: number } };
        if (request.capabilityId !== "messaging.readMessages") return Response.json({ error: "unexpected capability" }, { status: 400 });
        expect(request.input).toEqual({ conversationId: channelId, limit: 60 });
        return Response.json({ ok: true, data: threadBody() });
      }
      return Response.json({ error: "unexpected legacy thread read" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MessagesPage />);

    expect(await screen.findByText("Morning all")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/capabilities/execute")).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/conversations/${channelId}/messages`)).toBe(false);
  });

  it("shows selected Go mention-people failures instead of silently using an empty list", async () => {
    vi.stubGlobal("__GO_MESSAGING_PEOPLE_READS__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [], me });
      if (path === "/api/capabilities/execute") return Response.json({ error: "disabled" }, { status: 503 });
      return Response.json({ error: "unexpected legacy fallback" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("disabled");
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/conversations/people"))).toBe(false);
  });

  it("shows selected Go add-member lookup failures in the conversation settings dialog", async () => {
    vi.stubGlobal("__GO_MESSAGING_PEOPLE_READS__", true);
    let capabilityCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path === "/api/capabilities/execute") {
        capabilityCalls += 1;
        if (capabilityCalls === 1) return Response.json({ ok: true, data: { people } });
        return Response.json({ error: "service unavailable" }, { status: 503 });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
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
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/conversations/people"))).toBe(false);
  });

  it("shows the empty state and creates a channel through the legacy route", async () => {
    const created: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations" && init?.method === "POST") {
        created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ conversationId: channelId }, { status: 201 });
      }
      if (path === "/api/conversations") return Response.json({ conversations: [], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Create your first channel" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "operations" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ title: "operations", agentEnabled: true, intentId: expect.any(String) });
  });

  it("keeps a pending channel creation visible as pending, never as success or error", async () => {
    const fetchMock = router([
      moduleRoute,
      peopleRoute,
      presenceRoute,
      {
        match: (path, init) => {
          if (path !== "/api/conversations") return null;
          if (init?.method === "POST") return Response.json({ pendingApproval: true }, { status: 202 });
          return Response.json({ conversations: [], me });
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Create your first channel" }));
    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("waiting for approval");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("advances the read cursor for the newest message and reconciles the list", async () => {
    const readCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.endsWith("/read")) {
        readCalls.push(String(init?.body));
        return Response.json({ ok: true });
      }
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    await waitFor(() => expect(readCalls).toHaveLength(1));
    expect(JSON.parse(readCalls[0]!)).toMatchObject({ readAt: "2026-10-01T09:00:00.000Z", intentId: expect.any(String) });
  });

  it("marks a message pending rather than sent when the governed write returns 202", async () => {
    const posts: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages") && init?.method === "POST") {
        posts.push(String(init.body));
        return Response.json({ pendingApproval: true }, { status: 202 });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    fireEvent.change(composer, { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 5_000 });
    expect(JSON.parse(posts[0]!)).toMatchObject({ body: "Ship it", intentId: expect.any(String) });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("waiting for approval"), { timeout: 5_000 });
    expect(screen.getByRole("status").textContent).toContain("Your draft is still in this composer");
    expect((composer as HTMLTextAreaElement).value).toBe("Ship it");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores the exact Go message edit after approval is pending and the page reloads", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/capabilities/execute") return Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
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
    const requestCount = paths.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Restore Go message editing");
    expect(paths).toHaveLength(requestCount);
    const goBody = JSON.parse(String(fetchMock.mock.calls.find(([path]) => String(path) === "/api/capabilities/execute")?.[1]?.body)) as Record<string, unknown>;
    expect(goBody).toMatchObject({ capabilityId: "messaging.editMessage", input: { body: "Corrected after reload" }, intentId: expect.any(String) });
  });

  it("keeps a Go edit 404 locked across selector rollback without calling legacy PATCH", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/capabilities/execute") return Response.json({ error: "route unavailable" }, { status: 404 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
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
    const requestCount = paths.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Restore Go message editing");
    expect(paths).toHaveLength(requestCount);
  });

  it("blocks message edits until the Go actor, organization, and conversation scope is resolved", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "PATCH" || (path === "/api/capabilities/execute" && init?.method === "POST")) writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    fireEvent.change(await screen.findByLabelText("Edit message"), { target: { value: "Must wait for scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("paused until the actor and organization are resolved");
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
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    fireEvent.change(await screen.findByLabelText("Edit message"), { target: { value: "Must not send without scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("actor and organization are resolved");
    expect(writes).toEqual([]);
  });

  it("does not let a stale Go edit response clear the next scope's editor state", async () => {
    vi.stubGlobal("__GO_MESSAGING_EDIT_SLICE__", true);
    let finishRequest: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        return new Promise((resolve) => { finishRequest = resolve; });
      }
      if (path === "/api/modules") return Promise.resolve(Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] }));
      if (path === "/api/conversations") return Promise.resolve(Response.json({ conversations: [conversation()], me }));
      if (path.startsWith("/api/conversations/people")) return Promise.resolve(Response.json({ people }));
      if (path.includes("/presence")) return Promise.resolve(Response.json({ people: [] }));
      if (path.endsWith("/messages")) return Promise.resolve(Response.json(threadBody()));
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
      if (path === "/api/capabilities/execute") {
        capabilityBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ pendingApproval: true, reason: "Manager review required." }, { status: 202 });
      }
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { allowGo: true, ...props, conversationId: channelId });
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

  it("restores and locks an unresolved Go deletion after selector rollback", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" || path.startsWith("/api/messages/")) writes.push(path);
      if (path === "/api/capabilities/execute") return Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { allowGo: true, ...props, conversationId: channelId });
    const writesBeforeReload = writes.length;

    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    render(<MessagesPage {...props} />);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this message?" });
    expect((within(dialog).getByRole("button", { name: "Delete message" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete message" }));
    expect(writes).toHaveLength(writesBeforeReload);
  });

  it("keeps a Go deletion 404 locked across selector rollback without calling legacy DELETE", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/capabilities/execute") return Response.json({ error: "route unavailable" }, { status: 404 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    const first = render(<MessagesPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));
    const scope = { actorId: me, organizationId: props.organizationId };
    await waitFor(async () => expect(await getPendingMessageDelete(scope)).toMatchObject({ messageId: "m1", conversationId: channelId }));
    expect(paths.some((path) => path.startsWith("/api/messages/m1?intentId="))).toBe(false);
    await waitFor(() => {
      expect((within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }) as HTMLButtonElement).disabled).toBe(false);
    });

    first.unmount();
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    render(<MessagesPage {...props} />);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this message?" });
    expect((within(dialog).getByRole("button", { name: "Delete message" }) as HTMLButtonElement).disabled).toBe(true);
    expect(paths.some((path) => path.startsWith("/api/messages/m1?intentId="))).toBe(false);
  });

  it("blocks selector-off deletion when a pending Go marker cannot be checked for missing scope", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const scope = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true }, { status: 202 })));
    await deleteMessage("m1", undefined, { allowGo: true, ...scope, conversationId: channelId });
    expect(await getPendingMessageDelete(scope)).toMatchObject({ messageId: "m1", conversationId: channelId });

    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", false);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" || (path.startsWith("/api/messages/") && init?.method === "DELETE")) writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("actor and organization are resolved");
    expect(writes).toEqual([]);
    await expect(getPendingMessageDelete(scope)).resolves.toMatchObject({ messageId: "m1", conversationId: channelId });
  });

  it.each([true, false])("blocks message deletion until actor and organization scope resolve when Go selector is %s", async (goDeleteEnabled) => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", goDeleteEnabled);
    const writes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" || path.startsWith("/api/messages/")) writes.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this message?" })).getByRole("button", { name: "Delete message" }));

    expect((await screen.findByRole("alert")).textContent).toContain("paused until the actor");
    expect(writes).toEqual([]);
  });

  it("ignores a stale Go deletion response after the active actor or organization changes", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const finishRequests: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        return new Promise((resolve) => { finishRequests.push(resolve); });
      }
      if (path === "/api/modules") return Promise.resolve(Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] }));
      if (path === "/api/conversations") return Promise.resolve(Response.json({ conversations: [conversation()], me }));
      if (path.startsWith("/api/conversations/people")) return Promise.resolve(Response.json({ people }));
      if (path.includes("/presence")) return Promise.resolve(Response.json({ people: [] }));
      if (path.endsWith("/messages")) return Promise.resolve(Response.json(threadBody()));
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
      if (path === "/api/capabilities/execute") {
        capabilityBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 });
      }
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scopeA = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { allowGo: true, ...scopeA, conversationId: channelId });
    const view = render(<MessagesPage {...scopeA} />);
    expect(await screen.findByRole("alertdialog", { name: "Delete this message?" })).not.toBeNull();

    view.rerender(<MessagesPage actorId={other} organizationId="7d15d9ac-d8b6-4f49-8ca5-387adf08b8e5" />);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Delete this message?" })).toBeNull());
    expect(capabilityBodies).toHaveLength(1);
  });

  it("does not send a restored Go deletion after its actor and organization become unresolved", async () => {
    vi.stubGlobal("__GO_MESSAGING_DELETE_SLICE__", true);
    const deleteRequests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/capabilities/execute" || path.startsWith("/api/messages/m1?intentId=")) deleteRequests.push(path);
      if (path === "/api/capabilities/execute") return Response.json({ pendingApproval: true, reason: "Review required." }, { status: 202 });
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scopeA = { actorId: me, organizationId: "6a7c5482-c5a6-4fcb-8b69-a06d4820238a" };
    await deleteMessage("m1", undefined, { allowGo: true, ...scopeA, conversationId: channelId });
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
        match: (path, init) => (path.endsWith("/messages") && init?.method === "POST"
          ? Response.json({ error: "no capacity" }, { status: 422 })
          : path.endsWith("/messages") ? Response.json(threadBody()) : null),
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
        match: (path) => (path === "/api/conversations"
          ? Response.json({ conversations: [conversation(), conversation({ id: dmId, kind: "dm", title: "Grace Hopper" })], me })
          : null),
      },
      {
        match: (path) => (path.startsWith("/api/conversations/") && path.endsWith("/messages")
          ? Response.json(threadBody())
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
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence") && init?.method === "POST") { typingBodies.push(String(init.body)); return Response.json({ ok: true }); }
      if (path.includes("/presence")) return Response.json({ people: [{ userId: other, name: "Grace", typing: true }] });
      if (path.endsWith("/messages")) return Response.json(threadBody());
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

  it("polls the thread on the legacy five second cadence and pins to the newest message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let threadCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
        if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
        if (path.startsWith("/api/conversations/people")) return Response.json({ people });
        if (path.includes("/presence")) return Response.json({ people: [] });
        if (path.includes("/messages")) { threadCalls += 1; return Response.json(threadBody({ messages: [message({ id: `m${threadCalls}` })] })); }
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

  it("opens the mention picker from an alias and sends the mention to the legacy route", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", false);
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages") && init?.method === "POST") { posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); return Response.json({ ok: true, agentReply: null }); }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = (await screen.findByLabelText("Message general")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "@Gra", selectionStart: 4 } });
    const option = await screen.findByRole("option", { name: /@Grace/ });
    fireEvent.click(option);
    expect(composer.value).toBe("@Grace ");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 5_000 });
    expect(posts[0]).toMatchObject({ body: "@Grace", mentions: [{ type: "user", id: other }] });
  });

  it("keeps agent-enabled and @agent sends on the legacy path while Go replies are not ported", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const paths: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/messages") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ ok: true, agentReply: "On it" });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = (await screen.findByLabelText("Message general")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "@Chas", selectionStart: 5 } });
    fireEvent.click(await screen.findByRole("option", { name: /@Chaste/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(paths).not.toContain("/api/capabilities/execute");
    expect(posts[0]).toMatchObject({ body: "@Chaste", mentions: [{ type: "agent", id: "agent-1" }] });
  });

  it("sends mentions, replies, and uploaded attachments through Go when the slice is enabled", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const actionBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/attachments")) return Response.json({ attachmentId: "72b99920-8c21-463a-9c5b-479216017501", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 10 });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        actionBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ ok: true, data: { messageId: "sent-message-id" } });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<MessagesPage />);
    const composer = (await screen.findByLabelText("Message general")) as HTMLTextAreaElement;

    await screen.findByText("Morning all");
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

  it("keeps the draft visible when a Go message is pending approval", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const intentIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        intentIds.push((JSON.parse(String(init.body)) as { intentId: string }).intentId);
        return Response.json({ ok: false, pendingApproval: true, approvalId: "550e8400-e29b-41d4-a716-446655440000", reason: "Manager review required." }, { status: 202 });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    const composer = await screen.findByLabelText("Message general");
    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect((await screen.findByRole("status", {}, { timeout: 5_000 })).textContent).toContain("Manager review required.");
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(intentIds).toHaveLength(2), { timeout: 5_000 });
    expect(intentIds[1]).toBe(intentIds[0]);
  });

  it("reuses a Go message intent after an uncertain transport failure and clears it on success", async () => {
    vi.stubGlobal("__GO_MESSAGING_SEND_SLICE__", true);
    const sent: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation({ agentEnabled: false })], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (sent.length === 1) throw new TypeError("connection reset");
        return Response.json({ ok: true, data: { messageId: "sent-message-id" } });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
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

  it("rejects a sixth attachment with the legacy message and uploads before sending", async () => {
    const uploads: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.endsWith("/attachments")) { uploads.push(init?.body instanceof FormData ? "form" : String(init?.body)); return Response.json({ attachmentId: "attach-1", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 10 }); }
      if (path.endsWith("/messages") && init?.method === "POST") { posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); return Response.json({ ok: true, agentReply: null }); }
      if (path.endsWith("/messages")) return Response.json(threadBody());
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
    expect(uploads).toEqual(["form"]);
    expect(posts[0]).toMatchObject({ attachmentIds: ["attach-1"] });
  });

  it("confirms a governed conversation change and reports it as pending, not done", async () => {
    const patches: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === `/api/conversations/${channelId}` && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ pendingApproval: true, hint: "This change waits for approval in the Approvals inbox." }, { status: 202 });
      }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversation settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect((await screen.findByRole("status")).textContent).toContain("waits for approval in the Approvals inbox");
    expect(patches[0]).toMatchObject({ action: "archive", archived: true, intentId: expect.any(String) });
    expect(screen.getByRole("dialog", { name: /general/ })).not.toBeNull();
  });

  it("deletes a message through the governed route after a confirmation", async () => {
    const deletes: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.startsWith("/api/messages/m1") && init?.method === "DELETE") { deletes.push(path); return Response.json({ ok: true, data: {} }); }
      if (path.endsWith("/messages")) return Response.json(threadBody());
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage actorId={me} organizationId="legacy-delete-org" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this message?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete message" }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toMatch(/^\/api\/messages\/m1\?intentId=/);
  });

  it("runs a full message history search and jumps to the conversation that holds the hit", async () => {
    const threadUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.startsWith("/api/messages/search")) return Response.json({ results: [{ id: "hit-1", conversationId: channelId, conversationTitle: "general", body: "the needle", createdAt: "2026-10-01T09:00:00.000Z", senderType: "human", senderUserId: other }] });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.includes("/messages")) { threadUrls.push(path); return Response.json(threadBody({ messages: [message({ id: "hit-1", body: "the needle" })] })); }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MessagesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "All messages" }));
    fireEvent.change(screen.getByLabelText("Search all messages"), { target: { value: "needle" } });
    fireEvent.click(await screen.findByRole("button", { name: /the needle/ }));

    await waitFor(() => expect(threadUrls.some((url) => url.includes("around=hit-1"))).toBe(true));
  });

  it("scrolls to the top of the thread to prepend an older page without duplicating rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json({ catalog: [{ id: "messaging" }], enabledModules: ["messaging"] });
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path.includes("before=")) return Response.json(threadBody({ messages: [message({ id: "old", body: "from last week" }), message({ id: "m1" })], hasMore: false, nextCursor: null }));
      if (path.endsWith("/messages")) return Response.json(threadBody({ hasMore: true, nextCursor: "m1" }));
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
      if (path === "/api/conversations") return Response.json({ conversations: [conversation()], me });
      if (path.startsWith("/api/conversations/people")) return Response.json({ people });
      if (path.includes("/presence")) return Response.json({ people: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as { capabilityId?: string; input?: Record<string, unknown> };
        if (request.capabilityId !== "messaging.readMessages" || !request.input) return Response.json({ error: "unexpected capability" }, { status: 400 });
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
