# ADR 0067: Workspace CRM views and reversible customer imports

## Status

Accepted

## Context

Saved CRM filters need to follow a person across devices and be useful to a team. Customer imports also need a review step because a spreadsheet can contain malformed rows or near-duplicate records, and a mistaken import should have a clear recovery path without deleting linked history.

## Decision

- Store saved customer views in the workspace with their filters, creator, sharing state, and pin state. Private views are visible to their creator; shared views are visible to CRM users in the workspace.
- Show the current customer count beside each saved view so the name and filters can be checked before opening it.
- Import reviewed customer rows through `crm.importCustomers`, a governed capability. Likely duplicates are skipped unless a reviewer explicitly allows a row.
- Make import undo a governed soft-deactivation of only the imported customer IDs. The inverse restores those records. Existing linked deals, tasks, invoices, and documents remain attached.
- Keep matching deterministic and explainable. Email, normalized phone, exact normalized name, and close normalized name matches identify a likely duplicate; they do not merge records automatically.

## Consequences

- Views work across devices and can be shared without copying filter settings by hand.
- Counts are live snapshots from the customer list, so they may change as records change.
- Import undo preserves relationships and audit history, but deactivates imported customer records rather than physically deleting them.
- Duplicate review remains a human decision. A separate side-by-side merge workflow is still needed before records can be consolidated safely.
