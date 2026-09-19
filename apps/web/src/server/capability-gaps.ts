import { z } from "zod";
import { tickets, type Database } from "@chaste/db";

export const capabilityGapContractSchema = z.object({
  requestedCapabilityId: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-zA-Z0-9-]*$/),
  desiredBehavior: z.string().trim().min(20).max(4_000),
  acceptanceCriteria: z.array(z.string().trim().min(5).max(500)).min(1).max(20),
  exampleInput: z.record(z.string(), z.unknown()).optional(),
});

export type CapabilityGapContract = z.infer<typeof capabilityGapContractSchema>;

export async function fileCapabilityGap(
  db: Database["db"],
  input: {
    orgId: string;
    title: string;
    contract: CapabilityGapContract;
    sessionId?: string | null;
  },
): Promise<string> {
  const contract = capabilityGapContractSchema.parse(input.contract);
  const description = [
    "Capability unavailable; no execution was attempted.",
    `Requested capability: ${contract.requestedCapabilityId}`,
    `Desired behavior: ${contract.desiredBehavior}`,
    "Acceptance criteria:",
    ...contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...(contract.exampleInput ? [`Example input: ${JSON.stringify(contract.exampleInput)}`] : []),
  ].join("\n");
  const [row] = await db
    .insert(tickets)
    .values({
      orgId: input.orgId,
      sessionId: input.sessionId ?? null,
      title: input.title.trim().slice(0, 200),
      description,
      origin: "capability_gap",
      status: "open",
    })
    .returning({ id: tickets.id });
  if (!row) throw new Error("capability gap ticket was not created");
  return row.id;
}
