# Gates: Docker deployment

Scope: production image build, Compose wiring, database-backed boot, and the repository verification gate.

- [x] G0: this ledger states runnable oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-DOCKER.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=81b152dc75be/36 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] G1: Docker Compose configuration is valid
  CHECK: docker compose config -q && echo DOCKER-COMPOSE-CONFIG-OK
  EXPECT: DOCKER-COMPOSE-CONFIG-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=81b152dc75be/36 entries; EXPECT=matched; output-sha256=117030382080764be7f246ee0f6d9dbe76e1dbc7cedd719750ec4d1170933f3b; output-bytes=25

- [ ] G2: the production web image builds from the repository root
  CHECK: docker build -f apps/web/Dockerfile -t chaste-web:verification . && echo DOCKER-IMAGE-BUILD-OK
  EXPECT: DOCKER-IMAGE-BUILD-OK
  EVIDENCE: pending

- [ ] G3: the composed database and web app become healthy and the app health endpoint reports a connected database
  CHECK: node scripts/verify-docker.mjs
  EXPECT: DOCKER-RUNTIME-OK
  EVIDENCE: pending

- [ ] G4: the repository verification gate passes after deployment changes
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo REPO-VERIFICATION-OK
  EXPECT: REPO-VERIFICATION-OK
  EVIDENCE: pending
