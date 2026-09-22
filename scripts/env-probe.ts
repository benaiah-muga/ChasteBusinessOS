import type OpenAI from "openai";
import { resolveClient } from "@chaste/ai";

async function main() {
  const client: OpenAI = resolveClient("zai/glm-4.5-flash");
  const base = (client as unknown as { baseURL: string }).baseURL;
  console.log("baseURL:", base);
  try {
    const s = await client.chat.completions.create(
      {
        model: "glm-4.5-flash",
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 4096,
        temperature: 0,
        tools: [
          {
            type: "function",
            function: {
              name: "purchasing_createVendor",
              description: "Create vendor",
              parameters: { type: "object", properties: { name: { type: "string", description: "name" } }, required: ["name"] },
            },
          },
        ],
        stream: true,
        stream_options: { include_usage: true },
      } as never,
    );
    let n = 0;
    for await (const chunk of s) {
      n += chunk.choices?.length ?? 0;
      if (n > 3) break;
    }
    console.log("stream ok, chunks:", n);
  } catch (err) {
    console.log("FAILED:", (err as Error).message.slice(0, 300));
  }
}
main();
