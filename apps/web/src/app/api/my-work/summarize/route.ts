import { NextResponse } from "next/server";
import { resolveClient, stripProviderPrefix } from "@chaste/ai";
import { getResolvedUser } from "@/server/session";

/**
 * P01: deterministic ranking decides the list; the model only writes the
 * one-paragraph brief over the already-authorized card bundle it is given.
 * NL operations for the pilot run on openrouter/stealth/union-alpha
 * (MODEL_PROVIDER-style prefix routes through OPENROUTER_API_KEY). No key,
 * no brief: the endpoint degrades honestly instead of inventing one.
 */

const NL_MODEL = process.env.MODEL_NL ?? "openrouter/stealth/union-alpha";

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { cards?: unknown[] } | null;
  if (!body?.cards || !Array.isArray(body.cards) || body.cards.length === 0) {
    return NextResponse.json({ error: "cards are required" }, { status: 400 });
  }
  if (body.cards.length > 30) {
    return NextResponse.json({ error: "too many cards" }, { status: 400 });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json(
      { error: "summary unavailable", hint: "no OPENROUTER_API_KEY configured; the ranked list itself does not depend on it" },
      { status: 503 },
    );
  }

  const lines = (body.cards as Array<Record<string, unknown>>).map((c) => {
    const detail = typeof c.detail === "string" ? c.detail : "";
    const title = typeof c.title === "string" ? c.title : "";
    const kind = typeof c.kind === "string" ? c.kind : "item";
    return `- [${kind}] ${title}: ${detail}`;
  });

  try {
    const client = resolveClient(NL_MODEL);
    const completion = await client.chat.completions.create(
      {
        model: stripProviderPrefix(NL_MODEL),
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You write a two-sentence brief of a business team's pending work for its home page. " +
              "Group what belongs together, name concrete counts, never invent items that are not in the list, never give advice.",
          },
          { role: "user", content: `Pending work:\n${lines.join("\n")}` },
        ],
      },
      { headers: { "X-Title": "ChasteBusinessOS" } },
    );
    const brief = completion.choices[0]?.message?.content?.trim();
    if (!brief) return NextResponse.json({ error: "summary unavailable" }, { status: 502 });
    return NextResponse.json({ brief, model: stripProviderPrefix(NL_MODEL) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "model call failed";
    return NextResponse.json({ error: "summary unavailable", detail: message }, { status: 502 });
  }
}
