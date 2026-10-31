import { describe, expect, it } from "vitest";
import type { SupportConversation, SupportMessage } from "../../api/support";
import {
  attentionRows,
  countByStatus,
  customerHistory,
  escalationReason,
  filterConversations,
  formatMinor,
  isSlaBreached,
  parseSupportRoute,
  pendingActionDescription,
  slaState,
  sortConversations,
  systemMessageText,
} from "./support-model";

const NOW = Date.parse("2026-10-30T09:00:00.000Z");
const ORGANIZATION = "66666666-6666-4666-8666-666666666666";
const CUSTOMER = "b2b7d5f0-9a3a-4f38-8f47-1a2b3c4d5e6f";
const OTHER_CUSTOMER = "9a145d87-5642-4c92-9d87-67f93b63b327";

function conversation(
  overrides: Partial<SupportConversation>,
): SupportConversation {
  return {
    id: "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
    customerId: CUSTOMER,
    customerName: "Ada Lovelace",
    subject: "Invoice question",
    status: "open",
    priority: "normal",
    channel: "desk",
    ticketNumber: 12,
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-30T08:00:00.000Z",
    lastMessageAt: "2026-10-30T08:00:00.000Z",
    lastMessagePreview: "My invoice looks wrong",
    ...overrides,
  };
}

const MESSAGES: SupportMessage[] = [
  {
    id: "d6a3b0c1-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
    orgId: ORGANIZATION,
    conversationId: "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
    senderType: "system",
    senderUserId: null,
    body: "Conversation opened about Invoice question.",
    createdAt: "2026-10-29T09:00:00.000Z",
  },
  {
    id: "e7b4c1d2-3a7b-4b1b-8d0f-7d2b3c4e5f60",
    orgId: ORGANIZATION,
    conversationId: "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
    senderType: "system",
    senderUserId: null,
    body: "Escalated by human: refund above policy",
    createdAt: "2026-10-30T08:30:00.000Z",
  },
];

describe("support app routes", () => {
  it("maps the app root and every tab to a URL-addressable surface", () => {
    expect(parseSupportRoute("/support")).toEqual({
      tab: "inbox",
      conversationId: null,
    });
    expect(parseSupportRoute("/support/inbox")).toEqual({
      tab: "inbox",
      conversationId: null,
    });
    expect(parseSupportRoute("/support/overview")).toEqual({
      tab: "overview",
      conversationId: null,
    });
    expect(parseSupportRoute("/support/knowledge")).toEqual({
      tab: "knowledge",
      conversationId: null,
    });
    expect(parseSupportRoute("/support/channels")).toEqual({
      tab: "channels",
      conversationId: null,
    });
    expect(parseSupportRoute("/support/settings")).toEqual({
      tab: "settings",
      conversationId: null,
    });
  });

  it("deep links a conversation only for a real UUID", () => {
    expect(
      parseSupportRoute("/support/inbox/3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f"),
    ).toEqual({
      tab: "inbox",
      conversationId: "3f1b0c6e-2f6a-4a0a-9c9e-6c1a2b3d4e5f",
    });
    expect(parseSupportRoute("/support/inbox/not-a-conversation")).toEqual({
      tab: "inbox",
      conversationId: null,
    });
    expect(parseSupportRoute("/support/billing")).toEqual({
      tab: "not-found",
      conversationId: null,
    });
  });
});

