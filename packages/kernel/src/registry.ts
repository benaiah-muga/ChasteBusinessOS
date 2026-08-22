import type { Actor, Capability } from "./capability";
import { assertWellFormedCapability, type ConformanceIssue } from "./conformance";
import { hasPermission } from "./policy";

export class CapabilityRegistry {
  private readonly map = new Map<string, Capability>();

  register(cap: Capability): void {
    const existing = this.map.get(cap.id);
    if (existing) throw new Error(`capability already registered: ${cap.id}`);
    const issues = assertWellFormedCapability(cap);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
      const detail = errors.map((e) => `[${e.rule}] ${e.message}`).join("; ");
      throw new Error(`capability "${cap.id}" failed conformance: ${detail}`);
    }
    this.map.set(cap.id, cap);
  }

  get(id: string): Capability | undefined {
    return this.map.get(id);
  }

  require(id: string): Capability {
    const cap = this.map.get(id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    return cap;
  }

  all(): Capability[] {
    return [...this.map.values()];
  }

  forActor(actor: Actor): Capability[] {
    return this.all().filter((c) => hasPermission(actor, c.permission));
  }

  /**
   * Cross-capability checks that can only run after all registrations:
   * inverse targets must exist. Warnings (missing inverses etc.) are
   * reported, not thrown — tracked debt beats silent gaps.
   */
  validateAll(): ConformanceIssue[] {
    const issues: ConformanceIssue[] = [];
    for (const cap of this.all()) {
      if (cap.inverse && !this.map.has(cap.inverse.capabilityId)) {
        issues.push({
          capabilityId: cap.id,
          level: "error",
          rule: "inverse-exists",
          message: `inverse "${cap.inverse.capabilityId}" is not registered`,
        });
      }
      const orphanWarnings = assertWellFormedCapability(cap).filter((i) => i.level === "warning");
      issues.push(...orphanWarnings);
    }
    return issues;
  }

  /**
   * Fuzzy-ish lookup used by the agent to find candidate capabilities for an
   * intent. Keyword overlap scoring; embeddings-based retrieval layers on top.
   */
  search(query: string, limit = 8): Capability[] {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    const scored = this.all()
      .map((cap) => {
        const haystack = `${cap.id} ${cap.title} ${cap.intent} ${cap.module}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (haystack.includes(t)) score += 1;
        if (terms.some((t) => cap.id.includes(t))) score += 2;
        return { cap, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.cap);
  }
}
