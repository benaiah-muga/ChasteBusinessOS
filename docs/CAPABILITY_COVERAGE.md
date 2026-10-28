# Capability coverage audit

This page is the module-by-module answer to one question: can the agent see
and use the same capabilities a person can, under the same governance?

The rule is now enforced in code, not by documentation alone:

- Every supported capability is in the discovery catalog after registration.
- Every visible capability has a reviewed agent contract.
- Every exception is `humanOnly` or `agentHidden` with a reason in
  `capability_agent_contract_test.go`.
- Registering a capability without a contract fails CI.

Run the gate with:

```sh
cd apps/api
go test ./internal/capability -run 'TestEveryCapability|TestEveryVisible|TestProjectsList|TestAgentHidden'
```

## What changed

| Gap found | Fix |
|---|---|
| `projects.list` was a non-capability read used by the human projects page | Promoted to a governed `projects.list` capability with `projects.read`, module gate, audit event, and agent contract. The custom `ReadProjectCollection` bypass is gone. |
| 17 supported capabilities had no discovery catalog entry | 8 business capabilities were exposed with contracts; 9 credential, identity, system, or inverse-checkpoint capabilities were marked `agentHidden` with reasons. |
| New capabilities could be executable but invisible until someone regenerated a catalog | The catalog now merges `capabilitySpecs` after all domain inits. A conformance test still requires an authored contract before release. |
| No test prevented human-only business actions from silently losing agent parity | `TestEveryCapabilityIsDiscoverableOrReviewedHidden` requires every exception to be reviewed, and every visible capability to resolve with a useful contract. |
| The organization agent persona (`agent_soul`) was an admin write outside the kernel | It is now the governed `iam.setAgentSoul` capability with an audit event, an `iam.restoreAgentSoul` inverse, and a direct agent tool. |
| The agent could not read the approval policy it operates under | `iam.getOrgPolicy` returns the autonomy ceiling, money threshold, and always-approval risk classes with an audit event. |
| A module could be added to the switchboard without a capability | `TestEveryInstalledModuleHasCapabilities` requires every installed module to have a supported, agent-visible capability. |
| Direct HTTP writes could grow silently | `TestDirectHTTPWritesAreReviewedExceptions` lists every HTTP-layer file that writes to PostgreSQL outside the executor, with its reason, and fails on a new one. |
| Workmate lost the thread on reload and Agent runs could only replay | Workmate resumes from `?session=`, persists the active session per organization and user, rebuilds the transcript, and exposes Continue links from Agent runs and the recent list. |

## Module matrix

Counts are supported capabilities. `visible` means discoverable by an agent
with the right permission. `humanOnly` requires an authenticated human session.
`agentHidden` is deliberately outside model discovery for a reviewed reason.
`catalog` is the number with a discovery entry after the automatic merge.
`handTools` is the number with a hand-written tool contract, which is a subset
of the catalog.

| Module | Total | Visible | Human only | Agent hidden | Catalog | Hand tools |
|---|---:|---:|---:|---:|---:|---:|
| accounting | 73 | 73 | 0 | 0 | 73 | 16 |
| analytics | 8 | 8 | 0 | 0 | 8 | 7 |
| creator | 15 | 14 | 1 | 0 | 14 | 1 |
| crm | 28 | 27 | 1 | 0 | 27 | 10 |
| documents | 29 | 29 | 0 | 0 | 29 | 4 |
| harness | 1 | 1 | 0 | 0 | 1 | 0 |
| hr | 26 | 26 | 0 | 0 | 26 | 6 |
| iam | 19 | 12 | 0 | 7 | 13 | 2 |
| inventory | 33 | 33 | 0 | 0 | 33 | 12 |
| manufacturing | 17 | 17 | 0 | 0 | 17 | 1 |
| marketing | 5 | 5 | 0 | 0 | 5 | 1 |
| messaging | 25 | 25 | 0 | 0 | 25 | 0 |
| notifications | 2 | 2 | 0 | 0 | 2 | 2 |
| operations | 3 | 3 | 0 | 0 | 3 | 3 |
| pos | 6 | 6 | 0 | 0 | 6 | 1 |
| projects | 12 | 12 | 0 | 0 | 12 | 4 |
| purchasing | 30 | 30 | 0 | 0 | 30 | 14 |
| routines | 5 | 5 | 0 | 0 | 5 | 0 |
| sales | 8 | 7 | 0 | 1 | 7 | 4 |
| settings | 3 | 2 | 1 | 0 | 3 | 0 |
| signals | 1 | 1 | 0 | 0 | 1 | 1 |
| skills | 2 | 2 | 0 | 0 | 2 | 2 |
| support | 18 | 16 | 0 | 2 | 16 | 5 |

