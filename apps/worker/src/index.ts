/**
 * Outbox / job worker stub.
 * Foundation: logs heartbeat. Later: drain outbox_events, BullMQ, LangGraph runners.
 */
const intervalMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 30_000);

console.log(
  JSON.stringify({
    service: "chaste-worker",
    status: "starting",
    note: "Outbox consumer not yet wired — API uses in-process outbox for demo",
  }),
);

setInterval(() => {
  console.log(
    JSON.stringify({
      service: "chaste-worker",
      status: "heartbeat",
      at: new Date().toISOString(),
    }),
  );
}, intervalMs);
