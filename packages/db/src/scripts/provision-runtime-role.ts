import {
  ensureAppRole,
  ensureJobsWorkerRole,
  ensureOutboxWorkerRole,
} from "../roles";

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL or DATABASE_URL is required to provision the runtime role",
  );
}

const role = await ensureAppRole({ databaseUrl });
const outboxRole = await ensureOutboxWorkerRole({ databaseUrl });
const jobsRole = await ensureJobsWorkerRole({ databaseUrl });
console.info(`least-privilege runtime role ready: ${role.roleName}`);
console.info(`webhook outbox worker role ready: ${outboxRole.roleName}`);
console.info(`Go capability jobs worker role ready: ${jobsRole.roleName}`);
