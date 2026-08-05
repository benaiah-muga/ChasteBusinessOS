# Spec: PWA installability & multi-device access (Tailscale)

**Status:** Draft  
**Related:** [ARCHITECTURE.md](../../ARCHITECTURE.md), [configuration.md](../configuration.md)

## 1. Goal

- **Web first** is a Progressive Web App: installable on desktop and mobile, works offline for shell/static assets, and reuses the same HTTP API as future native apps.
- **Secure multi-device access** to self-hosted instances uses **Tailscale** (or equivalent zero-trust overlay) rather than exposing the SoR on the public internet by default.

Native mobile apps remain a later horizon; the API contract must not depend on browser-only APIs for core business operations.

## 2. PWA requirements (web)

| Requirement | Implementation |
|---|---|
| Web App Manifest | `apps/web/public/manifest.webmanifest` — name, icons, `display: standalone`, theme colors |
| Service worker | Cache app shell + static assets; network-first for `/api/*` (never cache authenticated API responses as authoritative SoR) |
| Installability | HTTPS (or localhost); manifest + SW registered from root layout |
| Icons | At least 192 and 512 PNG (or SVG where supported) |
| Offline | Shell + last-known UI chrome; chat/history require network |
| Push (later) | Optional Web Push for notifications; not required for installability |

**Security:** Service worker must not store secrets, auth tokens in Cache API, or offline-write business mutations without server confirmation.

## 3. Tailscale / private access

| Pattern | Guidance |
|---|---|
| Self-host default | API + web bind on private interface or Tailscale IP; no open `0.0.0.0` without reverse proxy + auth |
| Multi-device | Devices join same Tailnet; access `https://chaste.<magicdns>` or IP |
| Exit nodes / subnet | Optional for office LAN resources; document in deploy guide |
| Auth still required | Tailscale is transport trust, **not** RBAC. Session tokens and permissions still apply |
| Cloud tenants | Public HTTPS + org auth; Tailscale optional for private deployments |

Config knobs (document in `configuration.md` when wired):

- `CHASTE_BIND_HOST` — e.g. Tailscale IP or `127.0.0.1`
- `CHASTE_PUBLIC_URL` — canonical origin for resource links and PWA
- `CHASTE_TRUST_PROXY` — when behind reverse proxy

## 4. Resource access correctness

Even on private networks, chat must not emit dead links. See [ui-correctness-and-safety.md](./ui-correctness-and-safety.md): `resource_link` is server-resolved with allowlisted path templates.

## 5. Phasing

| Phase | Deliverable |
|---|---|
| P0 | Manifest + icons + SW registration (installable web) |
| P1 | Offline shell polish; install prompt UX |
| P2 | Deploy docs for Tailscale + bind host |
| P3 | Web Push + mobile deep links (pre-native) |
