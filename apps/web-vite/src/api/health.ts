import { z } from "zod";

const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["connected", "unavailable"]),
  time: z.string().datetime(),
});

export type ApiHealth = z.infer<typeof healthSchema>;

export async function fetchApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Go health endpoint returned HTTP ${response.status}`);
  }
  return healthSchema.parse(await response.json());
}
