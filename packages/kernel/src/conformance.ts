import type { Capability } from "./capability";

export interface ConformanceIssue {
  capabilityId: string;
  level: "error" | "warning";
  rule: string;
  message: string;
}

const ID_PATTERN = /^[a-z][a-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

/**
 * Structural contract every capability must satisfy before it may register.
 * Ecosystems die from silent non-activation (see dsh's plugin audit), we
 * validate at boot and in CI instead of discovering gaps at runtime.
 *
 * Errors reject registration. Warnings surface but do not block, so teams
 * can ship with tracked debt instead of lying metadata.
 */
export function assertWellFormedCapability(cap: Capability): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ capabilityId: cap.id, level: "error", rule, message });
  const warn = (rule: string, message: string) => issues.push({ capabilityId: cap.id, level: "warning", rule, message });

  if (!ID_PATTERN.test(cap.id)) {
    err("id-format", `id "${cap.id}" must be "module.action" (lowercase module, no dots inside parts)`);
  }
  if (!cap.module || !/^[a-z][a-z0-9-]*$/.test(cap.module)) {
    err("module-name", `module "${cap.module}" must be lowercase-kebab`);
  }
  if (!cap.id.startsWith(`${cap.module}.`)) {
    err("id-module-mismatch", `id "${cap.id}" must start with its module prefix "${cap.module}."`);
  }
  if (!cap.title.trim()) err("title-required", "title must not be empty");
  if (cap.intent.trim().length < 20) {
    err("intent-too-short", "intent must be at least 20 chars, it is embedded for agent retrieval");
  }
  if (!cap.permission.trim()) err("permission-required", "permission reference must not be empty");

  // Temporal composability: state changes must be undoable or explicitly warned.
  const stateChanging = cap.risk === "write" || cap.risk === "money" || cap.risk === "destructive";
  if (stateChanging && !cap.inverse) {
    warn(
      "inverse-recommended",
      `${cap.risk}-class capabilities should declare an inverse so actions remain reversible`,
    );
  }
  if (cap.inverse) {
    if (!ID_PATTERN.test(cap.inverse.capabilityId)) {
      err("inverse-format", `inverse capabilityId "${cap.inverse.capabilityId}" is not a valid capability id`);
    }
    if (cap.inverse.capabilityId === cap.id) {
      err("inverse-self", "a capability cannot be its own inverse");
    }
  }

  // Money gating must be declared, not inferred from field names: a missing
  // extractor would silently disable amount thresholds for agents.
  if (cap.risk === "money" && !cap.moneyAmount) {
    err(
      "money-amount-required",
      'risk "money" capabilities must declare moneyAmount(input); return null when the amount is unknowable up front',
    );
  }

  return issues;
}
