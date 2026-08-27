# syntax=docker/dockerfile:1

# ChasteBusinessOS — Render demo image.
#
# Multi-stage: install -> build -> run.
# The @chaste/* workspace packages export raw TypeScript and are compiled by
# Next at build time (transpilePackages), so the runner must ship the whole
# monorepo tree with production deps so pnpm workspace symlinks resolve at
# `next start` time. No `output: standalone` for that reason.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@11.9.0
WORKDIR /app

# deps: full install so turbo/next/dev tools are present for the build
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# build: turbo builds every package that defines a build script (web);
# packages without one are skipped (they export source, transpiled by Next)
#
# Render injects its service environment variables as the build args below;
# both are consumed by `next build` (the DB for route-metadata collection,
# NEXT_PUBLIC_APP_URL is inlined into client bundles). They are read-only in
# this stage, never copied into the runner stage, so no secrets land in the
# final image.
FROM deps AS build
ARG DATABASE_URL
ARG NEXT_PUBLIC_APP_URL
ENV NODE_ENV=production \
    CHASTE_SKIP_MIGRATION_BACKUP=1
# Build web directly (not via turbo): no @chaste/* package defines a build
# script (they export TS source transpiled by Next), and turbo scrubs
# arbitrary env vars from task children unless explicitly allowed.
RUN pnpm --filter web run build

# runner: prod-only deps, migrations run automatically at boot from the
# web app's instrumentation hook
FROM base AS runner
ENV NODE_ENV=production \
    CI=true \
    PORT=3000 \
    AUTO_MIGRATE_ON_BOOT=1 \
    CHASTE_SKIP_MIGRATION_BACKUP=1
COPY --from=build /app /app
RUN pnpm install --prod --frozen-lockfile
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]