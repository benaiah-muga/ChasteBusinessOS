import { FULL_AUTONOMOUS_WARNING, ChasteError, NotFoundError } from "@chaste/kernel";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import {
  createAppContext,
  healthPayload,
  refreshSessionUser,
  runChat,
  runCommand,
  runQuery,
  buildWorkflow,
  executeWorkflowRun,
  type AppContext,
} from "./app-context.js";
import { workflowDefinitionSchema } from "@chaste/ai-core";

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

  await server.register(cors, { origin: true });

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

  server.get("/api/v1/session", async () => {
    await refreshSessionUser(app);
    return {
      userId: app.sessionUser.id,
      organizationId: app.sessionUser.organizationId,
      email: app.sessionUser.email,
      displayName: app.sessionUser.displayName,
      permissions: app.sessionUser.permissions,
      autonomy: app.sessionUser.autonomy,
      orgName: app.sessionUser.orgName,
      region: app.sessionUser.region,
      fullAutonomousWarning: FULL_AUTONOMOUS_WARNING,
      allowFullAutonomous: app.config.allowFullAutonomous,
      aiProvider: app.provider.id,
    };
  });

  server.get("/api/v1/modules", async (req) => {
    const result = await runQuery(app, "core.modules.list", {}, req.id);
    return result.data;
  });

  server.get("/api/v1/commands", async () => ({ items: app.commands.list() }));
  server.get("/api/v1/queries", async () => ({ items: app.queries.list() }));
  server.get("/api/v1/specialists", async () => ({ items: app.modules.specialists() }));

  server.post("/api/v1/commands/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    const body = z.object({ input: z.unknown().default({}) }).parse(req.body ?? {});
    return runCommand(app, name, body.input, req.id);
  });

  server.post("/api/v1/queries/:name", async (req) => {
    const name = (req.params as { name: string }).name;
    const body = z.object({ input: z.unknown().default({}) }).parse(req.body ?? {});
    return runQuery(app, name, body.input, req.id);
  });

  // CRM convenience
  server.get("/api/v1/crm/customers", async (req) => {
    const result = await runQuery(app, "crm.customer.list", {}, req.id);
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
    const result = await runCommand(app, "crm.customer.create", input, req.id);
    return result.data;
  });

  // Domain convenience routes (all still command/query backed)
  server.get("/api/v1/accounting/accounts", async (req) => {
    return (await runQuery(app, "acc.account.list", {}, req.id)).data;
  });
  server.get("/api/v1/accounting/invoices", async (req) => {
    return (await runQuery(app, "acc.invoice.list", {}, req.id)).data;
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
    return (await runCommand(app, "acc.invoice.create", input, req.id)).data;
  });

  server.get("/api/v1/inventory/stock", async (req) => {
    return (await runQuery(app, "inv.stock.list", {}, req.id)).data;
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
    return (await runCommand(app, "inv.product.create", input, req.id)).data;
  });

  server.get("/api/v1/purchasing", async (req) => {
    return (await runQuery(app, "pur.po.list", {}, req.id)).data;
  });
  server.post("/api/v1/purchasing/vendors", async (req) => {
    const input = z.object({ name: z.string(), email: optionalEmailSchema }).parse(req.body);
    return (await runCommand(app, "pur.vendor.create", input, req.id)).data;
  });

  server.get("/api/v1/hr", async (req) => {
    return (await runQuery(app, "hr.overview", {}, req.id)).data;
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
    return (await runCommand(app, "hr.employee.create", input, req.id)).data;
  });
  server.post("/api/v1/hr/payroll", async (req) => {
    const input = z.object({ periodLabel: z.string() }).parse(req.body);
    return (await runCommand(app, "hr.payroll.prepare", input, req.id)).data;
  });

  server.get("/api/v1/manufacturing", async (req) => {
    return (await runQuery(app, "mfg.overview", {}, req.id)).data;
  });

  server.get("/api/v1/rbac", async (req) => {
    return (await runQuery(app, "core.rbac.overview", {}, req.id)).data;
  });

  server.get("/api/v1/marketplace", async (req) => {
    const region = (req.query as { region?: string }).region;
    return (await runQuery(app, "core.marketplace.list", { region }, req.id)).data;
  });

  // Multi-branch (platform spec §4)
  server.get("/api/v1/branches", async (req) => {
    return (await runQuery(app, "core.branch.list", {}, req.id)).data;
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
    return (await runCommand(app, "core.branch.create", input, req.id)).data;
  });
  server.post("/api/v1/branches/switch", async (req) => {
    const input = z.object({ branchId: z.string().uuid() }).parse(req.body);
    return (await runCommand(app, "core.branch.set_active", input, req.id)).data;
  });

  // Notifications (spec: scheduling-and-comms §4)
  server.get("/api/v1/notifications", async (req) => {
    const unreadOnly = (req.query as { unreadOnly?: string }).unreadOnly === "true";
    return (await runQuery(app, "core.notification.list", { unreadOnly }, req.id)).data;
  });
  server.post("/api/v1/notifications/:id/read", async (req) => {
    const { id } = req.params as { id: string };
    return (await runCommand(app, "core.notification.mark_read", { notificationId: id }, req.id)).data;
  });
  server.post("/api/v1/notifications/read-all", async (req) => {
    return (await runCommand(app, "core.notification.mark_all_read", {}, req.id)).data;
  });

  // Reminders & follow-ups (spec: scheduling-and-comms §2/§3)
  server.get("/api/v1/reminders", async (req) => {
    const { status } = req.query as { status?: string };
    return (await runQuery(app, "core.reminder.list", { status }, req.id)).data;
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
    return (await runCommand(app, "core.reminder.set", input, req.id)).data;
  });
  server.post("/api/v1/reminders/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (await runCommand(app, "core.reminder.cancel", { reminderId: id }, req.id)).data;
  });

  server.get("/api/v1/followups", async (req) => {
    const { status } = req.query as { status?: string };
    return (await runQuery(app, "core.followup.list", { status }, req.id)).data;
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
    return (await runCommand(app, "core.followup.create", input, req.id)).data;
  });
  server.post("/api/v1/followups/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (await runCommand(app, "core.followup.cancel", { followUpId: id }, req.id)).data;
  });

  // Calendar (spec: scheduling-and-comms §2.1)
  server.get("/api/v1/calendar", async (req) => {
    const { from, to, branchId } = req.query as { from?: string; to?: string; branchId?: string };
    return (await runQuery(app, "core.calendar.list", { from, to, branchId }, req.id)).data;
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
    return (await runCommand(app, "core.calendar.event.create", input, req.id)).data;
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
    return (await runCommand(app, "core.calendar.event.update", { eventId: id, ...body }, req.id)).data;
  });
  server.post("/api/v1/calendar/events/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (await runCommand(app, "core.calendar.event.cancel", { eventId: id }, req.id)).data;
  });

  server.post("/api/v1/autonomy", async (req) => {
    const input = z
      .object({
        autonomy: z.enum(["recommend", "confirm", "guarded_auto", "full_autonomous"]),
        acknowledgeFullAutonomous: z.boolean().optional(),
      })
      .parse(req.body);
    const result = await runCommand(app, "core.autonomy.set", input, req.id);
    await refreshSessionUser(app);
    return result.data;
  });

  // ─── Settings & Preferences ──────────────────────────────────────────

  server.get("/api/v1/settings", async (req) => {
    const result = await runQuery(app, "core.settings.get", {}, req.id);
    return result.data;
  });

  server.put("/api/v1/settings", async (req) => {
    const input = z.object({ settings: z.record(z.unknown()) }).parse(req.body);
    const result = await runCommand(app, "core.settings.update", input, req.id);
    return result.data;
  });

  server.get("/api/v1/preferences", async (req) => {
    const result = await runQuery(app, "core.preferences.get", {}, req.id);
    return result.data;
  });

  server.put("/api/v1/preferences", async (req) => {
    const input = z.object({ preferences: z.record(z.unknown()) }).parse(req.body);
    const result = await runCommand(app, "core.preferences.update", input, req.id);
    return result.data;
  });

  server.post("/api/v1/ai/chat", async (req) => {
    const body = z
      .object({
        sessionId: z.string().optional(),
        message: z.string().optional(),
        confirmId: z.string().optional(),
        cancelId: z.string().optional(),
      })
      .parse(req.body ?? {});
    return runChat(app, body);
  });

  // ─── Workflow endpoints ──────────────────────────────────────────────

  server.get("/api/v1/workflows", async () => {
    const items = Array.from(app.workflows.values()).map((wf) => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      trigger: wf.trigger,
      createdBy: wf.createdBy,
      stepCount: wf.steps.length,
    }));
    return { items };
  });

  server.post("/api/v1/workflows", async (req) => {
    const input = workflowDefinitionSchema.parse(req.body);
    app.workflows.set(input.id, input);
    return input;
  });

  server.post("/api/v1/workflows/build", async (req) => {
    const body = z.object({ request: z.string().min(1) }).parse(req.body);
    const result = await buildWorkflow(app, body.request);
    return result;
  });

  server.get("/api/v1/workflows/:id", async (req) => {
    const { id } = req.params as { id: string };
    const wf = app.workflows.get(id);
    if (!wf) {
      throw new NotFoundError("Workflow");
    }
    return wf;
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
    return executeWorkflowRun(app, id, input, { approvedStepIds });
  });

  server.get("/api/v1/audit", async () => {
    const items = await app.audit.list(app.sessionUser.organizationId, 100);
    return {
      items: items.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        action: e.action,
        success: e.success,
        actorKind: e.actorKind,
        errorCode: e.errorCode,
      })),
    };
  });

  return { server, app };
}
