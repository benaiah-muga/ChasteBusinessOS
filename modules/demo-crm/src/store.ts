export interface CustomerRecord {
  id: string;
  organizationId: string;
  name: string;
  email?: string | null;
  city?: string | null;
  createdAt: string;
}

export interface CustomerStore {
  create(input: Omit<CustomerRecord, "id" | "createdAt"> & { id?: string }): Promise<CustomerRecord>;
  list(organizationId: string): Promise<CustomerRecord[]>;
}

export class InMemoryCustomerStore implements CustomerStore {
  private rows: CustomerRecord[] = [];

  async create(
    input: Omit<CustomerRecord, "id" | "createdAt"> & { id?: string },
  ): Promise<CustomerRecord> {
    const row: CustomerRecord = {
      id: input.id ?? crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      email: input.email ?? null,
      city: input.city ?? null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async list(organizationId: string): Promise<CustomerRecord[]> {
    return this.rows
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
