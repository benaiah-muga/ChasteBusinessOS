# Deploying on Google Cloud

Recommended topology: **Cloud Run** for `api`, `web`, `worker`, and **Cloud
Run Jobs** for `migrate`, with **Cloud SQL (PostgreSQL 16)** and **Cloud
Storage** as the backup object store. Artifact Registry hosts the images.

## 1. Push images to Artifact Registry

```bash
export REGION=us-central1
export IMAGE=us-docker.pkg.dev/$PROJECT_ID/chaste

gcloud auth configure-docker $REGION-docker.pkg.dev

docker build --target migrate -t $IMAGE:migrate .
docker build --target api     -t $IMAGE:api .
docker build --target web     -t $IMAGE:web .
docker build --target worker  -t $IMAGE:worker .
docker push $IMAGE:migrate && docker push $IMAGE:api
docker push $IMAGE:web && docker push $IMAGE:worker
```

## 2. Database

Create a Cloud SQL Postgres 16 instance (private IP recommended) and a
database + user. Connection string:

```
DATABASE_URL=postgres://USER:PASS@10.x.x.x:5432/chaste
```

Use Cloud SQL Auth Proxy or a VPC connector from Cloud Run. Enable automated
backups and PITR.

## 3. Cloud Run jobs (migrate)

```bash
gcloud run jobs create chaste-migrate \
  --image $IMAGE:migrate \
  --region $REGION --vpc-connector=$CONNECTOR \
  --set-env-vars DATABASE_URL=$DATABASE_URL
gcloud run jobs execute chaste-migrate --region $REGION --wait
```

Rerun on every deploy after updating the image.

## 4. Cloud Run services

Create `chaste-api` and `chaste-worker` with the same env surface as the
compose contract (`CHASTE_SESSION_SECRET`, `CHASTE_BOOTSTRAP`,
`CHASTE_ADMIN_*`, plus email/backup vars). `chaste-api` needs:

```
--set-env-vars API_URL=https://api.example.com,WEB_ORIGIN=https://app.example.com
--port 3001
```

Allow unauthenticated invocation on `api` and `web` (auth is app-level). The
**worker must run as exactly one replica** (outbox consumer); Cloud Run
min-instances 1, max 1.

`chaste-web` needs the build-time arg baked in — build it locally with
`--build-arg NEXT_PUBLIC_API_URL=https://api.example.com` before pushing.

## 5. Backups

Platform snapshots use Cloud Storage. Give the worker service account
`roles/storage.objectUser` on the bucket and set `CHASTE_S3_BUCKET` /
`CHASTE_S3_REGION` / keys. `CHASTE_S3_ENDPOINT` can point at the Google Cloud
Storage XML API if you prefer S3-style credentials.

## 6. Ingress

Cloud Run issues managed TLS. Point an external HTTPS load balancer (or a
domain mapping) at `api` and `web`, set `API_URL` and `WEB_ORIGIN` to the
public HTTPS origins, and set the web's `NEXT_PUBLIC_API_URL` at build.