The matrix counts 368 supported capabilities. `iam.bootstrapOrganization` is a
pre-organization capability and is intentionally outside the organization
executor, so it is not included.

## Reviewed exceptions

`humanOnly`:

- `crm.listCustomerCollection`: the CRM page's rich 500-row profile collection.
  Agents use `crm.listCustomers` and `crm.customerTimeline` instead.
- `creator.reviewProposal`: a terminal human decision. An inverse would erase
  the decision.
- `harness.listCompositions`: the human approval queue for composed runtime
  profiles.

`agentHidden`:

- `iam.scimProvisionUser`: external SCIM provisioning is authenticated by an
  Identity Provider assertion, not an agent turn.
- `iam.createSCIMToken`, `iam.revokeSCIMToken`: one-time bearer material and a
  token id that is only listed in the human IAM console.
- `iam.createSSOConnection`, `iam.disableSSOConnection`,
  `iam.restoreSSOConnection`: client secrets and organization-wide sign-in.
- `support.updateChannelSettings`, `support.restoreChannelSettings`: the public
  widget embed token.
- `sales.restoreDraftOrder`: the internal inverse checkpoint used by the
  session revert path. People edit through `sales.updateDraftOrder`, whose
  inverse now plans the restore input from the nested `before` snapshot.
- `iam.restoreAgentSoul`: the internal inverse checkpoint for
  `iam.setAgentSoul`; people set the persona through the primary capability.

## Assurance boundary

This audit claims that every installed business module has at least one
supported, agent-visible capability; that every business-module write executes
through the capability kernel; and that every visible capability has a reviewed
contract. It does not claim that every HTTP route is a capability. Auth, public
tokenized invoice views, support widget intake, chat and session storage,
ledger/session/metrics observability, document editor autosave, evaluation
tooling, and platform credential configuration are explicit seams. The 14
direct-write files and the read mapping below are the complete reviewed list:
a new direct write fails the inventory test until it is governed or added with
a reason.

## Direct write exceptions

`TestDirectHTTPWritesAreReviewedExceptions` scans the Go HTTP package for
`INSERT`, `UPDATE`, and `DELETE` statements outside the executor. These are the
only reviewed files that still contain one. None of them changes a business
module's domain records:

| File | Why it is not a business capability |
|---|---|
| `ai_connections.go` | Coding-agent connection setup is human platform configuration; credentials and local process control never enter a model turn. |
| `ai_tools_mcp.go` | MCP session and trajectory storage around governed capability calls. |
| `chat_session.go` | Agent session and trajectory storage for the chat infrastructure. |
| `documents_editor_workspace.go` | Ephemeral draft autosave, presence, and soft locks, not published documents. |
| `documents_ingest_collection.go` | Queues a parse job and marks the document queued around the governed ingest capability. |
| `evaluations_store.go` | Internal quality-evaluation run storage, not business state. |
| `invitations.go` | Invitation claim and identity lifecycle, governed by ADR 0053. |
| `messaging_agent_session.go` | Agent session and token accounting around governed message capabilities. |
| `my_work_summary.go` | Coding-agent usage counters after a governed summary call. |
| `notification_preferences.go` | Per-user notification preference, authenticated and self-scoped. |
| `onboarding.go` | Onboarding checklist state and setup notifications around the governed bootstrap capability. |
| `portal_invoice.go` | Tokenized public invoice view and view tracking. |
| `support_auto_reply_budget.go` | Rate-limit and auto-reply budget counters. |
| `support_public.go` | Public support widget intake and visitor binding, governed by ADR 0025 containment. |

