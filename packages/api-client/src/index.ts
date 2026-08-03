import { chatMessageSchema, type ChatMessage, type UiPart } from "@chaste/ui-schema";
import { z } from "zod";

export { chatMessageSchema };
export type { ChatMessage, UiPart };

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
  config: z.unknown().optional(),
});

export const commandResultSchema = z.object({
  ok: z.literal(true),
  command: z.string(),
  requestId: z.string(),
  data: z.unknown(),
});

export const queryResultSchema = z.object({
  ok: z.literal(true),
  query: z.string(),
  requestId: z.string(),
  data: z.unknown(),
});

export const customerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  email: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  status: z.string().optional(),
  createdAt: z.string(),
});

export type Customer = z.infer<typeof customerSchema>;

export const customerListSchema = z.object({
  items: z.array(customerSchema),
});

export type CatalogItem = {
  id: string;
  moduleId: string;
  capabilityId: string;
  name: string;
  description: string;
  keywords: string[];
  implemented: boolean;
};export const sessionSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  email: z.string(),
  displayName: z.string(),
  permissions: z.array(z.string()),
  autonomy: z.enum(["recommend", "confirm", "guarded_auto", "full_autonomous"]),
  orgName: z.string().optional(),
  region: z.string().optional(),
  fullAutonomousWarning: z.string().optional(),
  allowFullAutonomous: z.boolean().optional(),
  aiProvider: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

