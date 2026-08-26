import { NextResponse } from "next/server";
import { getResolvedUser } from "@/server/session";
import { detectCodingAgent } from "@/server/creator-agent";

/**
 * Coding-agent detection for Creator mode. Read-only: reports whether a
 * known agent CLI is on the server's PATH and how to install/auth one if
 * not. The install itself is always run by the human; we never execute
 * package-manager writes from the app.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const agent = await detectCodingAgent();
  return NextResponse.json(agent);
}
