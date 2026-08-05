# Spec: Semantic memory system (jcode-inspired)

**Status:** Draft product/engineering spec  
**Related:** [ADR 0007](../adr/0007-harness-memory-and-self-dev.md), [agent-harness.md](./agent-harness.md), [ARCHITECTURE.md](../../ARCHITECTURE.md)

## 1. Goal

Give the harness a **human-like memory system** that:

- Automatically recalls relevant information without the model burning tokens on memory tools every turn
- Still allows **explicit** search/store when the agent chooses
- Separates conversational memory from permanent business facts (SoR via commands)
- Remembers **how hard customizations were done** for efficient reuse
- Consolidates over time (staleness, conflicts, merges)

Inspiration: jcode-style harnesses -- embed turns, cosine-retrieve from a memory graph, optional memory side-agent verification, periodic extraction, ambient consolidation, session RAG, and explicit memory tools.

> We adopt the **architecture ideas** from that class of systems, not a dependency on any specific proprietary codebase.

## 2. Layers

```
┌────────────────────────────────────────────────────────────┐
│ Working context: current session transcript (short-term)   │
├────────────────────────────────────────────────────────────┤
│ Passive recall: cosine hits from memory graph (+ verify)   │
├────────────────────────────────────────────────────────────┤
│ Explicit tools: memory.search / store, session.search      │
├────────────────────────────────────────────────────────────┤
│ Permanent business truth: commands → SoR tables only       │
└────────────────────────────────────────────────────────────┘
```

| Layer | Write policy | Read policy |
|---|---|---|
| Session messages | Every turn | Last N turns always in prompt |
| Turn embeddings | Every turn (async ok) | Used for session.search + extraction seeds |
| Memory graph nodes | Extraction side-agent, explicit store, system events | Passive top-k + tools |
| Customization lessons | After successful self-dev / closed ticket | Prefer high weight on similar gap intents |
| SoR | Commands only | Queries only |

**Never** treat a memory node as the sole source of truth for balances, stock, or legal records.

## 3. Data model (logical)

```ts
type MemoryNode = {
  id: string;
  organizationId: string;
  kind:
    | "episodic"          // what happened in a conversation
    | "semantic_fact"     // durable org knowledge (non-SoR)
    | "decision"          // policy/process choices
    | "preference"        // user/org soft prefs
    | "customization"     // how a feature was implemented
    | "procedure"         // how we do X operationally
    | "entity_link";      // pointer to SoR id (customer, invoice, …)
  content: string;        // natural language or structured summary
  embedding: number[];    // pgvector
  metadata: {
    userId?: string;
    sessionId?: string;
    capabilityIds?: string[];
    moduleIds?: string[];
    branchId?: string;
    source: "extraction" | "explicit" | "system" | "consolidation";
    confidence?: number;
    importance?: number;  // 0–1
    expiresAt?: string;
    piiClass?: "none" | "low" | "restricted";
  };
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
};

type MemoryEdge = {
  id: string;
  fromId: string;
  toId: string;
  relation: "related" | "caused" | "supersedes" | "part_of" | "about_entity";
};
```

Session table remains as today (`chat_sessions`); add embeddings table for turns if not stored on messages.

## 4. Passive recall (every turn)

```
build query text = recent user message + light session summary
  → embed
  → cosine similarity against memory graph (org-scoped, permission-aware filters)
  → top-k (e.g. 8) with score threshold
  → optional Memory Side-Agent:
        verify relevance, drop noise, optionally fetch 1-hop edges / session.search
  → format budgeted block into system/context
  → main agent continues
```

**Design goals:**

- Default path requires **zero** memory tool calls from the main agent
- Side-agent is skippable when latency budget is tight (`CHASTE_MEMORY_SIDE_AGENT=off|async|sync`)
- Branch filter: prefer active branch memories but allow org-global facts

## 5. Extraction

Memories must be **extracted and stored** to be retrieved later.

### Triggers

| Trigger | When |
|---|---|
| `k_turns` | Every K user turns (org setting, default 8) |
| `semantic_drift` | Embedding distance from session centroid exceeds threshold |
| `session_end` | Explicit close or idle timeout |
| `plan_complete` | Multi-step plan finished successfully |
| `gap_closed` | Customization shipped / ticket resolved |
| `explicit` | Agent or user asked to remember |

### Extraction side-agent

Input: recent turns + existing near-duplicate candidates (cosine prefilter).  
Output: 0–N proposed `MemoryNode`s + optional edges; Zod-validated.

Rules:

- Prefer durable facts over chit-chat
- Do not duplicate SoR (store `entity_link` pointers + summary, not full invoice copies)
- Redact secrets; respect `piiClass`
- Mark `customization` kind with capability id + module path when from self-dev

## 6. Explicit tools

| Tool | Behavior |
|---|---|
| `memory.search` | Query graph by text (cosine + filters); return snippets + ids |
| `memory.store` | Write node (kind + content); subject to size limits |
| `session.search` | Traditional RAG / hybrid over prior sessions for the org/user |

These exist so the agent is **not limited** to passive injection when it knows it needs something specific.

## 7. Ambient consolidation

Worker job (schedule + after large extract batches):

1. Cluster near-duplicates (cosine)
2. Merge or supersede with `supersedes` edges
3. Flag conflicts (contradictory decisions) for human or agent review
4. Decay low-importance, unused nodes (`importance`, last access)
5. Refresh embeddings if content edited

## 8. Customization memory

When a Capability Gap Ticket is implemented:

```ts
{
  kind: "customization",
  content: "Implemented multi-currency price lists via inventory price_list module extension…",
  metadata: {
    capabilityIds: ["inventory.price_list.multi_currency"],
    moduleIds: ["inventory"],
    source: "system",
    importance: 0.9,
    // optional: PR url, package version, coding agent used
  }
}
```

Future similar requests retrieve this **before** re-deriving approach from scratch.

## 9. Implementation sketch (packages)

| Piece | Location |
|---|---|
| Ports (`MemoryGraphStore`, embedder) | `packages/ai-core/src/memory*` |
| PG + pgvector schema | `packages/db` |
| Passive inject + tools | `packages/ai-core` orchestrator |
| Extraction / consolidation jobs | `apps/worker` |
| Config | `packages/config` (`CHASTE_EMBEDDING_*`, side-agent mode, K, budgets) |

Existing `MemoryStore` / `InMemoryMemoryStore` evolve into graph-capable store with backward-compatible simple search.

## 10. Privacy & tenancy

- Strict `organizationId` isolation in all queries
- Optional user-scoped preferences vs org-scoped procedures
- No cross-tenant mapping templates without anonymization + opt-in (ingestion spec)
- Restricted PII nodes excluded from broad passive recall unless tool explicitly requests and permission allows

## 11. Success metrics

- Passive recall hit-rate on golden dialogues (human-judged relevance)
- Reduction in redundant clarifying questions for known org facts
- Token overhead of memory block under budget (p95)
- Customization reuse: second similar gap resolves faster / fewer coding cycles
- Zero cross-org vector leaks in contract tests

## 12. Phasing

| Phase | Deliverable |
|---|---|
| M0 | Session transcript multi-turn (exists) |
| M1 | Turn embeddings + `session.search` |
| M2 | Memory nodes table + passive top-k inject |
| M3 | Explicit memory tools |
| M4 | Extraction side-agent on K turns / session end |
| M5 | Ambient consolidation job |
| M6 | Customization lesson kind + gap-close hook |

## 13. Non-goals

- Replacing the ERP database with a vector store
- Unlimited history in the prompt
- Storing raw credentials or full document binaries as embeddings
