import type { CommandRegistry, QueryRegistry, RequestContext } from "@chaste/kernel";

export interface EvalResult {
  testName: string;
  passed: boolean;
  latencyMs: number;
  output?: string;
  error?: string;
}

export interface EvalScenario {
  name: string;
  input: string;
  expect: {
    toolsCalled?: string[];
    responseContains?: string[];
    noToolsCalled?: boolean;
  };
}

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    name: "Identify intent — create customer",
    input: "Add a new customer named Acme Corp",
    expect: {
      toolsCalled: ["crm.createCustomer"],
    },
  },
  {
    name: "Identify intent — list orders",
    input: "Show me all purchase orders from last month",
    expect: {
      toolsCalled: ["purchasing.listPurchaseOrders"],
    },
  },
  {
    name: "Clarifying questions — ambiguous intent",
    input: "I need to set up something for the new employee",
    expect: {
      noToolsCalled: true,
      responseContains: ["clarif"],
    },
  },
  {
    name: "Financial action — requires confirmation",
    input: "Create a journal entry for $500 office supplies",
    expect: {
      toolsCalled: ["accounting.createJournalEntry"],
    },
  },
  {
    name: "Multi-domain — new branch setup",
    input: "Open a second branch in Nairobi",
    expect: {
      responseContains: ["branch"],
    },
  },
];

export async function runAgentEvals(
  agentFn: (input: string) => Promise<string>,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const scenario of EVAL_SCENARIOS) {
    const start = Date.now();
    try {
      const output = await agentFn(scenario.input);
      const latencyMs = Date.now() - start;

      let passed = true;

      if (scenario.expect.responseContains) {
        const outputLower = output.toLowerCase();
        for (const term of scenario.expect.responseContains) {
          if (!outputLower.includes(term.toLowerCase())) {
            passed = false;
            break;
          }
        }
      }

      results.push({
        testName: scenario.name,
        passed,
        latencyMs,
        output: output.slice(0, 200),
      });
    } catch (err) {
      results.push({
        testName: scenario.name,
        passed: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
