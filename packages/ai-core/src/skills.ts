/**
 * AI skill catalog — ported & adapted from OpenWorker `coworker/skills/` +
 * `agent.py` skill-loader wiring.
 *
 * Rather than stuff every instruction into the system prompt, the agent sees a
 * **catalog per turn** describing available skills, and calls `loadSkill(name)`
 * to pull a specific skill's full instructions *into the conversation* only
 * when needed. Applied patterns from OpenWorker:
 *
 * - **Progressive disclosure**: small catalog live-recomputed per turn; the
 *   full body lands only when the agent calls `loadSkill`.
 * - **Live re-evaluation**: enabling/disabling a skill applies from the next
 *   message — no new session needed.
 * - **Loaded-skill disable countermand**: once a skill's instructions are in
 *   history, they keep steering the model even after the skill is disabled —
 *   history can't be un-read. So the per-turn context provider detects
 *   loaded-but-no-longer-available skills and explicitly appends the
 *   disable note.
 * - **Authoring loop**: `saveSkill` installs an agent-authored procedure as an
 *   org-scoped skill but routes through the standard approval card — the same
 *   Inbox contract as for any other external action (no self-grant rule).
 * - **Continual-Harness refine loop**: `refineSkill` applies the *smallest*
 *   evidence-backed edit to an existing skill (summary/instructions) based on
 *   what the trajectory showed, parks it behind the same approval card, and —
 *   once approved — records the before/after snapshot + trigger so the edit is
 *   reviewable and revertible by ID. Mirrors Prime Agent's `/refine`: minimal
 *   edit, evidence-backed, immutable base; here the immutable base is the
 *   approval gate rather than an un-editable system prompt.
 *
 * In ChasteBusinessOS these map onto VISION §5.2 customization-memory: the
 * "store how the hard customization was done" primitive becomes an
 * inspectable, reviewable object instead of a silent embedding.
 */

