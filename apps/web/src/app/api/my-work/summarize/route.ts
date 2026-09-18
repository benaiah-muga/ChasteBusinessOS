import { NextResponse } from "next/server";
import { resolveClient, stripProviderPrefix } from "@chaste/ai";
import { getResolvedUser } from "@/server/session";

/**
 * P01: deterministic ranking decides the list; the model only writes the
 * one-paragraph brief over the already-authorized card bundle it is given.
 * NL operations for the pilot run on openrouter/stealth/union-alpha
 * (MODEL_PROVIDER-style prefix routes through OPENROUTER_API_KEY). Stealth
 * slugs rotate, so a retired model falls back to the successor slug; no
 * key at all means no brief: the endpoint degrades honestly instead of
 * inventing one.
 */

const NL_MODEL = process.env.MODEL_NL ?? "openrouter/stealth/union-alpha";
const NL_FALLBACK_MODEL = process.env.MODEL_NL_FALLBACK ?? "openrouter/unbiased/pareto";

async function briefWith(modelRef: string, list: string[]): Promise<string> {
  const client = resolveClient(modelRef);
  const completion = await client.chat.completions.create(
    {
      model: stripProviderPrefix(modelRef),
      temperature: 0.2,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            "You write a two-sentence brief of a business team's pending work for its home page. " +
            "Group what belongs together, name concrete counts, never invent items that are not in the list, never give advice.",
        },
        { role: "user", content: `Pending work:\n${list.join("\n")}` },
      ],
    },
    { headers: { "X-Title": "ChasteBusinessOS" } },
  );
  return completion.choices[0]?.message?.content?.trim() ?? "";
}

const isModelUnavailable = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string };
  return e?.status === 404 || /testing period|no endpoints found|not a valid model|model_not_found/i.test(e?.message ?? "");
};

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
    let brief = await briefWith(NL_MODEL, lines);
    let usedModel = stripProviderPrefix(NL_MODEL);
    if (!brief) {
      // The primary slug rotated or returned nothing: take the successor model.
      brief = await briefWith(NL_FALLBACK_MODEL, lines);
      usedModel = stripProviderPrefix(NL_FALLBACK_MODEL);
    }
    if (!brief) return NextResponse.json({ error: "summary unavailable" }, { status: 502 });
    return NextResponse.json({ brief, model: usedModel });
  } catch (err) {
    if (isModelUnavailable(err)) {
      try {
        const brief = await briefWith(NL_FALLBACK_MODEL, lines);
        if (brief) return NextResponse.json({ brief, model: stripProviderPrefix(NL_FALLBACK_MODEL) });
      } catch {
        // fall through to the honest failure
      }
    }
    const message = err instanceof Error ? err.message : "model call failed";
    return NextResponse.json({ error: "summary unavailable", detail: message }, { status: 502 });
  }
}
