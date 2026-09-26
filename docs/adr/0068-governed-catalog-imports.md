# ADR 0068: Governed catalog imports

## Status

Accepted

## Context

The onboarding CSV importer could add catalog rows directly, but it was not available from the catalog and did not send imported changes through the same capability and audit path as item creation. Service businesses also need to import billable work without inventing a physical product SKU or stock balance.

## Decision

- Route product and service imports through `inventory.importItems`, with workspace permission checks, input validation, duplicate checks, audit recording, and a declared inverse.
- Skip an imported row when its SKU or barcode already exists in the workspace or earlier in the same file. Return skipped row numbers for a clear result summary.
- Allow service rows to receive generated service codes when their spreadsheet has no SKU. Store the billing unit as the service unit label and clear stock-only fields.
- Undo a batch by archiving only the item IDs returned from that batch. The inverse restores the same item IDs so references and any later history remain intact.
- Keep opening balances out of catalog import. Staff record stock quantities through Inventory so the stock ledger always has a reason and actor.

## Consequences

- Catalog imports are available after onboarding and use the governed item capability.
- The spreadsheet preview can flag current SKU and barcode matches before submission; the capability repeats that check at write time to avoid race conditions.
- Importing a service does not create stock, barcode, or reorder behavior.
- Item history is preserved when an import is undone, and undo is itself auditable.
