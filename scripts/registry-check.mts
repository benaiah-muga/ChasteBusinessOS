process.env.DATABASE_URL ??= "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
import { getDb } from "@chaste/db";
import { CapabilityRegistry } from "@chaste/kernel";
import { registerAccountingCapabilities } from "@chaste/module-accounting";
import { registerCrmCapabilities } from "@chaste/module-crm";
import { registerMessagingCapabilities } from "@chaste/module-messaging";
import { registerPurchasingCapabilities } from "@chaste/module-purchasing";
import { registerPosCapabilities } from "@chaste/module-pos";
import { registerIamCapabilities } from "@chaste/module-iam";
import { registerInventoryCapabilities } from "@chaste/module-inventory";
import { registerCreatorCapabilities } from "@chaste/module-creator";
import { registerDocumentCapabilities } from "@chaste/module-documents";
import { registerHrCapabilities } from "@chaste/module-hr";
import { registerSupportCapabilities } from "@chaste/module-support";

const db = getDb().db;
const registry = new CapabilityRegistry();
registerCrmCapabilities(registry, { db });
registerAccountingCapabilities(registry, { db });
registerMessagingCapabilities(registry, { db });
registerPurchasingCapabilities(registry, { db });
registerPosCapabilities(registry, { db });
registerIamCapabilities(registry, { db });
registerInventoryCapabilities(registry, { db });
registerCreatorCapabilities(registry, { db });
registerDocumentCapabilities(registry, { db });
registerHrCapabilities(registry, { db });
registerSupportCapabilities(registry, { db });
for (const i of registry.validateAll()) {
  if (i.level === "error") console.error(i.level, i.capabilityId, i.rule, i.message);
}
process.exit(0);
