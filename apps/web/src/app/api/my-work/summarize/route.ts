import { NextResponse } from "next/server";
import { resolveClient, stripProviderPrefix } from "@chaste/ai";
import { getDb } from "@chaste/db";
import { runtimeAiConfig } from "@/server/ai-settings";
import { getResolvedUser } from "@/server/session";
import { generateWithCodingPlanText } from "@/server/coding-agent-adapter";

const MAX_BODY_BYTES = 1 << 20;
const MAX_CARD_FIELD_UNITS = 4096;
const MAX_PROMPT_UNITS = 32000;

type SummaryCard = { kind: string; title: string; detail: string };

async function readSummaryBody(req: Request): Promise<{ value: unknown } | { tooLarge: true } | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) return { tooLarge: true };
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown };
  } catch {
    return null;
  }
}

/**
 * P01: deterministic ranking decides the list; the model only writes the
 * one-paragraph brief over the already-authorized card bundle it is given.
 * NL operations for the pilot run on openrouter/stealth/union-alpha
 * (MODEL_PROVIDER-style prefix routes through OPENROUTER_API_KEY). Stealth
 * slugs rotate, so a retired model falls back to the successor slug; no
 * key at all means no brief: the endpoint degrades honestly instead of
 * inventing one.
 */

async function briefWith(modelRef: string, list: string[], runtime: Awaited<ReturnType<typeof runtimeAiConfig>>["runtime"]): Promise<string> {
  const client = resolveClient(modelRef, runtime);
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

  const parsedBody = await readSummaryBody(req);
  if (parsedBody && "tooLarge" in parsedBody) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }
  const body = parsedBody?.value;
  if (!body || typeof body !== "object" || Array.isArray(body) || !("cards" in body) || !Array.isArray(body.cards) || body.cards.length === 0) {
    return NextResponse.json({ error: "cards are required" }, { status: 400 });
  }
  if (body.cards.length > 30) {
    return NextResponse.json({ error: "too many cards" }, { status: 400 });
  }

  const cards: SummaryCard[] = [];
  for (const value of body.cards) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return NextResponse.json({ error: "invalid card" }, { status: 400 });
    }
    const fields = value as Record<string, unknown>;
    if (typeof fields.kind !== "string" || fields.kind.length === 0 || typeof fields.title !== "string" || fields.title.length === 0 || typeof fields.detail !== "string") {
      return NextResponse.json({ error: "invalid card" }, { status: 400 });
    }
    cards.push({ kind: fields.kind, title: fields.title, detail: fields.detail });
  }

  const lines: string[] = [];
  for (const card of cards) {
    if (card.kind.length > MAX_CARD_FIELD_UNITS || card.title.length > MAX_CARD_FIELD_UNITS || card.detail.length > MAX_CARD_FIELD_UNITS) {
      return NextResponse.json({ error: "card text is too long" }, { status: 400 });
    }
    const line = `- [${card.kind}] ${card.title}: ${card.detail}`;
    lines.push(line);
  }
  const prompt = `Pending work:\n${lines.join("\n")}`;
  if (prompt.length > MAX_PROMPT_UNITS) {
    return NextResponse.json({ error: "card text is too long" }, { status: 400 });
  }

  const db = getDb().db;
  const ai = await runtimeAiConfig(db, resolved.orgId, resolved.userId);
  if (!ai.runtime.apiKey && !ai.codingAgentConnection) {
    return NextResponse.json(
      { error: "summary unavailable", hint: "no workspace model credential is configured; the ranked list itself does not depend on it" },
      { status: 503 },
    );
  }

  if (ai.codingAgentConnection) {
    try {
      const result = await generateWithCodingPlanText({
        db,
        connection: ai.codingAgentConnection,
        system: "You write a two-sentence brief of a business team's pending work for its home page. Group what belongs together, name concrete counts, never invent items that are not in the list, never give advice.",
        prompt,
      });
      if (!result.text) return NextResponse.json({ error: "summary unavailable" }, { status: 502 });
      return NextResponse.json({
        brief: result.text,
        model: `${ai.codingAgentConnection.provider}:${ai.codingAgentConnection.modelId ?? "plan-default"}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "model call failed";
      return NextResponse.json({ error: "summary unavailable", detail: message }, { status: 502 });
    }
  }

  try {
    const primary = ai.models.fast;
    const fallback = ai.models.primary;
    let brief = await briefWith(primary, lines, ai.runtime);
    let usedModel = stripProviderPrefix(primary);
    if (!brief) {
      // The fast model returned nothing: use the workspace primary model.
      brief = await briefWith(fallback, lines, ai.runtime);
      usedModel = stripProviderPrefix(fallback);
    }
    if (!brief) return NextResponse.json({ error: "summary unavailable" }, { status: 502 });
    return NextResponse.json({ brief, model: usedModel });
  } catch (err) {
    if (isModelUnavailable(err)) {
      try {
        const brief = await briefWith(ai.models.primary, lines, ai.runtime);
        if (brief) return NextResponse.json({ brief, model: stripProviderPrefix(ai.models.primary) });
      } catch {
        // fall through to the honest failure
      }
    }
    const message = err instanceof Error ? err.message : "model call failed";
    return NextResponse.json({ error: "summary unavailable", detail: message }, { status: 502 });
  }
}
