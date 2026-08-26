import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import {
  customers,
  getDb,
  invitations,
  items,
  memberships,
  supportSettings,
  vendors,
} from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { detectCodingAgent } from "@/server/creator-agent";

export interface SetupItem {
  id: string;
  title: string;
  /** Why it matters, one sentence — the "what is expected of me". */
  why: string;
  /** Where to do it — powers the take-me-there link. */
  href: string;
  done: boolean;
}

/**
 * The workspace setup checklist: what is expected of this organization,
 * what depends on what, and where to do each thing. Computed live from
 * real state — an item disappears the moment it is actually done.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const db = getDb().db;

  const [vendorCount, itemCount, customerCount, memberCount, inviteCount] = await Promise.all([
    db.select({ n: count() }).from(vendors).where(eq(vendors.orgId, orgId)),
    db.select({ n: count() }).from(items).where(eq(items.orgId, orgId)),
    db.select({ n: count() }).from(customers).where(eq(customers.orgId, orgId)),
    db.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId)),
    db.select({ n: count() }).from(invitations).where(eq(invitations.orgId, orgId)),
  ]);
  const [settings] = await db
    .select({ embedToken: supportSettings.embedToken })
    .from(supportSettings)
    .where(eq(supportSettings.orgId, orgId))
    .limit(1);
  const agent = await detectCodingAgent();

  const setupItems: SetupItem[] = [
    {
      id: "products",
      title: "Add what you sell",
      why: "Orders, invoices, and stock all reference products; without them nothing can be priced.",
      href: "/products",
      done: (itemCount[0]?.n ?? 0) > 0,
    },
    {
      id: "customers",
      title: "Add your first customer",
      why: "Sales, invoicing, and customer care hang off customer records.",
      href: "/crm",
      done: (customerCount[0]?.n ?? 0) > 0,
    },
    {
      id: "vendors",
      title: "Add a vendor",
      why: "Purchase requests, RFQs, and bills name the vendor you buy from.",
      href: "/purchasing",
      done: (vendorCount[0]?.n ?? 0) > 0,
    },
    {
      id: "team",
      title: "Invite your team",
      why: "Approvals need a second pair of eyes; money-gated actions wait for them.",
      href: "/team",
      done: (memberCount[0]?.n ?? 0) > 1 || (inviteCount[0]?.n ?? 0) > 0,
    },
    {
      id: "email",
      title: "Connect outgoing email",
      why: "Invoices, approvals, and notifications reach people by email once SMTP is set.",
      href: "/settings",
      done: Boolean(process.env.SMTP_HOST),
    },
    {
      id: "widget",
      title: "Put chat on your website",
      why: "Customer questions land in your care inbox instead of a shared mailbox.",
      href: "/support",
      done: Boolean(settings?.embedToken),
    },
    {
      id: "creator-agent",
      title: "Connect a coding agent for Creator mode",
      why: "With an agent installed, improvements are proposed as reviewed diffs instead of wishful thinking.",
      href: "/proposals",
      done: agent.installed,
    },
  ];

  return NextResponse.json({
    items: setupItems,
    remaining: setupItems.filter((i) => !i.done).length,
  });
}
