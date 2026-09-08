/**
 * Groq Provider Test Suite
 * 
 * Tests 6 tasks of varying complexity against Groq's API:
 * - 2 Simple: Basic Q&A, single-step reasoning
 * - 2 Medium: Multi-step reasoning, structured output
 * - 2 Complex: Tool use, complex orchestration
 * 
 * Run: GROQ_API_KEY=gsk_... pnpm test:groq
 */

import OpenAI from "openai";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY environment variable is required");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Available Groq models (fast inference)
const MODELS = {
  fast: "openai/gpt-oss-120b",
  reasoning: "openai/gpt-oss-120b",
  tools: "openai/gpt-oss-120b",
} as const;

interface TestCase {
  name: string;
  complexity: "simple" | "medium" | "complex";
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  expectedToolCalls?: string[];
  validation?: (response: string) => boolean;
}

const testCases: TestCase[] = [
  // ─── SIMPLE TASKS ───────────────────────────────────────────────────────────
  {
    name: "Simple 1: Basic Math",
    complexity: "simple",
    messages: [
      { role: "system", content: "You are a helpful assistant. Answer concisely." },
      { role: "user", content: "What is 15 * 37? Show your work briefly." },
    ],
    validation: (r) => r.includes("555"),
  },
  {
    name: "Simple 2: Fact Retrieval",
    complexity: "simple",
    messages: [
      { role: "system", content: "You are a helpful assistant. Answer concisely." },
      { role: "user", content: "What is the capital of France? One word answer." },
    ],
    validation: (r) => r.toLowerCase().includes("paris"),
  },

  // ─── MEDIUM TASKS ───────────────────────────────────────────────────────────
  {
    name: "Medium 1: Structured JSON Output",
    complexity: "medium",
    messages: [
      {
        role: "system",
        content: "You are a data analyst. Output valid JSON only, no markdown.",
      },
      {
        role: "user",
        content: `Create a JSON object representing a product catalog with 3 items. Each item should have: id, name, price (in cents), category, inStock (boolean). Use realistic data.`,
      },
    ],
    validation: (r) => {
      try {
        const parsed = JSON.parse(r);
        // Accept a bare array OR an object wrapping any array property (e.g. {catalog: [...]}, {products: [...]})
        const items = Array.isArray(parsed)
          ? parsed
          : Object.values(parsed).find((v) => Array.isArray(v));
        return (
          Array.isArray(items) &&
          items.length === 3 &&
          items.every((i) => {
            const o = i as Record<string, unknown>;
            return "id" in o && "name" in o && typeof o.price === "number" && "category" in o && "inStock" in o;
          })
        );
      } catch {
        return false;
      }
    },
  },
  {
    name: "Medium 2: Multi-Step Reasoning",
    complexity: "medium",
    messages: [
      { role: "system", content: "You are a helpful assistant. Show your reasoning step by step." },
      {
        role: "user",
        content: `A store offers 20% off for purchases over $100, and an additional 5% off for members. 
Sarah buys items worth $150 and is a member. 
What does she pay? Show the calculation steps.`,
      },
    ],
    validation: (r) => {
      // Should arrive at $114 (150 * 0.8 * 0.95 = 114)
      return r.includes("114") || r.includes("$114");
    },
  },

  // ─── COMPLEX TASKS ──────────────────────────────────────────────────────────
  {
    name: "Complex 1: Tool Use (Function Calling)",
    complexity: "complex",
    messages: [
      {
        role: "system",
        content: "You are an ERP assistant. Use tools to perform actions. Always use tools when requested.",
      },
      {
        role: "user",
        content: "Create a new customer called 'Acme Corp' and then create an invoice for them for $500 (50000 cents) with line item 'Consulting Services'.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "create_customer",
          description: "Create a new customer record",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Customer name" },
              email: { type: "string", description: "Customer email" },
            },
            required: ["name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_invoice",
          description: "Create an invoice for a customer",
          parameters: {
            type: "object",
            properties: {
              customerId: { type: "string", description: "Customer ID" },
              amount: { type: "number", description: "Amount in minor units (cents)" },
              lineItems: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    amount: { type: "number" },
                  },
                },
              },
            },
            required: ["customerId", "amount", "lineItems"],
          },
        },
      },
    ],
    expectedToolCalls: ["create_customer", "create_invoice"],
  },
  {
    name: "Complex 2: Multi-Step Orchestration with Reasoning",
    complexity: "complex",
    messages: [
      {
        role: "system",
        content: `You are an ERP agent. You have these tools:
- inventory.checkStock(productId): Check current stock level
- inventory.adjustStock(productId, quantity, reason): Adjust inventory
- crm.getCustomer(customerId): Get customer details
- orders.createOrder(customerId, items[]): Create a sales order
Use tools step by step. Explain your reasoning between steps.`,
      },
      {
        role: "user",
        content: `Customer "CUST-001" wants to order 50 units of "PROD-A". 
Check if we have enough stock, get the customer details, and if everything looks good, create the order. 
If stock is insufficient, tell me what we need.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "inventory.checkStock",
          description: "Check current stock level for a product",
          parameters: {
            type: "object",
            properties: { productId: { type: "string" } },
            required: ["productId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "crm.getCustomer",
          description: "Get customer details by ID",
          parameters: {
            type: "object",
            properties: { customerId: { type: "string" } },
            required: ["customerId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "orders.createOrder",
          description: "Create a sales order",
          parameters: {
            type: "object",
            properties: {
              customerId: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    productId: { type: "string" },
                    quantity: { type: "number" },
                  },
                },
              },
            },
            required: ["customerId", "items"],
          },
        },
      },
    ],
    expectedToolCalls: ["inventory.checkStock", "crm.getCustomer", "orders.createOrder"],
  },
];

// Mock tool execution (simulates server-side tool handlers)
function executeTool(name: string, args: Record<string, unknown>): string {
  const mocks: Record<string, (args: Record<string, unknown>) => string> = {
    create_customer: (a) => JSON.stringify({ customerId: "cus_" + Math.random().toString(36).slice(2, 8), name: a.name }),
    create_invoice: (a) => JSON.stringify({ invoiceId: "inv_" + Math.random().toString(36).slice(2, 8), amount: a.amount, status: "pending" }),
    "inventory.checkStock": (a) => JSON.stringify({ productId: a.productId, stock: 120, unit: "units" }),
    "crm.getCustomer": (a) => JSON.stringify({ customerId: a.customerId, name: "Acme Corp", creditLimit: 100000 }),
    "orders.createOrder": () => JSON.stringify({ orderId: "ord_" + Math.random().toString(36).slice(2, 8), status: "created" }),
  };
  return mocks[name]?.(args) ?? JSON.stringify({ error: "unknown tool" });
}

async function runTest(test: TestCase, model: string): Promise<{
  passed: boolean;
  response: string;
  toolCalls: string[];
  duration: number;
  error?: string;
}> {
  const start = Date.now();
  const messages = [...test.messages];
  const allToolCalls: string[] = [];
  const maxIterations = 5;

  try {
    for (let i = 0; i < maxIterations; i++) {
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model,
        messages,
        temperature: 0.1,
        max_tokens: 2048,
      };

      if (test.tools) {
        params.tools = test.tools;
      }

      const response = await client.chat.completions.create(params);
      const choice = response.choices[0];

      if (!choice?.message) {
        return {
          passed: false,
          response: "",
          toolCalls: allToolCalls,
          duration: Date.now() - start,
          error: "No response from model",
        };
      }

      // Check for tool calls
      if (choice.message.tool_calls?.length) {
        // Add assistant message with tool calls
        messages.push(choice.message);

        // Execute each tool and add results
        for (const tc of choice.message.tool_calls) {
          allToolCalls.push(tc.function.name);
          const args = JSON.parse(tc.function.arguments);
          const result = executeTool(tc.function.name, args);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
        continue; // Continue loop to get final response
      }

      // No tool calls - we have a final text response
      const finalText = choice.message.content ?? "";
      const passed = test.validation ? test.validation(finalText) : true;

      return {
        passed,
        response: finalText,
        toolCalls: allToolCalls,
        duration: Date.now() - start,
      };
    }

    return {
      passed: false,
      response: "Max iterations reached",
      toolCalls: allToolCalls,
      duration: Date.now() - start,
      error: "Exceeded max tool call iterations",
    };
  } catch (err) {
    return {
      passed: false,
      response: "",
      toolCalls: allToolCalls,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Groq Provider Test Suite");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results: Array<{
    test: string;
    complexity: string;
    model: string;
    passed: boolean;
    duration: number;
    toolCalls: string[];
    error?: string;
  }> = [];

  for (const test of testCases) {
    const model = test.tools ? MODELS.tools : (test.complexity === "complex" ? MODELS.reasoning : MODELS.fast);
    
    console.log(`▶ ${test.name}`);
    console.log(`  Model: ${model}`);
    
    const result = await runTest(test, model);
    
    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`  ${status} (${result.duration}ms)`);
    
    if (result.toolCalls.length > 0) {
      console.log(`  Tool calls: ${result.toolCalls.join(" → ")}`);
    }
    
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
    
    if (test.complexity !== "complex") {
      const preview = result.response.slice(0, 150).replace(/\n/g, " ");
      console.log(`  Response: ${preview}...`);
    }
    
    console.log();

    results.push({
      test: test.name,
      complexity: test.complexity,
      model,
      passed: result.passed,
      duration: result.duration,
      toolCalls: result.toolCalls,
      error: result.error,
    });

    // Small delay between tests to avoid rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  Total time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log();

  // Breakdown by complexity
  for (const complexity of ["simple", "medium", "complex"]) {
    const group = results.filter((r) => r.complexity === complexity);
    const groupPassed = group.filter((r) => r.passed).length;
    const avgDuration = group.reduce((sum, r) => sum + r.duration, 0) / group.length;
    console.log(`  ${complexity.charAt(0).toUpperCase() + complexity.slice(1)}: ${groupPassed}/${group.length} passed (avg ${avgDuration.toFixed(0)}ms)`);
  }

  console.log();
  
  // Tool calling summary
  const toolTests = results.filter((r) => r.toolCalls.length > 0);
  if (toolTests.length > 0) {
    console.log("  Tool Calling:");
    for (const t of toolTests) {
      console.log(`    ${t.test}: ${t.toolCalls.join(" → ")}`);
    }
    console.log();
  }

  console.log("═══════════════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
