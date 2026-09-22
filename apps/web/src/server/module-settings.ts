import { z } from "zod";

/**
 * Per-module settings schemas. The registry is injected into the iam
 * module, so `iam.setModuleConfig` validates kernel-side no matter who
 * calls it (settings UI, agent tool call, or script); the settings API
 * uses the same definitions to render forms and to type the payloads.
 *
 * Adding module settings = one entry here (schema) + a panel descriptor in
 * the Settings UI + a consumer that reads the values as defaults.
 */

export const moduleSettingsSchemas: Record<string, z.ZodTypeAny> = {
  inventory: z
    .object({
      defaultUnitLabel: z.string().trim().min(1).max(20).default("unit"),
      defaultReorderPointUnits: z.number().int().min(0).max(1_000_000).default(0),
    })
    .partial()
    .default({}),
};

// Registered when their forms grow the matching fields:
// sales.defaultPaymentTermDays, purchasing.defaultPaymentTermDays.

export function settingsSchemaFor(module: string): z.ZodTypeAny | undefined {
  return moduleSettingsSchemas[module];
}
