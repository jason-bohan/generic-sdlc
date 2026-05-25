#!/usr/bin/env bash
# Run the SDLC Framework test suite against the running Docker stack.
#
# Reads the server port from .sdlc-framework/.dev-port (written by docker-up.sh).
# Runs vitest unit tests, then Cypress E2E tests against the live stack.
#
# Usage:
#   bin/docker-test.sh [options]
#
# Options:
#   --cypress-only      Skip vitest, only run Cypress
#   --unit-only         Skip Cypress, only run vitest
#   --open              Open Cypress in interactive mode
#   --spec <pattern>    Run only matching Cypress specs (comma-separated)
#   -h, --help          Show this message

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CYPRESS_ONLY=0; UNIT_ONLY=0; OPEN=0; SPEC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cypress-only) CYPRESS_ONLY=1 ;;
    --unit-only)    UNIT_ONLY=1 ;;
    --open)         OPEN=1 ;;
    --spec)         shift; SPEC="$1" ;;
    -h|--help)
      sed -n '/^# Usage:/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \{0,2\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# ── Read port from .dev-port (written by docker-up.sh) ───────────────────────
DEV_PORT_FILE=".sdlc-framework/.dev-port"
if [ ! -f "$DEV_PORT_FILE" ]; then
  echo "No .sdlc-framework/.dev-port found. Run bin/docker-up.sh first." >&2
  exit 1
fi
SERVER_PORT=$(cat "$DEV_PORT_FILE")
API_URL="http://localhost:${SERVER_PORT}"
# Vite uses API_PORT + 1000 when API_PORT != 3001 (matches vite.config.ts logic)
if [ "$SERVER_PORT" = "3001" ]; then
  VITE_PORT=3847
else
  VITE_PORT=$((SERVER_PORT + 1000))
fi
DASHBOARD_URL="http://localhost:${VITE_PORT}"

echo ""
echo "▶ Running tests against $API_URL"

PASS=0; FAIL=0

# ── Unit tests ────────────────────────────────────────────────────────────────
if [ "$CYPRESS_ONLY" = "0" ]; then
  echo ""
  echo "── Unit tests (vitest) ──────────────────────────────────────────────────────"
  if npm run test; then
    PASS=$((PASS + 1))
    printf '\033[32m  ✔ Unit tests passed\033[0m\n'
  else
    FAIL=$((FAIL + 1))
    printf '\033[31m  ✖ Unit tests failed\033[0m\n'
  fi
fi

# ── Cypress E2E ───────────────────────────────────────────────────────────────
if [ "$UNIT_ONLY" = "0" ]; then
  echo ""
  echo "── Cypress E2E ──────────────────────────────────────────────────────────────"

  # Vite must be running; auto-start it if not
  if ! curl -sf "$DASHBOARD_URL" >/dev/null 2>&1; then
    echo "  Starting Vite dashboard on port ${VITE_PORT}…"
    npm run dashboard &
    VITE_PID=$!
    for i in $(seq 1 15); do
      sleep 1
      curl -sf "$DASHBOARD_URL" >/dev/null 2>&1 && break
    done
    trap 'kill $VITE_PID 2>/dev/null || true' EXIT
  fi

  CYPRESS_ARGS=(npx cypress)
  if [ "$OPEN" = "1" ]; then
    CYPRESS_ARGS+=(open)
  else
    CYPRESS_ARGS+=(run)
  fi
  CYPRESS_ARGS+=(--config "baseUrl=${DASHBOARD_URL}" --env "apiUrl=${API_URL}")
  [ -n "$SPEC" ] && CYPRESS_ARGS+=(--spec "$SPEC")

  if "${CYPRESS_ARGS[@]}"; then
    PASS=$((PASS + 1))
    printf '\033[32m  ✔ Cypress tests passed\033[0m\n'
  else
    FAIL=$((FAIL + 1))
    printf '\033[31m  ✖ Cypress tests failed\033[0m\n'
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" = "0" ]; then
  printf '\033[32m✅ All test suites passed\033[0m\n'
  exit 0
else
  printf '\033[31m✖ %s suite(s) failed\033[0m\n' "$FAIL"
  exit 1
fi
