# syntax=docker/dockerfile:1
# --- k6, for Hera (load testing) ---
# See the note in ./Dockerfile — same pin, same multi-arch reasoning.
# TODO: pin the manifest-list digest once a registry is reachable —
#   docker buildx imagetools inspect grafana/k6:2.0.0 | grep Digest
ARG K6_IMAGE=grafana/k6:2.0.0
FROM ${K6_IMAGE} AS k6bin

# --- Stage 1: build the static Go binary (modernc sqlite = pure Go, no cgo) ---
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY backend-go/go.mod backend-go/go.sum ./
RUN go mod download
COPY backend-go/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/hermes-go .

# --- Stage 2a: minimal runtime WITHOUT Hera ---
# Build with `--target runtime-slim` for the pre-Hera image (15.4MB content).
FROM gcr.io/distroless/static-debian12 AS runtime-slim
WORKDIR /app

COPY --from=build /out/hermes-go /app/hermes-go
# docs served by /api/docs — ship them so the Docs page works on this backend too
COPY README.md USER_MANUAL.md HOW-TO-DEPLOY.md /app/docs/
ENV DOCS_DIR=/app/docs

# shares the SAME SQLite store + jwt-secret as the Node backend (mount /data)
ENV DATA_DIR=/data
ENV PORT=4001
EXPOSE 4001
CMD ["/app/hermes-go"]

# --- Stage 2b: DEFAULT runtime — the slim image plus k6 ---
# No base-image change is needed for this: k6's Linux build is pure-Go static
# (the same release binary runs in the Alpine grafana/k6 image AND on glibc
# Debian), and distroless-static already carries CA certificates, nsswitch and
# the tz database. /etc/resolv.conf is injected by the container runtime.
#
# This image has no shell, so verify k6 by exec'ing it directly:
#   docker run --rm --entrypoint /usr/local/bin/k6 hermes-go:latest version
FROM runtime-slim AS runtime
COPY --from=k6bin /usr/bin/k6 /usr/local/bin/k6
ENV HERA_K6_BIN=/usr/local/bin/k6
