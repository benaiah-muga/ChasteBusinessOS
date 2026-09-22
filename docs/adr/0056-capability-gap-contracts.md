# ADR 0056: Capability gaps become behavior contracts

## Status

Accepted

## Decision

When the registry cannot satisfy a requested behavior, the honesty path
creates a tenant-scoped `capability_gap` ticket containing the requested
capability id, desired behavior, acceptance criteria, and optional example
input. The ticket explicitly records that no execution was attempted.

## Consequence

Product and Creator work receives a bounded contract to implement and verify,
instead of an ambiguous feature request or an invented capability result.
