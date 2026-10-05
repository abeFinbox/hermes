#!/usr/bin/env bash
#
# Start Hermes locally: Node backend (4000), Go backend (4001), Vite UI (5173).
#
#   ./start-local.sh
#
# One foreground process that owns all three. Ctrl+C stops everything. Output is
# interleaved with a [node] / [go] / [ui] prefix so it is obvious who said what.
#
# Ports already in use are taken over ONLY when the holder is recognisably a
# Hermes process (the point of the script is restarting after a code change);
# anything else makes it stop and tell you, rather than killing a stranger.
#
# Expected noise on startup: if a browser tab is already open on 5173, Vite logs
# a few `http proxy error ... ECONNREFUSED /api/auth/me` lines while the Node
# backend is still booting. They stop as soon as it is listening.
#
# Kept bash 3.2 compatible — that is what ships with macOS.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_PORT=4000
GO_PORT=4001
UI_PORT=5173

say() { printf '[start] %s\n' "$1"; }

# LISTEN only. Without -sTCP:LISTEN this also returns every client with an open
# connection to the port — the browser tab watching the UI included, which made
# the script refuse to start because "Chrome is holding 5173".
port_pids() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null; }

# A Hermes process is one whose command line points into THIS checkout (the tsx
# Node backend and the Vite dev server both do), or the Go backend — which runs
# from a go-build cache path, so it is recognised by its binary name instead.
# Glob matching via `case`, so a project path full of slashes needs no escaping.
is_hermes_proc() {
  cmd=$(ps -o command= -p "$1" 2>/dev/null)
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$ROOT"*)     return 0 ;;
    *backend-go*)  return 0 ;;
  esac
  return 1
}

free_port() {
  port="$1"
  for pid in $(port_pids "$port"); do
    if is_hermes_proc "$pid"; then
      say "port $port: stopping previous Hermes process $pid"
      kill "$pid" 2>/dev/null
    else
      say "port $port is held by PID $pid, which does not look like Hermes:"
      ps -o command= -p "$pid"
      say "stop it yourself, then re-run this script."
      exit 1
    fi
  done
  # give the socket a moment to be released
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$(port_pids "$port")" ] && return 0
    sleep 0.5
  done
  say "port $port did not free up — check what is still holding it."
  exit 1
}

# Prefix a child's output and keep it unbuffered enough to read live. awk is used
# rather than `sed -u`, which BSD/macOS sed does not have.
prefix() { awk -v tag="$1" '{ print "[" tag "] " $0; fflush() }'; }

wait_health() {
  name="$1"; url="$2"
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      say "$name is up — $url"
      return 0
    fi
    sleep 0.5
  done
  say "$name did not answer at $url yet (still starting, or it failed — see its log lines above)"
  return 1
}

command -v node >/dev/null || { say "node not found on PATH"; exit 1; }
command -v go >/dev/null || { say "go not found on PATH (needed for the second backend)"; exit 1; }

say "project: $ROOT"
free_port "$NODE_PORT"
free_port "$GO_PORT"
free_port "$UI_PORT"

# Kill a process and everything under it. Needed because `npm run` is a wrapper:
# signalling it leaves the actual node/tsx child listening, and `go run` likewise
# spawns the compiled binary as a separate process.
kill_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null
}

cleanup() {
  trap - INT TERM EXIT
  echo
  say "stopping…"
  for pid in $PIDS; do
    kill_tree "$pid"
  done
  # Belt and braces: anything of ours still LISTENING (a child that reparented
  # before we got to it) gets stopped too, so the ports are free for the next run.
  for port in $NODE_PORT $GO_PORT $UI_PORT; do
    for pid in $(port_pids "$port"); do
      is_hermes_proc "$pid" && kill "$pid" 2>/dev/null
    done
  done
  exit 0
}
trap cleanup INT TERM EXIT

PIDS=""
( npm --prefix "$ROOT/backend" run start 2>&1 | prefix node ) &
PIDS="$PIDS $!"
( cd "$ROOT/backend-go" && DATA_DIR="$ROOT/backend/data" go run . 2>&1 | prefix go ) &
PIDS="$PIDS $!"
( npm --prefix "$ROOT/frontend" run dev 2>&1 | prefix ui ) &
PIDS="$PIDS $!"

wait_health "Node backend" "http://localhost:$NODE_PORT/api/health"
wait_health "Go backend  " "http://localhost:$GO_PORT/api/health"
wait_health "UI          " "http://localhost:$UI_PORT/"

say "sign in at http://localhost:$UI_PORT  (admin / admin123)"
say "Ctrl+C stops all three."
wait
