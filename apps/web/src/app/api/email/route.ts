import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { customers, getDb, invoices } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, sendOrgMail } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test"), to: z.string().email() }),
  z.object({
    action: z.literal("emailInvoice"),
    invoiceNumber: z.number().int().positive(),
    to: z.string().email(),
  }),
]);

/** SMTP delivery status for the Settings surface. */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    configured: Boolean(process.env.SMTP_HOST),
    from: process.env.SMTP_FROM ?? null,
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  if (parsed.data.action === "test") {
    const result = await sendOrgMail({
      to: parsed.data.to,
      subject: "[Chaste] SMTP test",
      text: "Your Chaste Business OS workspace can now send email.",
    });
    return NextResponse.json(result, { status: result.sent ? 200 : 422 });
  }

  // Email an invoice: mint a private share link (governed capability) and
  // attach a plain-HTML copy so the customer keeps a document either way.
  const [inv] = await db
    .select({
      number: invoices.number,
      status: invoices.status,
      currency: invoices.currency,
      subtotalMinor: invoices.subtotalMinor,
      taxMinor: invoices.taxMinor,
      totalMinor: invoices.totalMinor,
      paidMinor: invoices.paidMinor,
      customerName: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.orgId, resolved.orgId), eq(invoices.number, parsed.data.invoiceNumber)))
    .limit(1);
  if (!inv) return NextResponse.json({ error: "invoice not found" }, { status: 404 });

  const share = await executor.execute("accounting.shareInvoice", ctx, {
    invoiceNumber: inv.number,
  });
  const shareData = share.data as { token?: string; urlPath?: string } | undefined;
  if (!share.ok || !shareData?.urlPath) {
    return NextResponse.json(
      { error: share.pendingApproval ? "share link needs approval first" : (share.error ?? "could not create share link") },
      { status: 422 },
    );
  }
  const urlPath = shareData.urlPath;

  const money = (m: number) => (m / 100).toFixed(2);
  const origin = new URL(req.url).origin;
  const link = `${origin}${urlPath}`;
  const html = [
    '<!doctype html><html><body style="font-family:ui-sans-serif,system-ui;margin:40px;color:#1c1917">',
    `<h1 style="font-size:20px">Invoice #${inv.number}</h1>`,
    `<p>Billed to <strong>${inv.customerName}</strong> &middot; status ${inv.status}</p>`,
    '<table style="border-collapse:collapse;font-size:14px">',
    `<tr><td style="padding:4px 16px 4px 0">Subtotal</td><td style="text-align:right">${money(inv.subtotalMinor)} ${inv.currency}</td></tr>`,
    `<tr><td style="padding:4px 16px 4px 0">Tax</td><td style="text-align:right">${money(inv.taxMinor)}</td></tr>`,
    `<tr><td style="padding:4px 16px 4px 0"><strong>Total</strong></td><td style="text-align:right"><strong>${money(inv.totalMinor)}</strong></td></tr>`,
    `<tr><td style="padding:4px 16px 4px 0">Paid</td><td style="text-align:right">${money(inv.paidMinor)}</td></tr>`,
    '</table>',
    `<p style="margin-top:24px">View or track this invoice online:<br><a href="${link}">${link}</a></p>`,
    '</body></html>',
  ].join("\n");

  const result = await sendOrgMail({
    to: parsed.data.to,
    subject: `Invoice #${inv.number} — ${money(inv.totalMinor)} ${inv.currency}`,
    text: `Invoice #${inv.number}\nBilled to: ${inv.customerName}\nTotal: ${money(inv.totalMinor)} ${inv.currency} (paid ${money(inv.paidMinor)})\n\nOpen your live invoice: ${origin}${urlPath}`,
    attachments: [{ filename: `invoice-${inv.number}.html`, content: html, contentType: "text/html" }],
  });
  if (!result.sent) return NextResponse.json(result, { status: 422 });
  return NextResponse.json({ sent: true, urlPath });
}
