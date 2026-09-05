import { z } from "zod";
import { defineCapability, sortSignals, type CapabilityRegistry, type SignalProducer } from "@chaste/kernel";

/**
 * The signals aggregator (ADR 0034). The module itself owns no business
 * logic: producers are injected by the app layer from whatever modules the
 * process already composes, so signal coverage grows with the install
 * without this module ever importing a sibling.
 */

export interface SignalsDeps {
  producers: SignalProducer[];
}

const severitySchema = z.enum(["red", "orange", "green"]);

const signalsList = (deps: SignalsDeps) =>
  defineCapability({
    id: "signals.list",
    title: "List business signals",
    intent:
      "Collect every module's needs-attention signals — stockout risk, dead stock, overdue receivables, stalled deals — sorted red first, each with evidence and a suggested governed action",
    module: "signals",
    risk: "read",
    permission: "signals.read",
    input: z.object({
      severity: severitySchema.optional(),
      module: z.string().min(2).max(40).optional(),
    }),
    output: z.object({
      signals: z.array(
        z.object({
          id: z.string(),
          severity: severitySchema,
          module: z.string(),
          subject: z.string(),
          detail: z.string(),
          evidence: z
            .object({ refType: z.string(), refId: z.string().nullable().optional() })
            .nullable()
            .optional(),
          suggestedAction: z
            .object({
              capabilityId: z.string(),
              inputDraft: z.record(z.string(), z.unknown()).optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const collected = await Promise.all(
        deps.producers.map(async (producer) => {
          try {
            return await producer(ctx.actor.orgId, ctx.now);
          } catch {
            // A failing producer degrades to missing signals, never to a
            // broken aggregator — the dashboard must render regardless.
            return [];
          }
        }),
      );
      const flat = collected.flat().filter((signal, index, all) => all.findIndex((s) => s.id === signal.id) === index);
      const sorted = sortSignals(flat).filter(
        (s) =>
          (input.severity ? s.severity === input.severity : true) &&
          (input.module ? s.module === input.module : true),
      );
      return { signals: sorted };
    },
  });

export function registerSignalsCapabilities(registry: CapabilityRegistry, deps: SignalsDeps): void {
  registry.register(signalsList(deps));
}
