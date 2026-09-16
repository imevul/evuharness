#!/usr/bin/env bash
# Start, restart, or stop the non-Docker dev stack: the demo API (port 4301) and
# the demo web app (port 4300), each run directly with pnpm — no Docker required.
#
# This is the "Option A" counterpart to the Docker compose stack (`make dev`):
# useful where Docker is unavailable, such as a Cloud Agent VM.
#
# Usage:
#   scripts/dev-native.sh [restart|start|stop|status]
#     restart (default)  Stop any running instance, then start both servers.
#     start              Alias for restart (idempotent).
#     stop               Stop both servers.
#     status             Report whether each server is up.
#
# Provider:
#   By default the API talks to the configured OpenAI-compatible provider (set it
#   in the web Settings panel, or seed it with EVUHARNESS_PROVIDER_BASE_URL /
#   EVUHARNESS_PROVIDER_MODEL / EVUHARNESS_PROVIDER_API_KEY). Export
#   EVUHARNESS_FAKE_PROVIDER=1 to use the in-process echo provider instead, which
#   streams replies without any live model — handy for a quick offline demo, but
#   it overrides every real provider, so leave it unset when using your own.
#
# Logs and pids live under .data/dev/ (gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.data/dev"
mkdir -p "$STATE_DIR"

API_HOST="${EVUHARNESS_HOST:-0.0.0.0}"
API_PORT="${EVUHARNESS_API_PORT:-4301}"
WEB_PORT="${EVUHARNESS_WEB_PORT:-4300}"

log() { printf 'dev-native: %s\n' "$*"; }

# Kill the process group recorded in a pidfile, if still alive. Servers are started
# as process-group leaders (via setsid) so the whole tree is stopped, not just the
# wrapper. We only ever signal pids we started ourselves (never by name).
stop_pidfile() {
  local name="$1" pidfile="$2"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    log "stopping $name (pgid $pid)"
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "-$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

start_server() {
  local name="$1" pidfile="$2" logfile="$3"
  shift 3
  : >"$logfile"
  setsid bash -c "exec $*" >"$logfile" 2>&1 &
  local pid=$!
  echo "$pid" >"$pidfile"
  log "started $name (pgid $pid) -> $logfile"
}

wait_healthy() {
  local name="$1" url="$2" logfile="$3" tries="${4:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 2 -o /dev/null "$url" 2>/dev/null; then
      log "$name is up ($url)"
      return 0
    fi
    sleep 1
  done
  log "ERROR: $name did not become healthy at $url"
  log "last lines of $logfile:"
  tail -n 20 "$logfile" | sed 's/^/  /' || true
  return 1
}

do_stop() {
  stop_pidfile "web" "$STATE_DIR/web.pid"
  stop_pidfile "api" "$STATE_DIR/api.pid"
}

do_status() {
  local api="down" web="down"
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$API_PORT/health" 2>/dev/null && api="up"
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null && web="up"
  log "api ($API_PORT): $api   web ($WEB_PORT): $web"
}

do_start() {
  do_stop
  local fake_note=""
  [[ "${EVUHARNESS_FAKE_PROVIDER:-}" == "1" ]] && fake_note=" (fake echo provider)"

  start_server "api" "$STATE_DIR/api.pid" "$STATE_DIR/api.log" \
    "env EVUHARNESS_HOST='$API_HOST' EVUHARNESS_API_PORT='$API_PORT' pnpm --filter @evu/harness-api dev"
  start_server "web" "$STATE_DIR/web.pid" "$STATE_DIR/web.log" \
    "pnpm --filter @evu/harness-web dev --port '$WEB_PORT'"

  wait_healthy "api" "http://127.0.0.1:$API_PORT/health" "$STATE_DIR/api.log" 60
  wait_healthy "web" "http://127.0.0.1:$WEB_PORT/" "$STATE_DIR/web.log" 60

  log "dev stack ready$fake_note"
  log "  web app : http://localhost:$WEB_PORT   (open this in the browser)"
  log "  demo API: http://localhost:$API_PORT/health"
  log "  logs    : $STATE_DIR/{api,web}.log      (stop with: scripts/dev-native.sh stop)"
}

case "${1:-restart}" in
  restart | start) do_start ;;
  stop) do_stop && log "stopped" ;;
  status) do_status ;;
  *)
    echo "usage: $0 [restart|start|stop|status]" >&2
    exit 2
    ;;
esac
