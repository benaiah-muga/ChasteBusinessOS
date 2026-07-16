import { ChasteError } from "@chaste/kernel";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import {
  createAppContext,
  runChat,
  runCommand,
  runQuery,
  type AppContext,
} from "./app-context.js";

export async function buildServer(appCtx?: AppContext) {
  const app = appCtx ?? (await createAppContext());
  const server = Fastify({ logger: true });

  await server.register(cors, {
    origin: true,
  });

  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof ChasteError) {
      return reply.status(err.status).send({
        message: err.message,
        code: err.code,
        details: err.details,
      });
    }
    server.log.error(err);
    return reply.status(500).send({ message: "Internal Server Error", code: "INTERNAL" });
  });

  server.get("/health", async () => ({
    ok: true as const,
    service: "chaste-api",
    version: "0.1.0",
  }));

  server.get("/api/v1/session", async () => ({
    userId: app.demoUser.id,
    organizationId: app.demoUser.organizationId,
    email: app.demoUser.email,
    displayName: app.demoUser.displayName,
    permissions: app.demoUser.permissions,
    autonomy: app.autonomy,
  }));

  server.get("/api/v1/modules", async () => ({
    items: app.modules.list().map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      capabilities: m.capabilities,
      specialist: m.specialist,
    })),
  }));

  server.get("/api/v1/commands", async () => ({
    items: app.commands.list(),
  }));

  server.get("/api/v1/queries", async () => ({
    items: app.queries.list(),
  }));

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

  // Convenience REST for CRM (still command/query underneath)
  server.get("/api/v1/crm/customers", async (req) => {
    const result = await runQuery(app, "crm.customer.list", {}, req.id);
    return result.data;
  });

  server.post("/api/v1/crm/customers", async (req) => {
    const input = z
      .object({
        name: z.string().min(1),
        email: z.string().email().optional(),
        city: z.string().optional(),
      })
      .parse(req.body);
    const result = await runCommand(app, "crm.customer.create", input, req.id);
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

  server.get("/api/v1/audit", async () => ({
    items: app.audit.entries.slice(-100).reverse(),
  }));

  server.get("/api/v1/outbox", async () => ({
    items: app.outbox.events.slice(-100).reverse(),
  }));

  return { server, app };
}
