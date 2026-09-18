# syntax=docker/dockerfile:1
#
# Production image for the Chaste BusinessOS web app (Next.js, apps/web).
# Build from the REPO ROOT so the pnpm workspace resolves:
#
#   docker build -f apps/web/Dockerfile -t chaste-web .
#   docker compose up --build app
#
# The container runs `next start` and migrates the database on boot
# (apps/web/src/instrumentation.ts). In production it refuses to serve
# when the migration fails, so a deploy can never serve new code against
# an old schema. Point it at Postgres with DATABASE_URL.
#
# NEXT_PUBLIC_* values bake in at build time; pass --build-arg to change
# them (defaults suit `docker compose up` on localhost).

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:${PATH}" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# Trim the workspace to what `web` needs (turbo prune).
FROM base AS pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.5.8 prune --scope=web --docker

# Install exactly the pruned lockfile, then build the app. The pnpm store lives
# in a build cache mount so a flaky registry link resumes instead of restarting.
# No database needed for the build: dynamic routes render on demand and
# prerendering never touches Postgres (verified: `next build` passes with
# an unreachable DATABASE_URL).
FROM base AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --network-concurrency 4 --fetch-retries 5 --fetch-timeout 120000
COPY --from=pruner /repo/out/full/ ./
# turbo prune tracks packages, not tsconfig extends: every workspace
# tsconfig reaches up to this file, so it comes along explicitly.
COPY ./tsconfig.base.json ./
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
# Route collection imports server modules that require these variables to
# exist, but the build must not connect to Postgres. Keep the placeholders
# scoped to this command so they cannot become image metadata or runtime env.
RUN DATABASE_URL=postgresql://build:build@localhost:1/build \
    BETTER_AUTH_SECRET=build-only-placeholder \
    pnpm --filter web build
# Next's standalone output does not copy these static assets by default.
RUN mkdir -p apps/web/.next/standalone/apps/web/.next \
    && cp -r apps/web/public apps/web/.next/standalone/apps/web/public \
    && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
    && mkdir -p apps/web/.next/standalone/apps/web/node_modules/@chaste/db \
    && cp packages/db/package.json apps/web/.next/standalone/apps/web/node_modules/@chaste/db/package.json \
    && cp -r packages/db/drizzle apps/web/.next/standalone/apps/web/node_modules/@chaste/db/drizzle

# Minimal runtime: the traced standalone server, nothing else.
FROM node:${NODE_VERSION}-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
WORKDIR /app/apps/web
USER node
EXPOSE 3000
ENV HOSTNAME=0.0.0.0 PORT=3000 \
    CHASTE_MIGRATIONS_FOLDER=/app/apps/web/node_modules/@chaste/db/drizzle
CMD ["node", "server.js"]
