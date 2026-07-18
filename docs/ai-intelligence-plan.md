# Implementation Plan: AI-Native Intelligence Layer

## Goal
Make ChasteBusinessOS truly intelligent — natural language in, business actions out, with memory, clarification, multi-step planning, and proactive suggestions.

## Architecture Decision
Custom implementation using our existing `AiProvider.complete()` + session DB persistence.
No new external dependencies.

---

## Feature 1: Multi-Turn Conversation Memory

### Problem
Each LLM call receives only the current message. The AI has no memory of prior turns.

### Solution
Pass conversation history to the LLM on every call. Persist sessions to DB.

### Changes

**1a. Extend `CompletionRequest`** (`packages/ai-core/src/providers.ts`)
```ts
interface CompletionRequest {
  system: string;
  user?: string;          // single-turn shortcut
  messages?: ChatMessage[];  // multi-turn history (takes precedence over `user`)
  temperature?: number;
}
```
When `messages` is provided, convert them to OpenAI format:
- `role: "user"` for user messages
- `role: "assistant"` for assistant messages
- Only include text parts (skip UI parts for the LLM context)

**1b. Update `OpenAiCompatibleProvider.complete()`** (`packages/ai-core/src/providers.ts`)
```ts
async complete(req: CompletionRequest): Promise<CompletionResult> {
  const messages = req.messages
    ? req.messages.map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.parts.filter(p => p.type === "text").map(p => p.text).join("\n"),
      }))
    : [{ role: "user", content: req.user ?? "" }];

  // Prepend system message
  messages.unshift({ role: "system", content: req.system });

  const res = await fetch(`${this.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
    body: JSON.stringify({ model: this.model, messages, temperature: req.temperature }),
  });
  // ... parse response
}
```

**1c. Pass history in orchestrator** (`packages/ai-core/src/orchestrator.ts`)
In the Tier 2 LLM call:
```ts
const completion = await deps.provider.complete({
  system: `You map user requests...`,
  messages: session.messages,  // pass full history
});
```

**1d. Persist sessions to DB** (`packages/db/src/schema.ts`)
```sql
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]',
  pending JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**1e. Update `AppContext`** (`apps/api/src/app-context.ts`)
- Replace `sessions: Map<string, ChatSessionState>` with DB-backed read/write
- On `runChat()`: load session from DB (or create new), save after turn
- Keep in-memory Map as write-through cache for performance

### File changes
- `packages/ai-core/src/providers.ts` — extend CompletionRequest, update complete()
- `packages/ai-core/src/orchestrator.ts` — pass messages in Tier 2 + 3
- `packages/db/src/schema.ts` — add chat_sessions table
- `packages/db/src/migrate.ts` — add migration
- `apps/api/src/app-context.ts` — DB-backed sessions

---

## Feature 2: Clarifying Questions

### Problem
When intent is ambiguous, the AI either guesses wrong or shows a help message. No structured clarification flow.

### Solution
Add a "clarification" response type to the LLM output. When the AI isn't sure, it asks 1-2 focused questions. The user answers, and the AI retries with the new context.

### Changes

**2a. New UI part** (`packages/ui-schema/src/index.ts`)
```ts
{ type: "clarify"; id: string; questions: string[]; context?: string }
```

**2b. Extend `PlannedAction`** (`packages/ai-core/src/orchestrator.ts`)
```ts
interface PlannedAction {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  specialist?: string;
}

interface ClarifyAction {
  type: "clarify";
  questions: string[];
  context?: string;
}

type IntentResult = PlannedAction | ClarifyAction | null;
```

**2c. Update Tier 2 LLM prompt** (`packages/ai-core/src/orchestrator.ts`)
```
You map user requests to business actions. Use only: ${toolList}

If the request is ambiguous (missing required info, could match multiple commands),
respond with: {"clarify":["question1","question2"]}

Otherwise respond with: {"command":"...","input":{...}}
```

**2d. Handle clarification in `handleChatTurn`**
```ts
if (result.type === "clarify") {
  session.pending = { type: "clarification", questions: result.questions };
  session.messages.push(msg("assistant", [{
    type: "clarify",
    id: crypto.randomUUID(),
    questions: result.questions,
  }]));
  return { session };
}
```

**2e. Handle clarification response**
When the user responds to a clarification (check `session.pending?.type === "clarification"`):
- Merge the user's answer into the context
- Re-run the intent resolution with the enriched context
- This creates a natural back-and-forth

### File changes
- `packages/ui-schema/src/index.ts` — add clarify part
- `packages/ai-core/src/orchestrator.ts` — ClarifyAction type, Tier 2 prompt update, clarification handling

---

## Feature 3: Multi-Step Autonomous Planning

### Problem
Each turn maps to exactly one command. "Hire someone and set them up" should produce a multi-step plan.

### Solution
When the LLM detects a multi-step request, it returns a plan (list of commands). The user reviews the plan, then approves execution.

### Changes

