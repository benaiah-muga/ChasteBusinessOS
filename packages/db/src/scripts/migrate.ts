import { runMigrations } from "../migrate";

const result = await runMigrations();
console.log("migrations applied");
if (result.backupSkippedReason) console.warn(`warning: ${result.backupSkippedReason}`);
