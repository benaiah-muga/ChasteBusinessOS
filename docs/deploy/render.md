# Deploying on Render

Render supports the four images as **Web Services** (`api`, `web`), a
**Background Worker** (`worker`), and a one-off **Job** for migrations
(`migrate`). Use Render's managed **PostgreSQL**.

## 1. Create resources

| Resource         | Type              | Image / Build               |
| ---------------- | ----------------- | --------------------------- |
| `chaste-db`      | Render Postgres   | —                           |
| `chaste-migrate` | Job (manual)      | Dockerfile target `migrate` |
| `chaste-api`     | Web Service       | Dockerfile target `api`     |
| `chaste-worker`  | Background Worker | Dockerfile target `worker`  |
| `chaste-web`     | Web Service       | Dockerfile target `web`     |

For a Blueprint instead of the dashboard, use a `render.yaml`:

```yaml
services:
  - type: web
    name: chaste-api
    runtime: docker
    dockerfilePath: ./Dockerfile
    dockerCommand: ""
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: chaste-db
          property: connectionString
      - key: CHASTE_SESSION_SECRET
        sync: false
      - key: CHASTE_BOOTSTRAP
        value: "true"
    healthCheckPath: /health
    buildFilter:
      paths:
        - apps/api/**
        - packages/**
        - modules/**

  - type: worker
    name: chaste-worker
    runtime: docker
    dockerfilePath: ./Dockerfile

  - type: web
    name: chaste-web
    runtime: docker
    dockerfilePath: ./Dockerfile
    envVars:
      - key: API_URL
        value: https://chaste-api.onrender.com

  - type: job
    name: chaste-migrate
    runtime: docker
    dockerfilePath: ./Dockerfile

databases:
  - name: chaste-db
    databaseName: chaste
    plan: basic
```

## 2. Target-specific builds on Render

Render builds `./Dockerfile` by default; to select a target, pass a
`DOCKER_TARGET` build arg by setting an environment variable
`RENDER_BUILD_DOCKER_TARGET=api` (Render injects it as a Docker build arg for
the `Dockerfile`). Verify each service's Dockerfile build target in the
dashboard before first deploy.

## 3. Web build arg

`chaste-web` must bake `NEXT_PUBLIC_API_URL` at build time. Render's web
service needs `RENDER_BUILD_DOCKER_TARGET=web` and an env var
`NEXT_PUBLIC_API_URL=https://chaste-api.onrender.com` (available at build).

## 4. Run order

Trigger `chaste-migrate` once after `chaste-db` exists, then deploy
`chaste-api` and `chaste-worker`, then `chaste-web`. Keep the worker at a
single instance (outbox consumer).
