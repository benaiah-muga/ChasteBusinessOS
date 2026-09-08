/**
 * Live chat test for thinking-machines/inkling via OpenRouter.
 * 2 simple / 2 medium / 2 complex natural-language tasks against the platform.
 */
import { chat } from "../packages/ai/src/providers";

const tasks = [
  { tier: "simple", label: "List current workspace name and active session count briefly.", prompt: "What workspace and session details can you see from my account? Answer briefly." },
  { tier: "simple", label: "Identify one open deal in the pipeline.", prompt: "Look at the deals pipeline and tell me the name of one open deal and its stage. Keep it short." },
  { tier: "medium", label: "Create a new deal and advance it.", prompt: "Create a deal titled 'Inkling Test Deal' valued at $2,500, then move it to the qualified stage. Confirm both actions." },
  { tier: "medium", label: "Draft a short invoice memo for a customer.", prompt: "Draft a brief invoice memo for a customer named 'Inkling Test Client' for $320.00. Don't post it, just summarize what you'd include." },
  { tier: "complex", label: "Multi-step: hire + leave + payroll overview.", prompt: "Perform these steps in order: (1) hire an employee named 'Inkling Tester' at $4,800/month, (2) file a 2-day annual leave request for that employee starting tomorrow, (3) tell me the drafted payroll status. Use the tools available. Answer concisely after each step." },
  { tier: "complex", label: "Review inventory + propose BOM adjustment.", prompt: "Check current inventory items, then propose a bill-of-materials change that connects one item as a component of another, explaining the quantities. Don't execute unless safe; describe the plan clearly." },
];

async function run() {
  console.log("=== Inkling (thinking-machines/inkling) live chat tests ===\n");
  for (const t of tasks) {
    console.log(`[${t.tier.toUpperCase()}] ${t.label}`);
    try {
      const reply = await chat(t.prompt, { temperature: 0.3, maxTokens: 512 });
      const snippet = reply.slice(0, 400).replace(/\n/g, " ");
      console.log(`  → ${snippet}${reply.length > 400 ? " ..." : ""}\n`);
    } catch (e) {
      // provider SDK errors are untyped at this boundary; message extraction is best-effort
      const message = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ERROR: ${message}\n`);
    }
  }
  console.log("=== Tests complete ===");
}

run();