Adding a new direct write fails the test until it is either routed through the
executor or added to the reviewed map with a reason. The test is a file-level
review gate, not a semantic proof, so a reviewer still checks that a new write
inside an already-listed file is the same kind of infrastructure work.

## Read seams and their capability equivalents

The UI also has read routes that aggregate data for a page. They are not
business writes, but the agent needs an equivalent way to see the same facts.
The current mapping:

| Human read surface | Agent equivalent |
|---|---|
| Dashboard and My work | `signals.list`, `accounting.overview`, `accounting.arAging`, `purchasing.apAging`, `inventory.stockReport`, `crm.listTasks`, `hr.leaveCalendar`, plus `recent_changes` |
| Notifications | `notifications_inbox` built-in and `notifications.markRead` |
| Approvals inbox | `approvals_inbox` built-in; decisions stay human |
| Team and roles | `iam.listMembers` returns members, roles, and permissions |
| Ledger | `recent_changes` for state-changing events and the accounting reports for balances; raw payload audit remains a human observability surface |
| Sessions, durable runs, metrics | Observability of agent work; the agent does not list human sessions |
| Record search and entity pickers | `resolve_entity`, `crm.listCustomers`, `support.listConversations`, `inventory.listLocations` |
| Setup, module switchboard, branding, AI config | Platform administration reads; writes use `iam.setModules`, `iam.setModuleConfig`, `iam.setOrgBranding`, and `settings.configureAiProvider` |
| Approval policy | `iam.getOrgPolicy` reads the active policy; `iam.setOrgPolicy` changes it |
| POS, sales, support, and CRM customer pickers | `crm.listCustomers` and the module read capabilities |
| Portal invoice and print views | Tokenized public document reads; the agent uses `accounting.customerStatement`, `accounting.listInvoices`, and `sales.listOrders` |

The module matrix above is the stronger check: every module on the
switchboard must have at least one supported, agent-visible capability, and
every installed business module has read and write capabilities unless it is
informational by design (analytics, signals, skills).

## Adding a capability

1. Register the spec in `capabilitySpecs` or a domain spec table, with the
   module, permission, risk, and inverse.
2. Implement the parser and handler. State changes must be reversible.
3. Add a model-facing contract: the capability spec's `title`, `intent`, and
   `inputSchema` fields, `agent_tool_contracts.json`, or the migration manifest.
   The intent must be at least 40 characters and the input schema must be a
   closed object (or a union of closed objects).
4. If the capability must not be agent-visible, add `humanOnly` or an
   `agentHidden` reason and add it to the reviewed map in
   `capability_agent_contract_test.go`. Do not hide a business action because
   the UI route already exists.
5. Run `go test ./internal/capability ./internal/httpapi`. The conformance
   tests fail if the contract is missing, the schema is open, the exception is
   unreviewed, a module has no visible capability, or a new direct write has
   no reviewed reason.

The catalog is rebuilt at process startup, so `pnpm agents:catalog` is no
longer required for a new Go capability to be discoverable. It remains the
generator for the checked-in manifest index.

## Workmate resume

- `GET /api/sessions/{id}` already returns the session record and ordered
  events. Workmate reuses it; no new route was needed.
- `resumeChat` fetches the session, rebuilds text, tool activity, record cards,
  pending approvals, and clarifications, and sets the session id used by the
  next turn.
- The active session pointer is stored in `localStorage` under
  `chaste:chat:session:v1`, scoped by organization and user.
- `/chat?session=<id>` is the continuation link used by Agent runs and the
  Workmate recent list.
- The floating Workmate dock restores the last conversation lazily when it is
  opened, so a person can continue from any workspace page.
- `New` clears the pointer and starts fresh. The previous session remains in
  Agent runs for replay and revert.
