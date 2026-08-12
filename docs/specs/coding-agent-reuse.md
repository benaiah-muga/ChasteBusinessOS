# Spec: Reusing local coding agents as AI providers

**Status:** Implemented (ADR 0013)  
**Related:** [self-development.md](./self-development.md), [agent-harness.md](./agent-harness.md), [ADR 0013](../adr/0013-coding-agent-reuse.md)

## 1. Problem

Self-hosted Chaste installs run next to the operator's coding-agent CLIs
(Claude Code, Codex, OpenCode, Gemini, Grok, Cline, Antigravity, Pi, …), most
of which already hold a paid subscription or API credential. Requiring a
separate `CHASTE_AI_PROVIDER` + API key is redundant and blocks "zero-config
AI" on local installs.

## 2. Approach

`CHASTE_AI_PROVIDER=auto` makes Chaste **detect installed coding agents and
reuse their model + endpoint + credential** as an `AiProvider`. The operator
brings their own subscription; Chaste calls the underlying provider HTTP API
(OpenAI-compatible, Anthropic Messages, or the Gemini OpenAI-compatible
endpoint) directly — fast enough for the harness's many small completions.

Explicit config always wins. Stock installs stay `none` (opt-in, fail-closed).

## 3. Detection model

```
detectCodingAgents()
  for each agent in CODING_AGENT_REGISTRY (27 agents):
    binary on PATH?            (CHASTE_CODING_AGENT_<ID>_BIN override wins)
      ├─ no  → { installed: false, detail: "not installed" }
      └─ yes → resolve { model, baseUrl, apiKey } from the agent's own
                config/auth files + env (e.g. ~/.codex/auth.json,
                ~/.claude/settings.json, ~/.config/opencode/opencode.json(c),
                ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …)
                ├─ reusable → providerKind + hasApiKey: true
                └─ OAuth/subscription only (Cursor, Copilot, Devin, …)
                   → installed but providerKind: null
```

Every result carries a safe `detail` reason. The API key value is never kept
or logged; `toPublicAgentInfo()` strips it.

## 4. Configuration

| Env | Meaning |
|---|---|
| `CHASTE_AI_PROVIDER=auto` | Activate detection (adds `auto` to `aiProviderSchema`) |
| `CHASTE_AI_PREFER_CODING_AGENT=<id>` | Pin one agent (e.g. `codex`, `claude-code`); falls back to registry order if unusable |
| `CHASTE_CODING_AGENT_<ID>_BIN` | Override an agent's binary path |
| `CHASTE_CODING_AGENT_<ID>_MODEL` | Override an agent's model |
| Agent's own credential env | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `MISTRAL_API_KEY`, `MINIMAX_API_KEY`, `OPENROUTER_API_KEY`, … |

Selection order: usable agent matching `prefer`, else the first usable agent
in registry order (Claude Code → Codex → OpenCode → Gemini → Grok → …).

## 5. Security posture

- Coding agents are **completion backends only** — no elevated privileges.
  Outputs flow through the same command/query bus, Zod validation, permissions,
  and audit as any provider (AGENTS.md invariants 1–2, 4).
- Secrets are read from the operator's own agent config, used in-process, and
  never persisted, logged, or exposed through any API.
- Detection is a probe, never a guarantee: `isUsable()` requires installed +
  providerKind + model + key + baseUrl all present.
- `provider.id` records attribution (`claude-code`, `codex`, …) so tracing and
  audit keep explainability.

## 6. Supported agents (registry)

Reusable credentials: claude-code, codex, opencode, gemini, grok, qwen, aider,
kimi, cline, pi, antigravity (needs `GOOGLE_API_KEY` + `ANTIGRAVITY_MODEL`),
goose, roo, kilocode, amp, minimax, mistral, hermes, continue.

Installed-but-OAuth (reported for self-dev handoff, not reusable as API key):
cursor, copilot, droid, cody, windsurf, auggie, openclaw, devin.

## 7. Limits & roadmap

- Claude Code OAuth logins are not API keys → needs `ANTHROPIC_API_KEY`
  (or a gateway token via `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`).
- Agents that speak only `responses` wire protocol on a custom gateway
  (e.g. Codex→Buzz) are detected; the harness uses the chat-completions path,
  so a `CODEX_WIRE_API=chat` override is surfaced in `detail` when needed.
- Future: a headless-CLI `AiProvider` (`claude -p` / `codex exec` /
  `opencode run`) as a fallback for agents without reusable credentials —
  the same detection registry feeds it.
