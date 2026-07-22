# syntax=docker/dockerfile:1
# --- Stage 1: build the static Go binary (modernc sqlite = pure Go, no cgo) ---
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY backend-go/go.mod backend-go/go.sum ./
RUN go mod download
COPY backend-go/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/hermes-go .

# --- Stage 2: minimal runtime ---
FROM gcr.io/distroless/static-debian12 AS runtime
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
