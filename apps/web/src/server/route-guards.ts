import { NextResponse } from "next/server";
import { hasPermission } from "@chaste/kernel";

/**
 * Route-level read authorization (N01): session membership alone must not
 * reveal salaries, ledger payloads, or another module's records. Each
 * ungoverned GET checks its module's read permission explicitly; owners hold
 * `*`, restricted roles need the grant. Returns the 403 response to send, or
 * null when the caller may proceed.
 */
export function missingPermission(
  subject: { permissions: ReadonlySet<string> },
  permission: string,
): NextResponse | null {
  if (hasPermission(subject, permission)) return null;
  return NextResponse.json({ error: `forbidden: missing ${permission}` }, { status: 403 });
}
