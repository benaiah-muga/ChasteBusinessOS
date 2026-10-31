/**
 * Seed a realistic customer support desk in an existing workspace.
 *
 * Demo only. Do not run this against a production workspace.
 *
 * The conversations, messages, ticket fields, escalation, resolution, canned
 * replies, knowledge articles, and internal tickets all go through the governed
 * capability executor. Timestamps are backdated afterwards only so the queue
 * looks like a working desk rather than eight conversations created in one
 * second. Re-running the seed replaces the Northwind demo conversations and
 * keeps the demo customers, so invoices and other records are never destroyed.
 *
 * Usage:
 *   SUPPORT_SEED_ORG=<org-slug-or-uuid> pnpm seed:support
 *   pnpm seed:support -- --org <org-slug-or-uuid> [--owner <user-uuid>] [--billing]
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  customers,
  getDb,
  invoices,
  memberships,
  organizations,
  rolePermissions,
  supportConversations,
  supportKbArticles,
  supportMessages,
  supportSettings,
  tickets,
  userRoles,
  users,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "./lib/go-driver";

const DEMO_DOMAIN = "northwind.example";
const WIDGET_VISITOR_EMAIL = "visitor@northwind.example";
const SEEDED_ARTICLE_TITLES = [
  "Refund and proration policy",
  "Changing the billing email",
  "API key rotation",
  "Export troubleshooting",
  "Support response targets",
];
const SEEDED_TICKET_TITLES = [
  "Widget transcript drops the first line",
  "Add a monthly CSAT export",
];
const CANNED_REPLIES = [
  {
    shortcut: "/refund",
    title: "Refund review",
    body: "Thanks for flagging this. I have sent the request to the billing team for a refund review. Nothing is charged or refunded until a person confirms the amount, and I will update this thread as soon as that review is complete.",
  },
  {
    shortcut: "/billing-email",
    title: "Change the billing email",
    body: "You can change the billing email yourself: open Settings, then Billing, update the email field, and save. The next invoice will use the new address. If the field is missing on your plan, reply here and I will route the change to billing.",
  },
  {
    shortcut: "/seats",
    title: "Seat changes and proration",
    body: "Seat changes take effect on the next billing cycle. A person on the billing team reviews mid-cycle removals for proration so the credit is correct. I will confirm the amount here before anything is charged or refunded.",
  },
  {
    shortcut: "/api-key",
    title: "Rotate an API key",
    body: "Open Settings, then API keys, create the replacement key, deploy it, and only then revoke the old one. If the requests are still returning 401, send the key hint (never the key) and the request timestamp so I can trace it.",
  },
  {
    shortcut: "/status",
    title: "Check a record status",
    body: "I can check the invoice and order records on your account. Send the invoice number or the date of the charge and I will confirm the current status here.",
  },
];
const ARTICLES = [
  {
    title: "Refund and proration policy",
    category: "billing",
    isPublic: true,
    body: "Refunds are reviewed by a person. A mid-cycle seat removal may qualify for a prorated credit, calculated from the unused portion of the term. Nothing is refunded until the billing team confirms the amount on the conversation. Annual plans follow the same review.",
  },
  {
    title: "Changing the billing email",
    category: "billing",
    isPublic: true,
    body: "A workspace admin can change the billing email in Settings, then Billing. The next invoice uses the new address. If the field is not present on the plan, the support team routes the change to billing instead of editing payment records.",
  },
  {
    title: "API key rotation",
    category: "api",
    isPublic: true,
    body: "Create the replacement key first, deploy it to the integration, confirm requests succeed, then revoke the old key. Never paste a full key into a support conversation. A 401 after rotation usually means the old key is still being sent.",
  },
  {
    title: "Export troubleshooting",
    category: "technical",
    isPublic: false,
    body: "If an export is empty, check the date range, the account filter, and whether the export ran before the day closed. A range that ends today can be empty before the nightly rollup. Ask for the export name, time, and range before escalating.",
  },
  {
    title: "Support response targets",
    category: "operations",
    isPublic: false,
    body: "Urgent conversations target a first human response within two hours. High priority targets four hours. Normal priority targets one business day. The SLA field on a ticket is the commitment for that conversation, not a per-message timer.",
  },
];

type OwnerKind = "owner" | "teammate" | null;

type Scenario = {
  name: string;
  email: string;
  subject: string;
  status: "open" | "escalated" | "resolved";
  priority: "low" | "normal" | "high" | "urgent";
  category: string;
  assignee: OwnerKind;
  slaOffsetHours: number | null;
  startedHoursAgo: number;
  messages: Array<{
    from: "customer" | "staff";
    body: string;
    hoursAfterStart: number;
  }>;
  escalateReason?: string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "Nadia Haddad",
    email: `nadia@${DEMO_DOMAIN}`,
    subject: "Wants a refund for two seats removed mid-cycle",
    status: "escalated",
    priority: "urgent",
    category: "billing",
    assignee: "owner",
    slaOffsetHours: -2,
    startedHoursAgo: 23,
    messages: [
      {
        from: "customer",
        body: "We removed two seats in the middle of the billing cycle. The invoice still charges for all ten seats. Can you refund the difference?",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "I can check that. Removing seats mid-cycle may qualify for a prorated credit. I am pulling in a teammate to confirm the amount before anything is charged or refunded.",
        hoursAfterStart: 0.4,
      },
      {
        from: "customer",
        body: "Thank you. Our finance lead needs the credit note this week so we can close the month.",
        hoursAfterStart: 2,
      },
    ],
    escalateReason:
      "Nadia needs a prorated refund above the desk's authority. Billing should confirm the amount before anyone promises it.",
  },
  {
    name: "Nina Alvarez",
    email: `nina@${DEMO_DOMAIN}`,
    subject: "Invoice email needs to change before the next billing run",
    status: "open",
    priority: "urgent",
    category: "billing",
    assignee: "owner",
    slaOffsetHours: 2,
    startedHoursAgo: 4,
    messages: [
      {
        from: "customer",
        body: "Our finance team changed the email they want invoices sent to. How do I update it before the next billing run?",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "You can change the billing email yourself. Open Settings, then Billing, update the email field, and save. The next invoice will use the new address. If the Billing section is missing on the Scale plan, tell me and I will route it.",
        hoursAfterStart: 0.2,
      },
      {
        from: "customer",
        body: "I do not see a Billing section. We are on the Scale plan, so it should be under Workspace?",
        hoursAfterStart: 1.5,
      },
    ],
  },
  {
    name: "Sam Okafor",
    email: `sam@${DEMO_DOMAIN}`,
    subject: "Where do the citations under an AI answer come from?",
    status: "resolved",
    priority: "normal",
    category: "product",
    assignee: "owner",
    slaOffsetHours: 24,
    startedHoursAgo: 22,
    messages: [
      {
        from: "customer",
        body: "Every AI answer in the inbox shows citations under the response. Is that the source list for the whole workspace?",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "Each citation is the specific reviewed article used for that answer, not the whole library. If an answer has no citation, a person should check it before sending.",
        hoursAfterStart: 0.6,
      },
      {
        from: "customer",
        body: "That is exactly what I needed. Thanks.",
        hoursAfterStart: 1.2,
      },
    ],
  },
  {
    name: "Elena Rossi",
    email: `elena@${DEMO_DOMAIN}`,
    subject: "Export is empty when the range ends today",
    status: "open",
    priority: "high",
    category: "technical",
    assignee: null,
    slaOffsetHours: 3,
    startedHoursAgo: 1.5,
    messages: [
      {
        from: "customer",
        body: "The orders export is empty whenever I choose a range that ends today. Yesterday works. Is this a permissions problem?",
        hoursAfterStart: 0,
      },
    ],
  },
  {
    name: "Owen Park",
    email: `owen@${DEMO_DOMAIN}`,
    subject: "Add three more seats before the next project",
    status: "open",
    priority: "normal",
    category: "billing",
    assignee: "teammate",
    slaOffsetHours: null,
    startedHoursAgo: 26,
    messages: [
      {
        from: "customer",
        body: "We are starting a new project next month and need three more seats. Can we add them without changing the annual term?",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "Seats can be added from Settings, then Billing. On the annual plan the added seats start a prorated line for the remaining term. I will confirm the exact amount with billing before you approve it.",
        hoursAfterStart: 1,
      },
    ],
  },
  {
    name: "Tomas Ferreira",
    email: `tomas@${DEMO_DOMAIN}`,
    subject: "API returns 401 after rotating the key",
    status: "open",
    priority: "high",
    category: "api",
    assignee: "owner",
    slaOffsetHours: -20,
    startedHoursAgo: 30,
    messages: [
      {
        from: "customer",
        body: "We rotated our API key and now every request returns 401. The integration is down for the whole team.",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "I am sorry about the outage. Please create the replacement key, deploy it, and then revoke the old one. Can you confirm whether the 401s started before or after the old key was revoked?",
        hoursAfterStart: 0.3,
      },
      {
        from: "customer",
        body: "The old key was revoked first. The new key is in the environment now but the requests still fail.",
        hoursAfterStart: 4,
      },
    ],
  },
  {
    name: "Priya Shah",
    email: `priya@${DEMO_DOMAIN}`,
    subject: "Staging tenant expires Friday and needs one more week",
    status: "open",
    priority: "normal",
    category: "account",
    assignee: "owner",
    slaOffsetHours: 20,
    startedHoursAgo: 7,
    messages: [
      {
        from: "customer",
        body: "Our staging tenant expires on Friday but the migration review slipped. Can we extend it by one week?",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "I have asked the account team to extend the staging tenant by seven days. Nothing will be deleted while that review is open, and I will confirm the new date here.",
        hoursAfterStart: 0.8,
      },
    ],
  },
  {
    name: "Lucas Meyer",
    email: `lucas@${DEMO_DOMAIN}`,
    subject: "Second key for the integration",
    status: "resolved",
    priority: "low",
    category: "api",
    assignee: "owner",
    slaOffsetHours: 48,
    startedHoursAgo: 92,
    messages: [
      {
        from: "customer",
        body: "Can we create a second key so the reporting job and the sync use separate credentials?",
        hoursAfterStart: 0,
      },
      {
        from: "staff",
        body: "Yes. Create the second key in Settings, then API keys, give it only the scope the reporting job needs, and deploy it there. Both keys can stay active.",
        hoursAfterStart: 2,
      },
      {
        from: "customer",
        body: "Done. The reporting job is using the new key now.",
        hoursAfterStart: 5,
      },
    ],
  },
];

type RunResult = { error?: string; data?: unknown; ok?: boolean };

function data<T>(run: RunResult): T {
  if (run.error) throw new Error(`capability failed: ${run.error}`);
  return run.data as T;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const db = getDb().db;
  const selector = option("org") ?? process.env.SUPPORT_SEED_ORG;
  if (!selector) {
    throw new Error("Pass --org <slug-or-uuid> or set SUPPORT_SEED_ORG.");
  }
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      enabledModules: organizations.enabledModules,
    })
    .from(organizations)
    .where(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        selector,
      )
        ? eq(organizations.id, selector)
        : eq(organizations.slug, selector),
    )
    .limit(1);
  if (!org) throw new Error(`workspace not found: ${selector}`);

  const requestedOwner = option("owner");
  const ownerScope = requestedOwner
    ? and(eq(memberships.orgId, org.id), eq(memberships.userId, requestedOwner))
    : eq(memberships.orgId, org.id);
  const [authorizedOwner] = await db
    .select({ id: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(
      userRoles,
      and(eq(userRoles.userId, users.id), eq(userRoles.orgId, org.id)),
    )
    .innerJoin(
      rolePermissions,
      and(
        eq(rolePermissions.roleId, userRoles.roleId),
        eq(rolePermissions.orgId, org.id),
      ),
    )
    .where(and(ownerScope, eq(rolePermissions.permissionKey, "*")))
    .orderBy(memberships.createdAt)
    .limit(1);
  let owner = authorizedOwner;
  if (!owner) {
    const [fallback] = await db
      .select({ id: users.id, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(ownerScope)
      .orderBy(memberships.createdAt)
      .limit(1);
    owner = fallback;
    if (owner)
      console.warn(
        "No wildcard owner role was found; the seed acts as the first workspace member.",
      );
  }
  if (!owner)
    throw new Error(
      requestedOwner
        ? `owner is not a member of ${org.name}: ${requestedOwner}`
        : `the workspace has no member to act as the seed owner`,
    );

  const executor = buildExecutor(db, buildRegistry(db));
  const ctx = {
    actor: {
      type: "human" as const,
      id: owner.id,
      orgId: org.id,
      permissions: new Set(["*"]),
    },
    now: new Date(),
    services: {},
  };

  const ownerUserID = owner.id;
  let teammateUserID = ownerUserID;
  const [otherMember] = await db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(eq(memberships.orgId, org.id), ne(memberships.userId, ownerUserID)),
    )
    .orderBy(memberships.createdAt)
    .limit(1);
  if (otherMember) teammateUserID = otherMember.id;

  // Reuse demo customers by email so invoices and other records survive a reseed.
  const customerIDs = new Map<string, string>();
  for (const scenario of SCENARIOS) {
    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.orgId, org.id), eq(customers.email, scenario.email)),
      )
      .limit(1);
    if (existing) {
      customerIDs.set(scenario.email, existing.id);
      continue;
    }
    const created = data<{ customerId: string }>(
      await executor.execute("crm.createCustomer", ctx, {
        name: scenario.name,
        email: scenario.email,
        preferredContactMethod: "email",
      }),
    );
    customerIDs.set(scenario.email, created.customerId);
  }
  const ids = [...customerIDs.values()];

  await db
    .delete(supportConversations)
    .where(
      and(
        eq(supportConversations.orgId, org.id),
        inArray(supportConversations.customerId, ids),
      ),
    );
  await db
    .delete(supportConversations)
    .where(
      and(
        eq(supportConversations.orgId, org.id),
        eq(supportConversations.visitorEmail, WIDGET_VISITOR_EMAIL),
      ),
    );
  await db
    .delete(tickets)
    .where(
      and(
        eq(tickets.orgId, org.id),
        inArray(tickets.title, SEEDED_TICKET_TITLES),
      ),
    );
  await db
    .delete(supportKbArticles)
    .where(
      and(
        eq(supportKbArticles.orgId, org.id),
        inArray(supportKbArticles.title, SEEDED_ARTICLE_TITLES),
      ),
    );

  for (const reply of CANNED_REPLIES) {
    data(
      await executor.execute("support.createCannedResponse", ctx, {
        shortcut: reply.shortcut,
        title: reply.title,
        body: reply.body,
      }),
    );
  }
  for (const article of ARTICLES) {
    data(await executor.execute("support.createKbArticle", ctx, article));
  }

  let createdConversations = 0;
  for (const scenario of SCENARIOS) {
    const customerId = customerIDs.get(scenario.email);
    if (!customerId) throw new Error(`missing customer for ${scenario.name}`);
    const started = data<{ conversationId: string }>(
      await executor.execute("support.startConversation", ctx, {
        customerId,
        subject: scenario.subject,
      }),
    );
    const conversationId = started.conversationId;
    const messageIDs: string[] = [];
    for (const message of scenario.messages) {
      const posted = data<{ messageId: string }>(
        await executor.execute("support.postMessage", ctx, {
          conversationId,
          body: message.body,
          from: message.from,
        }),
      );
      messageIDs.push(posted.messageId);
    }
    const assignee =
      scenario.assignee === "owner"
        ? ownerUserID
        : scenario.assignee === "teammate"
          ? teammateUserID
          : null;
    const slaDueAt =
      scenario.slaOffsetHours === null
        ? null
        : new Date(
            Date.now() + scenario.slaOffsetHours * 3_600_000,
          ).toISOString();
    data(
      await executor.execute("support.updateTicket", ctx, {
        conversationId,
        priority: scenario.priority,
        category: scenario.category,
        assigneeUserId: assignee,
        slaDueAt,
      }),
    );
    if (scenario.status === "escalated" && scenario.escalateReason) {
      data(
        await executor.execute("support.escalateConversation", ctx, {
          conversationId,
          reason: scenario.escalateReason,
        }),
      );
    }
    if (scenario.status === "resolved") {
      data(
        await executor.execute("support.resolveConversation", ctx, {
          conversationId,
        }),
      );
    }

    // Backdate the transcript so last activity and SLA states are believable.
    const rows = await db
      .select({ id: supportMessages.id, createdAt: supportMessages.createdAt })
      .from(supportMessages)
      .where(eq(supportMessages.conversationId, conversationId))
      .orderBy(supportMessages.createdAt, supportMessages.id);
    const start = Date.now() - scenario.startedHoursAgo * 3_600_000;
    const offsets = scenario.messages.map((message) => message.hoursAfterStart);
    const lastOffset = offsets.length > 0 ? offsets[offsets.length - 1]! : 0;
    for (let index = 0; index < rows.length; index += 1) {
      const offset =
        index === 0
          ? 0
          : Math.min(lastOffset, offsets[index - 1] ?? lastOffset) + 0.05;
      const when = new Date(start + offset * 3_600_000);
      await db
        .update(supportMessages)
        .set({ createdAt: when })
        .where(eq(supportMessages.id, rows[index]!.id));
    }
    await db
      .update(supportConversations)
      .set({
        createdAt: new Date(start),
        updatedAt: new Date(start + lastOffset * 3_600_000),
      })
      .where(eq(supportConversations.id, conversationId));
    createdConversations += 1;
  }

  // The public widget starts unbound conversations outside the staff
  // capability path. This visitor mirrors that shape so the desk proves it can
  // see and answer a widget escalation without attaching unverified identity.
  const widgetStartedAt = Date.now() - 45 * 60_000;
  const [widgetConversation] = await db
    .insert(supportConversations)
    .values({
      orgId: org.id,
      visitorEmail: WIDGET_VISITOR_EMAIL,
      visitorSecretHash: createHash("sha256")
        .update(`${org.id}:${WIDGET_VISITOR_EMAIL}:demo`)
        .digest("hex"),
      subject: "Pricing for a second workspace",
      status: "escalated",
      priority: "high",
      category: "sales",
      slaDueAt: new Date(Date.now() + 4 * 3_600_000),
      createdByActorType: "widget",
      createdAt: new Date(widgetStartedAt),
      updatedAt: new Date(widgetStartedAt + 20 * 60_000),
    })
    .returning({ id: supportConversations.id });
  if (!widgetConversation)
    throw new Error("failed to seed the widget visitor conversation");
  await db.insert(supportMessages).values([
    {
      orgId: org.id,
      conversationId: widgetConversation.id,
      senderType: "system",
      body: "Hi - ask us anything and a person on the Northwind support desk will get right back to you.",
      createdAt: new Date(widgetStartedAt),
    },
    {
      orgId: org.id,
      conversationId: widgetConversation.id,
      senderType: "customer",
      body: "Hi, we need pricing for a second workspace and a separate billing contact. Can you help?",
      createdAt: new Date(widgetStartedAt + 4 * 60_000),
    },
    {
      orgId: org.id,
      conversationId: widgetConversation.id,
      senderType: "system",
      body: "Escalated by widget: The visitor needs a plan recommendation and a separate billing contact.",
      createdAt: new Date(widgetStartedAt + 20 * 60_000),
    },
  ]);

  for (const ticket of [
    {
      title: "Widget transcript drops the first line",
      description:
        "Two widget conversations arrived without the visitor's opening line. The rest of the transcript is intact. This is a bug in the transcript handoff, not a customer problem.",
      origin: "bug" as const,
    },
    {
      title: "Add a monthly CSAT export",
      description:
        "The desk can see resolved conversations but cannot export a monthly CSAT summary. A CSV export with date range and assignee would be enough for the operations review.",
      origin: "request" as const,
    },
  ]) {
    data(await executor.execute("support.createTicket", ctx, ticket));
  }

  // A fresh workspace gets a complete demo channel. An existing workspace
  // keeps its real embed token, auto-reply choice, and greeting untouched.
  const [existingSettings] = await db
    .select({ orgId: supportSettings.orgId })
    .from(supportSettings)
    .where(eq(supportSettings.orgId, org.id))
    .limit(1);
  let widgetNote = "widget settings kept";
  if (!existingSettings) {
    await db.insert(supportSettings).values({
      orgId: org.id,
      embedToken: `northwind-desk-${org.id.slice(0, 8)}-demo`,
      autoReplyEnabled: true,
      greeting:
        "Hi - ask us anything and a person on the Northwind support desk will get right back to you.",
    });
    widgetNote = "widget settings created";
  }

  let billingNote = "billing not requested";
  if (process.argv.includes("--billing")) {
    const modules = org.enabledModules as string[] | null;
    const accountingEnabled =
      modules === null || modules.includes("accounting");
    const nadia = customerIDs.get(`nadia@${DEMO_DOMAIN}`);
    const [existingInvoice] = nadia
      ? await db
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(eq(invoices.orgId, org.id), eq(invoices.customerId, nadia)),
          )
          .limit(1)
      : [];
    if (!accountingEnabled) {
      billingNote = "billing skipped: accounting module is not enabled";
    } else if (!nadia) {
      billingNote = "billing skipped: Nadia was not seeded";
    } else if (existingInvoice) {
      billingNote = "billing kept: Nadia already has an invoice";
    } else {
      try {
        data(
          await executor.execute("accounting.createInvoice", ctx, {
            customerId: nadia,
            lines: [
              {
                description: "Ten workspace seats, current term",
                quantity: 1000,
                unitPriceMinor: 120_000,
                taxMinor: 0,
              },
            ],
          }),
        );
        billingNote = "billing seeded: one unpaid invoice for Nadia";
      } catch (error) {
        billingNote = `billing skipped: ${error instanceof Error ? error.message : "invoice creation failed"}`;
      }
    }
  }

  console.log(`Support desk seeded in ${org.name} (${org.slug})`);
  console.log(`  customers: ${ids.length}`);
  console.log(
    `  conversations: ${createdConversations + 1} (${createdConversations} bound, 1 widget visitor)`,
  );
  console.log(`  quick replies: ${CANNED_REPLIES.length}`);
  console.log(`  articles: ${ARTICLES.length}`);
  console.log(`  internal tickets: ${SEEDED_TICKET_TITLES.length}`);
  console.log(`  ${widgetNote}`);
  console.log(`  ${billingNote}`);
  console.log("Open /support to review the desk.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
