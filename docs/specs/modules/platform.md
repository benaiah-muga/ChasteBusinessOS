# Module spec: Platform (branches, identity, gaps, marketplace, time)

**Status:** Draft SMB baseline  
**Module id:** `platform` (+ `core-system` always-on queries)  
**Related:** [product-architecture-next.md](../../product-architecture-next.md), [agent-harness.md](../agent-harness.md), [self-development.md](../self-development.md), [scheduling-and-comms.md](../scheduling-and-comms.md)

## 1. Purpose

Platform is the control plane of the Business OS: identity, RBAC, branches, module install/marketplace, org settings, autonomy policy, capability catalog/gaps, notifications, and (progressively) calendar/reminders/email.

## 2. Actors

| Role | Needs |
|---|---|
| Owner / admin | Branches, users, roles, installs, autonomy, marketplace publish |
| Manager | Branch-scoped ops, invite team, view audit in scope |
| Operator | Switch branch, use installed modules, chat with AI under policy |
| Auditor | Read audit, explanations, gap ticket history |
| Agent (same principal) | Tools limited by user permissions; never elevate |

## 3. Entities (target)

| Entity | Status target |
|---|---|
| Organization | exists |
| User | exists |
| Role / Permission / assignment | exists (expand) |
| Branch | **implemented (Horizon A)** |
| UserBranchAccess | **implemented (Horizon A)** |
| ModuleInstall / MarketplaceListing | exists |
| Capability / CapabilityGapTicket | **implemented (Horizon A)** |
| Notification | **implemented (foundation)** |
| CalendarEvent / Reminder / FollowUp | **later** |
| EmailOutbox | **later** |
| Chat session / Memory nodes | ai-core + db (cross-cutting); history + feedback **Horizon A** |

## 4. Multi-branch

### 4.1 Model

```
Organization
  └── Branch { id, name, code, timezone?, parentBranchId?, active }
  └── UserBranchAccess { userId, branchId, roleIds? }
```

- Session: `activeBranchId` (null = all allowed branches for principals with `core.branch.all`)
- UI: list **all accessible branches**; switcher in global chrome
- AI: "switch to …", "open second branch in Nairobi" → multi-step plan

### 4.2 Commands / queries (target)

| Name | Purpose | Priority |
|---|---|---|
| `core.branch.list` | All branches user can see | P0 |
| `core.branch.create` | Create branch | P0 |
| `core.branch.update` | Rename/deactivate | P0 |
| `core.branch.set_active` | Session switch | P0 |
| `core.branch.grant` / `revoke` | User access | P1 |

### 4.3 AI intents

- List branches / switch branch
- Open new location (create branch + seed warehouse if inventory installed + assign manager)

## 5. Users & RBAC

| Capability | Priority |
|---|---|
| Roles & permissions UI | exists -- deepen |
| Invite / activate / deactivate | P0 |
| Session revoke / list | P1 |
| Branch-scoped role assignment | P1 |
| SSO / OIDC | P2 |
| Service accounts | P2 |
| Break-glass admin | P2 (documented) |

**AI constraint:** security_sensitive risk class; confirm minimum; no auto role elevation in guarded_auto without explicit policy allowlist.

## 6. Capability catalog & gaps

| Name | Purpose |
|---|---|
| `core.capability.catalog.list/search` | Machine catalog |
| `core.capability.gap.create/update/list/confirm` | Gap tickets |
| `core.customization.handoff` | Self-dev pipeline |

See [self-development.md](../self-development.md).

## 7. Marketplace

Existing install/archive flows; extend with:

- Publish from resolved gap (permissioned)
- Region filters (config `CHASTE_REGIONS`)
- Distinguish `builtin` \| `marketplace` \| `local_extension` \| `private_cloud`

## 8. Time & communications

See [scheduling-and-comms.md](../scheduling-and-comms.md). Platform owns commands; worker delivers.

## 9. UI nav (module world)

Suggested Platform sidebar:

- Overview
- Branches
- Users & invites
- Roles & permissions
- Modules / Marketplace
- Capability gaps
- Notifications
- Calendar (when ready)
- Autonomy & AI settings
- Audit

Global chrome always shows: **branch switcher**, notification bell, AI chat entry.

## 10. SMB checklist (baseline)

- [x] Create and switch branches
- [x] See all allowed branches
- [ ] Invite user to org (and optionally branch)
- [x] Assign roles without raw SQL
- [x] Install/uninstall module from marketplace
- [x] Configure autonomy level with warnings
- [x] File and view capability gap tickets
- [x] Receive in-app notification foundation (list/mark read)
- [ ] Set a reminder in natural language (when C4+)

## 11. Non-goals

- Full multi-company consolidation accounting in v1
- SCIM before invite/password basics
- Agent-managed superuser without audit
