# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS base
WORKDIR /workspace
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.26.0 --activate

# Dependency manifests only, so ordinary source edits reuse this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/sqlite/package.json packages/sqlite/
COPY packages/postgres/package.json packages/postgres/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=evuharness-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @evu/harness-web build

# Production runtime: static assets behind an unprivileged nginx.
FROM ${NGINX_IMAGE} AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "--spider", "-q", "http://127.0.0.1:8080/"]

# Dev image: Vite dev server against bind-mounted source.
FROM deps AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      curl \
      vim-tiny \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 4300
CMD ["pnpm", "--filter", "@evu/harness-web", "dev"]
