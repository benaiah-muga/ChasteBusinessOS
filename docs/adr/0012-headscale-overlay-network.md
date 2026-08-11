# ADR 0012 — Private overlay network (Headscale + Tailscale clients) as the infrastructure security layer

## Status

Accepted (2026-08-08) — deployment/infrastructure decision; no app-code coupling.

## Context

ChasteBusinessOS is self-hostable and ships `docker-compose.prod.yml` with
publicly bound ports (`API_BIND`/`WEB_BIND`) and a Postgres/Redis backend that
operators may leave exposed on a LAN or publish. The app-level security model
(RBAC, per-command permissions, audit — see ADR 0011) protects _inside the
API_, but there is no identity/authorization at the _network_ layer: nothing
stops anyone who can reach port `5432` from talking to Postgres directly, or a
compromised web client from laddering to the worker.

Goal: a second, orthogonal layer of security — "who may reach which service at
all" — implemented with a fully self-hostable, open-source control plane so no
third-party SaaS is required to operate the mesh.

## Decision

Use **Headscale** (BSD-licensed, fully open control plane implementing the
Tailscale control protocol) with **Tailscale clients** on each node (servers,
operator laptops, optional thin clients). This is the operator's explicit
choice over Nebula / Netbird (both fully open end-to-end but with less mature
Tailscale-client ecosystem and tooling).

Deployment shape:

- Headscale runs as one more service (its own container or host package) with
  its private control-plane port only reachable by mesh nodes.
- `api`, `worker`, `postgres`, `redis`, and the operator's jump/admin box all
  join the same tailnet; `postgres`/`redis`/`worker` **stop publishing public
  interfaces** and accept connections only over the tailnet (`tailscale0` /
  `100.64.0.0/10`) with Postgres `pg_hba.conf` limited to `10.0.0.0/8` tailnet
  ranges.
- ACLs (Headscale policy file) express "api ⇄ postgres", "worker ⇄ postgres",
  "api ⇄ redis" as the only allowed flows; the web app remains the single
  public entry point and still talks to the API over the public HTTPS ingress.
- Node identity (Tailscale keys) is separate from application identity (RBAC +
  API keys, ADR 0011) — the two layers never share state.

This is **infrastructure only**: `images/*`, routes, and the command bus are
unchanged. `docker-compose.prod.yml` gains a `headscale` service and drops the
public port mappings for non-ingress services when the mesh is enabled.

## Backward compatibility

- The compose file defaults remain today's public-bind behavior; the mesh
  layout is opt-in via a `CHASTE_MESH` profile so single-host dev and small
  LANs are unaffected.
- No API/DB code changes are required by this ADR — it is a deployment posture.

## Consequences

- Defense in depth: DB/Redis/worker are unreachable except from authenticated,
  ACL-approved mesh peers — even a compromised API container cannot reach
  Postgres from outside the tailnet's approved peers without node keys.
- Operational cost: running the control plane, enrolling nodes, and curating
  the ACL policy file. Node-key rotation must be part of the runbook.
- Explicit non-goal: the mesh does **not** fix application-layer findings
  (auth bypass, RCE, IDOR) — those were remediated separately (F1–F7,
  CHANGELOG 2026-08-08). The overlay and app auth are complementary, never
  substitutes.
