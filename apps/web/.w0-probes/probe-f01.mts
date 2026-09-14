/**
 * W0 probe — F01: "capability executes before a separate audit append".
 *
 * Demonstrates that a governed write which commits, followed by a failed
 * audit append, is reported to the caller as a failed action — the exact
 * window where a retry would duplicate the committed effect.
 * Non-mutating: no database involved; the "write" is a counter.
 */
import { z } from "zod";
import { CapabilityRegistry, KernelExecutor, defineCapability, type LedgerEntry } from "@chaste/kernel";

let committedWrites = 0;

const cap = defineCapability({
  id: "probe.write",
  title: "Probe write",
  intent: "Probe capability that commits a side effect used to demonstrate the audit failure window",
  module: "probe",
  risk: "write",
  permission: "probe.write",
  input: z.object({}),
  output: z.object({ n: z.number() }),
  execute: async () => {
    committedWrites += 1;
    return { n: committedWrites };
  },
});

const registry = new CapabilityRegistry();
registry.register(cap);

const executor = new KernelExecutor({
  registry,
  ledger: {
    append: async (entry: LedgerEntry) => {
      if (entry.kind === "capability.executed") {
        throw new Error("simulated audit append failure");
      }
    },
  },
});

const result = await executor.execute(
  "probe.write",
  { actor: { type: "human", id: "u1", orgId: "o1", permissions: new Set(["probe.write"]) }, now: new Date(), services: {} },
  {},
);

console.log("F01 probe:");
console.log("  executor reported ok:", result.ok, "outcome:", result.outcome ?? "unspecified");
console.log("  side effect committed:", committedWrites === 1);
const discharged = !result.ok && result.outcome === "unknown";
console.log("  VERDICT:", discharged ? "DISCHARGED — committed write now reported as outcome unknown, not a retryable failure" : committedWrites === 1 ? "REGRESSION — committed write reported without unknown outcome" : "NOT REPRODUCED");
if (!discharged) process.exit(1);
