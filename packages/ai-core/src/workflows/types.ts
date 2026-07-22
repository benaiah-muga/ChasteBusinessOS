import { z } from "zod";

export const workflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.enum(["command", "agent", "approval", "condition", "parallel"]),
    command: z.string().optional(),
    agentId: z.string().optional(),
    condition: z.string().optional(),
    approveBy: z.string().optional(),
    description: z.string().optional(),
    input: z.record(z.unknown()).optional(),
    steps: z.array(workflowStepSchema).optional(),
    onError: z.enum(["bail", "retry", "continue"]).default("bail"),
  }),
);

export interface WorkflowStep {
  id: string;
  type: "command" | "agent" | "approval" | "condition" | "parallel";
  command?: string;
  agentId?: string;
  condition?: string;
  approveBy?: string;
  description?: string;
  input?: Record<string, unknown>;
  steps?: WorkflowStep[];
  onError?: "bail" | "retry" | "continue";
}

export const workflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: z.enum(["manual", "event", "schedule"]),
  triggerConfig: z.record(z.unknown()).optional(),
  steps: z.array(workflowStepSchema),
  createdBy: z.enum(["user", "ai"]).default("user"),
  createdAt: z.string(),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export interface WorkflowRun {
  id: string;
  workflowId: string;
  organizationId: string;
  status: "running" | "suspended" | "completed" | "failed";
  context: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  error?: string;
}
