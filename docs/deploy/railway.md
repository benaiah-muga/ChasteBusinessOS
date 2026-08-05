# Deploying on Railway

Railway runs containers with a `railway.json` per image or one config with
services. Use Railway's **PostgreSQL** plugin, a **pre-deploy command** for
migrations, and Railway variables for secrets.

## 1. Postgres plugin

Add a PostgreSQL plugin from the dashboard. Railway sets `DATABASE_URL` for
linked services automatically.

## 2. One config, four services

`railway.json` (or separate deployments per image):

```json
{
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE"
  }
}
```

Create four Railway services from the same repo, each selecting its target by
setting the build variable:

| Service   | Docker target | Notes                            |
| --------- | ------------- | -------------------------------- |
| `migrate` | `migrate`     | one-off; run manually per deploy |
| `api`     | `api`         | public port 3001                 |
| `worker`  | `worker`      | internal, scale to 1             |
| `web`     | `web`         | public port 3000                 |

## 3. Target selection

Railway maps the Docker target via a build variable named `DOCKER_TARGET`
(in Service → Settings → Build). Set it per service.

## 4. Variables

Link each service to the Postgres plugin, then set in Service → Variables:

```
CHASTE_SESSION_SECRET      # Railway Variable Reference or generated
CHASTE_BOOTSTRAP=true
CHASTE_ADMIN_EMAIL / CHASTE_ADMIN_NAME / CHASTE_ORG_NAME
API_URL / WEB_ORIGIN       # public HTTPS URLs (api + web)
```

The `web` service additionally needs `NEXT_PUBLIC_API_URL` as a build-time
variable (Service → Variables → Build Variables).

## 5. Migrations

Migrations run via the `migrate` service's start command (default
`node dist/migrate.js`). Trigger it after the Postgres plugin exists and after
every deploy that changes schema. Optionally use Railway's pre-deploy command
field on `api` to run the migrate image's command first.

Keep the worker at a single replica.
