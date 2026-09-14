/**
 * W0 probe — F02: "executor validates input but does not parse cap.output".
 *
 * Demonstrates that a capability returning data violating its own declared
 * output schema is reported as ok:true — invalid output crosses the trust
 * boundary unvalidated.
 * Non-mutating: no database involved.
 */
import { z } from "zod";
import { CapabilityRegistry, KernelExecutor, defineCapability } from "@chaste/kernel";

const cap = defineCapability<{ n: number }, { n: number }>({
  id: "probe.invalidOutput",
  title: "Probe invalid output",
  intent: "Probe capability whose execution returns data violating its declared output schema",
  module: "probe",
  risk: "read",
  permission: "probe.read",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  execute: async (_ctx, input) => {
    // Schema violation introduced deliberately; nothing validates it downstream.
    return { n: `not-a-number-${input.n}` } as unknown as { n: number };
  },
});

const registry = new CapabilityRegistry();
registry.register(cap);

const executor = new KernelExecutor({
  registry,
  ledger: { append: async () => {} },
});

const result = await executor.execute(
  "probe.invalidOutput",
  { actor: { type: "human", id: "u1", orgId: "o1", permissions: new Set(["probe.read"]) }, now: new Date(), services: {} },
  { n: 7 },
);

console.log("F02 probe:");
console.log("  executor reported ok:", result.ok, "error:", result.error ?? "none");
console.log("  returned data:", JSON.stringify(result.data));
const discharged = !result.ok && typeof result.error === "string" && result.error.includes("invalid output");
console.log("  VERDICT:", discharged ? "DISCHARGED — output schema enforced at the executor boundary" : result.ok ? "REGRESSION — invalid output crossed as ok" : "NOT REPRODUCED");
if (!discharged) process.exit(1);
