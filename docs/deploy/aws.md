# Deploying on AWS

Recommended topology: **ECS Fargate** services + **RDS PostgreSQL (16)** +
**Elastic Container Registry (ECR)** + **S3** backup store, behind an
**Application Load Balancer** with ACM TLS. EKS works too but adds operational
weight with no benefit at this scale.

## 1. Push images to ECR

```bash
export AWS_REGION=us-east-1
export IMAGE_URI=123456789012.dkr.ecr.$AWS_REGION.amazonaws.com/chaste

aws ecr create-repository --repository-name chaste --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $IMAGE_URI

docker build --target migrate -t $IMAGE_URI:migrate .
docker build --target api     -t $IMAGE_URI:api .
docker build --target web     -t $IMAGE_URI:web .
docker build --target worker  -t $IMAGE_URI:worker .
docker push --all-tags $IMAGE_URI
```

## 2. Infrastructure

- **RDS**: PostgreSQL 16 with the `vector` extension is not required to run the
  platform (Drizzle schema is plain SQL); use standard Postgres 16. Enable
  automated snapshots + point-in-time recovery. Place in the same VPC/subnet
  as the services or allow the security group.
- **S3**: one bucket for backups. Give the task role `s3:PutObject`,
  `s3:GetObject`, `s3:ListBucket`.
- **Secrets**: store secrets in **Secrets Manager** and reference them in the
  ECS task definition (`CHASTE_SESSION_SECRET`, `CHASTE_BACKUP_KEY`, RDS
  credentials, API keys). Never put them in the task definition literally.

## 3. ECS services

Create four task definitions from the same **Dockerfile targets**:

| Task             | Family                                            | Runs                    |
| ---------------- | ------------------------------------------------- | ----------------------- |
| `chaste-migrate` | one-off `RunTask`/`execute_command`               | `chaste/migrate`        |
| `chaste-api`     | service (1+ replicas), ALB target group `/health` | `chaste/api`, port 3001 |
| `chaste-web`     | service (1+ replicas), ALB host rules             | `chaste/web`, port 3000 |
| `chaste-worker`  | service, exactly 1 replica                        | `chaste/worker`         |

Environment for all: `DATABASE_URL`, `CHASTE_SESSION_SECRET`,
`CHASTE_BOOTSTRAP=true` on first deploy, `CHASTE_ORG_NAME`,
`CHASTE_ADMIN_EMAIL`, `CHASTE_ADMIN_NAME`. `api` and `web` additionally get:

- `API_URL=https://api.example.com`, `WEB_ORIGIN=https://app.example.com`
- `web` build arg `NEXT_PUBLIC_API_URL=https://api.example.com`

Worker adds `CHASTE_S3_BUCKET`/`REGION`/access keys + `CHASTE_BACKUP_KEY`.

**Run order:** `chaste-migrate` once → start `api` + `worker` → start `web`.
The worker must run as a single replica (outbox consumer) until queue scale-out
is added.

## 4. Backups

Platform snapshots (encrypted with `CHASTE_BACKUP_KEY`) are written to S3 by
the worker job loop; restore from the `/data` page. RDS snapshots cover the
database itself — the platform snapshot and RDS snapshot are complementary.

## 5. TLS / routing

- ALB listener :443 with ACM certificate.
- `chaste-api` target group health check path `/health`.
- Host-based rules: `api.example.com → chaste-api`, `app.example.com →
chaste-web`.
- `CHASTE_SMTP_SECURE=true` if your SMTP relay uses implicit TLS on 465.
