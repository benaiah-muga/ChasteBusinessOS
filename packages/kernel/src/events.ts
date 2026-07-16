export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  organizationId: string;
  occurredAt: string;
  payload: T;
  correlationId?: string;
  causationId?: string;
}

export interface OutboxWriter {
  enqueue(event: DomainEvent): Promise<void>;
}

export class InMemoryOutboxWriter implements OutboxWriter {
  readonly events: DomainEvent[] = [];

  async enqueue(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }
}
