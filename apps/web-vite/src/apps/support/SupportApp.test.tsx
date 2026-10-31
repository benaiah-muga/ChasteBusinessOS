import { useEffect, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupportApp } from "./SupportApp";
import { ToastProvider } from "../../ui/toast";
import { stubWebLocks } from "../../test/web-locks";
import type { SupportConversation, SupportMessage } from "../../api/support";

const actorId = "55555555-5555-4555-8555-555555555555";
const organizationId = "66666666-6666-4666-8666-666666666666";
const customerId = "b2b7d5f0-9a3a-4f38-8f47-1a2b3c4d5e6f";
const openId = "11111111-1111-4111-8111-111111111111";
const escalatedId = "22222222-2222-4222-8222-222222222222";
const resolvedId = "33333333-3333-4333-8333-333333333333";
const widgetId = "77777777-7777-4777-8777-777777777777";
const newConversationId = "44444444-4444-4444-8444-444444444444";
const messageId = "88888888-8888-4888-8888-888888888888";

const openConversation: SupportConversation = {
  id: openId,
  customerId,
  customerName: "Nadia Haddad",
  customerEmail: "nadia@haddad.example",
  subject: "Wants a refund for two seats removed mid-cycle",
  status: "open",
  priority: "urgent",
  category: "billing",
  assignedUserId: actorId,
  assignedUserName: "Amina Okoye",
  slaDueAt: "2026-10-30T08:00:00.000Z",
  ticketNumber: 9,
  channel: "desk",
  createdAt: "2026-10-29T09:00:00.000Z",
  updatedAt: "2026-10-30T07:00:00.000Z",
  lastMessageAt: "2026-10-30T07:00:00.000Z",
  lastMessagePreview: "Can you refund the difference?",
};

const escalatedConversation: SupportConversation = {
  id: escalatedId,
  customerId,
  customerName: "Owen Park",
  customerEmail: "owen@park.example",
  subject: "Add three more seats before the next project",
  status: "escalated",
  priority: "high",
  category: "billing",
  assignedUserId: actorId,
  assignedUserName: "Amina Okoye",
  slaDueAt: "2026-10-30T06:00:00.000Z",
  ticketNumber: 10,
  channel: "desk",
  createdAt: "2026-10-28T09:00:00.000Z",
  updatedAt: "2026-10-30T06:30:00.000Z",
  lastMessageAt: "2026-10-30T06:30:00.000Z",
  lastMessagePreview: "I will confirm the amount with billing.",
};

const resolvedConversation: SupportConversation = {
  id: resolvedId,
  customerId,
  customerName: "Sam Okafor",
  customerEmail: "sam@okafor.example",
  subject: "Where do the citations come from?",
  status: "resolved",
  priority: "normal",
  category: "product",
  assignedUserId: actorId,
  assignedUserName: "Amina Okoye",
  slaDueAt: "2026-10-30T10:00:00.000Z",
  ticketNumber: 11,
  channel: "widget",
  createdAt: "2026-10-28T09:00:00.000Z",
  updatedAt: "2026-10-29T09:00:00.000Z",
  lastMessageAt: "2026-10-29T09:00:00.000Z",
  lastMessagePreview: "That is exactly what I needed.",
};

const widgetConversation: SupportConversation = {
  id: widgetId,
  customerId: "",
  customerName: "Website visitor",
  customerEmail: "visitor@northwind.example",
  subject: "Pricing for a second workspace",
  status: "open",
  priority: "normal",
  category: "sales",
  assignedUserId: undefined,
  assignedUserName: undefined,
  slaDueAt: null,
  ticketNumber: null,
  channel: "widget",
  createdAt: "2026-10-30T07:00:00.000Z",
  updatedAt: "2026-10-30T07:20:00.000Z",
  lastMessageAt: "2026-10-30T07:20:00.000Z",
  lastMessagePreview: "Can you help with a separate billing contact?",
};

const conversations = [
  openConversation,
  escalatedConversation,
  resolvedConversation,
  widgetConversation,
];

