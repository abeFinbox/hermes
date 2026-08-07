# syntax=docker/dockerfile:1
# Declared BEFORE the first FROM so it is a global ARG — an ARG after a FROM is
# scoped to that stage only, and `FROM ${K6_IMAGE}` would then resolve to blank.
# Pinned and multi-arch: BuildKit resolves it per $TARGETPLATFORM, so the same
# line yields linux/arm64 on an Apple laptop and linux/amd64 in CI, with no
# architecture logic of our own.
# TODO: pin the manifest-list digest once a registry is reachable —
#   docker buildx imagetools inspect grafana/k6:2.0.0 | grep Digest
# then use  grafana/k6:2.0.0@sha256:<digest>
ARG K6_IMAGE=grafana/k6:2.0.0

# --- Stage 1: build the frontend into static assets ---
FROM node:24-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build            # -> /app/frontend/dist

# --- k6, for Hera (load testing) — see the global ARG at the top ---
FROM ${K6_IMAGE} AS k6bin

# --- Stage 2a: runtime WITHOUT Hera ---
# Build this with `--target runtime-slim` for an image identical to the
# pre-Hera one: same size, and no dependency on pulling grafana/k6. Hera then
# reports available:false and the UI disables the launch button.
FROM node:24-bookworm-slim AS runtime-slim
ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./

# the backend serves ../../frontend/dist when it exists (single-container deploy)
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# persistent SQLite data lives here — mount a volume at /data in production
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data

EXPOSE 4000
# runs TypeScript directly via tsx (a dependency); no separate backend build step
CMD ["npm", "run", "start"]

# --- Stage 2b: DEFAULT runtime — the slim image plus k6 ---
# Last on purpose: a plain `docker build .` and the unchanged compose `build:`
# stanzas therefore produce the Hera-capable image.
FROM runtime-slim AS runtime
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6
ENV HERA_K6_BIN=/usr/local/bin/k6
