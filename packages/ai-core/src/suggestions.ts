/**
 * Proactive follow-up suggestions after successful command execution.
 * Uses rule-based heuristics + optional LLM refinement.
 */
import type { AiProvider } from "./providers.js";

/** Map of command → follow-up suggestions. */
const RULE_BASED: Record<string, string[]> = {
  "crm.customer.create": [
    "Create an invoice for this customer",
    "Add a contact person for this customer",
    "Create a sales order for this customer",
  ],
  "crm.customer.list": [
    "Filter by active customers only",
    "Export customer list to CSV",
    "Create a new customer",
  ],
  "hr.employee.create": [
    "Create an onboarding checklist for this employee",
    "Assign the employee to a department",
    "Set up a payroll entry for this employee",
  ],
  "acc.invoice.create": [
    "Send this invoice via email",
    "Create another invoice",
    "View this customer's outstanding balance",
  ],
  "inv.stock.adjust": [
    "View current stock levels",
    "Create a stock move between warehouses",
    "Set up a low-stock alert",
  ],
  "pur.purchaseOrder.create": [
    "Add more line items to this PO",
    "View pending purchase orders",
    "Receive goods against this PO",
  ],
  "wf.workflow.build": [
    "Execute this workflow now",
    "Modify the workflow steps",
    "Create another workflow",
  ],
};

export interface SuggestionResult {
  suggestions: string[];
}

/**
 * Generate proactive follow-up suggestions after a command executes.
 * Tries rule-based first, falls back to LLM if available.
 */
export async function generateSuggestions(
  commandName: string,
  output: unknown,
  provider?: AiProvider,
): Promise<SuggestionResult> {
  // Try rule-based first
  const rules = RULE_BASED[commandName];
  if (rules && rules.length > 0) {
    return { suggestions: rules };
  }

  // Fall back to LLM for commands without rules
  if (provider && provider.id !== "none") {
    try {
      const completion = await provider.complete({
        system:
          "Suggest 2-3 concise follow-up actions the user might want next after completing a business operation. " +
          "Reply with a JSON array of strings only, e.g. [\"action 1\", \"action 2\"]. No other text.",
        user: `The user just executed the command "${commandName}". Suggest relevant follow-up actions.`,
      });
      const match = completion.text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as unknown;
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
          return { suggestions: parsed.slice(0, 3) };
        }
      }
    } catch {
      // ignore LLM errors
    }
  }

  return { suggestions: [] };
}
