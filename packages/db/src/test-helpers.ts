import { sql, eq } from "drizzle-orm";
import { users, invWarehouses } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Truncate all test-related tables to ensure a clean slate.
 */
export async function cleanupTestData(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE
      audit_log, outbox_events, org_memories,
      chat_feedback, chat_messages, chat_sessions, ai_explanations,
      notifications, capability_gap_tickets, reminders, follow_ups,
      user_branch_access, branches,
      pending_approvals, ai_wakes, ai_skills, channel_session_bindings,
      crm_customers,
      inv_stock_moves, inv_stock_levels, inv_warehouses, inv_products,
      acc_journal_lines, acc_journal_entries, acc_invoices, acc_accounts,
      hr_payroll_runs, hr_employees,
      pur_purchase_orders, pur_vendors,
      mfg_work_orders, mfg_bom_lines, mfg_boms,
      marketplace_listings, module_installs,
      user_roles, role_permissions, roles,
      users, organizations
      CASCADE`
  );
}

/**
 * Find a user by email in the given organization.
 */
export async function findUserByEmail(
  db: Db,
  orgId: string,
  email: string,
): Promise<typeof users.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.organizationId, orgId))
    .limit(50);
  return rows.find((r) => r.email === email);
}

/**
 * Find a user by ID.
 */
export async function findUserById(
  db: Db,
  userId: string,
): Promise<typeof users.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0];
}

/**
 * Find all users in the given organization.
 */
export async function findUsersByOrg(
  db: Db,
  orgId: string,
): Promise<typeof users.$inferSelect[]> {
  return db
    .select()
    .from(users)
    .where(eq(users.organizationId, orgId));
}

/**
 * Find the first warehouse in the given organization.
 */
export async function findFirstWarehouse(
  db: Db,
  orgId: string,
): Promise<typeof invWarehouses.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(invWarehouses)
    .where(eq(invWarehouses.organizationId, orgId))
    .limit(1);
  return rows[0];
}

/**
 * Find a warehouse by name in the given organization.
 */
export async function findWarehouseByName(
  db: Db,
  orgId: string,
  name: string,
): Promise<typeof invWarehouses.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(invWarehouses)
    .where(eq(invWarehouses.organizationId, orgId))
    .limit(50);
  return rows.find((r) => r.name === name);
}
