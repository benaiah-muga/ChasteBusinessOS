import type OpenAI from "openai";
import { MODELS, chatClient } from "./providers";

export const MODELS_OCR = () => process.env.MODEL_OCR ?? "nvidia/nemotron-parse-v1.2";

const PARSE_PROMPT = "</s><s><predict_bbox><predict_classes><output_markdown><predict_no_text_in_pic>";

/**
 * Extracts markdown (with layout structure) from a document image via the
 * nemotron-parse NIM. Input is raw image bytes + mime type; sent as a
 * base64 data URL per the NIM vision-language convention.
 */
export async function parseDocumentImage(
  bytes: Uint8Array,
  mimeType: string,
  opts: { client?: OpenAI; model?: string } = {},
): Promise<string> {
  const client = opts.client ?? chatClient();
  const b64 = Buffer.from(bytes).toString("base64");
  const res = await client.chat.completions.create({
    model: opts.model ?? MODELS_OCR(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PARSE_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
        ],
      },
    ] as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: 0,
  });
  return res.choices[0]?.message?.content ?? "";
}

/**
 * Pulls candidate bill lines out of parsed document text. Best-effort LLM
 * step over a strict JSON contract, callers must validate and fall back to
 * human entry when it fails or when no key is configured.
 */
export async function extractBillLinesFromText(
  documentText: string,
  opts: { client?: OpenAI; model?: string } = {},
): Promise<{ description: string; quantityThousandths: number; unitPriceMinor: number }[]> {
  const client = opts.client ?? chatClient();
  const res = await client.chat.completions.create({
    model: opts.model ?? MODELS.primary(),
    messages: [
      {
        role: "system",
        content:
          "You extract vendor-bill line items from document text. Reply with ONLY a JSON array " +
          '[{"description": string, "quantityThousandths": integer, "unitPriceMinor": integer}] where ' +
          "quantityThousandths is thousandths of a unit (1 item = 1000) and unitPriceMinor is integer minor " +
          "units (cents). Omit tax lines and totals. If no line items exist, reply [].",
      },
      { role: "user", content: documentText.slice(0, 12_000) },
    ],
    temperature: 0,
    max_tokens: 2048,
  });
  const raw = res.choices[0]?.message?.content ?? "[]";
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("model did not return a JSON array");
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  return zValidateLines(parsed);
}

function zValidateLines(value: unknown): { description: string; quantityThousandths: number; unitPriceMinor: number }[] {
  if (!Array.isArray(value)) throw new Error("expected an array of lines");
  return value.map((v) => {
    const o = v as Record<string, unknown>;
    if (typeof o.description !== "string" || !o.description.trim()) throw new Error("line missing description");
    if (!Number.isSafeInteger(o.quantityThousandths) || (o.quantityThousandths as number) <= 0)
      throw new Error(`bad quantity for "${String(o.description)}"`);
    if (!Number.isSafeInteger(o.unitPriceMinor) || (o.unitPriceMinor as number) < 0)
      throw new Error(`bad price for "${String(o.description)}"`);
    return {
      description: o.description,
      quantityThousandths: o.quantityThousandths as number,
      unitPriceMinor: o.unitPriceMinor as number,
    };
  });
}
