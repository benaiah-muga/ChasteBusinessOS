/**
 * End-to-end proof of the core thesis:
 * a natural-language goal → real LLM → capability tool call → governance
 * pipeline → append-only hash-chained ledger.
 *
 * Run: pnpm demo   (requires .env with NVIDIA_API_KEY + running pgvector DB)
 */
import { OpenAiCompatAdapter } from "@chaste/ai";
import {
  defineCapability,
  InMemoryLedger,
  KernelExecutor,
  runAgentLoop,
  CapabilityRegistry,
  type ActionContext,
} from "@chaste/kernel";
import { z } from "zod";

const createCustomer = defineCapability({
  id: "crm.createCustomer",
  title: "Create customer",
  intent: "Create a new customer record for the organization",
  module: "crm",
  risk: "write",
  permission: "crm.write",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ customerId: z.string() }),
  execute: async () => ({ customerId: `cus_${Math.random().toString(36).slice(2, 8)}` }),
});

async function main() {
  const registry = new CapabilityRegistry();
  registry.register(createCustomer);

  const ledger = new InMemoryLedger();
  const executor = new KernelExecutor({
    registry,
    ledger,
    approvals: { submit: async (req) => (console.log("→ APPROVAL REQUIRED:", req.rationale), false) },
  });

  const ctx: ActionContext = {
    actor: { type: "agent", id: "agent-demo", orgId: "org_demo", permissions: new Set(["crm.write"]) },
    now: new Date(),
    services: {},
  };

  const model = new OpenAiCompatAdapter();
  const result = await runAgentLoop(
    model,
    registry,
    executor,
    ctx,
    {
      sessionId: "demo",
      systemPrompt:
        "You are the ChasteBusinessOS agent. You operate an ERP through capabilities. Use tools when appropriate; otherwise answer briefly.",
      userGoal: "Please create a customer named 'Glow Works' for me.",
      maxSteps: 4,
    },
    { file: async (_org, title) => console.log("→ TICKET FILED:", title) },
  );

  console.log("\n── final message ──");
  console.log(result.finalMessage);
  console.log("steps:", result.steps);
  console.log("\n── ledger ──");
  for (const e of ledger.entries) {
    console.log(`${e.kind.padEnd(22)} ${e.capabilityId ?? "-"} hash=${e.hash.slice(0, 12)}…`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
