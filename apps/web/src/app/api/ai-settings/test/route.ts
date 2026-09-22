import { NextResponse } from "next/server";
import { getDb } from "@chaste/db";
import { resolveOrgClient } from "@/server/ai-config";
import { getResolvedUser } from "@/server/session";

/**
 * Test-connection for the org's AI configuration: one tiny completion
 * against the configured provider with the org's own key. The key never
 * appears anywhere in the response.
 */
export async function POST() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const started = Date.now();
  try {
    const { client, model, provider, orgManaged } = await resolveOrgClient(getDb().db, resolved.orgId, "primary");
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
      max_tokens: 8,
      temperature: 0,
    });
    return NextResponse.json({
      ok: true,
      provider,
      orgManaged,
      model,
      latencyMs: Date.now() - started,
      sample: completion.choices[0]?.message?.content?.slice(0, 40) ?? "",
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "connection failed",
    });
  }
}
