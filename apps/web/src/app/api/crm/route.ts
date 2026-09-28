import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalInputHash, logger } from "@chaste/kernel";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser, type SessionUser } from "@/server/session";
import { draftCrmFollowUp } from "@/server/crm-assist";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function crmGoUnavailable() {
  return NextResponse.json(
    { error: "CRM service unavailable; check deal status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function crmGoResponse(result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return crmGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: z.object({
          dealId: z.string().uuid(),
          customerId: z.string().uuid(),
          stage: z.literal("qualified"),
        }),
      }).safeParse(body);
      if (!parsed.success) return crmGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return crmGoUnavailable();
      return NextResponse.json(
        { error: parsed.data.reason, pendingApproval: true },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return crmGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return crmGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return crmGoUnavailable();
  }

  return crmGoUnavailable();
}

function crmTaskGoUnavailable() {
  return NextResponse.json(
    { error: "CRM service unavailable; check task status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function crmTaskGoResponse(
  result: GoCapabilityBridgeResult,
  action: "createTask" | "completeTask" | "updateTaskDetails",
) {
  if (result.kind !== "response") return crmTaskGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const taskDataSchema = action === "createTask"
        ? z.object({ taskId: z.string().uuid() })
        : action === "completeTask"
          ? z.object({ completed: z.literal(true) })
          : z.object({
              taskId: z.string().uuid(),
              previous: z.object({
                dueAt: z.string().datetime().nullable(),
                assigneeUserId: z.string().uuid().nullable(),
              }),
            });
      const parsed = z.object({ ok: z.literal(true), data: taskDataSchema }).safeParse(body);
      if (!parsed.success) return crmTaskGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return crmTaskGoUnavailable();
      return NextResponse.json(
        { error: parsed.data.reason, pendingApproval: true },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return crmTaskGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return crmTaskGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return crmTaskGoUnavailable();
  }

  return crmTaskGoUnavailable();
}

const crmTimelineResponseSchema = z.object({
  entries: z.array(z.object({
    kind: z.string(),
    date: z.string(),
    refId: z.string(),
    summary: z.string(),
  })),
});

const crmTasksResponseSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    dueAt: z.string().nullable(),
    doneAt: z.string().nullable(),
    refType: z.string().nullable(),
    refId: z.string().nullable(),
    assigneeUserId: z.string().nullable(),
    assigneeName: z.string().nullable(),
    customerName: z.string().nullable(),
  })),
});

type CRMReadMode = "timeline" | "tasks";
type CRMReadResult = z.infer<typeof crmTimelineResponseSchema> | z.infer<typeof crmTasksResponseSchema>;
type GoCRMReadOutcome =
  | { kind: "success"; data: CRMReadResult }
  | { kind: "error"; status: 422; error: string };

