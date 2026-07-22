# syntax=docker/dockerfile:1
# --- Stage 1: build the frontend into static assets ---
FROM node:24-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build            # -> /app/frontend/dist

# --- Stage 2: runtime (backend serves the API + the built frontend) ---
FROM node:24-bookworm-slim AS runtime
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
