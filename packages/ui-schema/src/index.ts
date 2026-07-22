import { z } from "zod";

/** Shared generative UI parts rendered inside the chat widget. */

export const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const explanationPartSchema = z.object({
  type: z.literal("explanation"),
  summary: z.string(),
  reasons: z.array(z.string()).default([]),
  rulesApplied: z.array(z.string()).default([]),
  dataUsed: z.array(z.string()).default([]),
});

export const formFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  fieldType: z.enum(["text", "number", "email", "checkbox", "select"]),
  required: z.boolean().default(false),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const formPartSchema = z.object({
  type: z.literal("form"),
  id: z.string(),
  title: z.string().optional(),
  fields: z.array(formFieldSchema),
  submitLabel: z.string().default("Submit"),
});

export const buttonGroupPartSchema = z.object({
  type: z.literal("button_group"),
  id: z.string(),
  buttons: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      variant: z.enum(["primary", "secondary", "danger"]).default("secondary"),
    }),
  ),
});

export const confirmActionPartSchema = z.object({
  type: z.literal("confirm_action"),
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  command: z.string(),
  input: z.unknown(),
  confirmLabel: z.string().default("Confirm"),
  cancelLabel: z.string().default("Cancel"),
});

export const tablePartSchema = z.object({
  type: z.literal("table"),
  columns: z.array(z.object({ key: z.string(), label: z.string() })),
  rows: z.array(z.record(z.unknown())),
});

export const metricPartSchema = z.object({
  type: z.literal("metric"),
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  hint: z.string().optional(),
});

export const errorPartSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
});

export const clarifyPartSchema = z.object({
  type: z.literal("clarify"),
  questions: z.array(z.string()),
});

export const planPartSchema = z.object({
  type: z.literal("plan"),
  id: z.string(),
  title: z.string(),
  steps: z.array(
    z.object({
      command: z.string(),
      description: z.string(),
      input: z.record(z.unknown()).optional(),
    }),
  ),
});

export const suggestionsPartSchema = z.object({
  type: z.literal("suggestions"),
  suggestions: z.array(z.string()),
});

export const uiPartSchema = z.discriminatedUnion("type", [
  textPartSchema,
  explanationPartSchema,
  formPartSchema,
  buttonGroupPartSchema,
  confirmActionPartSchema,
  tablePartSchema,
  metricPartSchema,
  errorPartSchema,
  clarifyPartSchema,
  planPartSchema,
  suggestionsPartSchema,
]);

export type UiPart = z.infer<typeof uiPartSchema>;
export type ConfirmActionPart = z.infer<typeof confirmActionPartSchema>;
export type ExplanationPart = z.infer<typeof explanationPartSchema>;
export type ClarifyPart = z.infer<typeof clarifyPartSchema>;
export type PlanPart = z.infer<typeof planPartSchema>;
export type SuggestionsPart = z.infer<typeof suggestionsPartSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(uiPartSchema),
  createdAt: z.string(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
