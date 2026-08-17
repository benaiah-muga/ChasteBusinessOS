import { FULL_AUTONOMOUS_WARNING, ChasteError, NotFoundError, type Actor } from "@chaste/kernel";
import {
  agentPlanSchema,
  watchTriggerSchema,
  watchActionSchema,
  proactivePreferencesSchema,
  harnessToolGrantSchema,
  harnessMessageSchema,
  harnessStartRequestSchema,
  harnessRunFromTrajectory,
} from "@chaste/ai-core";
import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getUserWithOrg, resolveUserPermissions, schema } from "@chaste/db";
import {
  createAppContext,
  healthPayload,
  getSessionPayload,
  runChat,
  runCommandAsActor,
  runCommandAsAuth,
  runQueryAsAuth,
  extractBearerToken,
  resolveRequestAuth,
  buildWorkflow,
  executeWorkflowRun,
  type AppContext,
  type RequestAuth,
} from "./app-context.js";
import { createRateLimiter, rateLimitedPayload } from "./rate-limit.js";

/** Form posts often send "" for optional fields — treat as omitted, not invalid. */
const optionalEmailSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().email().optional(),
);

const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

/** HTML number inputs / JSON may arrive as strings; coerce at the HTTP boundary. */
const nonNegativeNumberSchema = z.coerce.number().finite().nonnegative();
const optionalNonNegativeNumberSchema = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().finite().nonnegative().optional(),
);

