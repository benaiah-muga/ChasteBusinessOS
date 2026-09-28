import { NextResponse } from "next/server";
import { z } from "zod";
import { executeGoCapability, type GoCapabilityBridgeResult, type GoCapabilityExecutionAssertionInput } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

export function goCapabilityUnavailable(message: string) {
  return NextResponse.json({ error: message }, { status: 503, headers: noStore });
}

export async function goCapabilityRouteResponse(result: GoCapabilityBridgeResult, unavailableMessage: string) {
  if (result.kind !== "response") return goCapabilityUnavailable(unavailableMessage);
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(body);
      if (!parsed.success) return goCapabilityUnavailable(unavailableMessage);
      return NextResponse.json(parsed.data, { status: 200, headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return goCapabilityUnavailable(unavailableMessage);
      return NextResponse.json(parsed.data, { status: 202, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goCapabilityUnavailable(unavailableMessage);
      return NextResponse.json(parsed.data, { status: 422, headers: noStore });
    }
    if (result.response.status === 400 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goCapabilityUnavailable(unavailableMessage);
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goCapabilityUnavailable(unavailableMessage);
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
  } catch {
    return goCapabilityUnavailable(unavailableMessage);
  }
  return goCapabilityUnavailable(unavailableMessage);
}

export async function dispatchGoCapabilityRoute(input: GoCapabilityExecutionAssertionInput, unavailableMessage: string) {
  try {
    return await goCapabilityRouteResponse(await executeGoCapability(input), unavailableMessage);
  } catch {
    return goCapabilityUnavailable(unavailableMessage);
  }
}
