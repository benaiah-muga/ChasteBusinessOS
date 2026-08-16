/**
 * Postgres-backed `ApprovalGrantStore` over the `approval_grants` table.
 *
 * ADR 0014 tranche 3 — the durable counterpart to `InMemoryApprovalGrantStore`.
 * A grant survives process restarts and is shared across hosts (API + worker),
 * so an approval minted while a session is served by one process still
 * authorizes the envelope on another.
 */
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import {
  grantCovers,
  type ApprovalGrantRecord,
  type ApprovalGrantStatus,
  type ApprovalGrantStore,
  type CreateApprovalGrantInput,
  type EvidenceRef,
  type GrantCheck,
  type GrantCheckRequest,
} from "@chaste/kernel";
const { approvalGrants } = schema;

export class PostgresApprovalGrantStore implements ApprovalGrantStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateApprovalGrantInput): Promise<ApprovalGrantRecord> {
    const id = input.id ?? crypto.randomUUID();
    await this.db.insert(approvalGrants).values({
      id,
      organizationId: input.organizationId,
      grantedBy: input.grantedBy,
      grantedToUserId: input.grantedToUserId,
      grantedAt: input.grantedAt ? new Date(input.grantedAt) : new Date(),
      scopeCommandType: input.scope.commandType ?? null,
      scopeResourceType: input.scope.resourceType ?? null,
      scopeResourceId: input.scope.resourceId ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      conditions: input.conditions ?? [],
      policyBasis: input.policyBasis ?? null,
      evidenceShown: (input.evidenceShown ?? []) as unknown[],
      status: "active",
    });
    const row = await this.get(id);
    if (!row) throw new Error("Approval grant was not persisted");
    return row;
  }

  async get(id: string): Promise<ApprovalGrantRecord | undefined> {
    const rows = await this.db
      .select()
      .from(approvalGrants)
      .where(eq(approvalGrants.id, id))
      .limit(1);
    const row = rows[0];
    return row ? this.mapRow(row) : undefined;
  }

  async check(opts: GrantCheckRequest): Promise<GrantCheck> {
    const rows = await this.db
      .select()
      .from(approvalGrants)
      .where(
        and(
          eq(approvalGrants.organizationId, opts.organizationId),
          eq(approvalGrants.grantedToUserId, opts.userId),
          eq(approvalGrants.status, "active"),
        ),
      );
    for (const row of rows) {
      const result = grantCovers(this.mapRow(row), opts);
      if (result.ok) return result;
    }
    return { ok: false, reason: "not_found" };
  }

  async revoke(
    id: string,
    opts: { by: string; reason?: string; now?: () => Date },
  ): Promise<boolean> {
    const rows = await this.db
      .update(approvalGrants)
      .set({
        status: "revoked",
        revokedAt: opts.now?.() ?? new Date(),
        revokedBy: opts.by,
        revokeReason: opts.reason ?? null,
      })
      .where(and(eq(approvalGrants.id, id), eq(approvalGrants.status, "active")))
      .returning({ id: approvalGrants.id });
    return rows.length > 0;
  }

  async list(organizationId: string): Promise<ApprovalGrantRecord[]> {
    const rows = await this.db
      .select()
      .from(approvalGrants)
      .where(eq(approvalGrants.organizationId, organizationId))
      .orderBy(asc(approvalGrants.grantedAt));
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: {
    id: string;
    organizationId: string;
    grantedBy: string;
    grantedToUserId: string;
    grantedAt: Date;
    scopeCommandType: string | null;
    scopeResourceType: string | null;
    scopeResourceId: string | null;
    expiresAt: Date | null;
    conditions: string[];
    policyBasis: string | null;
    evidenceShown: unknown[];
    status: string;
    revokedAt: Date | null;
    revokedBy: string | null;
    revokeReason: string | null;
  }): ApprovalGrantRecord {
    return {
      id: row.id,
      organizationId: row.organizationId,
      grantedBy: row.grantedBy,
      grantedToUserId: row.grantedToUserId,
      grantedAt: row.grantedAt.toISOString(),
      scope: {
        commandType: row.scopeCommandType ?? undefined,
        resourceType: row.scopeResourceType ?? undefined,
        resourceId: row.scopeResourceId ?? undefined,
      },
      expiresAt: row.expiresAt?.toISOString(),
      conditions: row.conditions,
      policyBasis: row.policyBasis ?? undefined,
      evidenceShown: row.evidenceShown as EvidenceRef[],
      status: row.status as ApprovalGrantStatus,
      revokedAt: row.revokedAt?.toISOString(),
      revokedBy: row.revokedBy ?? undefined,
      revokeReason: row.revokeReason ?? undefined,
    };
  }
}