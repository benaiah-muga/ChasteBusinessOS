# syntax=docker/dockerfile:1.7
# The workspace target is also used by the one-shot database setup services.
# Keep build dependencies out of the static web runtime image.

FROM node:24-bookworm-slim AS workspace
ENV PNPM_HOME="/pnpm" PATH="/pnpm:${PATH}" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --filter '@chaste/web-vite...' --filter '@chaste/db...' --frozen-lockfile --store-dir /pnpm/store --network-concurrency 4 --fetch-retries 5 --fetch-timeout 120000

FROM workspace AS builder
RUN pnpm --filter @chaste/web-vite build

FROM nginx:1.29-alpine AS runner
COPY apps/web-vite/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web-vite/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
