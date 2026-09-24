import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, nextAuthoredDocumentNumber, nextDocNumber } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

const querySchema = z.object({ kind: z.enum(["invoice", "quote", "receipt", "delivery_note", "purchase_order", "voucher", "employment_contract", "employment_agreement"]) });
const prefixes = { invoice: "INV", quote: "QTN", receipt: "RCT", delivery_note: "DN", purchase_order: "PO", voucher: "VCH", employment_contract: "EMP", employment_agreement: "AGR" } as const;

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = querySchema.safeParse({ kind: new URL(req.url).searchParams.get("kind") });
  if (!parsed.success) return NextResponse.json({ error: "invalid document kind" }, { status: 400 });
  const { kind } = parsed.data;
  try {
    const number = kind === "invoice" || kind === "quote"
      ? await nextDocNumber(getDb().db, resolved.orgId, kind)
      : await nextAuthoredDocumentNumber(getDb().db, resolved.orgId, kind);
    return NextResponse.json({ number: `${prefixes[kind]}-${new Date().getFullYear()}-${String(number).padStart(4, "0")}` });
  } catch {
    return NextResponse.json({ error: "number unavailable" }, { status: 503 });
  }
}
