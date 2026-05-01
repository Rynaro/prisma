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
    && chown -R node:node /home/node /pnpm
WORKDIR /app
# Pre-create /app/node_modules with node ownership so the named volume that
# overlays it inherits the right permissions on first mount.
RUN mkdir -p /app/node_modules \
    && chown -R node:node /app

# ---------- dev ----------
# Used by docker compose for `app`, `worker`, and `tools` services. Source is
# bind-mounted from the host at runtime; node_modules lives in a named volume.
# The container runs as a non-root user matched to the host UID/GID (passed in
# via docker-compose `user:`) so files written into the bind mount stay owned
# by the developer on the host. Production stages arrive in Phase 5.
FROM base AS dev
USER node
CMD ["sleep", "infinity"]
