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
FROM deps AS build
ENV NODE_ENV=production
RUN pnpm run build

# runner: prod-only deps, migrations run automatically at boot from the
# web app's instrumentation hook
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    AUTO_MIGRATE_ON_BOOT=1 \
    CHASTE_SKIP_MIGRATION_BACKUP=1
COPY --from=build /app /app
RUN pnpm install --prod --frozen-lockfile
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]