describe("support queue model", () => {
  it("filters by query, status, assignee, priority, and SLA state", () => {
    const rows = [
      conversation({
        id: "open",
        status: "open",
        customerName: "Ada Lovelace",
        assignedUserId: null,
      }),
      conversation({
        id: "escalated",
        status: "escalated",
        customerName: "Grace Hopper",
        customerEmail: "grace@example.test",
        priority: "urgent",
        assignedUserId: "55555555-5555-4555-8555-555555555555",
        slaDueAt: "2026-10-30T08:00:00.000Z",
      }),
      conversation({
        id: "resolved",
        status: "resolved",
        customerName: "Katherine Johnson",
        subject: "Old receipt",
      }),
    ];
    expect(
      filterConversations(rows, { status: "escalated", now: NOW }).map(
        (row) => row.id,
      ),
    ).toEqual(["escalated"]);
    expect(
      filterConversations(rows, { query: "grace@example", now: NOW }).map(
        (row) => row.id,
      ),
    ).toEqual(["escalated"]);
    expect(filterConversations(rows, { query: "#12", now: NOW })).toHaveLength(
      3,
    );
    expect(
      filterConversations(rows, {
        assignee: "mine",
        actorId: "55555555-5555-4555-8555-555555555555",
        now: NOW,
      }).map((row) => row.id),
    ).toEqual(["escalated"]);
    expect(
      filterConversations(rows, { assignee: "unassigned", now: NOW }).map(
        (row) => row.id,
      ),
    ).toEqual(["open", "resolved"]);
    expect(
      filterConversations(rows, { priority: "urgent", now: NOW }).map(
        (row) => row.id,
      ),
    ).toEqual(["escalated"]);
    expect(
      filterConversations(rows, { sla: "breached", now: NOW }).map(
        (row) => row.id,
      ),
    ).toEqual(["escalated"]);
    expect(filterConversations(rows, { sla: "soon", now: NOW })).toHaveLength(
      0,
    );
  });

  it("sorts newest, priority, and SLA due without mutating the source", () => {
    const newest = conversation({
      id: "newest",
      lastMessageAt: "2026-10-30T08:59:00.000Z",
    });
    const urgent = conversation({
      id: "urgent",
      priority: "urgent",
      lastMessageAt: "2026-10-30T08:00:00.000Z",
      slaDueAt: "2026-10-30T10:00:00.000Z",
    });
    const low = conversation({
      id: "low",
      priority: "low",
      lastMessageAt: "2026-10-30T08:30:00.000Z",
      slaDueAt: "2026-10-30T09:30:00.000Z",
    });
    const rows = [low, newest, urgent];
    expect(sortConversations(rows, "newest").map((row) => row.id)).toEqual([
      "newest",
      "low",
      "urgent",
    ]);
    expect(sortConversations(rows, "priority").map((row) => row.id)).toEqual([
      "urgent",
      "newest",
      "low",
    ]);
    expect(sortConversations(rows, "sla").map((row) => row.id)).toEqual([
      "low",
      "urgent",
      "newest",
    ]);
    expect(rows.map((row) => row.id)).toEqual(["low", "newest", "urgent"]);
  });

  it("labels SLA states and suppresses breaches on resolved work", () => {
    expect(slaState("2026-10-30T08:59:00.000Z", NOW)).toEqual({
      tone: "danger",
      label: "SLA breached",
    });
    expect(slaState("2026-10-30T10:00:00.000Z", NOW)).toEqual({
      tone: "warn",
      label: "SLA 1h left",
    });
    expect(slaState("2026-11-01T09:00:00.000Z", NOW).tone).toBe("ok");
    expect(slaState(null, NOW)).toEqual({ tone: "none", label: "No SLA" });
    expect(
      isSlaBreached(
        conversation({
          status: "resolved",
          slaDueAt: "2026-10-29T08:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("counts the queue and ranks only work that needs a person", () => {
    const rows = [
      conversation({ id: "open", status: "open" }),
      conversation({ id: "escalated", status: "escalated" }),
      conversation({
        id: "resolved",
        status: "resolved",
        slaDueAt: "2026-10-29T08:00:00.000Z",
      }),
      conversation({
        id: "breached",
        status: "open",
        slaDueAt: "2026-10-30T08:00:00.000Z",
      }),
      conversation({
        id: "urgent-unassigned",
        status: "open",
        priority: "urgent",
        assignedUserId: null,
      }),
    ];
    expect(countByStatus(rows)).toEqual({
      all: 5,
      open: 3,
      escalated: 1,
      resolved: 1,
    });
    const attention = attentionRows(rows, NOW).map((row) => row.id);
    expect(attention).toContain("escalated");
    expect(attention).toContain("breached");
    expect(attention).toContain("urgent-unassigned");
    expect(attention).not.toContain("resolved");
  });

  it("finds the customer's other conversations without repeating the current one", () => {
    const rows = [
      conversation({ id: "current" }),
      conversation({
        id: "earlier",
        lastMessageAt: "2026-10-28T08:00:00.000Z",
      }),
      conversation({
        id: "foreign",
        customerId: OTHER_CUSTOMER,
        lastMessageAt: "2026-10-30T08:00:00.000Z",
      }),
    ];
    expect(
      customerHistory(rows, CUSTOMER, "current").map((row) => row.id),
    ).toEqual(["earlier"]);
  });
});

describe("support conversation copy", () => {
  it("extracts the handoff reason and shortens system records", () => {
    expect(escalationReason(MESSAGES)).toBe("refund above policy");
    expect(systemMessageText(MESSAGES[0]!.body)).toBe("Conversation opened");
    expect(systemMessageText(MESSAGES[1]!.body)).toBe("Escalated to a person");
    expect(systemMessageText("Resolved by human.")).toBe("Resolved");
    expect(systemMessageText("A note without a known prefix")).toBe(
      "A note without a known prefix",
    );
  });

  it("describes an unresolved action without exposing the raw capability id", () => {
    expect(
      pendingActionDescription("support.postMessage", {
        body: "A recorded customer reply",
      }),
    ).toContain("A recorded customer reply");
    expect(pendingActionDescription("support.resolveConversation", {})).toBe(
      "Resolve this conversation",
    );
    expect(
      pendingActionDescription("support.startConversation", {
        subject: "Seat change",
      }),
    ).toContain("Seat change");
  });

  it("formats money from minor units and falls back for an unknown currency", () => {
    expect(formatMinor(120_000, "USD")).toContain("1,200");
    expect(formatMinor(1_234, "")).toBe("12.34");
  });
});