async function readGoCRM(input: {
  resolved: SessionUser;
  actor: NonNullable<ReturnType<typeof actorFromResolved>>["actor"];
  mode: CRMReadMode;
  capabilityId: "crm.customerTimeline" | "crm.listTasks";
  capabilityInput: { customerId: string } | { openOnly: boolean | undefined };
  timelineId?: string;
  openOnly?: boolean;
}): Promise<GoCRMReadOutcome | null> {
  const secret = process.env.GO_INTERNAL_AUTH_SECRET;
  if (!secret) {
    logger.warn("Go CRM read unavailable: bridge secret is not configured");
    return null;
  }
  const resolved = input.resolved;
  if (!resolved || !resolved.orgId || input.actor.type !== "human" || input.actor.id !== resolved.userId || input.actor.orgId !== resolved.orgId) {
    return null;
  }

  try {
    if (Buffer.byteLength(secret, "utf8") < 32) return null;
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      aud: "go.crm.read",
      sub: resolved.userId,
      org_id: resolved.orgId,
      capability_id: input.capabilityId,
      input_sha256: await canonicalInputHash(input.capabilityInput),
      actor_id: input.actor.id,
      actor_type: input.actor.type,
      permissions: [...input.actor.permissions].sort(),
      auth_session_id: resolved.authSessionId,
      iat: issuedAt,
      exp: issuedAt + 30,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const assertion = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
    const baseUrl = new URL(process.env.GO_API_INTERNAL_URL ?? "http://127.0.0.1:8080");
    const bridgeHost = baseUrl.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(bridgeHost);
    if (
      baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/" ||
      (baseUrl.protocol !== "https:" && !loopbackHttp)
    ) {
      logger.warn("Go CRM read unavailable: bridge URL must use loopback HTTP or HTTPS");
      return null;
    }
    const query = new URLSearchParams();
    if (input.mode === "timeline") query.set("timeline", input.timelineId ?? "");
    else {
      query.set("tasks", "1");
      if (input.openOnly) query.set("open", "1");
    }
    const response = await fetch(new URL(`/__go/crm?${query.toString()}`, baseUrl), {
      method: "GET",
      headers: { "X-Chaste-Session-Assertion": assertion },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 422) {
      const errorBody = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
      if (errorBody.success) return { kind: "error", status: 422, error: errorBody.data.error };
      logger.warn("Go CRM read returned an invalid error response");
      return null;
    }
    if (!response.ok) {
      logger.warn("Go CRM read failed", { status: response.status });
      return null;
    }
    const raw: unknown = await response.json().catch(() => null);
    const parsed = input.mode === "timeline"
      ? crmTimelineResponseSchema.safeParse(raw)
      : crmTasksResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("Go CRM read returned an invalid response", { mode: input.mode });
      return null;
    }
    return { kind: "success", data: parsed.data };
  } catch {
    logger.warn("Go CRM read failed");
    return null;
  }
}

