/**
 * Outbox event processor — routes domain events to registered handlers.
 * Each module can register handlers for the event types it cares about.
 * Handlers are idempotent — they may be called more than once for the same event.
 */
import type { DomainEvent } from "./events.js";

export type EventHandler = (event: DomainEvent) => Promise<void>;

export class OutboxProcessor {
  private handlers = new Map<string, EventHandler[]>();

  /**
   * Register a handler for an event type.
   * Multiple handlers per event type are supported (fan-out).
   */
  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Register a handler for multiple event types at once.
   */
  onMany(eventTypes: string[], handler: EventHandler): void {
    for (const type of eventTypes) {
      this.on(type, handler);
    }
  }

  /**
   * Process a single event by routing to registered handlers.
   * Unhandled event types are silently skipped (no error).
   * Handler errors are thrown after all handlers for the event run.
   */
  async process(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    const errors: Error[] = [];

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Handler errors for event ${event.type}: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  /**
   * List all registered event types (for diagnostics).
   */
  registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Check if a handler is registered for an event type.
   */
  hasHandler(eventType: string): boolean {
    const handlers = this.handlers.get(eventType);
    return handlers !== undefined && handlers.length > 0;
  }
}

/**
 * Default event handlers — built-in reactions to domain events.
 * These are pure functions that take an event and return structured log data.
 * The actual side effects (notifications, webhooks) are plugged in at the worker level.
 */
export const builtinHandlers: Record<string, EventHandler> = {
  "crm.customer.created": async (event) => {
    const p = event.payload as { customerId: string; name: string };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "crm.customer.created",
        customerId: p.customerId,
        name: p.name,
        orgId: event.organizationId,
      }),
    );
  },

  "inv.stock.adjusted": async (event) => {
    const p = event.payload as {
      warehouseId: string;
      productId: string;
      quantity: number;
      delta: number;
    };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "inv.stock.adjusted",
        warehouseId: p.warehouseId,
        productId: p.productId,
        delta: p.delta,
        newQuantity: p.quantity,
        orgId: event.organizationId,
      }),
    );
  },

  "pur.po.created": async (event) => {
    const p = event.payload as { poId: string; number: string };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "pur.po.created",
        poId: p.poId,
        number: p.number,
        orgId: event.organizationId,
      }),
    );
  },

  "hr.payroll.prepared": async (event) => {
    const p = event.payload as {
      payrollRunId: string;
      periodLabel: string;
      employeeCount: number;
    };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "hr.payroll.prepared",
        payrollRunId: p.payrollRunId,
        periodLabel: p.periodLabel,
        employeeCount: p.employeeCount,
        orgId: event.organizationId,
      }),
    );
  },

  "mfg.wo.created": async (event) => {
    const p = event.payload as { workOrderId: string; number: string };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "mfg.wo.created",
        workOrderId: p.workOrderId,
        number: p.number,
        orgId: event.organizationId,
      }),
    );
  },

  "acc.journal.posted": async (event) => {
    const p = event.payload as { entryId: string; reference: string };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "acc.journal.posted",
        entryId: p.entryId,
        reference: p.reference,
        orgId: event.organizationId,
      }),
    );
  },

  "acc.invoice.created": async (event) => {
    const p = event.payload as { invoiceId: string; number: string };
    console.log(
      JSON.stringify({
        service: "chaste-worker",
        handler: "acc.invoice.created",
        invoiceId: p.invoiceId,
        number: p.number,
        orgId: event.organizationId,
      }),
    );
  },
};

/**
 * Create a processor pre-loaded with all built-in event handlers.
 */
export function createDefaultProcessor(): OutboxProcessor {
  const processor = new OutboxProcessor();
  for (const [type, handler] of Object.entries(builtinHandlers)) {
    processor.on(type, handler);
  }
  return processor;
}
