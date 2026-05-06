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
# by the developer on the host. Production stages arrive in Phase 5.
FROM base AS dev
USER node
CMD ["sleep", "infinity"]