export interface SkillRecord {
  /** Stable id (`crm.lead-prioritization`). */
  name: string;
  /** Org-scoped skill (`org:acme/...`) or platform-bundled (`platform:...`). */
  scope: "platform" | "organization";
  /** Org ID when scope = organization. */
  organizationId?: string;
  /** Branch id when skill is branch-scoped; null/undefined = org-global. */
  branchId?: string;
  title: string;
  /** One-liner shown in the catalog list. */
  summary: string;
  /** Full instructions the agent receives when it calls `loadSkill(name)`. */
  instructions: string;
  /** Optional bundled files (paths + excerpts), per OpenWorker `save_skill`. */
  files?: SkillFile[];
  /** Optional Continual-Harness refinement history (evidence + before/after). */
  refinements?: SkillRefinement[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillFile {
  /** Path within the originating workspace root. */
  path: string;
  /** Truncated excerpt (≤ ~2000 chars). */
  excerpt: string;
}

/**
 * A single Continual-Harness refinement of a skill. Durable + inspectable: the
 * `before`/`after` snapshots make any applied edit revertible by ID, and the
 * `trigger` records the evidence (trajectory/audit snippet) that motivated it.
 */
export interface SkillRefinement {
  id: string;
  /** Evidence-backed trigger: what the trajectory/audit showed that motivated the edit. */
  trigger: string;
  /** Optional human note about the expected outcome. */
  note?: string;
  before: { summary?: string; instructions?: string };
  after: { summary?: string; instructions?: string };
  /** When later known: whether the edit produced the expected outcome. */
  outcome?: string;
  /** Set when this entry *reverts* another refinement; the other entry's id. */
  reversalRefinementId?: string;
  createdAt: string;
}

/** Proposed minimal edit to an existing skill (only the fields that change). */
export interface SkillRefineInput {
  name: string;
  summary?: string;
  instructions?: string;
  /** Evidence for the edit — the trajectory/audit snippet that triggered the proposal. */
  trigger: string;
  note?: string;
}

/**
 * Pure builder for a skill refinement. The *smallest evidence-backed edit* rule
 * from Continual Harness: only fields that actually differ are proposed, and a
 * no-op (nothing changed) is rejected rather than burning an approval card.
 */
export function buildSkillRefinement(
  existing: SkillRecord,
  input: SkillRefineInput,
  opts: { now?: () => Date } = {},
): { ok: true; refinement: SkillRefinement; skill: SkillRecord } | { ok: false; reason: string } {
  const before: SkillRefinement["before"] = {};
  const after: SkillRefinement["after"] = {};
  if (input.summary != null && input.summary !== existing.summary) {
    before.summary = existing.summary;
    after.summary = input.summary;
  }
  if (input.instructions != null && input.instructions !== existing.instructions) {
    before.instructions = existing.instructions;
    after.instructions = input.instructions;
  }
  const reason = refinementValidationError(existing.name, input);
  if (reason) return { ok: false, reason };
  if (Object.keys(after).length === 0) {
    return {
      ok: false,
      reason: "Refinement is a no-op: neither summary nor instructions differ from the current skill.",
    };
  }
  const refinement: SkillRefinement = {
    id: crypto.randomUUID(),
    trigger: input.trigger,
    note: input.note,
    before,
    after,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  return {
    ok: true,
    refinement,
    skill: {
      ...existing,
      summary: after.summary ?? existing.summary,
      instructions: after.instructions ?? existing.instructions,
      refinements: [...(existing.refinements ?? []), refinement],
      updatedAt: (opts.now?.() ?? new Date()).toISOString(),
    },
  };
}

function refinementValidationError(name: string, input: { trigger: string }): string | null {
  if (!name?.trim()) return "Refinement requires a valid skill name.";
  if (!input.trigger?.trim()) return "Refinement requires `trigger` evidence (non-empty).";
  return null;
}

/**
 * Pure builder for reverting a previously-applied refinement. Reapplies the
 * target's `before` snapshot for the fields it changed, producing a *new*
 * refinement entry chained via `reversalRefinementId` (itself reversible, so
 * re-reverting is a plain forward edit again). A no-op (skill already at the
 * pre-refinement state) is rejected.
 */
export function buildSkillRevert(
  existing: SkillRecord,
  target: SkillRefinement,
  opts: { now?: () => Date } = {},
): { ok: true; refinement: SkillRefinement; skill: SkillRecord } | { ok: false; reason: string } {
  const before: SkillRefinement["before"] = {};
  const after: SkillRefinement["after"] = {};
  for (const field of ["summary", "instructions"] as const) {
    const prior = target.before[field];
    if (prior === undefined) continue;
    if (existing[field] !== prior) {
      before[field] = existing[field];
      after[field] = prior;
    }
  }
  if (Object.keys(after).length === 0) {
    return {
      ok: false,
      reason: "Revert is a no-op: the skill already reflects the pre-refinement state.",
    };
  }
  const refinement: SkillRefinement = {
    id: crypto.randomUUID(),
    trigger: `Reverted refinement "${target.id}"`,
    note: target.note,
    before,
    after,
    reversalRefinementId: target.id,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  return {
    ok: true,
    refinement,
    skill: {
      ...existing,
      summary: after.summary ?? existing.summary,
      instructions: after.instructions ?? existing.instructions,
      refinements: [...(existing.refinements ?? []), refinement],
      updatedAt: (opts.now?.() ?? new Date()).toISOString(),
    },
  };
}

export interface SkillStore {
  /** All skills visible to a given (org, branch). Platform skills + org skills. */
  list(filter: {
    organizationId: string;
    branchId?: string;
    enabledOnly?: boolean;
  }): Promise<SkillRecord[]>;
  get(name: string, filter: { organizationId: string; branchId?: string }): Promise<SkillRecord | undefined>;
  upsert(record: Omit<SkillRecord, "createdAt" | "updatedAt">): Promise<SkillRecord>;
  setEnabled(name: string, filter: { organizationId: string; branchId?: string }, enabled: boolean): Promise<void>;
}

/**
 * In-memory skill store. A Postgres-backed implementation (in `@chaste/runtime`)
 * uses the `ai_skills` table (see migration additions). The interface is
 * identical either way so callers swap stores freely.
 */
export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly now = () => new Date();

  async list(filter: {
    organizationId: string;
    branchId?: string;
    enabledOnly?: boolean;
  }): Promise<SkillRecord[]> {
    const out: SkillRecord[] = [];
    for (const s of this.skills.values()) {
      if (s.scope === "platform" || s.organizationId === filter.organizationId) {
        if (filter.branchId && s.branchId && s.branchId !== filter.branchId) continue;
        if (filter.enabledOnly && !s.enabled) continue;
        out.push(s);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string, filter: { organizationId: string; branchId?: string }): Promise<SkillRecord | undefined> {
    return (await this.list(filter)).find((s) => s.name === name);
  }

  async upsert(record: Omit<SkillRecord, "createdAt" | "updatedAt">): Promise<SkillRecord> {
    const key = `${record.scope}:${record.organizationId ?? "platform"}:${record.branchId ?? "-"}:${record.name}`;
    const existing = this.skills.get(key);
    const ts = this.now().toISOString();
    const rec: SkillRecord = {
      ...record,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.skills.set(key, rec);
    return rec;
  }

  async setEnabled(name: string, filter: { organizationId: string; branchId?: string }, enabled: boolean): Promise<void> {
    const s = await this.get(name, filter);
    if (!s) return;
    s.enabled = enabled;
    s.updatedAt = this.now().toISOString();
    const key = `${s.scope}:${s.organizationId ?? "platform"}:${s.branchId ?? "-"}:${s.name}`;
    this.skills.set(key, s);
  }
}

/**
 * The per-turn catalog text injected into the latest user message. Lists every
 * enabled skill with a one-line description. Matches OpenWorker's catalog:
 * `"name  -- summary"` lines. Empty (`""`) when no skills are available.
 */
export async function skillCatalogText(store: SkillStore, filter: {
  organizationId: string;
  branchId?: string;
}): Promise<string> {
  const skills = await store.list({ ...filter, enabledOnly: true });
  if (skills.length === 0) return "";
  const lines = [
    "Available skills (call `loadSkill(name)` to load a skill's instructions into the conversation):",
    ...skills.map((s) => `- ${s.name} -- ${s.summary}`),
  ];
  return lines.join("\n");
}

/**
 * The Go-Ahead countermand (§3 of OpenWorker's SKILLS spec): once a skill's
 * instructions live in history, they keep steering the model even after the
 * skill is disabled — history can't be un-read. So when the assistant emits a
 * disable note *only* for loaded-but-no-longer-available skills, recomputed
 * fresh every turn (re-enable → the note disappears; never persisted).
 *
 * We detect "loaded" skill names by scanning prior assistant messages for any
 * tool-call result whose name was `load_skill` and whose result text contained
 * `"instructions"`. Then we diff against the currently-enabled set.
 *
 * Note: the assistant here is the LLM-backed orchestrator; historical tool
 * calls are recorded as audit entries and reflected into the transcript through
 * explanation parts. For the kernel-side path, we walk message parts for
 * `explanation` parts whose `rulesApplied` mentions `load_skill`.
 */
export async function disableCountermand(
  store: SkillStore,
  filter: { organizationId: string; branchId?: string },
  loadedSkillNames: string[],
): Promise<string> {
  if (loadedSkillNames.length === 0) return "";
  const available = new Set(
    (await store.list({ ...filter, enabledOnly: true })).map((s) => s.name),
  );
  const disappeared = loadedSkillNames.filter((n) => !available.has(n));
  if (disappeared.length === 0) return "";
  return (
    `The following skills that you previously loaded have been disabled by the user — stop following their instructions from here on: ${disappeared
      .map((n) => `"${n}"`)
      .join(", ")}.`
  );
}

/**
 * The agent-callable tool registry: `loadSkill(name)` returns the full skill
 * record (instructions + files) to be served as the tool result, or an error
 * string when the skill is unknown/disabled.
 *
 * The orchestrator appends the loaded skill name to a per-session loaded-set
 * (kept in `ChatSessionState.loadedSkillNames`). This is the input to
 * `disableCountermand` on the next turn.
 */
export interface SkillTools {
  loadSkill: (name: string) => Promise<{ ok: true; skill: SkillRecord } | { ok: false; error: string }>;
  saveSkill: (input: {
    name: string;
    title: string;
    summary: string;
    instructions: string;
    files?: SkillFile[];
  }) => Promise<{ ok: true; requiresApproval: true; skill: SkillRecord }>;
  /**
   * Continual-Harness refine: propose the smallest evidence-backed edit to an
   * existing skill. No state is mutated here — the proposal parks behind the
   * standard Inbox approval and is applied only after human resolution. The
   * returned `refinement` carries the before/after snapshot + trigger.
   */
  refineSkill: (input: SkillRefineInput) => Promise<
    | { ok: true; requiresApproval: true; skill: SkillRecord; refinement: SkillRefinement }
    | { ok: false; reason: string }
  >;
  /**
   * Revert a previously-applied refinement by id. Reapplies the entry's `before`
   * snapshot as a new, chained refinement, approved through the same Inbox card.
   * No state is mutated here; the reversal parks until human resolution.
   */
  revertSkillRefinement: (input: { name: string; refinementId: string; note?: string }) => Promise<
    | { ok: true; requiresApproval: true; skill: SkillRecord; refinement: SkillRefinement }
    | { ok: false; reason: string }
  >;
}

export function skillTools(
  store: SkillStore,
  filter: { organizationId: string; branchId?: string },
): SkillTools {
  return {
    async loadSkill(name: string) {
      const skill = await store.get(name, filter);
      if (!skill || !skill.enabled) {
        return { ok: false as const, error: `Skill ${name} not available.` };
      }
      return { ok: true as const, skill };
    },
    async saveSkill(input) {
      // Always requires approval: routes through the standard inbox approver.
      // The orchestrator intercepts the resulting approval_id and calls
      // `store.upsert(...)` on resolution === "allow" / "always".
      const record = await store.upsert({
        scope: "organization",
        organizationId: filter.organizationId,
        branchId: filter.branchId,
        name: input.name,
        title: input.title,
        summary: input.summary,
        instructions: input.instructions,
        files: input.files,
        enabled: false, // disabled until the approval resolves
      });
      return { ok: true as const, requiresApproval: true as const, skill: record };
    },
    async refineSkill(input) {
      const existing = await store.get(input.name, filter);
      if (!existing) {
        return { ok: false as const, reason: `Cannot refine unknown skill "${input.name}".` };
      }
      const proposal = buildSkillRefinement(existing, input);
      if (!proposal.ok) return proposal;
      return {
        ok: true as const,
        requiresApproval: true as const,
        skill: proposal.skill,
        refinement: proposal.refinement,
      };
    },
    async revertSkillRefinement(input) {
      if (!input.refinementId?.trim()) {
        return { ok: false as const, reason: "Revert requires a refinement id." };
      }
      const existing = await store.get(input.name, filter);
      if (!existing) {
        return { ok: false as const, reason: `Cannot revert on unknown skill "${input.name}".` };
      }
      const target = (existing.refinements ?? []).find((r) => r.id === input.refinementId);
      if (!target) {
        return {
          ok: false as const,
          reason: `No refinement "${input.refinementId}" found on skill "${input.name}".`,
        };
      }
      const proposal = buildSkillRevert(existing, { ...target, note: input.note ?? target.note });
      if (!proposal.ok) return proposal;
      return {
        ok: true as const,
        requiresApproval: true as const,
        skill: proposal.skill,
        refinement: proposal.refinement,
      };
    },
  };
}
