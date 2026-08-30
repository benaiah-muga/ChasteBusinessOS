/**
 * Gate G7: Z.ai GLM streams live through the exact adapter the chat route
 * uses (OpenAiCompatAdapter + zai client). Asserts deltas, a non-empty
 * reply, and provider-reported usage.
 */
import "./env";
import { OpenAiCompatAdapter, MODELS, resolveClient } from "@chaste/ai";
import type { LoopMessage, ToolSpec } from "@chaste/kernel";

async function main(): Promise<void> {
  process.env.MODEL_PROVIDER = "zai";
  const model = MODELS.primary();
  const adapter = new OpenAiCompatAdapter({
    client: resolveClient(model),
    model,
  });
  const messages: LoopMessage[] = [
    { role: "system", content: "Reply with exactly one short sentence." },
    { role: "user", content: "Say: the books balance." },
  ];
  let deltas = 0;
  const reply = await adapter.run(messages, [] as ToolSpec[], {
    onDelta: (t) => {
      if (t.length > 0) deltas += 1;
    },
  });
  if (deltas === 0) throw new Error("no streamed deltas received");
  if (!reply.message || reply.message.trim().length === 0) throw new Error("empty reply");
  if (!reply.usage || reply.usage.input <= 0 || reply.usage.output <= 0) {
    throw new Error(`usage missing: ${JSON.stringify(reply.usage)}`);
  }
  console.log(
    `[G7] ZAI GLM STREAM OK: model=${model} deltas=${deltas} in=${reply.usage.input} out=${reply.usage.output}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
