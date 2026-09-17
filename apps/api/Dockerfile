# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

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
RUN pnpm run build

# Production runtime: built workspace plus a minimal on-call debug toolkit.
FROM ${NODE_IMAGE} AS runtime
WORKDIR /workspace
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    EVUHARNESS_API_PORT=4301 \
    EVUHARNESS_HOST=0.0.0.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      curl \
      vim-tiny \
      iproute2 \
      iputils-ping \
      netcat-openbsd \
      dnsutils \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.26.0 --activate

COPY --from=builder --chown=node:node /workspace /workspace
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 4301
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4301/health || exit 1
CMD ["pnpm", "--filter", "@evu/harness-api", "start"]

# Dev image: dependencies plus a toolkit. Compose bind-mounts source over
# /workspace, so edits do not require a rebuild.
FROM deps AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      curl \
      vim-tiny \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*
ENV EVUHARNESS_API_PORT=4301 \
    EVUHARNESS_HOST=0.0.0.0
EXPOSE 4301
CMD ["pnpm", "--filter", "@evu/harness-api", "dev"]
