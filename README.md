# ⚡ Hermes — *The Messenger*

An API test suite builder. Hermes carries your requests, delivers their responses, and reports back: import Postman collections as **editable test suites** — or build suites from scratch — then chain requests through captured variables, validate responses with visual rules or scripts, run in cycles, and export back to Postman.

📖 **New here? Read the [User Manual](USER_MANUAL.md)** — it walks through every feature with examples.
🚀 **Deploying? See [HOW-TO-DEPLOY.md](HOW-TO-DEPLOY.md)** — local, single-server, Docker and Kubernetes.

Both docs are also readable in-app under **Docs** in the sidebar.

## Quick start

Requirements: **Node.js ≥ 22** (uses the built-in `node:sqlite`).

```bash
# 1. backend — API on http://localhost:4000
cd backend && npm install && npm run start

# 2. frontend (separate terminal) — UI on http://localhost:5173
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 and sign in with the seeded admin account: **admin / admin123** (change it in Settings, or seed differently via `ADMIN_USER` / `ADMIN_PASSWORD`).

**Single-server deployment:** `cd frontend && npm run build` — the backend automatically serves `frontend/dist` when it exists, so only port 4000 is needed.

**Optional Go backend (2.0):** Hermes ships a second, interchangeable backend written in Go that serves the identical API. Run it alongside Node and switch between them live from **Settings → Backend engine** (see [Dual backend engine](#dual-backend-engine-node--go) below):

```bash
cd backend-go && go run .   # API on http://localhost:4001
```

**Try it offline:** the built-in demo API under `/mock` lets you build a full chaining flow (login → capture a token → call authed endpoints) with zero external services — create a suite from scratch and point requests at `/mock/login`, `/mock/profile`, `/mock/items`.

## Feature overview

| Area | What you get |
|---|---|
| **Import** | Postman collection v2.0/v2.1 (upload or paste) → editable suite; folders, auth, bodies and pm scripts preserved |
| **Suites** | Create from import or from scratch; everything editable (requests, order, assertions, captures, variables, settings); duplicate; copy-on-write from the original collection |
| **File uploads** | `form-data` (multipart) body mode: mix text fields and file fields; files come from a shared server-side **Files** store (upload once, reference anywhere) |
| **Chaining** | Capture values from a response (JSONPath / header / status, or a script) into variables; later steps use them as `{{var}}` |
| **Validation** | Visual assertion rules + sandboxed `test()`/`expect()` scripts; per-assertion results in every run |
| **Variables** | Global + suite scopes with Postman-style precedence; secret masking; undefined `{{placeholders}}` flagged inline with one-click "define as global" |
| **Runs** | 1–100 cycles, stop-on-failure, live progress, full per-step request/response/assertion/capture/log detail |
| **Load testing (Hera)** | Run any suite under concurrency with the real **k6** binary: every virtual user walks all enabled steps in order, carrying captures between them. Capture/validation scripts run unchanged, polling is measured as time-to-completion, and targets are default-deny |
| **Single-step Send** | Run one request ad-hoc with unsaved edits; captures fold back so you can test a chain step by step |
| **Suite composer** | Draggable basket: collect requests across suites → create a new suite from them (referenced variables carried over) |
| **Export** | Any suite → Postman collection v2.1 (re-importable here or in Postman); visual rules become `pm.test` scripts |
| **Reports** | JSON report stub per run (download) — extension point for HTML/PDF rendering |
| **Auth** | Login + locally-generated captcha (no external service), JWT httpOnly cookie, login rate limiting, admin user management |
| **Roles** | Three user types — **admin** (full access), **moderator** (create/edit + appearance, no deletion), **npc** (read-only + execute runs, no admin/docs) — enforced on both backends and reflected in the UI |
| **Dual backend** | Interchangeable **Node** and **Go** backends serving one API over one database + session; switch live from Settings, with a read-only engine indicator in the top bar |
| **UI** | Legends toggle (ⓘ hover help on every function), light/dark/system + 8 theme presets + custom theme builder with live preview and JSON import/export |

## Dual backend engine (Node ⇄ Go)

Hermes 2.0 has **two backends that speak the same REST contract**:

- **Node** — Express + TypeScript, `node:vm` script sandbox (`backend/`, port 4000)
- **Go** — chi + [goja](https://github.com/dop251/goja) script sandbox, compiled to a single static binary (`backend-go/`, port 4001)

They **share the same SQLite database and the same JWT secret**, so a session minted by one is valid on the other and both see identical data. That's what makes switching seamless — pick the engine in **Settings → Backend engine** and the whole app re-points at it without logging you out or changing what you see. The top bar shows a read-only **Engine** pill (🐹 Go / ⬡ Node) with a live health dot; only admins can switch.

- **Dev:** Vite proxies `/api` → Node and `/_go/api` → Go, both same-origin so the cookie is shared.
- **Prod:** `docker compose up --build` runs Node, Go and an nginx reverse proxy that routes `/_go/*` → Go and everything else → Node behind one origin (`http://localhost:8080`). Both containers share one data volume and one `JWT_SECRET`.

The Go sandbox is a faithful port of the Node one — the `expect`/`test`/error-formatting logic runs as JavaScript inside goja, so assertion results and error messages are byte-for-byte identical.

## Roles & permissions

Each user has one of three roles (set when an admin creates them; existing users migrate to `admin`/`moderator`). The backend enforces these; the UI hides what a role can't do.

| Capability | admin | moderator | npc |
|---|:---:|:---:|:---:|
| View suites / collections / runs / variables / files | ✓ | ✓ | ✓ |
| Create / edit suites, import collections, edit variables, upload files | ✓ | ✓ | — |
| Delete anything (any tab) | ✓ | — | — |
| Run / execute suites (incl. single-step Send) | ✓ | ✓ | ✓ |
| Appearance page | ✓ | ✓ | — |
| Docs | ✓ | ✓ | — |
| Start a Hera load test | ✓ | opt-in¹ | — |
| Stop a running load test | ✓ | ✓ | ✓ |
| Manage users · switch backend engine | ✓ | — | — |

¹ Moderators can launch only when `HERA_ALLOW_MODERATOR=1`. Stopping is open to every role on purpose — anyone who can see a load test running should be able to hit the brakes.

## Architecture

```
Hermes/
├── backend/            Express + TypeScript (run with tsx)
│   └── src/
│       ├── index.ts            app assembly, static serving of frontend/dist
│       ├── db.ts               node:sqlite schema, JWT secret, admin seed
│       ├── auth.ts             captcha, login, JWT middleware, users
│       ├── postman.ts          Postman v2.x importer
│       ├── postman-export.ts   suite → Postman v2.1 exporter
│       ├── mock.ts             demo target API (/mock/*)
│       ├── routes/             collections, suites, variables, runs, files, docs
│       └── runner/
│           ├── executor.ts     variable resolution, step/suite execution
│           └── sandbox.ts      node:vm sandbox for capture/validation scripts
├── backend-go/         Go port — same API, same DB + JWT secret (port 4001)
│   ├── main.go               entrypoint
│   └── internal/
│       ├── model/            domain types (mirrors backend/src/types.ts)
│       ├── store/            modernc.org/sqlite store, schema, role migration
│       ├── auth/             captcha, JWT, users, role enforcement
│       ├── postman/          importer + exporter
│       ├── runner/           executor + goja sandbox (port of sandbox.ts)
│       └── server/           chi routes: collections/suites/variables/runs/…
├── frontend/           React 18 + Vite + TypeScript (no UI framework)
│   └── src/
│       ├── pages/              Login, Collections, Suites, SuiteEditor, Variables,
│       │                       Files, Runs, RunDetail, Appearance, Settings, Docs
│       ├── components/         StepTabs, KVEditor, VarChips, Composer
│       ├── themes.tsx          theme engine + presets
│       └── legends.tsx         ⓘ help system (all copy in one map)
├── Dockerfile              multi-stage build (frontend + Node backend in one image)
├── Dockerfile.go           multi-stage build for the Go backend (distroless static)
├── nginx.conf              reverse proxy: /_go → Go, everything else → Node
├── docker-compose.yml      runs Node + Go + proxy sharing one data volume
├── k8s/hermes.yaml         Kubernetes manifests (Secret, PVC, Deployment, Service, Ingress)
├── USER_MANUAL.md
└── HOW-TO-DEPLOY.md
```

- **Storage**: SQLite via Node's built-in `node:sqlite` — zero native dependencies. Data lives in `backend/data/` (`DATA_DIR` to relocate); uploaded files for requests live in `DATA_DIR/files/`.
- **Scripts** run server-side in a `node:vm` sandbox (2 s timeout, no fs/network). For hostile multi-tenant input, swap `runner/sandbox.ts` for an `isolated-vm` implementation — the interface is designed for that.
- **Requests** are sent from the backend (axios), so browser CORS never interferes with testing.
- **Load testing (Hera)** shells out to the real **k6** binary rather than reimplementing a load generator. The suite is compiled to a k6 script fed in on stdin, so it never touches disk; capture/validation scripts run verbatim on a shim over k6 primitives. The `zero native dependencies` note above still holds — k6 is a sibling process, not a linked module — but the published Docker images do bundle a pinned third-party binary (build `--target runtime-slim` for images without it).

## Backend environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `DATA_DIR` | `backend/data` | SQLite DB + JWT secret location |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin123` | Bootstrap admin (first run only) |
| `JWT_SECRET` | auto-generated, persisted | Session signing key — **set the same value on both backends** so sessions are interchangeable |
| `CAPTCHA_BYPASS` | off | `1` accepts captcha text `bypass` — dev/test only, **never in production** |
| `HERA_ENABLED` | `1` (`0` in k8s) | Turn load testing off entirely |
| `HERA_TARGET_ALLOW` | *(empty)* | Hosts Hera may target — exact, `*.suffix`, `host:port` or CIDR. **Empty means this instance's own `/mock` API and nothing else** |
| `HERA_MAX_VUS` | `20` (ceiling 100) | Virtual-user cap; requests above it are reduced, not rejected |
| `HERA_MAX_DURATION_SEC` | `60` (ceiling 300) | Run-length cap |
| `HERA_MAX_RPS` | `200` (ceiling 1000) | Always passed to k6 as `--rps`; VU count alone is not a throughput bound |
| `HERA_ALLOW_MODERATOR` | off | `1` lets moderators start load tests, not just admins |
| `HERA_K6_BIN` | *(PATH)* | Explicit path to the k6 binary |

The **Go backend** reads the same variables (`PORT` defaults to `4001`, `DATA_DIR` defaults to the sibling `backend/data`, plus `DOCS_DIR` for the Docs page). Point both at the same `DATA_DIR` and give them the same `JWT_SECRET` for a seamless toggle.

## Roadmap

- ✅ Import/export, suite building & editing, step search, chaining, script capture/validation, variables, file uploads (form-data + file store), runs & cycles, report stub, auth + captcha, legends, theming, composer, single-step send, in-app docs.
- ✅ Docker image, docker-compose, Kubernetes manifests (see [HOW-TO-DEPLOY.md](HOW-TO-DEPLOY.md)).
- ✅ Parallel **Go backend** with a live UI engine toggle; three-tier **roles** (admin/moderator/npc) enforced on both backends.
- ✅ **Hera** — k6-backed load testing on both backends, with live charts, per-step breakdown and default-deny targeting.
- ⏳ SQLite → Postgres data layer for multi-replica horizontal scaling.
- ⏳ Hera on Kubernetes (needs the Postgres migration, so load generation can run outside the API pod).
- ⏳ Real report rendering (HTML/PDF) behind the existing stub.
- ⏳ Executing imported Postman `pm.*` scripts in a compatible sandbox.
