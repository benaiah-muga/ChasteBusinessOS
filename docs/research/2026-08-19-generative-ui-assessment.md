# Generative UI — assessment for ChasteBusinessOS

Date: 2026-08-19
Status: Research + recommendation (no adoption of code-generating generative UI)
Scope: `apps/web` chat rendering, `packages/ui-schema` (UiPart), `packages/api-client`,
future `form`/`button_group`/`inbox_prompt` parts.

Asked: "research generative UI and whether we need it or not in this project."

## 1. What "generative UI" means (two different things)

The term conflates two very different capabilities, and the verdict differs per one:

**A. Code-generation generative UI (development-time).** Vercel v0, Figma AI, etc. —
an LLM writes React/Tailwind components from a text prompt; a human reviews, copies,
and ships them. This is a *build-time* productivity tool (Vercel Academy: "UI-as-Prompts",
`UI with v0`).

**B. Runtime generative UI (streaming UI from the model).** The Vercel AI SDK
GenUI/RSC pattern — "the LLM doesn't just stream text, it streams *which React
components to render*, with what props, in what order" (Vadim, "Build Generative UI with
Vercel AI SDK", 2026-05). The canonical mental model is **"tools are components"**:
a tool the model calls returns structured data that maps 1:1 to a typed React component
in a *component registry* on the client. The AI SDK ships a `partial-call` state so the
client can render skeletons while args stream in. When to reach for it: components with
interactive state (selectable rows, form fields, confirmation flows) or composing several
components into one assistant turn; when "your UI is just a styled list of strings,
markdown rendering is simpler and the streaming UX is better."

The key security literature (OWASP LLM01 prompt injection; "The Hidden Risks of
LLM-Generated Web Application Code" arXiv 2504.20612; A10 "malicious AI-generated code")
is about **unreviewed, arbitrary, LLM-authored code**. Runtime-genUI mitigates this by
**not letting the model write code** — the model emits *data*, and the client renders it
through a closed registry of human-reviewed components.

## 2. What ChasteBusinessOS already has

ChasteBusinessOS already implements **runtime generative UI in its safest form — a
closed, Zod-validated component registry**:

- `packages/ui-schema` defines a discriminated `UiPart` union of **13 part types**
  (`text`, `explanation`, `form`, `button_group`, `confirm_action`, `table`, `metric`,
  `error`, `clarify`, `plan`, `suggestions`, `progress`, `inbox_prompt`).
- The orchestrator (`packages/ai-core`) *emits typed data parts*; the frontend
  (`apps/web/src/components/ChatWidget.tsx`) is the *component registry* — a switch over
  the union that maps each part to a reviewed component. There is no path where the model
  authors JSX.
- `packages/api-client` re-validates every part at the boundary with `uiPartSchema` before
  rendering. Unknown part types fail closed (Zod reject) or render a graceful fallback —
  never raw model-authored markup.
- The part list is **driver-verified** (`nl-driver*` assert exact parts: `confirm_action`,
  `table`, `clarify`, `suggestions`, `progress`, natural-key no-op). This is
  deterministic, auditable UI — matching the platform's invariants (AI/manual parity,
  explainability, auditability, "Zod validates intent and payloads at boundaries").

This is precisely the "tools are components / registered-component rendering" half of the
AI SDK GenUI pattern, implemented without a new framework. `form`, `button_group`, and
`inbox_prompt` are the *unused* parts of the registry — they are the natural, safe next
steps of generative UI here.

## 3. Gaps versus "full" generative UI

1. **Streaming / skeleton states.** The orchestrator emits parts as one turn result;
   the only live element is the `progress` part. AI SDK-style partial rendering (skeleton
   for a pending tool call) is not present. Low-value for a business OS: turns are
   seconds, not minutes; `progress` covers the long cases.
2. **Interactive `form`, `button_group`, `inbox_prompt`.** The schema has them; nothing
   emits them, and the chat API only accepts `message`/`confirmId`/`cancelId` — so a form
   part cannot be submitted today. The chat currently renders these as read-only summaries
   (added 2026-08-19) rather than inert fake inputs.
3. **Ad-hoc/exploratory dashboards.** No mechanism for the model to request "a new kind
   of card" on the fly.

## 4. Verdict

**Do not adopt free-form, code-generating generative UI at runtime.** Rationale:

- **Security.** Unreviewed LLM-authored React means arbitrary code in the client; prompt
  injection (OWASP LLM01) turns any data source into a code-injection vector. The repo's
  CSP (no `unsafe-eval` in prod) and security invariants exist precisely to keep that
  boundary closed. The "malicious AI-generated code" risk category is well documented.
- **Auditability / parity / determinism.** Every UI element must map to a command/query
  and a permission check, be explainable, and be assertable by `nl-driver*` tests.
  Free-form UI cannot be contract-tested. A closed registry can.
- **Existing coverage.** The 13-part UiPart registry is already the correct
  generative-UI pattern for a governed OS. The gap is *depth of the registry*, not a
  missing framework.

**Do adopt, incrementally (recommended direction):**

1. **Wire the dormant parts to real backends.** Give `form`/`button_group` a submit path
   (chat API gains an optional `partId` + payload that the orchestrator routes back to a
   command, still Zod-validated and permission-checked — same bus, no AI shortcut), and
   give `inbox_prompt` a resolve path via the existing inbox `decide` contract. This turns
   the currently-static summaries into interactive-but-governed widgets.
2. **Keep the registry closed.** New parts = reviewed ChatWidget components + ui-schema
   entries + a driver assertion. No LLM-authored JSX, no arbitrary props.
3. **Optional: lightweight skeletons.** If long turns become a UX problem, add a
   `progress`-driven skeleton rather than adopting a streaming framework.

**Not needed now:** Vercel AI SDK GenUI/RSC, v0-style runtime component generation, or
any "model picks a component from an open registry" mechanism. None of these add
capability that the UiPart registry + `progress` part doesn't already give, and all of
them cost determinism and auditability.

## 5. Sources

- Vercel Academy, "UI with v0" — development-time component generation.
- Vercel AI SDK GenUI (ai-sdk.dev; vercel-labs RSC example) — "tools are components".
- Vadim, "Build Generative UI with Vercel AI SDK: Stream React Components from an LLM"
  (2026-05) — registry pattern, partial-call skeletons, "when generative UI is the wrong call".
- OWASP GenAI Security Project, LLM01 Prompt Injection.
- "The Hidden Risks of LLM-Generated Web Application Code" (arXiv 2504.20612) — security
  non-compliance of LLM-authored code.
- A10 Networks, "Top Generative AI Security Risks in 2026" — malicious AI-generated code.