const openMessages: SupportMessage[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    orgId: organizationId,
    conversationId: openId,
    senderType: "system",
    senderUserId: null,
    body: `Conversation opened about ${openConversation.subject}.`,
    createdAt: "2026-10-29T09:00:00.000Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    orgId: organizationId,
    conversationId: openId,
    senderType: "customer",
    senderUserId: null,
    body: "We removed two seats in the middle of the billing cycle. The invoice still charges for all ten seats. Can you refund the difference?",
    createdAt: "2026-10-29T09:10:00.000Z",
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    orgId: organizationId,
    conversationId: openId,
    senderType: "staff",
    senderUserId: actorId,
    body: "I can check that. Removing seats mid-cycle may qualify for a prorated credit.",
    createdAt: "2026-10-29T10:00:00.000Z",
  },
];

const widgetMessages: SupportMessage[] = [
  {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    orgId: organizationId,
    conversationId: widgetId,
    senderType: "system",
    senderUserId: null,
    body: "Hi - ask us anything and a person on the Northwind support desk will get right back to you.",
    createdAt: "2026-10-30T07:00:00.000Z",
  },
  {
    id: "12121212-1212-4212-8212-121212121212",
    orgId: organizationId,
    conversationId: widgetId,
    senderType: "customer",
    senderUserId: null,
    body: "Hi, we need pricing for a second workspace and a separate billing contact. Can you help?",
    createdAt: "2026-10-30T07:20:00.000Z",
  },
];

const escalatedMessages: SupportMessage[] = [
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    orgId: organizationId,
    conversationId: escalatedId,
    senderType: "system",
    senderUserId: null,
    body: "Conversation opened about Add three more seats.",
    createdAt: "2026-10-28T09:00:00.000Z",
  },
  {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    orgId: organizationId,
    conversationId: escalatedId,
    senderType: "system",
    senderUserId: null,
    body: "Escalated by human: The seat change needs billing approval.",
    createdAt: "2026-10-30T06:30:00.000Z",
  },
];

const library = {
  canned: [
    {
      id: "9a145d87-5642-4c92-9d87-67f93b63b327",
      shortcut: "/refund",
      title: "Refund review",
      body: "I have sent this to the billing team for a refund review.",
    },
    {
      id: "8b034c76-4531-4b81-8c76-56e82a52c216",
      shortcut: "/billing",
      title: "Billing email",
      body: "Open Settings, then Billing, update the email, and save.",
    },
  ],
  articles: [
    {
      id: "7c923b65-3420-4a70-9b65-45d71941b105",
      title: "Refund and proration policy",
      body: "Refunds are reviewed by a person.",
      category: "billing",
      isPublic: true,
    },
  ],
};

const orderStatus = {
  customerName: "Nadia Haddad",
  totalOutstandingMinor: 120_000,
  invoices: [
    {
      number: 1,
      status: "sent",
      totalMinor: 120_000,
      paidMinor: 0,
      outstandingMinor: 120_000,
      issuedAt: "2026-10-29T09:00:00.000Z",
    },
  ],
};

const tickets = [
  {
    id: "6b812a54-2319-4960-8a54-34c60830a004",
    title: "Widget transcript drops the first line",
    description: "A bug in the handoff.",
    origin: "bug",
    status: "open",
    createdAt: "2026-10-30T06:00:00.000Z",
  },
];

const channels = {
  autoReplyEnabled: true,
  greeting: "Hi - how can we help?",
  embedToken: "northwind-token",
  canManage: true,
};

function threadFor(conversationId: string): {
  conversation: Record<string, unknown>;
  messages: SupportMessage[];
} {
  if (conversationId === escalatedId)
    return { conversation: escalatedConversation, messages: escalatedMessages };
  if (conversationId === resolvedId)
    return {
      conversation: resolvedConversation,
      messages: openMessages.map((message) => ({
        ...message,
        conversationId: resolvedId,
      })),
    };
  if (conversationId === widgetId)
    return {
      conversation: { ...widgetConversation, customerId: null },
      messages: widgetMessages,
    };
  return { conversation: openConversation, messages: openMessages };
}

interface FetchOptions {
  disabled?: boolean;
  failPosts?: boolean;
}

