# How to Deploy — Hermes™

Four paths, simplest to most scalable: **local dev → single-server build → Docker → Kubernetes**. All ship as one process (the backend serves both the API and the built frontend), so there's only ever one port to expose (`4000`).

---

## 0. Before any real deployment

Set these — the defaults are for local convenience only:

| Variable | Why it matters |
|---|---|
| `JWT_SECRET` | Signs session cookies. Use a long random string (`openssl rand -hex 32`). If unset, one is generated and persisted in `DATA_DIR` — fine for a single box, but set it explicitly so restarts/replicas share it. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | The bootstrap admin, created **only on first run** against an empty DB. Change the password immediately if you rely on the default. |
| `DATA_DIR` | Where the SQLite DB + JWT secret live. Point it at persistent storage. |
| `CAPTCHA_BYPASS` | Leave **unset** in production. `1` accepts the literal captcha `bypass` (CI/testing only). |

> **Security note:** secret variables are masked in the UI and blanked in exports, but stored in plaintext in the SQLite DB. Protect `DATA_DIR` accordingly, and put Hermes behind your own TLS/ingress + network controls.

---

## 1. Local development

Two processes with hot reload. Requires **Node ≥ 22** (uses the built-in `node:sqlite`).

```bash
cd backend  && npm install && npm run dev     # API on :4000
cd frontend && npm install && npm run dev     # UI  on :5173 (proxies /api + /mock to :4000)
```

Open http://localhost:5173, sign in with `admin` / `admin123`.

---

## 2. Single-server (no Docker)

Build the frontend once; the backend auto-serves it, so you run **one** process on **one** port.

```bash
cd frontend && npm install && npm run build    # -> frontend/dist
cd ../backend && npm install
JWT_SECRET="$(openssl rand -hex 32)" \
ADMIN_PASSWORD="a-strong-password" \
DATA_DIR="/var/lib/hermes" \
npm run start                                  # serves API + UI on http://localhost:4000
```

Keep it alive with your process manager of choice (systemd, pm2, …). Example systemd unit:

```ini
[Unit]
Description=Hermes
After=network.target

[Service]
WorkingDirectory=/opt/hermes/backend
ExecStart=/usr/bin/npm run start
Environment=DATA_DIR=/var/lib/hermes
Environment=JWT_SECRET=...          # or use EnvironmentFile=
Environment=ADMIN_PASSWORD=...
Restart=always

[Install]
WantedBy=multi-user.target
```

---

## 3. Docker

A multi-stage [`Dockerfile`](Dockerfile) builds the frontend, then runs the backend serving everything. SQLite data persists on a mounted volume at `/data`.

### With docker compose (recommended)

Edit the env values in [`docker-compose.yml`](docker-compose.yml), then:

```bash
docker compose up -d --build
docker compose logs -f          # watch startup
# open http://localhost:4000
```

The compose file defines a named volume `hermes-data` (your DB survives restarts) and a health check hitting `/api/health`.

### Plain docker

```bash
docker build -t hermes:latest .
docker run -d --name hermes -p 4000:4000 \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e ADMIN_PASSWORD="a-strong-password" \
  -v hermes-data:/data \
  hermes:latest
```

---

## 4. Kubernetes

Manifests are in [`k8s/hermes.yaml`](k8s/hermes.yaml): a `Secret`, a `PersistentVolumeClaim`, a `Deployment` (with readiness/liveness probes on `/api/health`), a `Service`, and an `Ingress`.

```bash
# 1. build and push to a registry your cluster can pull from
docker build -t <registry>/hermes:latest .
docker push <registry>/hermes:latest

# 2. set the image ref + host in k8s/hermes.yaml, edit the Secret values, then
kubectl apply -f k8s/hermes.yaml
kubectl rollout status deploy/hermes
```

⚠️ **Scaling caveat:** the default storage is SQLite — a single file — so the manifest ships with `replicas: 1` and a `Recreate` strategy (never two pods on the same file). For horizontal scaling, see the next section.

---

## 5. Scaling out (multi-replica)

To run more than one replica you must move off SQLite onto a shared database:

1. **Add a Postgres-backed data layer.** Everything DB-related is isolated in [`backend/src/db.ts`](backend/src/db.ts) and the `routes/` + `runner/` queries. Swap `node:sqlite` for a Postgres client (e.g. `pg`) keeping the same `prepare().get/all/run` shape, or introduce a thin query wrapper. (This is the one code change scaling requires — the rest of the app is already stateless.)
2. **Make the Deployment stateless:** drop the PVC and `DATA_DIR` volume, set the Postgres connection via env/Secret, change the strategy to `RollingUpdate`, and raise `replicas`.
3. **Share the session secret:** set an explicit `JWT_SECRET` (same value for all pods) so cookies validate across replicas.
4. **Enable the HPA** at the bottom of `k8s/hermes.yaml` (commented out) to autoscale on CPU.

Because requests are executed **from the backend** (not the browser), scaling the Deployment scales test-execution throughput directly.

---

## Health & operations

- **Health check:** `GET /api/health` → `{"ok":true}` (used by compose and k8s probes).
- **Backups:** back up `DATA_DIR/app.db` (SQLite) or your Postgres database. Custom UI themes and the composer basket live in each user's browser localStorage, not on the server.
- **Logs:** the backend logs to stdout (`docker compose logs`, `kubectl logs`).
- **Upgrades:** rebuild the image and re-deploy; the DB schema is created/migrated idempotently on boot.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Blank page, API works | The frontend wasn't built — `frontend/dist` is missing. Rebuild (Docker does this automatically). |
| Everyone logged out after redeploy | `JWT_SECRET` changed between runs. Set it explicitly and keep it stable. |
| Data lost after container restart | No volume mounted at `DATA_DIR`/`/data`. Mount persistent storage. |
| `node:sqlite` errors on start | Node too old — use Node ≥ 22 (the images use `node:24`). |
| Large Postman import rejected at ingress | Raise the proxy body size (the sample Ingress sets `proxy-body-size: 20m`). |
