# ADR 0066: Persisted document workspaces and virtual folders

## Status

Accepted

## Context

Authored documents previously stored only their current rich-text body and published versions. Folder navigation was inferred from strings already attached to documents, so empty folders could not exist and a parent shown by the interface was not always a real record. Draft page settings and business-record provenance were also lost outside the browser. PDF output depended on the visible application layout, which made pagination unreliable.

## Decision

- Keep document title, type, linked-record identity, folder path, and page settings on the authored document.
- Keep page settings with drafts and immutable published versions so reopening or restoring a version reproduces its layout.
- Store virtual folders as organization-scoped records. Creating a nested folder persists every parent path. Renaming a folder updates its descendants and contained documents atomically.
- Route folder and document metadata changes through kernel capabilities. Every query and update includes an explicit organization predicate even when row-level security is active.
- Keep keystroke autosaves in the draft workspace described by ADR 0056, while publishing remains an audited capability.
- Render a dedicated print surface from the saved editor HTML. Page size, orientation, margins, table headers, images, and page-break rules are applied only to that surface.

## Consequences

Users can create empty folder structures, move and rename documents without losing their location, and see the exact source record used to populate a template. Drafts reopen with the same content and layout. PDF output no longer depends on navigation chrome or the current screen size. Folder renames are transactional and tenant-scoped, but destructive removal is refused until nested folders and documents have been moved.
