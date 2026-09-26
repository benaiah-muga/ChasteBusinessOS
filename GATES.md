# Gates: coding-plan connections and end-to-end business workflows

OWNS: apps/web/**, modules/**, packages/**, docs/**, CHANGELOG.md

Scope: Add safe user-owned coding-plan inference connections, then complete the requested CRM, POS, Products & Services, and Inventory workflows with responsive interfaces and tested cross-module outcomes.

- [ ] G1: Users can connect and revoke coding-plan inference through supported Codex and OpenCode runtimes
  EVIDENCE: pending

- [ ] G2: Buzz and other agents route inference through the selected user-owned connection
  EVIDENCE: pending

- [ ] G3: Connection owner, plan usage, fallback behavior, and background-run charging are visible and controlled
  EVIDENCE: pending

- [ ] G4: CRM mobile customer list prioritizes search and rows, and active filters stay visible
  EVIDENCE: pending

- [ ] G5: CRM saved views persist at workspace scope with sharing, pinning, filter summary, and counts
  EVIDENCE: pending

- [ ] G6: Customer profiles show a relevant next step linked to the underlying record and resolution action
  EVIDENCE: pending

- [ ] G7: Deal board and table support keyboard stage movement with forecast-aware review and lost-reason capture
  EVIDENCE: pending

- [ ] G8: CRM follow-up queue supports due, overdue, unassigned, and stale-contact work with inline actions
  EVIDENCE: pending

- [ ] G9: Customer import maps columns, previews and repairs rows, flags duplicates, and supports undo
  EVIDENCE: pending

- [ ] G10: Duplicate review uses normalized phone and fuzzy-name suggestions and preserves linked records and history on merge
  EVIDENCE: pending

- [ ] G11: AI follow-up drafts cite CRM source records and require a deliberate send action
  EVIDENCE: pending

- [ ] G12: CRM profile shows contact preferences, do-not-contact state, owner, and last editor
  EVIDENCE: pending

- [ ] G13: Empty POS setup offers add, import, and inventory paths with barcode and price in quick-add
  EVIDENCE: pending

- [ ] G14: POS scanning keeps focus and offers category, favorite, keyboard, stock, and price feedback
  EVIDENCE: pending

- [ ] G15: Mobile POS keeps total and checkout in reach while the cart expands for review
  EVIDENCE: pending

- [ ] G16: Split tender tracks remaining due and refuses completion until fully paid
  EVIDENCE: pending

- [ ] G17: Receipts support preview and sharing, and returns trace to the original sale with refund review
  EVIDENCE: pending

- [ ] G18: Shift close captures denominations, tender totals, variance explanation, and final review
  EVIDENCE: pending

- [ ] G19: Cashiers can park and resume carts without losing customer or line details
  EVIDENCE: pending

- [ ] G20: Loyalty enrollment and redemption require consent and show an accurate balance
  EVIDENCE: pending

- [ ] G21: Offline POS preserves carts, marks stale stock, queues sales safely, and retries without duplicates
  EVIDENCE: pending

- [ ] G22: Register metrics link to the transactions behind sales, averages, and top items
  EVIDENCE: pending

- [ ] G23: Catalog is presented as Products & Services with type, category, active, and stock filters
  EVIDENCE: pending

- [ ] G24: Service setup uses a billing unit and automatic code while hiding stock-only fields
  EVIDENCE: pending

- [ ] G25: Service delivery links quote or booking to staff, job or time-and-materials, completion, and invoice
  EVIDENCE: pending

- [ ] G26: Catalog import, duplicate checks, bulk edits, price history, and stock-history links are available
  EVIDENCE: pending

- [ ] G27: Goods and services show the operational details each needs
  EVIDENCE: pending

- [ ] G28: Inventory empty states guide first item, opening balance, and location setup
  EVIDENCE: pending

- [ ] G29: Mobile stock entry keeps scan, search, and item creation clear and reachable
  EVIDENCE: pending

- [ ] G30: Inventory tabs remain discoverable and usable at phone width
  EVIDENCE: pending

- [ ] G31: Stock transfers and reservations use searchable item and location selectors
  EVIDENCE: pending

- [ ] G32: Location workflows separate setup, transfers, reservations, and history by task
  EVIDENCE: pending

- [ ] G33: Inventory valuation explains its meaning in plain language and keeps ledger details secondary
  EVIDENCE: pending

- [ ] G34: Item, opening balance, location, unit, and adjustment reason share a reviewed setup flow
  EVIDENCE: pending

- [ ] G35: Reorder context connects incoming supply and supplier details through purchase and receipt
  EVIDENCE: pending

- [ ] G36: Reservations link to demand records and show available, reserved, and expected quantities
  EVIDENCE: pending

- [ ] G37: Cycle counts support location/item selection, scanning, progress, discrepancy review, and posting reason
  EVIDENCE: pending

- [ ] G38: Stock control presents prioritized alerts with explanations and direct actions
  EVIDENCE: pending

- [x] G39: Automated tests cover provider ownership, inference routing, checkout balances, import and merge integrity, and inventory workflows
  CHECK: corepack pnpm test && printf 'ALL TESTS PASSED\n'
  EXPECT: ALL TESTS PASSED
  EVIDENCE: corepack pnpm test passed all 24 tasks; the web suite passed 326 tests across 46 files.

- [x] G40: Workspace typechecking and lint pass
  CHECK: corepack pnpm typecheck && corepack pnpm lint && printf 'TYPECHECK AND LINT PASSED\n'
  EXPECT: TYPECHECK AND LINT PASSED
  EVIDENCE: pnpm typecheck passed across 26 packages; pnpm lint passed with zero errors and 214 existing warnings.

- [x] G41: Running Next.js routes compile and the edited mobile and desktop workflows render without browser or server errors
  EVIDENCE: Clean agent-browser session `chaste-clean-verify-20260926` rendered CRM, Sales, POS, Products, Inventory, Documents, Support, Purchasing, Manufacturing, HR, and Accounting at 320x568 with an empty browser error log. CRM also rendered at 1280x800; the customer row opened its profile. Screenshots are under `/tmp/chaste-ui-review/`.

- [x] G42: Relevant summary cards and CRM customer cards open their destinations without hidden mobile Workmate controls blocking taps
  EVIDENCE: At 320x568, CRM customer cards and Open profile open the profile; typing in the name field retains focus and the draft was discarded without saving. POS drawer totals open Sessions, Sales weighted forecast opens the filtered CRM pipeline, Inventory reorder opens Reorder, Products reorder opens the catalog with Needs reorder selected, Documents Awaiting parse opens the matching library filter, Support open inquiries opens the Open inbox filter, Purchasing Requests pending opens Requests, Manufacturing Open work orders opens Work orders, and HR Headcount opens People. At 1280x800 a CRM customer row opens the profile. Browser errors remained empty.
