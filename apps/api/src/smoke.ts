import { buildServer } from "./server.js";

async function main() {
  const { server, app } = await buildServer();
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`).then((r) => r.json());
  const created = (await fetch(`${base}/api/v1/crm/customers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme", city: "Nairobi" }),
  }).then((r) => r.json())) as { name: string };

  const chat = (await fetch(`${base}/api/v1/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Create customer Beta Co in Kisumu" }),
  }).then((r) => r.json())) as { sessionId: string; pendingConfirmationId?: string };

  await fetch(`${base}/api/v1/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: chat.sessionId, confirmId: chat.pendingConfirmationId }),
  });

  const list = (await fetch(`${base}/api/v1/crm/customers`).then((r) => r.json())) as {
    items: { name: string }[];
  };

  console.log(
    JSON.stringify(
      {
        health,
        created: created.name,
        pending: Boolean(chat.pendingConfirmationId),
        customers: list.items.map((i) => i.name),
        audit: app.audit.entries.length,
      },
      null,
      2,
    ),
  );

  await server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
