#!/usr/bin/env bash
#
# End-to-end smoke test against a real demo API process.
#
# The unit tests exercise the router with a synthetic request; this checks the parts
# only a real process can show: that the entry point boots, that `node:sqlite` opens,
# that routes answer on the wire, and that the client's URLs match the server's.
#
# Not part of `make verify` — it needs a build and a free port. Run it after touching
# the demo app, the route table, or the client.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-4399}"
BASE="http://127.0.0.1:${PORT}"
FAILED=0

if [[ ! -f apps/api/dist/main.js ]]; then
  echo "apps/api/dist/main.js missing; run 'make build' first" >&2
  exit 1
fi

# `:memory:` so a run leaves no file behind and cannot inherit state from the last one.
EVUHARNESS_STORE_PATH=":memory:" \
EVUHARNESS_API_PORT="${PORT}" \
  node apps/api/dist/main.js >/tmp/evuharness-smoke.log 2>&1 &
API_PID=$!

cleanup() {
  kill "${API_PID}" 2>/dev/null || true
  wait "${API_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Poll rather than sleep: a fixed sleep is either flaky or slow, and usually both.
for _ in $(seq 1 50); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE}/health" >/dev/null 2>&1; then
  echo "FAIL: api did not become healthy" >&2
  cat /tmp/evuharness-smoke.log >&2
  exit 1
fi

# check <name> <expected-status> <curl args...>
check() {
  local name="$1" expected="$2"
  shift 2

  local status
  status="$(curl -s -o /tmp/evuharness-smoke-body -w '%{http_code}' "$@")"

  if [[ "${status}" == "${expected}" ]]; then
    printf '  ok    %-44s %s\n' "${name}" "${status}"
  else
    printf '  FAIL  %-44s got %s, want %s\n' "${name}" "${status}" "${expected}"
    sed 's/^/        /' /tmp/evuharness-smoke-body
    FAILED=1
  fi
}

# contains <name> <substring>  — asserts against the last response body
contains() {
  if grep -q "$2" /tmp/evuharness-smoke-body; then
    printf '  ok    %-44s contains %s\n' "$1" "$2"
  else
    printf '  FAIL  %-44s missing %s\n' "$1" "$2"
    sed 's/^/        /' /tmp/evuharness-smoke-body
    FAILED=1
  fi
}

json() { printf '%s' "$1"; }

echo "smoke: ${BASE}"

check 'GET /health'                200 "${BASE}/health"
check 'GET /api/health'            200 "${BASE}/api/health"
check 'GET /api/status'            200 "${BASE}/api/status"
contains 'status lists modes'      '"modes"'

check 'GET /api/tools'             200 "${BASE}/api/tools?mode=agent"
check 'GET /api/tools bad mode'    400 "${BASE}/api/tools?mode=nope"

# A mutating tool must be unavailable in a read-only mode. This is the assertion the
# whole mode/tool policy exists to make true.
check 'GET /api/tools ask mode'    200 "${BASE}/api/tools?mode=ask"
contains 'write_note gated in ask' '"name":"write_note","description":".*","parameters":.*"availableInMode":false'

check 'GET /api/prompt/preview'    200 "${BASE}/api/prompt/preview?mode=plan"
contains 'preview has sections'    '"sections"'
check 'GET /api/prompt/preview bad' 400 "${BASE}/api/prompt/preview?mode=nope"

check 'GET /api/settings'          200 "${BASE}/api/settings"
# A credential must never come back out of the settings endpoint.
contains 'settings expose hasApiKey' '"hasApiKey"'
if grep -q '"apiKey"' /tmp/evuharness-smoke-body; then
  echo '  FAIL  settings leaked an apiKey field'
  FAILED=1
else
  echo '  ok    settings leak no apiKey'
fi

check 'GET /api/context-menus'     200 "${BASE}/api/context-menus"
contains 'catalog has three menus' '"labels"'

check 'POST mentions items'        200 -X POST "${BASE}/api/context-menus/mentions/items" \
  -H 'content-type: application/json' --data "$(json '{"query":"","path":[]}')"
contains 'mentions top level'      '"Docs"'

check 'POST mentions drill-in'     200 -X POST "${BASE}/api/context-menus/mentions/items" \
  -H 'content-type: application/json' --data "$(json '{"query":"","path":["docs"]}')"
contains 'drill-in returns children' 'SPEC.md'

check 'POST mentions search'       200 -X POST "${BASE}/api/context-menus/mentions/items" \
  -H 'content-type: application/json' --data "$(json '{"query":"spec","path":[]}')"

check 'POST unknown menu'          404 -X POST "${BASE}/api/context-menus/nope/items" \
  -H 'content-type: application/json' --data "$(json '{"query":"","path":[]}')"

check 'POST /api/sessions'         201 -X POST "${BASE}/api/sessions" \
  -H 'content-type: application/json' --data "$(json '{"mode":"agent"}')"
SESSION_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/evuharness-smoke-body)"

check 'GET /api/sessions'          200 "${BASE}/api/sessions"
check 'GET /api/sessions/:id'      200 "${BASE}/api/sessions/${SESSION_ID}"
check 'GET unknown session'        404 "${BASE}/api/sessions/does-not-exist"

check 'POST set-mode'              200 -X POST "${BASE}/api/sessions/${SESSION_ID}/set-mode" \
  -H 'content-type: application/json' --data "$(json '{"mode":"plan"}')"
contains 'set-mode persisted'      '"mode":"plan"'

# The turn loop is not built yet, so these must answer 501 rather than 404 or 500.
check 'POST /api/chat'             501 -X POST "${BASE}/api/chat" \
  -H 'content-type: application/json' \
  --data "$(json "{\"sessionId\":\"${SESSION_ID}\",\"mode\":\"agent\",\"messages\":[{\"text\":\"hi\"}]}")"
check 'PATCH /api/settings'        501 -X PATCH "${BASE}/api/settings" \
  -H 'content-type: application/json' --data "$(json '{}')"
check 'POST /api/test'             501 -X POST "${BASE}/api/test" \
  -H 'content-type: application/json' --data "$(json '{}')"

check 'DELETE /api/sessions/:id'   204 -X DELETE "${BASE}/api/sessions/${SESSION_ID}"
check 'GET deleted session'        404 "${BASE}/api/sessions/${SESSION_ID}"

if [[ "${FAILED}" -ne 0 ]]; then
  echo 'smoke: FAILED' >&2
  exit 1
fi

echo 'smoke: ok'
