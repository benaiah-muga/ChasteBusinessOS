# Deploying on Azure

Recommended topology: **Azure Container Apps** for `api`, `web`, `worker`,
with **Azure Container Registry (ACR)** and an **Azure Database for PostgreSQL
(Flexible Server, 16)**. Backup object store: **Azure Blob Storage** via the
S3-compatible endpoint, or the local `CHASTE_BACKUP_DIR` with an attached
volume.

## 1. Build and push to ACR

```bash
export RG=chaste-prod
export ACR=chasteacr
az acr create --resource-group $RG --name $ACR --sku Basic
az acr login --name $ACR
IMAGE=$ACR.azurecr.io/chaste

docker build --target migrate -t $IMAGE:migrate .
docker build --target api     -t $IMAGE:api .
docker build --target web     -t $IMAGE:web .
docker build --target worker  -t $IMAGE:worker .
docker push $IMAGE:migrate && docker push $IMAGE:api
docker push $IMAGE:web && docker push $IMAGE:worker
```

## 2. Database

`az postgres flexible-server create` (PostgreSQL 16), then set
`DATABASE_URL=postgres://USER:PASS@HOST:5432/chaste`. Use a private endpoint
or the server's firewall allow-list for the Container Apps environment's
outbound IPs. Enable geo-redundant backups + PITR.

## 3. Container Apps

One environment containing three apps plus a one-shot job:

- `chaste-migrate` — a Container App Job (manual trigger), image
  `$IMAGE:migrate`. Run it once per deploy before scaling services.
- `chaste-api` — image `$IMAGE:api`, container port 3001, ingress on
  `api.example.com` with managed certificate.
- `chaste-web` — image `$IMAGE:web`, container port 3000, ingress on
  `app.example.com`. Rebuild with
  `--build-arg NEXT_PUBLIC_API_URL=https://api.example.com`.
- `chaste-worker` — no ingress, **scale to exactly 1** replica.

Environment variables follow the compose contract (`CHASTE_SESSION_SECRET`,
`CHASTE_BOOTSTRAP`, `CHASTE_ADMIN_*`, email, backups). Store secrets in a Key
Vault and inject via Container Apps secret references.

## 4. Backups

Platform snapshots write to Blob Storage through the S3-compatible endpoint:

```
CHASTE_S3_ENDPOINT=https://chaste.blob.core.windows.net
CHASTE_S3_BUCKET=chaste-backups
CHASTE_S3_ACCESS_KEY_ID=<storage-account-name>
CHASTE_S3_SECRET_ACCESS_KEY=<storage-account-key>
CHASTE_S3_REGION=us-east-1   # ignored for Azure, required by the schema
```

## 5. TLS

Container Apps ingress provisions managed TLS certs; set `API_URL`,
`WEB_ORIGIN`, and the web build arg to the public HTTPS origins.
