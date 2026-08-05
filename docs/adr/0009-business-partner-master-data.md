# ADR 0009 — Business Partner as shared master data

## Status
Accepted

## Context
The platform had three isolated "party" records — `crm_customers`,
`hr_employees`, `pur_vendors` — plus a just-added `crm_contacts`. Each duplicated
name/email/location with no shared identity. The same human ("Jane Smith") could
appear as an employee and as a vendor contact with no way to know they were one
person. CRM customers and vendors can also be companies ("Acme Ltd"), not just
individuals.

## Decision
Introduce a single platform-level master record, **business partner**
(`business_partners` table), that holds the universal identity for any external
or internal party. It carries:

- `type`: `person` | `organization` — *what the partner IS*
- shared identity fields: name, email, phone, city, country, notes
- `status`: `active` | `archived` (soft delete)

Module "role" tables (`crm_customers`, `pur_vendors`, `hr_employees`,
`crm_contacts`) keep their role-specific fields and gain a nullable
`businessPartnerId` FK. This is a **two-dimensional model**:

| Dimension | Values | Meaning |
|---|---|---|
| type | person \| organization | what the partner is |
| roles | customer, vendor, employee, contact | what the partner does in a context |

A single business partner can hold multiple roles (employee AND vendor contact;
organization that is both customer and vendor).

### Naming
"Business partner" (SAP S/4HANA BP convention) over "people", because the record
covers organizations as well as individuals — "people" is semantically wrong for
an org-type record. Code surface uses the abbreviation `bpartner`
(`core.bpartner.*`, `core.bpartner.manage/read`).

### Ownership
Business partners are **platform master data**, owned by the `platform` module
(`core.bpartner.*` commands/queries), not by any business module — mirroring how
`users`/`organizations`/`branches` are already shared. This respects the
"no cross-module private joins" rule: modules access `business_partners` through
the shared `@chaste/db` schema, not via private joins.

## Backward compatibility
- `businessPartnerId` is nullable on all role tables, so existing records keep
  working without a partner.
- Module create commands remain backward compatible; person-linkage
  (accept `personId` to reuse an existing partner, or auto-create from inline
  fields) is layered on in follow-up work without breaking existing callers.

## Consequences
- One identity per party across the system; deduplication and cross-module
  views ("show me everything about Acme") become possible.
- The Directory UI (`/directory`) is the single place to manage parties.
- Role tables become thinner over time (role-specific fields only) as shared
  identity migrates to `business_partners`.
- Future: module create commands accept `businessPartnerId` to link an existing
  partner rather than re-entering name/email.
