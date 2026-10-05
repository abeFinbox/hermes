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
| `HERA_ENABLED` | Load testing. `1` in compose, `0` in the k8s manifest (see *Hera resource requirements* below). |
| `HERA_TARGET_ALLOW` | **The single most important Hera setting.** Comma-separated hosts Hera may load-test — exact, `*.suffix`, `host:port` or CIDR. Leaving it empty means Hera can only reach this instance's own `/mock` API. |
| `HERA_MAX_VUS` / `HERA_MAX_DURATION_SEC` / `HERA_MAX_RPS` | Caps: `20`/`60`/`200` by default, ceilings `100`/`300`/`1000`. Over-large requests are reduced, and the run records what it used. |
| `HERA_ALLOW_MODERATOR` | `1` lets moderators start load tests. Admin-only otherwise; stopping is always open to every role. |
| `HERA_K6_BIN` | Explicit path to the k6 binary. The images set it; set it yourself for a bare-metal install. |

> **Security note:** secret variables are masked in the UI and blanked in exports, but stored in plaintext in the SQLite DB. Protect `DATA_DIR` accordingly, and put Hermes behind your own TLS/ingress + network controls.

> **Security note — outbound.** The line above is about traffic *into* Hermes. Hera adds a meaningful **egress** requirement: it generates load from this server towards whatever `HERA_TARGET_ALLOW` permits. Cloud metadata endpoints, link-local ranges and non-`http(s)` schemes are blocked in code and cannot be re-enabled by configuration, and hostnames are resolved and pinned to an IP before a run so DNS cannot be swapped mid-run. Treat the app-level allow-list as a usability guard, though — a firewall or Kubernetes NetworkPolicy egress rule is the real blast-radius control, because an app-level check is one bug away from failing open.

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
# open http://localhost:8080   (the compose file fronts both backends with nginx)
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

Because requests are executed **from the backend** (not the browser), scaling the Deployment scales *functional* test-execution throughput directly.

**This does not apply to Hera.** Load testing is deliberately limited to **one run at a time across the whole installation** (a heartbeat lock in the shared database), so that results stay comparable and replicas do not multiply the load on your target. Adding replicas does not add load-test capacity. Running Hera outside the API pod needs a second process writing the results DB, which the ReadWriteOnce SQLite PVC forbids — so it is blocked on the same Postgres migration described above.

---

## Hera (load testing) — resource requirements

Hera runs k6 as a child of the API process, so it competes for CPU with the very
API it is measuring. k6 timestamps requests in userspace, which means a throttled
or starved host attributes **its own scheduling stalls to your target** — and the
error grows as the target gets faster. That is why:

- Hera **refuses to start below 1000m of detected CPU** unless
  `HERA_ALLOW_CONSTRAINED=1`, and caps virtual users at roughly one per 50m.
- The shipped Kubernetes manifest sets `HERA_ENABLED=0`, because its limits are
  `cpu: 500m`. Enabling it there needs Guaranteed QoS — see the commented block
  at the bottom of `k8s/hermes.yaml`.
- Give it **≥ 2 CPU** if you want numbers you would act on.

The manifest's liveness probe now sets `timeoutSeconds: 5` / `failureThreshold: 6`
explicitly. That matters whether or not Hera is on: the defaults (1 s, 3) kill the
pod after 60 s of *any* CPU contention, and with `strategy: Recreate` on a
ReadWriteOnce PVC that is a full teardown and recreate.

### Image sizes

k6 is bundled into both images. If you do not want it, build the slim target —
Hera then reports unavailable and the UI disables the launch button, instead of
failing at run time.

| Image | Without Hera (`--target runtime-slim`) | Default (with k6) |
|---|---|---|
| `hermes` (Node) | ~94 MB | ~140 MB |
| `hermes-go` (distroless) | ~15 MB | ~60 MB |

```bash
docker build --target runtime-slim -t hermes:slim .
docker build --target runtime-slim -f Dockerfile.go -t hermes-go:slim .
```

