# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22.13.0
ARG PNPM_VERSION=9.15.0

# ---------- base ----------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NODE_ENV=development \
    HOME=/home/node \
    XDG_CACHE_HOME=/home/node/.cache
# Install pnpm globally without corepack (corepack's signature verification
# breaks when running as a non-root user in this image).
RUN npm install -g pnpm@${PNPM_VERSION} \
    && mkdir -p /home/node/.local /home/node/.cache /pnpm/store \
    && chown -R node:node /home/node /pnpm \
    && chmod -R 0777 /pnpm
WORKDIR /app
# Pre-create /app/node_modules and chmod 0777 so the named volume that
# overlays it on first mount is writable regardless of which UID the
# container runs as. Local dev (matching UID 1000) and CI (runner UID
# 1001 or root) both write into the same volume without ownership
# clashes. /pnpm/store gets the same treatment above so pnpm's
# content-addressable store, configured via .npmrc, is writable too.
RUN mkdir -p /app/node_modules \
    && chown -R node:node /app \
    && chmod -R 0777 /app/node_modules

# ---------- dev ----------
# Used by docker compose for `app`, `worker`, and `tools` services. Source is
# bind-mounted from the host at runtime; node_modules lives in a named volume.
# The container runs as a non-root user matched to the host UID/GID (passed in
# via docker-compose `user:`) so files written into the bind mount stay owned
# by the developer on the host.
FROM base AS dev
USER node
CMD ["sleep", "infinity"]

# ---------- prod ----------
# Immutable production image. tsx is retained (it lives in devDependencies but
# is required at runtime — DECISION-1 forbids a compile/bundle step). A full
# pnpm install is performed so tsx is present; NODE_ENV is set to production
# after install so pnpm does not skip devDependencies during the install step.
# The CMD intentionally has no hardcoded role: compose overrides `command:`
# per service (pnpm --filter @prisma-bot/github-app run start:app|start:worker).
FROM base AS prod
# Copy workspace manifests and lockfile first for better layer caching.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY --chown=node:node apps/github-app/package.json ./apps/github-app/
COPY --chown=node:node packages/ ./packages/
# Install all dependencies (including devDependencies so tsx is available).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=0 \
    pnpm install --frozen-lockfile
# Copy the full source after installing to keep the install layer cached.
COPY --chown=node:node . .
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "echo 'Usage: override command with: pnpm --filter @prisma-bot/github-app run start:app  OR  start:worker' >&2; exit 1"]