export const chatResponseSchema = z.object({
  sessionId: z.string(),
  messages: z.array(chatMessageSchema),
  pendingConfirmationId: z.string().optional(),
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ChasteApiClientOptions {
  baseUrl: string;
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

export function createChasteApiClient(options: ChasteApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit,
    parse: (data: unknown) => T,
  ): Promise<T> {
    const extra = options.getHeaders ? await options.getHeaders() : {};
    const res = await fetchImpl(new URL(path, options.baseUrl).toString(), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...extra,
        ...(init.headers ?? {}),
      },
    });

    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as { message?: string; code?: string; details?: unknown };
      throw new ApiError(err.message ?? res.statusText, res.status, err.code, err.details);
    }
    return parse(body);
  }

  return {
    health() {
      return request("/health", { method: "GET" }, (d) => healthResponseSchema.parse(d));
    },
    session() {
      return request("/api/v1/session", { method: "GET" }, (d) => sessionSchema.parse(d));
    },
    listModules() {
      return request("/api/v1/modules", { method: "GET" }, (d) => d as {
        registered: { id: string; name: string; version: string }[];
        installed: { moduleId: string; version: string; enabled: boolean }[];
      });
    },
    executeCommand(name: string, input: unknown) {
      return request(
        `/api/v1/commands/${encodeURIComponent(name)}`,
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    executeQuery(name: string, input: unknown = {}) {
      return request(
        `/api/v1/queries/${encodeURIComponent(name)}`,
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => queryResultSchema.parse(d),
      );
    },
    listCustomers() {
      return request("/api/v1/crm/customers", { method: "GET" }, (d) =>
        customerListSchema.parse(d),
      );
    },
    createCustomer(input: { name: string; email?: string; city?: string; country?: string }) {
      return request(
        "/api/v1/crm/customers",
        { method: "POST", body: JSON.stringify(input) },
        (d) => customerSchema.parse(d),
      );
    },
    listAccounts() {
      return request("/api/v1/accounting/accounts", { method: "GET" }, (d) => d as {
        items: { id: string; code: string; name: string; type: string; isActive: boolean }[];
      });
    },
    listInvoices() {
      return request("/api/v1/accounting/invoices", { method: "GET" }, (d) => d as {
        items: {
          id: string;
          number: string;
          status: string;
          currency: string;
          total: string;
          customerId?: string;
          createdAt: string;
        }[];
      });
    },
    createInvoice(input: { number: string; total: number; currency?: string; customerId?: string }) {
      return request(
        "/api/v1/accounting/invoices",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { id: string; number: string; status: string; currency: string; total: string },
      );
    },
    postJournal(input: {
      reference: string;
      memo?: string;
      lines: { accountId: string; debit: number; credit: number }[];
    }) {
      return request(
        "/api/v1/commands/acc.journal.post",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    listInventory() {
      return request("/api/v1/inventory/stock", { method: "GET" }, (d) => d as {
        warehouses: { id: string; code: string; name: string; city?: string }[];
        products: { id: string; sku: string; name: string; uom: string; reorderLevel: number }[];
        levels: { warehouseId: string; productId: string; quantity: number }[];
      });
    },
    createProduct(input: { sku: string; name: string; uom?: string; reorderLevel?: number }) {
      return request(
        "/api/v1/inventory/products",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { id: string; sku: string; name: string },
      );
    },
    createWarehouse(input: { code: string; name: string; city?: string }) {
      return request(
        "/api/v1/commands/inv.warehouse.create",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    adjustStock(input: {
      warehouseId: string;
      productId: string;
      quantityDelta: number;
      reason: string;
      reference?: string;
    }) {
      return request(
        "/api/v1/commands/inv.stock.adjust",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    listPurchasing() {
      return request("/api/v1/purchasing", { method: "GET" }, (d) => d as {
        vendors: { id: string; name: string; email?: string }[];
        orders: {
          id: string;
          vendorId?: string;
          number: string;
          status: string;
          total: string;
          currency?: string;
        }[];
      });
    },
    createVendor(input: { name: string; email?: string }) {
      return request(
        "/api/v1/purchasing/vendors",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { id: string; name: string },
      );
    },
    createPurchaseOrder(input: { vendorId: string; number: string; total?: number }) {
      return request(
        "/api/v1/commands/pur.po.create",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    listHr() {
      return request("/api/v1/hr", { method: "GET" }, (d) => d as {
        employees: {
          id?: string;
          employeeNumber: string;
          fullName: string;
          email?: string;
          department?: string;
          jobTitle?: string;
          baseSalary: string;
          isActive?: boolean;
        }[];
        payrollRuns: {
          id: string;
          periodLabel: string;
          status: string;
          totalGross: string;
          employeeCount: number;
        }[];
      });
    },
    createEmployee(input: {
      employeeNumber: string;
      fullName: string;
      email?: string;
      department?: string;
      jobTitle?: string;
      baseSalary: number;
    }) {
      return request(
        "/api/v1/hr/employees",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { id: string; employeeNumber: string; fullName: string; baseSalary: string },
      );
    },
    preparePayroll(input: { periodLabel: string }) {
      return request(
        "/api/v1/hr/payroll",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { id: string; periodLabel: string; status: string; totalGross: string; employeeCount: number },
      );
    },
    listManufacturing() {
      return request("/api/v1/manufacturing", { method: "GET" }, (d) => d as {
        boms: {
          id: string;
          productId?: string;
          name: string;
          quantity?: number;
        }[];
        workOrders: { id: string; number: string; status: string; quantity: number }[];
      });
    },
    createBom(input: {
      productId: string;
      name: string;
      quantity?: number;
      components: { componentProductId: string; quantity: number }[];
    }) {
      return request(
        "/api/v1/commands/mfg.bom.create",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    createWorkOrder(input: { bomId: string; number: string; quantity?: number }) {
      return request(
        "/api/v1/commands/mfg.wo.create",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    getRbacOverview() {
      return request("/api/v1/rbac", { method: "GET" }, (d) => d as {
        roles: {
          id?: string;
          key: string;
          name: string;
          description?: string;
          permissions: string[];
          isSystem?: boolean;
        }[];
        users: {
          id?: string;
          email: string;
          displayName: string;
          isActive: boolean;
          roleKeys: string[];
          createdAt?: string;
        }[];
        permissionCatalog: { permission: string; module: string; description: string }[];
      });
    },
    getMarketplace() {
      return request("/api/v1/marketplace", { method: "GET" }, (d) =>
        d as {
          items: {
            moduleId: string;
            name: string;
            version: string;
            summary: string;
            category: string;
            publisher: string;
            regions: string[];
            kind: "builtin" | "custom";
            archived: boolean;
            installed: boolean;
            enabled: boolean;
          }[];
          platformRegions: string[];
        },
      );
    },
    installModule(input: { moduleId: string; version?: string }) {
      return request(
        "/api/v1/commands/core.module.install",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    uninstallModule(input: { moduleId: string }) {
      return request(
        "/api/v1/commands/core.module.uninstall",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    setModuleEnabled(input: { moduleId: string; enabled: boolean }) {
      return request(
        "/api/v1/commands/core.module.set_enabled",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    archiveMarketplaceListing(input: { moduleId: string; archived: boolean }) {
      return request(
        "/api/v1/commands/core.marketplace.archive",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    listWorkflowsFull() {
      return request("/api/v1/workflows", { method: "GET" }, (d) => d as {
        items: {
          id: string;
          name: string;
          description: string;
          trigger: unknown;
          createdBy: string;
          stepCount: number;
        }[];
      });
    },
    getWorkflow(id: string) {
      return request(`/api/v1/workflows/${encodeURIComponent(id)}`, { method: "GET" }, (d) => d as {
        id: string;
        name: string;
        description: string;
        trigger: string;
        steps: unknown[];
      });
    },
    buildWorkflowFromText(textRequest: string) {
      return request(
        "/api/v1/workflows/build",
        { method: "POST", body: JSON.stringify({ request: textRequest }) },
        (d) =>
          d as {
            workflow?: { id: string; name: string; description: string; steps: unknown[] };
            error?: string;
            id?: string;
            name?: string;
            description?: string;
            steps?: unknown[];
          },
      );
    },
    saveWorkflow(def: Record<string, unknown>) {
      return request(
        "/api/v1/workflows",
        { method: "POST", body: JSON.stringify(def) },
        (d) => d as { id: string },
      );
    },
    runWorkflow(
      id: string,
      input: Record<string, unknown> = {},
      options: { approvedStepIds?: string[]; approveStepId?: string } = {},
    ) {
      return request(
        `/api/v1/workflows/${encodeURIComponent(id)}/execute`,
        {
          method: "POST",
          body: JSON.stringify({
            input,
            approvedStepIds: options.approvedStepIds,
            approveStepId: options.approveStepId,
          }),
        },
        (d) =>
          d as {
            success?: boolean;
            runId?: string;
            status?: string;
            stepResults?: { stepId: string; status: string; error?: string; output?: unknown }[];
            steps?: unknown[];
            error?: string;
            pendingApproval?: { stepId: string; description?: string; approveBy?: string };
            output?: Record<string, unknown>;
          },
      );
    },
    chat(body: {
      sessionId?: string;
      message?: string;
      confirmId?: string;
      cancelId?: string;
    }) {
      return request(
        "/api/v1/ai/chat",
        { method: "POST", body: JSON.stringify(body) },
        (d) => chatResponseSchema.parse(d),
      );
    },
    setAutonomy(body: {
      autonomy: "recommend" | "confirm" | "guarded_auto" | "full_autonomous";
      acknowledgeFullAutonomous?: boolean;
    }) {
      return request("/api/v1/autonomy", { method: "POST", body: JSON.stringify(body) }, (d) => d);
    },
    getSettings() {
      return request("/api/v1/settings", { method: "GET" }, (d) => d as Record<string, unknown>);
    },
    updateSettings(settings: Record<string, unknown>) {
      return request(
        "/api/v1/settings",
        { method: "PUT", body: JSON.stringify({ settings }) },
        (d) => d as Record<string, unknown>,
      );
    },
    getPreferences() {
      return request("/api/v1/preferences", { method: "GET" }, (d) => d as Record<string, unknown>);
    },
    updatePreferences(preferences: Record<string, unknown>) {
      return request(
        "/api/v1/preferences",
        { method: "PUT", body: JSON.stringify({ preferences }) },
        (d) => d as Record<string, unknown>,
      );
    },
    listAudit() {
      return request("/api/v1/audit", { method: "GET" }, (d) => d as {
        items: {
          id: string;
          at: string;
          action: string;
          success: boolean;
          actorKind: string;
          errorCode?: string;
        }[];
      });
    },
    listWorkflows() {
      return request("/api/v1/workflows", { method: "GET" }, (d) => d as {
        items: {
          id: string;
          name: string;
          description: string;
          trigger: unknown;
          createdBy: string;
          stepCount: number;
        }[];
      });
    },
    listBranches() {
      return request("/api/v1/branches", { method: "GET" }, (d) => d as {
        branches: {
          id: string;
          name: string;
          code: string;
          timezone: string | null;
          active: boolean;
          isActiveBranch: boolean;
          grantType: "all" | "explicit";
        }[];
      });
    },
    createBranch(input: { name: string; code: string; timezone?: string; parentBranchId?: string }) {
      return request(
        "/api/v1/branches",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { id: string; name: string; code: string },
      );
    },
    setActiveBranch(input: { branchId: string }) {
      return request(
        "/api/v1/branches/switch",
        { method: "POST", body: JSON.stringify(input) },
        (d) => d as { activeBranchId: string },
      );
    },
    listNotifications(unreadOnly = false) {
      return request(
        `/api/v1/notifications${unreadOnly ? "?unreadOnly=true" : ""}`,
        { method: "GET" },
        (d) => d as {
          notifications: {
            id: string;
            kind: string;
            title: string;
            body: string | null;
            href: string | null;
            resourceType: string | null;
            resourceId: string | null;
            read: boolean;
            createdAt: string;
          }[];
        },
      );
    },
    markNotificationRead(notificationId: string) {
      return request(
        `/api/v1/notifications/${encodeURIComponent(notificationId)}/read`,
        { method: "POST" },
        (d) => d as { ok: boolean },
      );
    },
    markAllNotificationsRead() {
      return request(
        "/api/v1/notifications/read-all",
        { method: "POST" },
        (d) => d as { ok: boolean },
      );
    },
    listReminders(status?: string) {
      return request(
        `/api/v1/reminders${status ? `?status=${status}` : ""}`,
        { method: "GET" },
        (d) => d as any,
      );
    },
    createReminder(input: {
      title: string;
      body?: string;
      fireAt: string;
      channel?: "in_app" | "email" | "both";
      branchId?: string;
    }) {
      return request("/api/v1/reminders", { method: "POST", body: JSON.stringify(input) }, (d) => d as any);
    },
    cancelReminder(reminderId: string) {
      return request(
        `/api/v1/reminders/${encodeURIComponent(reminderId)}/cancel`,
        { method: "POST" },
        (d) => d as { cancelled: boolean },
      );
    },
    listCalendarEvents(input: { from?: string; to?: string; branchId?: string } = {}) {
      const qs = new URLSearchParams(
        Object.entries(input).filter(([, v]) => v !== undefined) as [string, string][],
      ).toString();
      return request(
        `/api/v1/calendar${qs ? `?${qs}` : ""}`,
        { method: "GET" },
        (d) => d as any,
      );
    },
    createCalendarEvent(input: {
      title: string;
      startsAt: string;
      endsAt: string;
      timezone?: string;
      description?: string;
      branchId?: string;
      attendees?: string[];
    }) {
      return request("/api/v1/calendar/events", { method: "POST", body: JSON.stringify(input) }, (d) => d as any);
    },
    cancelCalendarEvent(eventId: string) {
      return request(
        `/api/v1/calendar/events/${encodeURIComponent(eventId)}/cancel`,
        { method: "POST" },
        (d) => d as { cancelled: boolean },
      );
    },
    listCapabilityGaps(status?: string) {
      return request(
        "/api/v1/queries/core.capability.gap.list",
        { method: "POST", body: JSON.stringify({ input: status ? { status } : {} }) },
        (d) => d as {
          tickets: {
            id: string;
            organizationId: string;
            status: string;
            proposedCapabilityId: string;
            title: string;
            abstractRequirement: string;
            suggestedModuleId: string | null;
            deploymentTarget: string;
            codingAgent: string | null;
            artifactRef: string | null;
            createdAt: string;
          }[];
        },
      );
    },
    createCapabilityGap(input: {
      proposedCapabilityId: string;
      title: string;
      abstractRequirement: string;
      acceptanceCriteria?: string[];
      exampleScenarios?: string[];
      nonGoals?: string[];
      deploymentTarget?: string;
    }) {
      return request(
        "/api/v1/commands/core.capability.gap.create",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    confirmCapabilityGap(input: { ticketId: string; suggestedModuleId?: string; deploymentTarget?: string }) {
      return request(
        "/api/v1/commands/core.capability.gap.confirm",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => commandResultSchema.parse(d),
      );
    },
    listCapabilityCatalog(moduleId?: string) {
      return request(
        "/api/v1/queries/core.capability.catalog.list",
        { method: "POST", body: JSON.stringify({ input: moduleId ? { moduleId } : {} }) },
        (d) => d as { items: CatalogItem[] },
      );
    },
    searchCapabilityCatalog(input: { query: string; moduleId?: string }) {
      return request(
        "/api/v1/queries/core.capability.catalog.search",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) => d as { items: CatalogItem[] },
      );
    },
    recommendCapability(input: {
      abstractRequirement: string;
      acceptanceCriteria?: string[];
      exampleScenarios?: string[];
      suggestedModuleId?: string;
    }) {
      return request(
        "/api/v1/queries/core.capability.gap.recommend",
        { method: "POST", body: JSON.stringify({ input }) },
        (d) =>
          d as {
            deploymentTarget: string;
            suggestedModuleId: string | null;
            rationale: string[];
            signals: string[];
          },
      );
    },
  };
}

export type ChasteApiClient = ReturnType<typeof createChasteApiClient>;