## Verifying Hera

Deny-list behaviour is safety-critical and identical across both backends by
contract, so it is checked by fixtures rather than by reading the source. Neither
of the first two needs k6, a network, or a running server.

```bash
# 1. the two backends must generate byte-identical k6 scripts
cd backend      && npx tsx tools/hera-script-runner.ts ../backend-go/testdata/hera-cases.json > /tmp/n.txt
cd ../backend-go && go run ./cmd/hera-script-runner ./testdata/hera-cases.json > /tmp/g.txt
diff /tmp/n.txt /tmp/g.txt && echo "script parity OK"

# 2. and identical target REJECTION STRINGS — a divergence here would mean one
#    backend is a bypass for the other. DNS is stubbed by the fixture.
cd backend      && npx tsx tools/hera-target-runner.ts ../backend-go/testdata/hera-target-cases.json > /tmp/nt.txt
cd ../backend-go && go run ./cmd/hera-target-runner ./testdata/hera-target-cases.json > /tmp/gt.txt
diff /tmp/nt.txt /tmp/gt.txt && echo "rejection parity OK"

# 3. and identical per-step cURL text. This command carries real credentials and
#    is what someone pastes into a terminal to reproduce a failing step, so a
#    quoting or percent-encoding divergence means one engine hands out a command
#    that does not reproduce the run.
cd backend      && npx tsx tools/hera-curl-runner.ts ../backend-go/testdata/hera-curl-cases.json > /tmp/nc.txt
cd ../backend-go && go run ./cmd/hera-curl-runner ./testdata/hera-curl-cases.json > /tmp/gc.txt
diff /tmp/nc.txt /tmp/gc.txt && echo "curl parity OK"
```

Then the live log route, which needs a running server and an in-flight run. It is
the one place the two backends deliberately answer *differently*: a live run's
output exists only in the process that spawned k6, so ask the engine named in
`runBackend`.

```bash
# while a run is in flight (id from POST /api/hera):
curl -s "localhost:8080/api/hera/$RUN/logs?sinceLine=0"      # owning lane: source=live
curl -s "localhost:8080/_go/api/hera/$RUN/logs?sinceLine=0"  # other lane: 200, source=none
# re-issue with ?sinceLine=<cursor from the last response> — only new lines come back.
# after it finishes, EITHER lane answers with source=tail, renumbered from 1:
# a client must REPLACE its buffer on 'tail', not append.
```

A step that ends non-2xx also emits one `HERA_DIAG step=… status=… code=… body=…`
line per VU (up to `HERA_DIAG_MAX`). If those lines are absent on a failing run,
check `HERA_DIAG` is not set to `0`. The body is on by default and truncated to
`HERA_DIAG_BODY_MAX`; **set `HERA_DIAG_BODY=0` on any instance pointed at
production data**, because those lines are persisted in the run row and therefore
put response payloads at rest until the run is deleted.

`GET /api/hera/:id/curl?stepId=…` returns a paste-runnable command for one step.
It resolves real values including secret variables — deliberately, since a masked
`Authorization` reproduces the wrong failure — so it is admin-gated
(`HERA_ALLOW_MODERATOR` extends it, exactly like launching) and never persisted.

Then a live smoke test against the built-in demo API, which is what the default
configuration permits anyway — no external service, no credentials:

```bash
# k6 present and the right platform? (the Go image has no shell, so exec it)
docker run --rm --entrypoint /usr/local/bin/k6 hermes-go:latest version

# in the UI: Hera → New load test → pick a suite pointed at /mock → Start.
# A healthy host reports p95 ≈ 200 ms for a suite hitting /mock/slow?ms=200.
# If it reports much more, this host is too CPU-starved to trust the numbers.
curl -s localhost:8080/api/hera/capabilities      # Node lane
curl -s localhost:8080/_go/api/hera/capabilities  # Go lane
```


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