**3a. New UI part** (`packages/ui-schema/src/index.ts`)
```ts
{
  type: "plan";
  id: string;
  title: string;
  description: string;
  steps: {
    id: string;
    command: string;
    description: string;
    input: Record<string, unknown>;
    requiresApproval: boolean;
  }[];
  confirmLabel: string;
  cancelLabel: string;
}
```

**3b. Extend `PlannedAction` to support plans**
```ts
interface MultiStepPlan {
  type: "plan";
  title: string;
  description: string;
  steps: PlannedAction[];
}
```

**3c. Update Tier 2 LLM prompt**
```
For multi-step requests, respond with:
{
  "plan": true,
  "title": "plan name",
  "description": "what this plan does",
  "steps": [
    {"command":"...","input":{...},"description":"step description"},
    ...
  ]
}

For single commands, respond with:
{"command":"...","input":{...}}
```

**3d. Handle plan in `handleChatTurn`**
- Store plan as `session.pending = { type: "plan", steps: [...] }`
- Return a `plan` UI part showing all steps
- User confirms → execute steps sequentially (using workflow engine)
- Store completed step results in context for variable resolution

**3e. Execute plan**
```ts
if (session.pending?.type === "plan" && confirmId) {
  for (const step of session.pending.steps) {
    const result = await executeCommand(...);
    // store result for variable resolution in next steps
    context[step.id] = result.data;
  }
}
```

### File changes
- `packages/ui-schema/src/index.ts` — add plan part
- `packages/ai-core/src/orchestrator.ts` — MultiStepPlan type, plan handling
- `apps/api/src/server.ts` — handle plan confirmation

---

## Feature 4: Proactive Follow-Up Suggestions

### Problem
After executing a command, the result is just a table. No "what's next?" logic.

### Solution
After successful execution, generate contextual suggestions based on what was done, the command's domain, and available related commands.

### Changes

**4a. New UI part** (`packages/ui-schema/src/index.ts`)
```ts
{
  type: "suggestions";
  items: {
    id: string;
    label: string;
    description?: string;
    command?: string;    // if clicking executes this command
    message?: string;    // or sends this message to chat
  }[];
}
```

**4b. Suggestion generator** (`packages/ai-core/src/suggestions.ts` — new file)
```ts
interface SuggestionRule {
  /** Command that was just executed */
  afterCommand: string;
  /** Suggestions to show */
  suggestions: { label: string; message: string; command?: string }[];
}

const SUGGESTION_RULES: SuggestionRule[] = [
  {
    afterCommand: "crm.customer.create",
    suggestions: [
      { label: "Create invoice for this customer", message: "Create an invoice for this customer" },
      { label: "View all customers", message: "List all customers" },
    ],
  },
  {
    afterCommand: "hr.employee.create",
    suggestions: [
      { label: "Prepare payroll", message: "Prepare payroll for this month" },
      { label: "Create another employee", message: "Create another employee" },
    ],
  },
  // ... more rules per module
];

function getSuggestions(commandName: string, tags: string[]): SuggestionItem[] {
  // 1. Check exact command match in rules
  // 2. Fall back to tag-based suggestions (e.g., all CRM commands suggest related CRM actions)
  // 3. Always include a "What else can I do?" option
}
```

**4c. LLM-based suggestions (for complex results)**
For commands that return rich data (e.g., "customer created with id=xyz"), use the LLM to generate contextual suggestions:
```ts
const completion = await provider.complete({
  system: `Based on this business action result, suggest 2-3 natural next steps. Be specific.`,
  user: `Action: ${commandName}\nResult: ${JSON.stringify(result.data)}\nAvailable commands: ${toolList}`,
});
```

**4d. Wire into orchestrator** (`packages/ai-core/src/orchestrator.ts`)
After successful execution in Phase 4:
```ts
if (result.ok) {
  const suggestions = getSuggestions(planned.command, meta?.tags ?? []);
  parts.push({ type: "suggestions", items: suggestions });
}
```

### File changes
- `packages/ai-core/src/suggestions.ts` — new file, rule-based + LLM suggestions
- `packages/ui-schema/src/index.ts` — add suggestions part
- `packages/ai-core/src/orchestrator.ts` — wire suggestions after execution
- `packages/ai-core/src/index.ts` — export suggestions

---

## Implementation Order

1. **Multi-turn memory** (Feature 1) — Foundation for everything else
2. **Clarifying questions** (Feature 2) — Needs conversation history to work well
3. **Multi-step planning** (Feature 3) — Builds on clarification flow
4. **Proactive suggestions** (Feature 4) — Independent, can be last

## Estimated scope
- ~400-500 lines of new/modified code
- 1 new DB migration
- 1 new file (suggestions.ts)
- Modifications to 5 existing files
- New UI parts in ui-schema

## Testing plan
- Unit tests for each feature
- Live E2E: multi-turn conversation, clarification, plan creation, suggestions
- Typecheck + lint on all packages
