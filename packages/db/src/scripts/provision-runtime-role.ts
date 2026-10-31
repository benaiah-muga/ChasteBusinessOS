import {
  ensureAppRole,
  ensureJobsWorkerRole,
  ensureMarketingEmailWorkerRole,
  ensureNotificationEmailWorkerRole,
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
const marketingEmailWorkerRole = await ensureMarketingEmailWorkerRole({ databaseUrl });
const notificationEmailWorkerRole = await ensureNotificationEmailWorkerRole({ databaseUrl });
const jobsRole = await ensureJobsWorkerRole({ databaseUrl });
console.info(`least-privilege runtime role ready: ${role.roleName}`);
console.info(`webhook outbox worker role ready: ${outboxRole.roleName}`);
console.info(`marketing email outbox worker role ready: ${marketingEmailWorkerRole.roleName}`);
console.info(`notification email outbox worker role ready: ${notificationEmailWorkerRole.roleName}`);
console.info(`Go capability jobs worker role ready: ${jobsRole.roleName}`);
