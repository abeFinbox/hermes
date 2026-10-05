# Hera — session handoff

Paste-ready context for continuing in a fresh chat. **Not committed** — delete when done.

## Where things stand
- **Hera** (k6 load testing) is fully built: schema, capability probe, script
  generator + sandbox shim, polling, target deny-list, process lifecycle, live
  progress, routes, full UI, packaging, docs. Verified 21/21 on both backends
  earlier; script + rejection parity fixtures byte-identical.
- Backend commits are **pushed** to `feat/hera-load-testing` (`abeFinbox/hermes`).
- Frontend, packaging, docs, and the two fixes below are **UNCOMMITTED** on
  purpose (user said not yet).

## Layout
- Node backend `backend/` :4000 · Go backend `backend-go/` :4001 · vite
  `frontend/` :5173 (proxies `/api`→4000, `/_go`→4001).
- Both backends share `backend/data` (SQLite + jwt-secret). k6 v2.0.0 local
  (darwin/arm64).

## Two fixes made, NOT yet loaded by the running backends
1. **TLS (critical).** resolve-then-pin was rewriting the URL to the raw IP →
   `x509: cannot validate certificate ... doesn't contain any IP SANs` on every
   HTTPS target. Fixed to use k6 `options.hosts` (hostname stays in the URL, DNS
   forced to the validated IP). Proven: example.com over HTTPS pinned to its IP
   → 200, 0 TLS errors. Files: `backend/src/hera/{script,runner}.ts`,
   `backend-go/internal/hera/{script,runner}.go`. `pinnedUrl`/`PinnedURL`
   removed; parity re-checked identical.
2. **UI.** Hera sigil glyph (`HeraGlyph.tsx`); a page-tear on the home page
   (`HeraTear.tsx`) replaces the sidebar Hera link; a subtle route transition
   (`RouteFX.tsx` — glyph breathes in/out) + page fade-in. Tear toned down to
   muted paper. All live on :5173 via HMR; tsc clean.

## Immediate blocker / next action
User is load-testing **bank-connect UAT**. The running :4000 and :4001 were
started BEFORE the TLS fix, and tsx/go-run do not hot-reload — so they still run
the old IP-rewrite code. **Restart both** to load the fix:

```bash
cd ~/IdeaProjects/Hermes/backend && \
  HERA_TARGET_ALLOW='apis-uat.bankconnect.finbox.in,apis-uat-k8s.bankconnect.finbox.in' npx tsx src/index.ts

cd ~/IdeaProjects/Hermes/backend-go && \
  HERA_TARGET_ALLOW='apis-uat.bankconnect.finbox.in,apis-uat-k8s.bankconnect.finbox.in' go run .
```

Then re-run the load test — requests go to `https://apis-uat.bankconnect.finbox.in/...`
(cert validates), pinned to 3.6.246.101 underneath.

- `base_url` in suites **TCAP Test** / **AA related** is a real hostname (confirmed) — not the IP, so the fix applies.
- `HERA_TARGET_ALLOW` is an allow-list (deny-by-default). Exact host, `*.suffix`,
  `host:port`, or CIDR. Keycloak auth steps pointing at `*.tclnprdservices.tatacapital.com`
  are **prod** and stay blocked unless deliberately allowed.
- Docker `runtime` (k6-bearing) target is unbuilt — registry unreachable here;
  digest is a TODO in both Dockerfiles. `--target runtime-slim` builds offline.

## Preferences
User runs commands themselves. Caveman-mode replies active.
