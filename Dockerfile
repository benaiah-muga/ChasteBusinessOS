# syntax=docker/dockerfile:1
#
# ChasteBusinessOS multi-target Dockerfile (buildx).
#
#   docker build --target api    -t chaste/api .
#   docker build --target web    -t chaste/web .
#   docker build --target worker -t chaste/worker .
#   docker build --target migrate -t chaste/migrate .
#
# All targets install the frozen pnpm workspace once (`deps`) and build only
# their own dependency graph with turbo, then `pnpm deploy` produces a
# self-contained production tree with workspace `dist` output inlined.

FROM node:22-slim AS base
ENV PNPM_HOME=/usr/local \
    CI=1
RUN npm install -g pnpm@9.15.0

FROM base AS deps
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile

# ── API ───────────────────────────────────────────────────────────────────
FROM deps AS api-build
RUN pnpm turbo run build --filter=@chaste/api
RUN pnpm --filter @chaste/api deploy --prod /out/api

FROM base AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-build /out/api ./
EXPOSE 3001
CMD ["node", "dist/index.js"]

# ── Web (Next.js) ─────────────────────────────────────────────────────────
FROM deps AS web-build
# Baked into client bundles at build time (server-side uses API_URL at runtime).
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm turbo run build --filter=@chaste/web
RUN pnpm --filter @chaste/web deploy --prod /out/web

FROM base AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=web-build /out/web ./
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]

# ── Worker ────────────────────────────────────────────────────────────────
FROM deps AS worker-build
RUN pnpm turbo run build --filter=@chaste/worker
RUN pnpm --filter @chaste/worker deploy --prod /out/worker

FROM base AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-build /out/worker ./
CMD ["node", "dist/index.js"]

# ── Migrations (one-shot job) ─────────────────────────────────────────────
FROM deps AS migrate-build
RUN pnpm turbo run build --filter=@chaste/db
RUN pnpm --filter @chaste/db deploy --prod /out/db

FROM base AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=migrate-build /out/db ./
CMD ["node", "dist/migrate.js"]
