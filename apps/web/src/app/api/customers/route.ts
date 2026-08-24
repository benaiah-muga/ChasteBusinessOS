import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { customers, getDb } from "@chaste/db";
import { hasPermission as hasPermissionFor } from "@chaste/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Customer directory (read-only). The support desk needs a picker for
 * "who is this conversation about"; the same list powers any future
 * customer-facing surfaces. No writes: creation stays in the CRM module.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perms = { permissions: resolved.permissions };
  if (!hasPermissionFor(perms, "support.read") && !hasPermissionFor(perms, "crm.read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await getDb()
    .db.select({ id: customers.id, name: customers.name, email: customers.email })
    .from(customers)
    .where(and(eq(customers.orgId, resolved.orgId)))
    .orderBy(asc(customers.name))
    .limit(500);
  return NextResponse.json({ customers: rows });
}
