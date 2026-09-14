# ADR 0044: Validate routine schedules as a discriminated contract

Status: Accepted

Date: 2026-09-14

## Context

Routine schedules can arrive as natural-language text or structured input.
The old parser accepted a valid interval prefix and ignored trailing text, and
the structured schema accepted impossible clock values. Updating a name or
prompt also recomputed the next run even though the schedule had not changed.

## Decision

Use one discriminated Zod schema for routine schedule inputs. Interval
schedules require a bounded `everyMinutes` value; daily and weekday schedules
require a valid `HH:MM`; weekly schedules additionally require a day from 0 to
6. Anchor deterministic text patterns to the complete input so unsupported
qualifiers are rejected rather than silently discarded. Recompute `nextRunAt`
only when the schedule itself changes.

## Consequences

- Invalid or ambiguous schedules fail before persistence.
- A routine rename, prompt edit, or enable/disable action does not move its
  already planned next occurrence.
- Timezone, DST, missed-run policy, and reversible archive/restore remain a
  separate follow-up because they require persisted business policy and a
  migration.
