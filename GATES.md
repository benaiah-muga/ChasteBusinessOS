# Gates: coding-plan connections and end-to-end business workflows

OWNS: apps/web/**, modules/**, packages/**, docs/**, CHANGELOG.md

Scope: Add safe user-owned coding-plan inference connections, then complete the requested CRM, POS, Products & Services, and Inventory workflows with responsive interfaces and tested cross-module outcomes.

- [ ] G1: Users can connect and revoke coding-plan inference through supported Codex and OpenCode runtimes
  EVIDENCE: pending

- [ ] G2: Buzz and other agents route inference through the selected user-owned connection
  EVIDENCE: pending

- [ ] G3: Connection owner, plan usage, fallback behavior, and background-run charging are visible and controlled
  EVIDENCE: pending

- [x] G4: CRM mobile customer list prioritizes search and rows, and active filters stay visible
  EVIDENCE: At 320x568, search, Filters, Import CSV, and Add customer are visible before the customer rows, with no always-open creation form. Opening Filters reveals status, owner, stale-contact, duplicate, and tag controls. Selecting “No activity 30d” leaves a removable active-filter chip in the list view. Screenshots: `/tmp/chaste-ui-review/crm-customer-list-320x568-review.png` and `/tmp/chaste-ui-review/crm-filter-active-chip-320x568.png`.

- [x] G5: CRM saved views persist at workspace scope with sharing, pinning, filter summary, and counts
  EVIDENCE: At 320x568, Save view showed the active filter and matching customer count, with team sharing enabled and pinning available. A browser-only `/api/crm/views` response verified the saved list renders its pinned state, filter summary, team visibility, and live count. The route was removed and no persistent view was written. The UI uses the workspace GET/POST endpoint, and the server route stores views by organization. Screenshot: `/tmp/chaste-ui-review/crm-saved-view-list-320x568.png`.

- [x] G6: Customer profiles show a relevant next step linked to the underlying record and resolution action
  EVIDENCE: At 320x568, a browser-only mocked customer with an overdue invoice shows the invoice number, age, and outstanding amount in both the customer card and profile. “Open invoice” from the profile reaches Accounting Receivables, where the focus query is consumed. The mock was removed and no write occurred. Browser errors remained empty. Screenshot: `/tmp/chaste-ui-review/crm-profile-next-step-320x568.png`.

- [x] G7: Deal board and table support keyboard stage movement with forecast-aware review and lost-reason capture
  EVIDENCE: At 320x568, a browser-only mocked deal shows value, time in stage, and forecast in Table view. ArrowRight on a focused Proposal card opens a review showing weighted forecast USh 500,000 → USh 700,000. Selecting Lost shows the lost-reason field and keeps Mark lost disabled until a reason is entered. Selecting Won from the table stage control also opens the review. All reviews were canceled, no POST to `/api/deals` was made, the route mock was removed, and the browser error log remained empty. Screenshots: `/tmp/chaste-ui-review/crm-pipeline-forecast-review-320x568.png` and `/tmp/chaste-ui-review/crm-pipeline-table-default-320x568.png`.

- [x] G8: CRM follow-up queue supports due, overdue, unassigned, and stale-contact work with inline actions
  EVIDENCE: At 320x568, a browser-only task/customer fixture populates Due today, Overdue, Unassigned, No recent contact, and All open views. The overdue row exposes reassignment, snooze, and complete controls. “Create follow-up” from the stale-customer view prefilled and linked the new follow-up form. No POST was made, both mocks were removed, and the browser error log remained empty. Screenshot: `/tmp/chaste-ui-review/crm-followup-queue-today-320x568.png`.

- [x] G9: Customer import maps columns, previews and repairs rows, flags duplicates, and supports undo
  EVIDENCE: At 320x568, imported a local preview CSV without sending customer data to the server. Auto-mapped name, email, and phone, showed a likely existing-customer match, blocked a row with a missing name, and allowed inline correction. On mobile, each row now uses an editable card instead of a clipped desktop table; duplicate override and row selection remain available. Mocked only `POST /api/import` to verify Import complete and Undo this import, then replaced the response to verify Import undone. Removed the mock, made no real import, and saw no browser errors. Screenshots: `/tmp/chaste-ui-review/crm-import-mobile-cards-320x568.png` and `/tmp/chaste-ui-review/crm-import-mobile-footer-320x568.png`.

- [x] G10: Duplicate review uses normalized phone and fuzzy-name suggestions and preserves linked records and history on merge
  EVIDENCE: At 320x568, browser-only customer fixtures produced normalized-phone and similar-name matches. Each review showed the reason, both full names, contact details, linked invoice/task previews, survivor selection, and clear history-preservation/undo copy. The phone cards no longer overflow the dialog or truncate distinguishing name text. No merge was submitted; all customer, deal, and timeline mocks were removed, real customer rows reloaded, and browser errors remained empty. Screenshots: `/tmp/chaste-ui-review/crm-duplicate-phone-review-320x568.png` and `/tmp/chaste-ui-review/crm-duplicate-fuzzy-names-visible-320x568.png`.

- [x] G11: AI follow-up drafts cite CRM source records and require a deliberate send action
  EVIDENCE: At 320x568, a mocked `/api/crm` draft response populated editable subject and body fields plus clickable invoice and task sources. Editing retained focus, Copy draft confirmed completion, and Open in email app produced a `mailto:` destination without sending. The server rejects do-not-contact profiles and the UI hides outreach controls for them. Removed the mock without performing a CRM write. Screenshot: `/tmp/chaste-ui-review/crm-ai-followup-draft-final-320x568.png`.

- [x] G12: CRM profile shows contact preferences, do-not-contact state, owner, and last editor
  EVIDENCE: At 320x568, the customer profile showed the preferred-contact selector, do-not-contact control, owner selector, and “Last edited by Muganzi Benaiah · 4h ago” context. The customer name is editable in the same profile. Screenshot: `/tmp/chaste-ui-review/crm-customer-profile-320x568-review.png`.

- [x] G13: Empty POS setup offers add, import, and inventory paths with barcode and price in quick-add
  EVIDENCE: At 320x568, a browser-only open-register/catalog fixture shows Add a product, Import spreadsheet, and Open Inventory. Quick add keeps name, price, opening stock, barcode, and Save product visible in the first view; SKU and unit are tucked under More details. Typing in the name retained focus. The register and catalog mocks were removed, the form was canceled, and no product or stock action was submitted. Screenshots: `/tmp/chaste-ui-review/pos-custom-action-320x568.png` and `/tmp/chaste-ui-review/pos-quick-add-stock-320x568.png`.

- [x] G14: POS scanning keeps focus and offers category, favorite, keyboard, stock, and price feedback
  EVIDENCE: At 320x568, the scan field appears before customer lookup. With a browser-only register/catalog fixture, scanning the barcode showed 2.5 bags available at USh 24,000; Enter added the item and returned focus to the scan field, with the focused field centered between the sticky app header and checkout bar. The Services shortcut showed the service with its hourly price, a favorite could be pinned and unpinned, `/` focused search, and Ctrl+Backspace removed the selected cart line. Only read-only shift-summary requests reached the POS route mock; no sale or stock POST was sent. Removed all mocks and the test cart. Screenshots: `/tmp/chaste-ui-review/pos-scan-first-screen-empty-cart-320x568.png`, `/tmp/chaste-ui-review/pos-services-shortcut-320x568.png`, `/tmp/chaste-ui-review/pos-barcode-match-320x568.png`.

- [x] G15: Mobile POS keeps total and checkout in reach with one-tap cart review
  EVIDENCE: At 320x568, the page stays 305px wide, the sticky bar shows the full USh 24,000 total and an explicit Complete sale action, and Review cart scrolls the line into view above checkout. The search field remains centered above the sticky bar after an item is added. No sale was submitted. Screenshots: `/tmp/chaste-ui-review/pos-cart-sticky-checkout-fixed-320x568.png`, `/tmp/chaste-ui-review/pos-cart-review-action-320x568.png`.

- [x] G16: Split tender tracks remaining due and refuses completion until fully paid
  EVIDENCE: At 320x568 using browser-only POS fixtures, split tender rows give the payment method a readable full-width selector, show the amount and remove action without horizontal overflow, and offer Cash, Card, and Mobile money. An under-allocated split shows the remaining amount and disables checkout; a cash shortfall shows the short amount in red and in the sticky action; adding an empty third payment shows Enter amounts. Exact cash/card allocation with USh 5,000 received against USh 4,000 cash allocation shows USh 1,000 change due and enables checkout. Did not submit a sale. Removed API mocks and cleared the test cart. Screenshots: `/tmp/chaste-ui-review/pos-split-payment-mobile-row-fixed-320x568.png`, `/tmp/chaste-ui-review/pos-split-payment-underpaid-320x568.png`, `/tmp/chaste-ui-review/pos-split-cash-short-final-320x568.png`, `/tmp/chaste-ui-review/pos-split-third-method-empty-320x568.png`, `/tmp/chaste-ui-review/pos-split-change-due-centered-320x568.png`.

- [ ] G17: Receipts support preview and sharing, and returns trace to the original sale with refund review
  EVIDENCE: pending

- [x] G18: Shift close captures denominations, tender totals, variance explanation, and final review
  EVIDENCE: At 320x568, a browser-only shift fixture showed separate opening float, cash sales, expected drawer cash, and captured sales totals by cash, card, and mobile money. Counting nine USh 50,000 notes matched the USh 450,000 drawer expectation and opened a review with all tender totals. Reducing the count by one note required a variance explanation; the final review repeated the expected and counted amounts, tender breakdown, and saved reason. Cancelled before confirmation, removed the POS API mock, and verified the real closed-register setup view again. No sale, refund, or register closure was submitted. Screenshots: `/tmp/chaste-ui-review/pos-shift-tenders-320x568.png`, `/tmp/chaste-ui-review/pos-shift-final-review-balanced-320x568.png`, `/tmp/chaste-ui-review/pos-shift-final-review-variance-320x568.png`.

- [x] G19: Cashiers can park and resume carts without losing customer or line details
  EVIDENCE: At 320x568 with browser-only POS fixtures, Alt+P parked the cart and showed one parked entry; Resume restored the product line and total. Removed the test cart from local browser storage, cleared all network mocks, and sent no sale request.

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

- [x] G28: Inventory empty states guide first item, opening balance, and location setup
  EVIDENCE: On the real empty inventory at 320x568, Stock levels shows Add first item, Create a location, and Open Products & Services. The inline item form includes opening balance and reorder point before any item is saved. Screenshot: `/tmp/chaste-ui-review/inventory-empty-setup-actions-320x568.png`.

- [x] G29: Mobile stock entry keeps scan, search, and item creation clear and reachable
  EVIDENCE: At 320x568, stock entry has a visible Add item shortcut alongside stock on hand, barcode scan/search stays in the first screen, and the empty state links to create a location or open Products & Services. Add item scrolls to the form and focuses the item-name field within the visible area. The document width stays at 305px, so the page does not overflow the 320px viewport. Screenshots: `/tmp/chaste-ui-review/inventory-stock-empty-320x568.png`, `/tmp/chaste-ui-review/inventory-add-item-focused-320x568.png`.

- [x] G30: Inventory tabs remain discoverable and usable at phone width
  EVIDENCE: At 320x568, the section tabs stay horizontal, show a clipped next-tab label, a scroll track, and a swipe hint. Selecting the hidden Locations tab brings it into view without using a dropdown. Screenshot: `/tmp/chaste-ui-review/inventory-overview-current-320x568.png`.

- [x] G31: Stock transfers and reservations use searchable item and location selectors
  EVIDENCE: At 320x568 with browser-only inventory fixtures, transfer source/destination search matched the human-readable location names, options retained codes, and item search returned the name, SKU, unit, and available quantity. The reservation item selector showed the same stock details. Enter selected the focused choice by keyboard. Cleared the mock and reloaded real inventory without posting a transfer or reservation. Screenshots: `/tmp/chaste-ui-review/inventory-transfer-search-options-320x568.png`, `/tmp/chaste-ui-review/inventory-reservation-search-options-320x568.png`.

- [x] G32: Location workflows separate setup, transfers, reservations, and history by task
  EVIDENCE: At 320x568, Locations presents creation and location status first, then separate Transfers and Reservations disclosures with pending/active counts. Expanding Transfers reveals the searchable source, destination, item, quantity, and transfer history controls. Browser errors remained empty. Screenshot: `/tmp/chaste-ui-review/inventory-location-disclosures-320x568.png`.

- [x] G33: Inventory valuation explains its meaning in plain language and keeps ledger details secondary
  EVIDENCE: The stock overview explains what stock value and available quantity mean, with moving-average and ledger details inside a collapsed native disclosure. Verified collapsed and expanded on a 320x568 screen. Screenshots: `/tmp/chaste-ui-review/inventory-valuation-explanation-320x568.png`, `/tmp/chaste-ui-review/inventory-valuation-explanation-open-320x568.png`.

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
  EVIDENCE: pnpm test passed all 24 tasks; the web suite passed 331 tests across 46 files.

- [x] G40: Workspace typechecking and lint pass
  CHECK: corepack pnpm typecheck && corepack pnpm lint && printf 'TYPECHECK AND LINT PASSED\n'
  EXPECT: TYPECHECK AND LINT PASSED
  EVIDENCE: pnpm typecheck passed across 26 packages; pnpm lint passed with zero errors and 215 warnings.

- [x] G41: Running Next.js routes compile and the edited mobile and desktop workflows render without browser or server errors
  EVIDENCE: Clean agent-browser session `chaste-clean-verify-20260926` rendered CRM, Sales, POS, Products, Inventory, Documents, Support, Purchasing, Manufacturing, HR, and Accounting at 320x568 with an empty browser error log. CRM also rendered at 1280x800; the customer row opened its profile. Screenshots are under `/tmp/chaste-ui-review/`.

- [x] G42: Relevant summary cards and CRM customer cards open their destinations without hidden mobile Workmate controls blocking taps
  EVIDENCE: At 320x568, CRM customer cards and Open profile open the profile; typing in the name field retains focus and the draft was discarded without saving. POS drawer totals open Sessions, Sales weighted forecast opens the filtered CRM pipeline, Inventory reorder opens Reorder, Products reorder opens the catalog with Needs reorder selected, Documents Awaiting parse opens the matching library filter, Support open inquiries opens the Open inbox filter, Purchasing Requests pending opens Requests, Manufacturing Open work orders opens Work orders, and HR Headcount opens People. At 1280x800 a CRM customer row opens the profile. Browser errors remained empty.

- [x] G43: CRM saved-view review shows the active filters and count with reachable save actions on a 320x568 phone
  EVIDENCE: At 320x568, Customers > Filters > No activity 30d > Save view collapses the filter panel and opens a dialog showing “Active · No activity 30d” plus the matching count. The view-name field gets focus without scrolling the description under the sticky title; Cancel and Save remain visible above the bottom navigation. Real keystrokes stayed focused, the draft was cleared without saving, and the browser error log remained empty. Screenshot: `/tmp/chaste-ui-review/crm-filter-save-dialog-320x568-final.png`.

- [x] G44: Accounting aging summary cards open the matching outstanding invoices, with a clear reset
  EVIDENCE: At 320x568, selecting 90+ days scrolls below the sticky Accounting header to the matching ledger, marks the selected range, and shows an explicit empty result when there are no matching invoices. “Show all invoices” clears the filter. No accounting action was submitted. Screenshot: `/tmp/chaste-ui-review/accounting-aging-drilldown-result-320x568.png`.