function installFetch(options: FetchOptions = {}) {
  const calls: Array<{
    path: string;
    capabilityId?: string;
    input?: Record<string, unknown>;
    method: string;
    body?: unknown;
  }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/modules") {
        return Response.json({
          catalog: [
            {
              id: "support",
              label: "Customer care",
              description: "Support desk",
              href: "/support",
            },
          ],
          enabledModules: options.disabled ? [] : ["support"],
          usingDefaults: false,
        });
      }
      if (path === "/api/team") {
        return Response.json({
          members: [
            {
              userId: actorId,
              name: "Amina Okoye",
              email: "amina@example.test",
              roleKeys: ["owner"],
            },
          ],
          roles: [],
          catalog: [],
        });
      }
      if (path === "/api/support/customers") {
        return Response.json({
          customers: [
            {
              id: customerId,
              name: "Nadia Haddad",
              email: "nadia@haddad.example",
            },
          ],
        });
      }
      if (path === "/api/support/draft") {
        return Response.json({
          draft: "A reviewed draft from the customer's own record.",
          sessionId: "session-1",
          steps: 1,
        });
      }
      if (path === "/api/notification-preferences") {
        const body =
          method === "PUT"
            ? (JSON.parse(String(init?.body ?? "{}")) as {
                mutedKinds?: string[];
              })
            : null;
        if (body) calls.push({ path, method, body });
        return Response.json({
          kinds: ["ticket.filed"],
          mutedKinds: body?.mutedKinds ?? [],
        });
      }
      if (path === "/api/support/channels") {
        if (method === "POST") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          calls.push({ path, method, body: patch });
          return Response.json({
            ...channels,
            ...patch,
            greeting:
              typeof patch.greeting === "string"
                ? patch.greeting
                : channels.greeting,
          });
        }
        return Response.json(channels);
      }
      if (path === "/api/capabilities/execute") {
        const payload = JSON.parse(String(init?.body)) as {
          capabilityId: string;
          input: Record<string, unknown>;
        };
        calls.push({
          path,
          method,
          capabilityId: payload.capabilityId,
          input: payload.input,
        });
        if (
          options.failPosts &&
          [
            "support.postMessage",
            "support.escalateConversation",
            "support.resolveConversation",
            "support.updateTicket",
          ].includes(payload.capabilityId)
        ) {
          return Response.json({ error: "internal error" }, { status: 500 });
        }
        switch (payload.capabilityId) {
          case "support.listConversations":
            return Response.json({ ok: true, data: { conversations } });
          case "support.readConversation":
            return Response.json({
              ok: true,
              data: threadFor(String(payload.input.conversationId)),
            });
          case "support.listTickets":
            return Response.json({ ok: true, data: { tickets } });
          case "support.listLibrary":
            return Response.json({ ok: true, data: library });
          case "support.lookupOrderStatus":
            return Response.json({
              ok: true,
              data:
                payload.input.conversationId === openId
                  ? orderStatus
                  : {
                      customerName: "Customer",
                      totalOutstandingMinor: 0,
                      invoices: [],
                    },
            });
          case "support.suggestCategory":
            return Response.json({
              ok: true,
              data: { category: "billing", draft: true },
            });
          case "support.postMessage":
            return Response.json({
              ok: true,
              data: {
                messageId,
                senderType:
                  payload.input.from === "customer" ? "customer" : "staff",
              },
            });
          case "support.updateTicket":
            return Response.json({ ok: true, data: { updated: true } });
          case "support.resolveConversation":
            return Response.json({ ok: true, data: { status: "resolved" } });
          case "support.reopenConversation":
            return Response.json({ ok: true, data: { status: "open" } });
          case "support.escalateConversation":
            return Response.json({ ok: true, data: { status: "escalated" } });
          case "support.startConversation":
            return Response.json({
              ok: true,
              data: { conversationId: newConversationId },
            });
          case "support.createCannedResponse":
            return Response.json({
              ok: true,
              data: {
                cannedResponseId: "99999999-9999-4999-8999-999999999999",
              },
            });
          case "support.createKbArticle":
            return Response.json({
              ok: true,
              data: { articleId: "99999999-9999-4999-8999-999999999998" },
            });
          case "support.createTicket":
            return Response.json({
              ok: true,
              data: { ticketId: "99999999-9999-4999-8999-999999999997" },
            });
          case "crm.createCustomer":
            return Response.json({
              ok: true,
              data: { customerId, duplicateWarning: null },
            });
          default:
            throw new Error(`unexpected capability ${payload.capabilityId}`);
        }
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function Harness({ initialPath }: { initialPath: string }) {
  const [pathname, setPathname] = useState(initialPath);
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return (
    <div>
      <div id="support-topbar-slot" data-testid="support-topbar-slot" />
      <ToastProvider>
        <SupportApp
          pathname={pathname}
          baseCurrency="USD"
          actorId={actorId}
          organizationId={organizationId}
        />
      </ToastProvider>
    </div>
  );
}

function renderApp(pathname: string) {
  window.history.replaceState(null, "", pathname);
  return render(<Harness initialPath={pathname} />);
}

function queue() {
  return screen.getByRole("complementary", { name: "Conversation queue" });
}

beforeEach(() => {
  stubWebLocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("min-width: 900px"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  window.history.replaceState(null, "", "/support");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const SLOW = 60_000;

describe("Customer support app surface", () => {
  it(
    "opens a deep-linked conversation with its ticket and real billing context",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);

      expect(
        await screen.findByRole("heading", { name: "Inbox" }),
      ).not.toBeNull();
      const thread = await screen.findByRole("region", {
        name: "Conversation with Nadia Haddad",
      });
      expect(
        within(thread).getByText(
          "Wants a refund for two seats removed mid-cycle",
        ),
      ).not.toBeNull();
      expect(within(thread).getByText(/We removed two seats/)).not.toBeNull();
      expect((await screen.findAllByText("$1,200.00")).length).toBeGreaterThan(
        0,
      );
      expect(
        calls.some((call) => call.capabilityId === "support.lookupOrderStatus"),
      ).toBe(true);
      expect(
        screen.getByRole("navigation", { name: "Customer support sections" }),
      ).not.toBeNull();
      expect(
        screen
          .getByRole("link", { name: /Inbox/ })
          .getAttribute("aria-current"),
      ).toBe("page");
    },
    SLOW,
  );

  it(
    "shows an unbound website-widget visitor in the queue and its thread",
    async () => {
      installFetch();
      renderApp(`/support/inbox/${widgetId}`);
      const thread = await screen.findByRole("region", {
        name: "Conversation with Website visitor",
      });
      expect(
        within(thread).getByText("visitor@northwind.example"),
      ).not.toBeNull();
      expect(
        within(thread).getByText("Pricing for a second workspace"),
      ).not.toBeNull();
      expect(
        within(thread).getByText(/separate billing contact/),
      ).not.toBeNull();
      expect(
        within(queue()).getByText("visitor@northwind.example"),
      ).not.toBeNull();
      expect(within(thread).getByText("Log customer message")).not.toBeNull();
    },
    SLOW,
  );

  it(
    "moves between the app's horizontal tabs and keeps each surface addressable",
    async () => {
      installFetch();
      renderApp("/support/overview");

      expect(
        await screen.findByRole("heading", { name: "Overview" }),
      ).not.toBeNull();
      fireEvent.click(screen.getByRole("link", { name: /Knowledge/ }));
      expect(
        await screen.findByRole("heading", { name: "What the desk knows" }),
      ).not.toBeNull();
      expect(window.location.pathname).toBe("/support/knowledge");

      fireEvent.click(screen.getByRole("link", { name: /Channels/ }));
      expect(
        await screen.findByRole("heading", {
          name: "Where customers reach you",
        }),
      ).not.toBeNull();
      expect(window.location.pathname).toBe("/support/channels");

      fireEvent.click(screen.getByRole("link", { name: /Settings/ }));
      expect(
        await screen.findByRole("heading", { name: "Support settings" }),
      ).not.toBeNull();
      expect(window.location.pathname).toBe("/support/settings");

      fireEvent.click(screen.getByRole("link", { name: /Inbox/ }));
      expect(
        await screen.findByRole("heading", { name: "Inbox" }),
      ).not.toBeNull();
      expect(window.location.pathname).toBe("/support/inbox");
    },
    SLOW,
  );

  it(
    "opens the support settings sections and embeds the real channel controls",
    async () => {
      installFetch();
      renderApp("/support/settings");

      expect(
        await screen.findByRole("heading", { name: "Support settings" }),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Overview" })).not.toBeNull();
      expect(screen.getByRole("button", { name: "Channels" })).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Channels" }));
      expect(await screen.findByText("Website widget")).not.toBeNull();
      expect(screen.getByText("AI behavior")).not.toBeNull();
      expect(screen.getByText(/northwind-token/)).not.toBeNull();
    },
    SLOW,
  );

  it(
    "saves the support ticket notification preference from support settings",
    async () => {
      const { calls } = installFetch();
      renderApp("/support/settings");

      fireEvent.click(
        await screen.findByRole("button", { name: "Notifications" }),
      );
      const toggle = await screen.findByRole("checkbox", {
        name: /Notify me when a support ticket is filed/,
      });
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole("button", { name: "Save preference" }));

      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.path === "/api/notification-preferences" &&
              call.method === "PUT",
          ),
        ).toBe(true),
      );
      expect(
        await screen.findByText("Support notification preference saved."),
      ).not.toBeNull();
    },
    SLOW,
  );

  it(
    "filters and searches the queue without losing the thread",
    async () => {
      installFetch();
      renderApp(`/support/inbox/${openId}`);
      await screen.findByRole("region", {
        name: "Conversation with Nadia Haddad",
      });

      fireEvent.click(
        within(queue()).getByRole("button", { name: /^Awaiting/ }),
      );
      expect(within(queue()).getByText("Owen Park")).not.toBeNull();
      expect(within(queue()).queryByText("Nadia Haddad")).toBeNull();

      fireEvent.click(within(queue()).getByRole("button", { name: /^All/ }));
      fireEvent.change(
        within(queue()).getByRole("searchbox", {
          name: "Search conversations",
        }),
        { target: { value: "Sam" } },
      );
      expect(within(queue()).getByText("Sam Okafor")).not.toBeNull();
      expect(within(queue()).queryByText("Nadia Haddad")).toBeNull();
    },
    SLOW,
  );

  it(
    "selects another conversation through the URL and shows its handoff reason",
    async () => {
      installFetch();
      renderApp(`/support/inbox/${openId}`);
      await screen.findByRole("region", {
        name: "Conversation with Nadia Haddad",
      });

      fireEvent.click(
        within(queue()).getByRole("button", { name: /Owen Park/ }),
      );
      const thread = await screen.findByRole("region", {
        name: "Conversation with Owen Park",
      });
      expect(window.location.pathname).toBe(`/support/inbox/${escalatedId}`);
      expect(within(thread).getByText("Why this needs a human")).not.toBeNull();
      expect(
        within(thread).getByText("The seat change needs billing approval."),
      ).not.toBeNull();
    },
    SLOW,
  );

  it(
    "sends a staff reply through the governed message capability",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);
      const composer = await screen.findByRole("textbox", {
        name: "Reply to the customer",
      });
      fireEvent.change(composer, {
        target: { value: "I have confirmed the credit with billing." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

      expect(await screen.findByText("Reply sent")).not.toBeNull();
      const call = calls.find(
        (entry) => entry.capabilityId === "support.postMessage",
      );
      expect(call?.input).toMatchObject({
        conversationId: openId,
        body: "I have confirmed the credit with billing.",
        from: "staff",
      });
      expect((composer as HTMLTextAreaElement).value).toBe("");
    },
    SLOW,
  );

  it(
    "logs a customer message without disguising it as a staff reply",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);
      const composer = await screen.findByRole("textbox", {
        name: "Reply to the customer",
      });
      fireEvent.click(
        screen.getByRole("button", { name: /Log customer message/ }),
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "Log the customer's message" }),
        { target: { value: "Please close the ticket after the credit." } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Log message" }));

      expect(
        await screen.findByText("Customer message recorded"),
      ).not.toBeNull();
      const call = calls.find(
        (entry) => entry.capabilityId === "support.postMessage",
      );
      expect(call?.input).toMatchObject({
        body: "Please close the ticket after the credit.",
        from: "customer",
      });
      expect(composer).not.toBeNull();
    },
    SLOW,
  );

  it(
    "drafts with the copilot into the editable composer, never into the thread",
    async () => {
      installFetch();
      renderApp(`/support/inbox/${openId}`);
      const composer = await screen.findByRole("textbox", {
        name: "Reply to the customer",
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Draft with copilot" }),
      );

      await waitFor(() =>
        expect((composer as HTMLTextAreaElement).value).toBe(
          "A reviewed draft from the customer's own record.",
        ),
      );
      expect(
        screen.getByText(/AI draft, built from this customer's record/),
      ).not.toBeNull();
      expect(
        screen.getByText(
          /Drafts are never sent without a person releasing them/,
        ),
      ).not.toBeNull();
    },
    SLOW,
  );

  it(
    "inserts a quick reply into the composer without sending it",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);
      const composer = await screen.findByRole("textbox", {
        name: "Reply to the customer",
      });
      fireEvent.click(screen.getByRole("button", { name: "Quick replies" }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Refund review/ }),
      );

      expect((composer as HTMLTextAreaElement).value).toContain(
        "billing team for a refund review",
      );
      expect(
        calls.some((entry) => entry.capabilityId === "support.postMessage"),
      ).toBe(false);
    },
    SLOW,
  );

  it(
    "resolves a conversation through the capability and reports the outcome",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);
      await screen.findByRole("region", {
        name: "Conversation with Nadia Haddad",
      });
      fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

      expect(await screen.findByText("Conversation resolved")).not.toBeNull();
      expect(
        calls.some(
          (entry) =>
            entry.capabilityId === "support.resolveConversation" &&
            entry.input?.conversationId === openId,
        ),
      ).toBe(true);
    },
    SLOW,
  );

  it(
    "requires a reason before escalating a thread",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);
      await screen.findByRole("region", {
        name: "Conversation with Nadia Haddad",
      });
      fireEvent.click(screen.getByRole("button", { name: "Escalate" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Escalate to a human",
      });
      fireEvent.change(
        within(dialog).getByLabelText("Why does this need a person?"),
        { target: { value: "The refund is above the desk's authority." } },
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Escalate" }));

      expect(await screen.findByText("Conversation escalated")).not.toBeNull();
      const call = calls.find(
        (entry) => entry.capabilityId === "support.escalateConversation",
      );
      expect(call?.input).toMatchObject({
        conversationId: openId,
        reason: "The refund is above the desk's authority.",
      });
    },
    SLOW,
  );

  it(
    "edits and saves the ticket fields in the context panel",
    async () => {
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);
      await screen.findByRole("region", {
        name: "Conversation with Nadia Haddad",
      });
      const priority = screen.getByLabelText("Priority");
      fireEvent.change(priority, { target: { value: "normal" } });
      fireEvent.click(screen.getByRole("button", { name: "Save ticket" }));

      expect(await screen.findByText("Ticket fields saved.")).not.toBeNull();
      const call = calls.find(
        (entry) => entry.capabilityId === "support.updateTicket",
      );
      expect(call?.input).toMatchObject({
        conversationId: openId,
        priority: "normal",
      });
    },
    SLOW,
  );

  it(
    "opens a new conversation bound to a customer",
    async () => {
      const { calls } = installFetch();
      renderApp("/support/inbox");
      await screen.findByRole("heading", { name: "Inbox" });
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
      const dialog = await screen.findByRole("dialog", {
        name: "New conversation",
      });
      await waitFor(() =>
        expect(
          within(dialog).getByRole("combobox", { name: "Customer" }),
        ).not.toBeNull(),
      );
      fireEvent.change(
        within(dialog).getByRole("combobox", { name: "Customer" }),
        { target: { value: customerId } },
      );
      fireEvent.change(
        within(dialog).getByRole("textbox", { name: "What is this about?" }),
        { target: { value: "Invoice email change" } },
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Open conversation" }),
      );

      expect(await screen.findByText("Conversation opened")).not.toBeNull();
      const call = calls.find(
        (entry) => entry.capabilityId === "support.startConversation",
      );
      expect(call?.input).toMatchObject({
        customerId,
        subject: "Invoice email change",
      });
    },
    SLOW,
  );

  it(
    "renders the support module as not installed without pretending the desk works",
    async () => {
      installFetch({ disabled: true });
      renderApp("/support/inbox");
      expect(
        await screen.findByRole("heading", {
          name: "The support app is not installed.",
        }),
      ).not.toBeNull();
      expect(
        screen.queryByRole("navigation", { name: "Customer support sections" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: /Open settings/ }),
      ).not.toBeNull();
    },
    SLOW,
  );

  it(
    "shows a retry banner for an unresolved governed action and recovers it",
    async () => {
      const storageKey = `chaste.support.conversation-write-intent.v1:pending:${encodeURIComponent(actorId)}:${encodeURIComponent(organizationId)}`;
      const input = {
        conversationId: openId,
        body: "Recover this customer reply.",
        from: "staff",
      };
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          intentId: "99999999-9999-4999-8999-999999999996",
          capabilityId: "support.postMessage",
          input,
          fingerprint: JSON.stringify({
            capabilityId: "support.postMessage",
            input,
          }),
        }),
      );
      const { calls } = installFetch();
      renderApp(`/support/inbox/${openId}`);

      expect(
        await screen.findByText(/An action is waiting to be confirmed/),
      ).not.toBeNull();
      expect(screen.getByText(/Recover this customer reply/)).not.toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Retry saved action" }),
      );
      await waitFor(() =>
        expect(
          calls.some(
            (entry) =>
              entry.capabilityId === "support.postMessage" &&
              entry.input?.body === "Recover this customer reply.",
          ),
        ).toBe(true),
      );
      await waitFor(() =>
        expect(
          screen.queryByText(/An action is waiting to be confirmed/),
        ).toBeNull(),
      );
    },
    SLOW,
  );

  it(
    "keeps the typed reply visible when a governed write fails",
    async () => {
      installFetch({ failPosts: true });
      renderApp(`/support/inbox/${openId}`);
      const composer = await screen.findByRole("textbox", {
        name: "Reply to the customer",
      });
      fireEvent.change(composer, {
        target: { value: "This reply must not disappear." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

      expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
      expect((composer as HTMLTextAreaElement).value).toBe(
        "This reply must not disappear.",
      );
    },
    SLOW,
  );
});

describe("support knowledge and channels", () => {
  it(
    "lists quick replies and articles and saves a reviewed article",
    async () => {
      const { calls } = installFetch();
      renderApp("/support/knowledge");

      expect(
        await screen.findByRole("heading", { name: "What the desk knows" }),
      ).not.toBeNull();
      expect(await screen.findByText("Refund review")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "New article" }));
      const dialog = await screen.findByRole("dialog", { name: "New article" });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), {
        target: { value: "Seat proration review" },
      });
      fireEvent.change(
        within(dialog).getByRole("textbox", { name: "Article" }),
        {
          target: {
            value: "A person on billing confirms any mid-cycle seat credit.",
          },
        },
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Save article" }),
      );

      expect(await screen.findByText("Article saved")).not.toBeNull();
      const call = calls.find(
        (entry) => entry.capabilityId === "support.createKbArticle",
      );
      expect(call?.input).toMatchObject({
        title: "Seat proration review",
        body: "A person on billing confirms any mid-cycle seat credit.",
      });
    },
    SLOW,
  );

  it(
    "saves the website auto-reply switch through the channel settings route",
    async () => {
      const { calls } = installFetch();
      renderApp("/support/channels");

      expect(
        await screen.findByRole("heading", {
          name: "Where customers reach you",
        }),
      ).not.toBeNull();
      expect(await screen.findByText(/northwind-token/)).not.toBeNull();
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: /Answer widget visitors automatically/,
        }),
      );
      await waitFor(() =>
        expect(
          calls.some((entry) => {
            if (
              entry.method !== "POST" ||
              typeof entry.body !== "object" ||
              entry.body === null
            )
              return false;
            return (
              (entry.body as Record<string, unknown>).autoReplyEnabled === false
            );
          }),
        ).toBe(true),
      );
      expect(await screen.findByText("Channel settings saved")).not.toBeNull();
    },
    SLOW,
  );
});