function crmReadMatches(left: CRMReadResult, right: CRMReadResult): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("convertLead"),
    dealId: z.string().uuid(),
    customerId: z.string().uuid().optional(),
    createCustomer: z.boolean().optional(),
    customerName: z.string().min(1).max(200).optional(),
  }),
  z.object({
    action: z.literal("createTask"),
    title: z.string().min(1).max(200),
    dueAt: z.string().datetime().optional(),
    assigneeUserId: z.string().uuid().optional(),
    refType: z.string().max(50).optional(),
    refId: z.string().uuid().optional(),
    note: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal("completeTask"), taskId: z.string().uuid() }),
  z.object({ action: z.literal("draftFollowUp"), customerId: z.string().uuid() }),
  z.object({
    action: z.literal("updateTaskDetails"),
    taskId: z.string().uuid(),
    dueAt: z.string().datetime().nullable().optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
  }),
]);

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const url = new URL(req.url);
  const timelineId = url.searchParams.get("timeline");
  let mode: CRMReadMode | null = null;
  let capabilityId: "crm.customerTimeline" | "crm.listTasks" | null = null;
  let capabilityInput: { customerId: string } | { openOnly: boolean | undefined } | null = null;
  if (timelineId) {
    mode = "timeline";
    capabilityId = "crm.customerTimeline";
    capabilityInput = { customerId: timelineId };
  } else if (url.searchParams.get("tasks")) {
    mode = "tasks";
    capabilityId = "crm.listTasks";
    capabilityInput = { openOnly: url.searchParams.get("open") === "1" ? true : undefined };
  }

  if (!mode || !capabilityId || !capabilityInput) return NextResponse.json({ error: "nothing requested" }, { status: 400 });

  const goReadEnabled = process.env.GO_CRM_READ === "1";
  const shadowEnabled = !goReadEnabled && process.env.NODE_ENV === "development" && process.env.GO_CRM_SHADOW === "1";
  const legacyPayload = !goReadEnabled || shadowEnabled
    ? await buildExecutor(getDb().db, buildRegistry(getDb().db)).execute(capabilityId, ctx, capabilityInput)
    : null;
  if (legacyPayload && !legacyPayload.ok) return NextResponse.json({ error: legacyPayload.error }, { status: 422 });

  if (goReadEnabled || shadowEnabled) {
    const goPayload = await readGoCRM({
      resolved,
      actor: ctx.actor,
      mode,
      capabilityId,
      capabilityInput,
      ...(timelineId ? { timelineId } : {}),
      ...(url.searchParams.get("open") === "1" ? { openOnly: true } : {}),
    });
    if (goReadEnabled && !goPayload) {
      return NextResponse.json({ error: "CRM service unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (goReadEnabled && goPayload?.kind === "error") {
      return NextResponse.json({ error: goPayload.error }, { status: goPayload.status, headers: { "Cache-Control": "no-store" } });
    }
    if (goPayload?.kind === "error") logger.warn("Go CRM read differs from legacy data", { mode });
    if (goPayload?.kind === "success" && legacyPayload?.ok && !crmReadMatches(goPayload.data, legacyPayload.data as CRMReadResult)) {
      logger.warn("Go CRM read differs from legacy data", { mode });
    }
    if (goReadEnabled && goPayload?.kind === "success") return NextResponse.json(goPayload.data, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(legacyPayload?.ok ? legacyPayload.data : null);
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const d = parsed.data;
  if (d.action === "draftFollowUp") {
    const drafted = await draftCrmFollowUp({
      db,
      resolved,
      customerId: d.customerId,
    });
    return NextResponse.json(drafted.body, { status: drafted.status });
  }

  if (d.action === "convertLead" && process.env.GO_CRM_DEAL_WRITES === "1") {
    const input = {
      dealId: d.dealId,
      customerId: d.customerId,
      createCustomer: d.createCustomer,
      customerName: d.customerName,
    };
    try {
      const result = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: "crm.convertLead",
        input,
      });
      return crmGoResponse(result);
    } catch {
      return crmGoUnavailable();
    }
  }

  if (
    process.env.GO_CRM_TASK_WRITES === "1" &&
    (d.action === "createTask" || d.action === "completeTask" || d.action === "updateTaskDetails")
  ) {
    const capabilityId = d.action === "createTask" ? "crm.createTask"
      : d.action === "completeTask" ? "crm.completeTask" : "crm.updateTaskDetails";
    const input = d.action === "createTask"
      ? {
          title: d.title,
          dueAt: d.dueAt,
          assigneeUserId: d.assigneeUserId,
          refType: d.refType,
          refId: d.refId,
          note: d.note,
        }
      : d.action === "completeTask"
        ? { taskId: d.taskId }
        : {
            taskId: d.taskId,
            ...(d.dueAt !== undefined ? { dueAt: d.dueAt } : {}),
            ...(d.assigneeUserId !== undefined ? { assigneeUserId: d.assigneeUserId } : {}),
          };
    try {
      const result = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId,
        input,
      });
      return crmTaskGoResponse(result, d.action);
    } catch {
      return crmTaskGoUnavailable();
    }
  }

  const capId = d.action === "convertLead" ? "crm.convertLead"
    : d.action === "createTask" ? "crm.createTask"
      : d.action === "completeTask" ? "crm.completeTask" : "crm.updateTaskDetails";
  const input =
    d.action === "convertLead"
      ? {
          dealId: d.dealId,
          customerId: d.customerId,
          createCustomer: d.createCustomer,
          customerName: d.customerName,
        }
      : d.action === "createTask"
        ? {
            title: d.title,
            dueAt: d.dueAt,
            assigneeUserId: d.assigneeUserId,
            refType: d.refType,
            refId: d.refId,
            note: d.note,
          }
        : d.action === "completeTask" ? { taskId: d.taskId }
          : { taskId: d.taskId, ...(d.dueAt !== undefined ? { dueAt: d.dueAt } : {}), ...(d.assigneeUserId !== undefined ? { assigneeUserId: d.assigneeUserId } : {}) };

  const result = await buildExecutor(db, buildRegistry(db)).execute(capId, ctx, input);
  if (!result.ok) {
    const gated = Boolean(result.pendingApproval);
    return NextResponse.json(
      { error: result.error, pendingApproval: gated || undefined },
      { status: gated ? 202 : 422 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
