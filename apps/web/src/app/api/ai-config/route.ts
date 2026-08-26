import { NextResponse } from "next/server";
import { getResolvedUser } from "@/server/session";

/**
 * Which model configuration the workmate actually runs on. Read-only: keys
 * live in the server environment and are never echoed, only their presence.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const provider = process.env.MODEL_PROVIDER === "openrouter" ? "openrouter" : "nvidia";
  const configured =
    provider === "openrouter" ? Boolean(process.env.OPENROUTER_API_KEY) : Boolean(process.env.NVIDIA_API_KEY);

  return NextResponse.json({
    provider,
    configured,
    baseUrl:
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : (process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1"),
    models: {
      primary: process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6",
      fast: process.env.MODEL_FAST ?? "meta/muse-glimmer-30b",
      reasoning: process.env.MODEL_REASONING ?? "nvidia/nemotron-3-ultra-550b-a55b",
      embeddings: process.env.MODEL_EMBEDDINGS ?? "nvidia/nv-embedqa-e5-v5",
    },
    source: "environment",
  });
}