export async function buildServer(appCtx?: AppContext) {
  const app = appCtx ?? (await createAppContext());
  const server = Fastify({ logger: true });

  // F9 — explicit origin allow-list (from config) instead of reflecting any
  // Origin. Requests without an Origin header (curl, server-to-server) pass.
  const allowedOrigins = new Set([app.config.webOrigin]);
  await server.register(cors, {
    origin: async (origin: string | undefined) => {
      if (!origin || allowedOrigins.has(origin)) return true;
      throw new Error("Not allowed by CORS");
    },
    credentials: false,
  });

  /**
   * ARCH-1 — per-request authentication. Resolve the acting principal from
   * `Authorization: Bearer <token>` or `X-Api-Key: <secret>` for every /api/v1
   * request. When no credential is supplied we retain the bootstrap admin only
   * in dev (`auth.allowAnonymousAdmin`, hard-rejected in production); an
   * invalid/revoked/expired credential returns 401 so RBAC is enforced at the
   * HTTP edge.
   */
  server.decorateRequest("auth", null);

  // F6 — fixed-window rate limits (in-memory, per server process).
  //  - authFailLimiter: throttles *failed* authentication on sensitive paths
  //    (`/auth/*`, `/ai/*`) per IP — this is what actually slows token
  //    brute-force, since the preHandler already rejects missing credentials
  //    before any route handler runs. Legit authenticated traffic is not
  //    counted here.
  //  - chatLimiter / keyedChatLimiter: cost bounds on the AI chat surface,
  //    per IP and per authenticated user, applied in the route handler.
  const authFailLimiter = createRateLimiter({ windowMs: 15_000, max: 10 });
  const chatLimiter = createRateLimiter({ windowMs: 15_000, max: 30 });
  const keyedChatLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
  /** True for the surfaces where failed auth should be throttled. */
  const isSensitivePath = (url: string): boolean =>
    url.startsWith("/api/v1/auth/") || url.startsWith("/api/v1/ai/");

  server.addHook("preHandler", async (req, reply) => {
    const header = req.headers["authorization"];
    const apiKey = req.headers["x-api-key"];
    const auth = await resolveRequestAuth(
      app,
      Array.isArray(header) ? header[0] : header,
      Array.isArray(apiKey) ? apiKey[0] : apiKey,
    );
    if (auth === null) {
      if (isSensitivePath(req.url)) {
        const hit = authFailLimiter.check(`ip:${req.ip}`);
        if (!hit.ok) {
          reply.header("retry-after", String(hit.retryAfterMs / 1000));
          return reply.status(429).send(rateLimitedPayload(hit.retryAfterMs));
        }
      }
      return reply.status(401).send({ message: "Authentication required", code: "UNAUTHORIZED" });
    }
    (req as unknown as { auth: RequestAuth }).auth = auth;
    return undefined;
  });

  /** Read the authenticated principal decorated on `req` by the preHandler. */
  const getAuth = (req: FastifyRequest): RequestAuth =>
    (req as unknown as { auth: RequestAuth }).auth;

  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof ChasteError) {
      return reply.status(err.status).send({
        message: err.message,
        code: err.code,
        details: err.details,
      });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        message: "Validation error",
        code: "VALIDATION_ERROR",
        details: err.flatten(),
      });
    }
    server.log.error(err);
    return reply.status(500).send({ message: "Internal Server Error", code: "INTERNAL" });
  });

  server.get("/health", async () => healthPayload(app));

  server.get("/api/v1/session", async (req) => {
    const auth = getAuth(req);
    return getSessionPayload(auth, app);
  });

  /**
   * ARCH-1 — login. Validates the bearer credential and returns the session
   * payload the web client persists. The token is the raw invite/onboarding
   * credential returned by `core.user.invite`; it is stored hashed at rest.
   */
  server.post("/api/v1/auth/login", async (req, reply) => {
    // Failed auth on this path is already throttled per IP by the preHandler
    // (F6) — a successful exchange is intentional and not counted.
    const header = req.headers["authorization"];
    const token = Array.isArray(header) ? header[0] : (header ?? "");
    const auth = await resolveRequestAuth(app, token);
    if (!auth) {
      return reply.status(401).send({ message: "Invalid or expired token", code: "UNAUTHORIZED" });
    }
    return {
      token: extractBearerToken(token),
      ...getSessionPayload(auth, app),
    };
  });

  server.get("/api/v1/modules", async (req) => {
    const result = await runQueryAsAuth(app, "core.modules.list", {}, getAuth(req), req.id);
    return result.data;
  });

  server.get("/api/v1/commands", async () => ({ items: app.commands.list() }));
  server.get("/api/v1/queries", async () => ({ items: app.queries.list() }));
  server.get("/api/v1/specialists", async () => ({ items: app.modules.specialists() }));

  // ─── Business partners (master data) ────────────────────────────────
  server.get("/api/v1/business-partners", async (req) => {
    const { search, type, includeArchived } = req.query as {
      search?: string;
      type?: string;
      includeArchived?: string;
    };
    return (
      await runQueryAsAuth(
        app,
        "core.bpartner.list",
        {
          search,
          type: type === "person" || type === "organization" ? type : undefined,
          includeArchived: includeArchived === "true" ? true : undefined,
        },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.post("/api/v1/business-partners", async (req) => {
    const input = z
      .object({
        type: z.enum(["person", "organization"]).default("person"),
        name: z.string().min(1),
        email: optionalEmailSchema,
        phone: optionalStringSchema,
        city: optionalStringSchema,
        country: optionalStringSchema,
        notes: optionalStringSchema,
      })
      .parse(req.body ?? {});
    return (await runCommandAsAuth(app, "core.bpartner.create", input, getAuth(req), req.id)).data;
  });
  server.get("/api/v1/business-partners/:id", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runQueryAsAuth(
        app,
        "core.bpartner.get",
        { businessPartnerId: id },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.patch("/api/v1/business-partners/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = z
      .object({
        name: optionalStringSchema,
        email: optionalEmailSchema,
        phone: optionalStringSchema,
        city: optionalStringSchema,
        country: optionalStringSchema,
        notes: optionalStringSchema,
      })
      .parse(req.body ?? {});
    return (
      await runCommandAsAuth(
        app,
        "core.bpartner.update",
        { businessPartnerId: id, ...patch },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.delete("/api/v1/business-partners/:id", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(
        app,
        "core.bpartner.delete",
        { businessPartnerId: id },
        getAuth(req),
        req.id,
      )
    ).data;
  });

  server.post("/api/v1/commands/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    const body = z.object({ input: z.unknown().default({}) }).parse(req.body ?? {});
    return runCommandAsAuth(app, name, body.input, getAuth(req), req.id);
  });

  server.post("/api/v1/queries/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    const body = z.object({ input: z.unknown().default({}) }).parse(req.body ?? {});
    return runQueryAsAuth(app, name, body.input, getAuth(req), req.id);
  });

  // ─── Buzz bridge inbound ─────────────────────────────────────────────
  // Signed webhook (X-Chaste-Signature: HMAC-SHA256 over the canonical JSON
  // body) that files an external Buzz channel message into an internal
  // thread. Posts via `messaging.thread.send` as the thread creator, so the
  // message is fully audited and permission-checked like any other send.
  server.post("/api/v1/buzz/webhook", async (req, reply) => {
    const secret = process.env.CHASTE_BUZZ_WEBHOOK_SECRET;
    if (!secret) {
      return reply
        .status(503)
        .send({ message: "Buzz bridge is not configured", code: "BUZZ_NOT_CONFIGURED" });
    }
    const body = z
      .object({
        threadId: z.string().uuid(),
        body: z.string().min(1).max(8000),
        // F18 — anti-replay: unix-seconds timestamp covered by the signature.
        ts: z.number().int().nonnegative(),
      })
      .parse(req.body ?? {});
    const provided = String(req.headers["x-chaste-signature"] ?? "");
    const expected = createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      return reply
        .status(401)
        .send({ message: "Invalid signature", code: "BUZZ_SIGNATURE_INVALID" });
    }
    // F18 — reject stale replayed webhooks (allow ≤5 min clock skew).
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - body.ts) > 300) {
      return reply
        .status(401)
        .send({ message: "Stale webhook timestamp", code: "BUZZ_STALE_TIMESTAMP" });
    }

    const [thread] = await app.db
      .select()
      .from(schema.msgThreads)
      .where(eq(schema.msgThreads.id, body.threadId))
      .limit(1);
    if (!thread) {
      return reply.status(404).send({ message: "Thread not found", code: "NOT_FOUND" });
    }
    const creatorRow = await getUserWithOrg(app.db, thread.createdBy);
    if (!creatorRow) {
      return reply.status(404).send({ message: "Thread creator not found", code: "NOT_FOUND" });
    }
    const permissions = await resolveUserPermissions(app.db, thread.createdBy);
    const actor: Actor = {
      kind: "user",
      userId: thread.createdBy,
      organizationId: thread.organizationId,
      displayName: creatorRow.displayName,
      permissions: new Set(permissions),
    };
    const result = await runCommandAsActor(
      app,
      "messaging.thread.send",
      { threadId: body.threadId, body: `[via Buzz] ${body.body}` },
      actor,
      req.id,
    );
    return result.data;
  });

  // CRM convenience
  server.get("/api/v1/crm/customers", async (req) => {
    const { search, status, includeDeleted } = req.query as {
      search?: string;
      status?: string;
      includeDeleted?: string;
    };
    const result = await runQueryAsAuth(
      app,
      "crm.customer.list",
      {
        search,
        status,
        includeDeleted: includeDeleted === "true" ? true : undefined,
      },
      getAuth(req),
      req.id,
    );
    return result.data;
  });
  server.post("/api/v1/crm/customers", async (req) => {
    const input = z
      .object({
        name: z.string().min(1),
        email: optionalEmailSchema,
        city: optionalStringSchema,
        country: optionalStringSchema,
      })
      .parse(req.body);
    const result = await runCommandAsAuth(app, "crm.customer.create", input, getAuth(req), req.id);
    return result.data;
  });

  server.get("/api/v1/crm/customers/:id", async (req) => {
    const { id } = req.params as { id: string };
    return (await runQueryAsAuth(app, "crm.customer.get", { customerId: id }, getAuth(req), req.id))
      .data;
  });
  server.patch("/api/v1/crm/customers/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = z
      .object({
        name: optionalStringSchema,
        email: optionalEmailSchema,
        city: optionalStringSchema,
        country: optionalStringSchema,
      })
      .parse(req.body ?? {});
    return (
      await runCommandAsAuth(
        app,
        "crm.customer.update",
        { customerId: id, ...patch },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.post("/api/v1/crm/customers/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const input = z.object({ status: z.string(), note: optionalStringSchema }).parse(req.body);
    return (
      await runCommandAsAuth(
        app,
        "crm.customer.setStatus",
        { customerId: id, ...input },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.delete("/api/v1/crm/customers/:id", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(app, "crm.customer.delete", { customerId: id }, getAuth(req), req.id)
    ).data;
  });

  server.get("/api/v1/crm/customers/:id/contacts", async (req) => {
    const { id } = req.params as { id: string };
    return (await runQueryAsAuth(app, "crm.contact.list", { customerId: id }, getAuth(req), req.id))
      .data;
  });
  server.post("/api/v1/crm/customers/:id/contacts", async (req) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({
        name: z.string().min(1),
        role: optionalStringSchema,
        email: optionalEmailSchema,
        phone: optionalStringSchema,
      })
      .parse(req.body);
    return (
      await runCommandAsAuth(
        app,
        "crm.contact.create",
        { customerId: id, ...input },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.delete("/api/v1/crm/contacts/:id", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(app, "crm.contact.delete", { contactId: id }, getAuth(req), req.id)
    ).data;
  });

  server.get("/api/v1/crm/customers/:id/interactions", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runQueryAsAuth(app, "crm.interaction.list", { customerId: id }, getAuth(req), req.id)
    ).data;
  });
  server.post("/api/v1/crm/customers/:id/interactions", async (req) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({
        kind: z.enum(["note", "email", "call", "meeting"]).default("note"),
        summary: z.string().min(1),
        detail: optionalStringSchema,
      })
      .parse(req.body);
    return (
      await runCommandAsAuth(
        app,
        "crm.interaction.log",
        { customerId: id, ...input },
        getAuth(req),
        req.id,
      )
    ).data;
  });

  // Domain convenience routes (all still command/query backed)
  server.get("/api/v1/accounting/accounts", async (req) => {
    return (await runQueryAsAuth(app, "acc.account.list", {}, getAuth(req), req.id)).data;
  });
  server.get("/api/v1/accounting/invoices", async (req) => {
    return (await runQueryAsAuth(app, "acc.invoice.list", {}, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/accounting/invoices", async (req) => {
    const input = z
      .object({
        number: z.string(),
        total: nonNegativeNumberSchema,
        currency: z.string().optional(),
        customerId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "acc.invoice.create", input, getAuth(req), req.id)).data;
  });

  server.get("/api/v1/inventory/stock", async (req) => {
    return (await runQueryAsAuth(app, "inv.stock.list", {}, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/inventory/products", async (req) => {
    const input = z
      .object({
        sku: z.string(),
        name: z.string(),
        uom: optionalStringSchema,
        reorderLevel: optionalNonNegativeNumberSchema,
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "inv.product.create", input, getAuth(req), req.id)).data;
  });

  server.get("/api/v1/purchasing", async (req) => {
    return (await runQueryAsAuth(app, "pur.po.list", {}, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/purchasing/vendors", async (req) => {
    const input = z.object({ name: z.string(), email: optionalEmailSchema }).parse(req.body);
    return (await runCommandAsAuth(app, "pur.vendor.create", input, getAuth(req), req.id)).data;
  });

  server.get("/api/v1/hr", async (req) => {
    return (await runQueryAsAuth(app, "hr.overview", {}, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/hr/employees", async (req) => {
    const input = z
      .object({
        employeeNumber: z.string(),
        fullName: z.string(),
        email: optionalEmailSchema,
        baseSalary: optionalNonNegativeNumberSchema,
        department: optionalStringSchema,
        jobTitle: optionalStringSchema,
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "hr.employee.create", input, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/hr/payroll", async (req) => {
    const input = z.object({ periodLabel: z.string() }).parse(req.body);
    return (await runCommandAsAuth(app, "hr.payroll.prepare", input, getAuth(req), req.id)).data;
  });

  server.get("/api/v1/manufacturing", async (req) => {
    return (await runQueryAsAuth(app, "mfg.overview", {}, getAuth(req), req.id)).data;
  });

  server.get("/api/v1/rbac", async (req) => {
    return (await runQueryAsAuth(app, "core.rbac.overview", {}, getAuth(req), req.id)).data;
  });

  server.get("/api/v1/marketplace", async (req) => {
    const region = (req.query as { region?: string }).region;
    return (await runQueryAsAuth(app, "core.marketplace.list", { region }, getAuth(req), req.id))
      .data;
  });

  // Multi-branch (platform spec §4)
  server.get("/api/v1/branches", async (req) => {
    return (await runQueryAsAuth(app, "core.branch.list", {}, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/branches", async (req) => {
    const input = z
      .object({
        name: z.string().min(1),
        code: z.string().min(1),
        timezone: optionalStringSchema,
        parentBranchId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "core.branch.create", input, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/branches/switch", async (req) => {
    const input = z.object({ branchId: z.string().uuid() }).parse(req.body);
    return (await runCommandAsAuth(app, "core.branch.set_active", input, getAuth(req), req.id))
      .data;
  });

  // Notifications (spec: scheduling-and-comms §4)
  server.get("/api/v1/notifications", async (req) => {
    const unreadOnly = (req.query as { unreadOnly?: string }).unreadOnly === "true";
    return (
      await runQueryAsAuth(app, "core.notification.list", { unreadOnly }, getAuth(req), req.id)
    ).data;
  });
  server.post("/api/v1/notifications/:id/read", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(
        app,
        "core.notification.mark_read",
        { notificationId: id },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.post("/api/v1/notifications/read-all", async (req) => {
    return (
      await runCommandAsAuth(app, "core.notification.mark_all_read", {}, getAuth(req), req.id)
    ).data;
  });

  // Reminders & follow-ups (spec: scheduling-and-comms §2/§3)
  server.get("/api/v1/reminders", async (req) => {
    const { status } = req.query as { status?: string };
    return (await runQueryAsAuth(app, "core.reminder.list", { status }, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/reminders", async (req) => {
    const input = z
      .object({
        title: z.string().min(1),
        body: z.string().optional(),
        href: z.string().optional(),
        fireAt: z.string(),
        channel: z.enum(["in_app", "email", "both"]).optional(),
        branchId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "core.reminder.set", input, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/reminders/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(app, "core.reminder.cancel", { reminderId: id }, getAuth(req), req.id)
    ).data;
  });

  server.get("/api/v1/followups", async (req) => {
    const { status } = req.query as { status?: string };
    return (await runQueryAsAuth(app, "core.followup.list", { status }, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/followups", async (req) => {
    const input = z
      .object({
        goal: z.string().min(1),
        fireAt: z.string(),
        sessionId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "core.followup.create", input, getAuth(req), req.id)).data;
  });
  server.post("/api/v1/followups/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(app, "core.followup.cancel", { followUpId: id }, getAuth(req), req.id)
    ).data;
  });

  // Calendar (spec: scheduling-and-comms §2.1)
  server.get("/api/v1/calendar", async (req) => {
    const { from, to, branchId } = req.query as { from?: string; to?: string; branchId?: string };
    return (
      await runQueryAsAuth(app, "core.calendar.list", { from, to, branchId }, getAuth(req), req.id)
    ).data;
  });
  server.post("/api/v1/calendar/events", async (req) => {
    const input = z
      .object({
        title: z.string().min(1),
        startsAt: z.string(),
        endsAt: z.string(),
        timezone: z.string().default("UTC"),
        description: z.string().optional(),
        calendarId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        attendees: z.array(z.string()).optional(),
        linkedResources: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
      })
      .parse(req.body);
    return (await runCommandAsAuth(app, "core.calendar.event.create", input, getAuth(req), req.id))
      .data;
  });
  server.patch("/api/v1/calendar/events/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
        timezone: z.string().optional(),
        branchId: z.string().uuid().nullable().optional(),
        attendees: z.array(z.string()).optional(),
        linkedResources: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
      })
      .parse(req.body);
    return (
      await runCommandAsAuth(
        app,
        "core.calendar.event.update",
        { eventId: id, ...body },
        getAuth(req),
        req.id,
      )
    ).data;
  });
  server.post("/api/v1/calendar/events/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (
      await runCommandAsAuth(
        app,
        "core.calendar.event.cancel",
        { eventId: id },
        getAuth(req),
        req.id,
      )
    ).data;
  });

  server.post("/api/v1/autonomy", async (req) => {
    const input = z
      .object({
        autonomy: z.enum(["recommend", "confirm", "guarded_auto", "full_autonomous"]),
        acknowledgeFullAutonomous: z.boolean().optional(),
      })
      .parse(req.body);
    const result = await runCommandAsAuth(app, "core.autonomy.set", input, getAuth(req), req.id);
    return result.data;
  });

  // ─── Settings & Preferences ──────────────────────────────────────────

  server.get("/api/v1/settings", async (req) => {
    const result = await runQueryAsAuth(app, "core.settings.get", {}, getAuth(req), req.id);
    return result.data;
  });

  server.put("/api/v1/settings", async (req) => {
    const input = z.object({ settings: z.record(z.unknown()) }).parse(req.body);
    const result = await runCommandAsAuth(app, "core.settings.update", input, getAuth(req), req.id);
    return result.data;
  });

  server.get("/api/v1/preferences", async (req) => {
    const result = await runQueryAsAuth(app, "core.preferences.get", {}, getAuth(req), req.id);
    return result.data;
  });

  server.put("/api/v1/preferences", async (req) => {
    const input = z.object({ preferences: z.record(z.unknown()) }).parse(req.body);
    const result = await runCommandAsAuth(
      app,
      "core.preferences.update",
      input,
      getAuth(req),
      req.id,
    );
    return result.data;
  });

  server.post("/api/v1/ai/chat", async (req, reply) => {
    // F6 — bound cost: per-IP *and* per-user throttles before any LLM work.
    const byIp = chatLimiter.check(`ip:${req.ip}`);
    if (!byIp.ok) {
      reply.header("retry-after", String(byIp.retryAfterMs / 1000));
      return reply.status(429).send(rateLimitedPayload(byIp.retryAfterMs));
    }
    const auth = getAuth(req);
    const byUser = keyedChatLimiter.check(`user:${auth.sessionUser.id}`);
    if (!byUser.ok) {
      reply.header("retry-after", String(byUser.retryAfterMs / 1000));
      return reply.status(429).send(rateLimitedPayload(byUser.retryAfterMs));
    }
    const body = z
      .object({
        sessionId: z.string().optional(),
        message: z.string().optional(),
        confirmId: z.string().optional(),
        cancelId: z.string().optional(),
      })
      .parse(req.body ?? {});
    return runChat(app, body, getAuth(req));
  });

  // ─── Native harness host (ADR 0014 tranche 8 — build item 9) ───────────
  // The host runs the harness over the command/query bus and serves inbox
  // plan/approval decisions through durable grants. AI and humans dispatch
  // through the same contracts; approval-required plans surface an inbox item
  // that any HTTP client (chat, console, mobile) can decide.

  server.post("/api/v1/ai/plans", async (req) => {
    const auth = getAuth(req);
    const body = z
      .object({
        sessionId: z.string().optional(),
        plan: agentPlanSchema,
        reason: z.string().optional(),
      })
      .parse(req.body ?? {});
    return app.harnessHost.submitPlan({
      sessionId: body.sessionId ?? crypto.randomUUID(),
      organizationId: auth.actor.organizationId,
      actor: auth.actor,
      plan: body.plan,
      correlationId: req.id,
      origin: "agent",
      reason: body.reason,
      approverUserId: auth.sessionUser.id,
    });
  });

    /** ADR 0014 — org-scoped AI usage summary from the durable model ledger. */
  server.get("/api/v1/ai/usage", async (req) => {
    const auth = getAuth(req);
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const spendCents = await app.usage.spendForOrganization(auth.actor.organizationId, since);
    return { organizationId: auth.actor.organizationId, spendCents, periodStart: since.toISOString() };
  });

  // ---- ADR 0014 proactive coordinator surface -----------------------------

  const createWatchRuleBody = z.object({
    name: z.string().min(1),
    trigger: watchTriggerSchema,
    action: watchActionSchema,
    condition: z.string().optional(),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    enabled: z.boolean().default(true),
  });

  const updateWatchRuleBody = createWatchRuleBody.partial().strict();

  server.get("/api/v1/proactive/rules", async (req) => {
    const auth = getAuth(req);
    const items = await app.proactive.watchRules.listByOrg(auth.actor.organizationId);
    return { items };
  });

  server.post("/api/v1/proactive/rules", async (req) => {
    const auth = getAuth(req);
    const body = createWatchRuleBody.parse(req.body ?? {});
    const rule = await app.proactive.watchRules.create({
      organizationId: auth.actor.organizationId,
      createdByUserId: auth.sessionUser.id,
      ...body,
    });
    return rule;
  });

  server.patch("/api/v1/proactive/rules/:id", async (req) => {
    const auth = getAuth(req);
    const { id } = req.params as { id: string };
    const body = updateWatchRuleBody.parse(req.body ?? {});
    const rule = await app.proactive.watchRules.update(auth.actor.organizationId, id, body);
    if (!rule) throw new NotFoundError(`Watch rule ${id}`);
    return rule;
  });

  server.delete("/api/v1/proactive/rules/:id", async (req) => {
    const auth = getAuth(req);
    const { id } = req.params as { id: string };
    const removed = await app.proactive.watchRules.remove(auth.actor.organizationId, id);
    if (!removed) throw new NotFoundError(`Watch rule ${id}`);
    return { removed: true };
  });

  server.get("/api/v1/proactive/preferences", async (req) => {
    const auth = getAuth(req);
    return app.proactive.preferences.get(auth.actor.organizationId);
  });

  server.put("/api/v1/proactive/preferences", async (req) => {
    const auth = getAuth(req);
    const body = z
      .object({
        quietHours: proactivePreferencesSchema.shape.quietHours,
        maxSuggestionsPerDay: proactivePreferencesSchema.shape.maxSuggestionsPerDay,
        channels: proactivePreferencesSchema.shape.channels,
      })
      .partial()
      .strict()
      .parse(req.body ?? {});
    const current = await app.proactive.preferences.get(auth.actor.organizationId);
    const prefs = await app.proactive.preferences.set({
      organizationId: auth.actor.organizationId,
      quietHours: body.quietHours ?? current.quietHours,
      maxSuggestionsPerDay: body.maxSuggestionsPerDay ?? current.maxSuggestionsPerDay,
      channels: body.channels ?? current.channels,
    });
    return prefs;
  });

  /** Dry-run: what would be suggested right now (nothing is recorded). */
  server.get("/api/v1/proactive/suggestions", async (req) => {
    const auth = getAuth(req);
    const { now } = req.query as { now?: string };
    const at = now ? new Date(now) : new Date();
    const suggestions = await app.proactive.coordinator.collect(auth.actor.organizationId, at);
    return { suggestions, at: at.toISOString() };
  });

  /** The tick: collect + gate + record everything due for the org. */
  server.post("/api/v1/proactive/tick", async (req) => {
    const auth = getAuth(req);
    const body = z.object({ now: z.string().optional() }).parse(req.body ?? {});
    const at = body.now ? new Date(body.now) : new Date();
    const deliveries = await app.proactive.coordinator.deliverDue(auth.actor.organizationId, at);
    return { deliveries, at: at.toISOString() };
  });

  // ---- ADR 0014 MCP/integration plane ------------------------------------

  const mcpMessageSchema = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.number(), z.string(), z.null()]).optional(),
      method: z.string(),
      params: z.unknown().optional(),
    })
    .strict();

  /** Streamable-HTTP-lite MCP endpoint. One JSON-RPC message per request; the
   * client keeps a session id in `x-chaste-session` for trajectory continuity
   * (defaults to a fresh session). Tools are scoped to the authenticated
   * actor; every call is revalidated, reauthorized, and audited on the
   * session log through the same pipeline the native harness uses. */
  server.post("/api/v1/mcp", async (req) => {
    const auth = getAuth(req);
    const message = mcpMessageSchema.parse(req.body ?? {});
    const header = req.headers["x-chaste-session"];
    const sessionId =
      typeof header === "string" && z.string().uuid().safeParse(header).success
        ? header
        : crypto.randomUUID();

    const session = app.mcp.createSession({
      sessionId,
      organizationId: auth.actor.organizationId,
      actor: auth.actor,
    });
    const response = await session.handleMessage(JSON.stringify(message));
    if (response === null) return { ok: true };
    return JSON.parse(response) as unknown;
  });

  // ---- ADR 0014 external harness adapters (build item 16) ----------------

  const harnessRunStartSchema = harnessStartRequestSchema
    .omit({ tenantId: true })
    .extend({ turn: harnessMessageSchema.optional() })
    .strict();

  server.get("/api/v1/harness-adapters", async () => {
    const items = await Promise.all(
      app.externalHarnesses.map(async (h) => ({
        id: h.id,
        kind: h.kind,
        capabilities: await h.capabilities(),
      })),
    );
    return { items };
  });

  /** Start a delegated external run. The run is bound to the authenticated
   * actor, records `externalHarness/session-start` on a fresh Chaste
   * trajectory, and optionally runs its first turn (tool calls mediated by the
   * MCP gateway). */
  server.post("/api/v1/harness-adapters/:kind/runs", async (req) => {
    const auth = getAuth(req);
    const { kind } = req.params as { kind: string };
    const adapter = app.externalHarnesses.find((h) => h.id === kind || h.kind === kind);
    if (!adapter) throw new NotFoundError(`Harness adapter ${kind}`);

    const body = harnessRunStartSchema.parse(req.body ?? {});
    const { turn, ...fields } = body;
    const handle = await adapter.start({
      actor: auth.actor,
      tenantId: auth.actor.organizationId,
      ...fields,
    });
    const afterTurn = turn ? await adapter.followup(handle, turn) : handle;
    return {
      runId: afterTurn.runId,
      status: afterTurn.status,
      usageVisibility: afterTurn.usageVisibility,
      toolOutcomes: afterTurn.toolOutcomes,
      summary: afterTurn.summary,
    };
  });

  /** Resume a run by `runId` — the handle is rebuilt from the trajectory, not
   * process memory. */
  server.post("/api/v1/harness-adapters/:kind/runs/:runId/turns", async (req) => {
    const auth = getAuth(req);
    const { kind, runId } = req.params as { kind: string; runId: string };
    const adapter = app.externalHarnesses.find((h) => h.id === kind || h.kind === kind);
    if (!adapter) throw new NotFoundError(`Harness adapter ${kind}`);

    const events = await app.sessionLog.list(runId);
    const handle = harnessRunFromTrajectory(runId, events);
    if (!handle) throw new NotFoundError(`Harness run ${runId}`);
    if (handle.actor.organizationId !== auth.actor.organizationId) {
      throw new NotFoundError(`Harness run ${runId}`);
    }

    const turn = harnessMessageSchema.parse(req.body ?? {});
    const next = await adapter.followup(handle, turn);
    return {
      runId: next.runId,
      status: next.status,
      usageVisibility: next.usageVisibility,
      toolOutcomes: next.toolOutcomes,
      summary: next.summary,
    };
  });

  /** Collect the run result (status, artifacts, model usage, trace ref). */
  server.get("/api/v1/harness-adapters/:kind/runs/:runId", async (req) => {
    const auth = getAuth(req);
    const { kind, runId } = req.params as { kind: string; runId: string };
    const adapter = app.externalHarnesses.find((h) => h.id === kind || h.kind === kind);
    if (!adapter) throw new NotFoundError(`Harness adapter ${kind}`);

    const events = await app.sessionLog.list(runId);
    const handle = harnessRunFromTrajectory(runId, events);
    if (!handle) throw new NotFoundError(`Harness run ${runId}`);
    if (handle.actor.organizationId !== auth.actor.organizationId) {
      throw new NotFoundError(`Harness run ${runId}`);
    }
    return adapter.collect(handle);
  });

  server.get("/api/v1/inbox", async (req) => {
    const auth = getAuth(req);
    const items = await app.harnessHost.pendingItems({
      organizationId: auth.actor.organizationId,
      userId: auth.sessionUser.id,
    });
    return { items };
  });

  server.post("/api/v1/inbox/:id/decide", async (req) => {
    const auth = getAuth(req);
    const { id } = req.params as { id: string };
    const body = z.object({ resolution: z.string().min(1) }).parse(req.body ?? {});
    const result = await app.harnessHost.decide({
      itemId: id,
      organizationId: auth.actor.organizationId,
      userId: auth.sessionUser.id,
      resolution: body.resolution,
    });
    if (!result.resolved) {
      throw new NotFoundError(`Inbox item ${id}`);
    }
    return result;
  });

  // ─── Workflow endpoints (ARCH-5 — persisted via the command/query bus) ──

  server.get("/api/v1/workflows", async (req) => {
    const result = await runQueryAsAuth(app, "core.workflow.list", {}, getAuth(req), req.id);
    return result.data;
  });

  server.post("/api/v1/workflows", async (req, reply) => {
    const input = z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        description: z.string().default(""),
        trigger: z.enum(["manual", "event", "schedule"]).default("manual"),
        triggerConfig: z.record(z.unknown()).default({}),
        steps: z.array(z.unknown()),
        createdBy: z.enum(["user", "ai"]).default("user"),
      })
      .parse(req.body);
    const result = await runCommandAsAuth(app, "core.workflow.create", input, getAuth(req), req.id);
    return result.data;
  });

  server.post("/api/v1/workflows/build", async (req) => {
    const body = z.object({ request: z.string().min(1) }).parse(req.body);
    const result = await buildWorkflow(app, body.request, getAuth(req));
    return result;
  });

  server.get("/api/v1/workflows/:id", async (req) => {
    const { id } = req.params as { id: string };
    const result = await runQueryAsAuth(
      app,
      "core.workflow.get",
      { workflowId: id },
      getAuth(req),
      req.id,
    );
    return result.data;
  });

  server.post("/api/v1/workflows/:id/execute", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        input: z.record(z.unknown()).optional(),
        approvedStepIds: z.array(z.string()).optional(),
        /** Convenience: approve a single pending gate then continue. */
        approveStepId: z.string().optional(),
      })
      .passthrough()
      .parse(req.body ?? {});

    const input = body.input ?? {};
    const approvedStepIds = [
      ...(body.approvedStepIds ?? []),
      ...(body.approveStepId ? [body.approveStepId] : []),
    ];
    return executeWorkflowRun(app, id, input, { approvedStepIds }, getAuth(req));
  });

  server.get("/api/v1/audit", async (req) => {
    // F16 — audit reads go through the permissioned query bus (core.rbac.read),
    // not a direct store call accessible to any authenticated user.
    const result = await runQueryAsAuth(app, "core.audit.list", {}, getAuth(req), req.id);
    return result.data as { items: unknown[] };
  });

  return { server, app };
}
