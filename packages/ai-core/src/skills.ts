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

export interface SkillStore {
  /** All skills visible to a given (org, branch). Platform skills + org skills. */
  list(filter: {
    organizationId: string;
    branchId?: string;
    enabledOnly?: boolean;
  }): SkillRecord[];
  get(name: string, filter: { organizationId: string; branchId?: string }): SkillRecord | undefined;
  upsert(record: Omit<SkillRecord, "createdAt" | "updatedAt">): SkillRecord;
  setEnabled(name: string, filter: { organizationId: string; branchId?: string }, enabled: boolean): void;
}

/**
 * In-memory skill store. A Postgres-backed implementation would use the
 * `ai_skills` table (see migration additions). The interface is identical
 * either way so callers swap stores freely.
 */
export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly now = () => new Date();

  list(filter: {
    organizationId: string;
    branchId?: string;
    enabledOnly?: boolean;
  }): SkillRecord[] {
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

  get(name: string, filter: { organizationId: string; branchId?: string }): SkillRecord | undefined {
    return this.list(filter).find((s) => s.name === name);
  }

  upsert(record: Omit<SkillRecord, "createdAt" | "updatedAt">): SkillRecord {
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

  setEnabled(name: string, filter: { organizationId: string; branchId?: string }, enabled: boolean): void {
    const s = this.get(name, filter);
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
export function skillCatalogText(store: SkillStore, filter: {
  organizationId: string;
  branchId?: string;
}): string {
  const skills = store.list({ ...filter, enabledOnly: true });
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
export function disableCountermand(
  store: SkillStore,
  filter: { organizationId: string; branchId?: string },
  loadedSkillNames: string[],
): string {
  if (loadedSkillNames.length === 0) return "";
  const available = new Set(
    store.list({ ...filter, enabledOnly: true }).map((s) => s.name),
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
  loadSkill: (name: string) => { ok: true; skill: SkillRecord } | { ok: false; error: string };
  saveSkill: (input: {
    name: string;
    title: string;
    summary: string;
    instructions: string;
    files?: SkillFile[];
  }) => { ok: true; requiresApproval: true; skill: SkillRecord };
}

export function skillTools(
  store: SkillStore,
  filter: { organizationId: string; branchId?: string },
): SkillTools {
  return {
    loadSkill(name: string) {
      const skill = store.get(name, filter);
      if (!skill || !skill.enabled) {
        return { ok: false, error: `Skill ${name} not available.` };
      }
      return { ok: true, skill };
    },
    saveSkill(input) {
      // Always requires approval: routes through the standard inbox approver.
      // The orchestrator intercepts the resulting approval_id and calls
      // `store.upsert(...)` on resolution === "allow" / "always".
      const record = store.upsert({
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
      return { ok: true, requiresApproval: true, skill: record };
    },
  };
}
