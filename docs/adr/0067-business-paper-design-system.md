# ADR 0067: Business paper, a structure-keyed template design system

## Status

Accepted

## Context

The built-in document templates rendered as generic rich text: boxed tables, a plain heading, labels glued to values in running paragraphs. Gallery cards compounded the problem with a fake skeleton preview and a description block, so the first thing a customer judged the product by was its weakest surface. Documents created from a template were then edited in Tiptap and printed through a separate print stylesheet, so three render paths (template preview, editor paper, print/PDF) disagreed with each other.

Tiptap constrains what template content can carry: only schema-known nodes and attributes survive an editing session, so design intent cannot ride into created documents as metadata or CSS classes stored in the JSON.

## Decision

- Compose all built-in templates from a shared kit with one anatomy: letterhead grid, ledger rule, party blocks, ruled data tables, a compact totals block, and composed signature lines. Placeholders keep the existing token vocabulary so record prefill keeps working.
- Key the visual design on document structure, not metadata: a table whose first row holds header cells is a data table (ruled, with money columns right-aligned by header wording); a headerless table is a layout grid; the first grid is the letterhead; grids containing total wording become totals blocks; all-caps short bold paragraphs render as eyebrows. The JSON renderer bakes these classes in; a DOM refiner applies the same rules to Tiptap-generated HTML for the editor paper and print surface, so hand-drawn documents get the same treatment.
- Style the three surfaces from one CSS system (fixed paper inks that do not flip in dark mode; Georgia for body, sans small caps for labels). The ledger rule, a thick ink bar with the gold hairline tucked under it, is the one signature element; everything else stays quiet.
- Rebuild gallery cards around real paper: the thumbnail is a scaled live rendering of the actual template with presentable demo values, the name and a spec chip sit below it, and descriptions move to the preview dialog. Category chips with counts replace the type dropdown, and templates outside the catalog render under Other instead of being skipped.
- Treat the studio form as the template's editing surface: using a template commits it under a file name and keeps the form open (saved status, Download PDF from the live preview, Save a copy after further edits). The word editor stays available from the library as a deliberate choice for freeform work, never as a forced stop in the template flow.
- Vary documents by design group, not by new products: financial papers (quotations, invoices, receipts, vouchers, purchase orders) dress the shared anatomy with a large ink title, dark ruled table headers, and a banded grand total; delivery notes keep light rules under a large title; employment paper keeps the modest gold title. The group rides the document type, so a saved paper inherits its treatment everywhere it renders.
- Treat system templates as code-owned: seeding adds missing built-ins and refreshes seeded ones whose content changed, while never touching custom templates. The template list capability now returns content so custom templates get real thumbnails.

## Consequences

Every surface a customer sees, from the first thumbnail to the printed invoice, reads as one designed object, and the guarantee is enforced by a structural verification gate rather than taste. The heuristics are conventions: an all-caps short paragraph anywhere in a document will render as an eyebrow, and a headerless table is treated as layout, which matches how the built-ins and the editor's own table tool behave. Organizations that seeded older templates receive the new designs automatically; documents already created from them are immutable history and are left as they were. Template flow no longer detours through the word editor, so committing a quotation takes one click in the form, and the editor reverts to what it is for: writing and restructuring documents from scratch.
