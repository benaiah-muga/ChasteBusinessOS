import { z } from "zod";

export const durableRunStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_approval",
  "paused",
  "cancel_requested",
  "cancelled",
  "blocked",
  "failed",
  "completed",
]);

export type DurableRunStatus = z.infer<typeof durableRunStatusSchema>;

export const durableStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_approval",
  "committed",
  "failed",
  "cancelled",
]);

export type DurableStepStatus = z.infer<typeof durableStepStatusSchema>;
