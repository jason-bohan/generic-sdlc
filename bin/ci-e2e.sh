#!/usr/bin/env bash
# Cypress E2E test runner for Linux CI (Azure Pipelines ubuntu-latest).
# Mirrors the lifecycle of bin/docker-test.ps1 but in bash.
#
# Usage:
#   bash bin/ci-e2e.sh
#
# Expects:
#   - Docker + docker compose v2 available
#   - npm ci already run
#   - Cypress binary cached (npm ci installs it)

set -euo pipefail

PROJECT="sdlc-framework-test-ci"
VITE_PORT=4000
VITE_PID=""
EXIT_CODE=0
DOCKER_START_LOG=""
VITE_LOG=""
CYPRESS_LOG=""

section() {
    echo ""
    echo "##[section]$1"
    echo "▶ $1"
}

group() {
    echo "##[group]$1"
}

end_group() {
    echo "##[endgroup]"
}

show_docker_diagnostics() {
    section "Docker startup diagnostics"

    if [[ -n "$DOCKER_START_LOG" && -f "$DOCKER_START_LOG" ]]; then
        group "Docker compose startup output"
        cat "$DOCKER_START_LOG"
        end_group
    fi

    group "Compose service status"
    COMPOSE_PROJECT_NAME=$PROJECT \
        docker compose -f docker-compose.yml -f docker-compose.test.yml ps || true
    end_group

    group "Server container logs"
    COMPOSE_PROJECT_NAME=$PROJECT \
        docker compose -f docker-compose.yml -f docker-compose.test.yml logs --no-color --tail=200 server || true
    end_group
}

show_runtime_diagnostics() {
    section "E2E failure diagnostics"

    if [[ -n "$CYPRESS_LOG" && -f "$CYPRESS_LOG" ]]; then
        echo "----- Cypress output tail -----"
        tail -n 200 "$CYPRESS_LOG" || true
        echo "----- End Cypress output tail -----"
    fi

    if [[ -n "$VITE_LOG" && -f "$VITE_LOG" ]]; then
        echo "----- Vite output tail -----"
        tail -n 120 "$VITE_LOG" || true
        echo "----- End Vite output tail -----"
    fi

    echo "----- Server container logs -----"
    COMPOSE_PROJECT_NAME=$PROJECT \
        docker compose -f docker-compose.yml -f docker-compose.test.yml logs --no-color --tail=120 server || true
    echo "----- End server container logs -----"

    echo "----- Cypress screenshots and videos -----"
    find cypress/screenshots cypress/videos -maxdepth 3 -type f 2>/dev/null | sort || true
    echo "----- End Cypress screenshots and videos -----"
}

cleanup() {
    section "E2E cleanup"
    group "Stop Vite and remove Docker test stack"
    if [[ -n "$VITE_PID" ]]; then
        kill -TERM "-$VITE_PID" 2>/dev/null || kill "$VITE_PID" 2>/dev/null || true
        sleep 2
        kill -KILL "-$VITE_PID" 2>/dev/null || true
    fi
    COMPOSE_PROJECT_NAME=$PROJECT \
        docker compose -f docker-compose.yml -f docker-compose.test.yml down --volumes 2>/dev/null || true
    end_group
}
trap cleanup EXIT

# ── Start server container ────────────────────────────────────────────────────
section "Docker test server"
mkdir -p .sdlc-framework
group "Build image and start server-only mock stack"
DOCKER_START_LOG="$(mktemp)"
set +e
COMPOSE_PROJECT_NAME=$PROJECT \
    docker compose -f docker-compose.yml -f docker-compose.test.yml up --build --detach --wait --wait-timeout 120 --no-deps server 2>&1 | tee "$DOCKER_START_LOG"
DOCKER_EXIT=${PIPESTATUS[0]}
set -e
end_group
if [[ $DOCKER_EXIT -ne 0 ]]; then
    echo "##[error]Docker test server failed to start (exit $DOCKER_EXIT)"
    show_docker_diagnostics
    exit $DOCKER_EXIT
fi

group "Resolve server port"
BINDING=$(COMPOSE_PROJECT_NAME=$PROJECT \
    docker compose -f docker-compose.yml -f docker-compose.test.yml port server 3001)
SERVER_PORT="${BINDING##*:}"
echo "  Test server → http://localhost:$SERVER_PORT"
end_group

# ── Start Vite dashboard ──────────────────────────────────────────────────────
section "Vite dashboard"
group "Start dashboard on port $VITE_PORT"
VITE_LOG="$(mktemp)"
setsid env SDLC_API_PORT="$SERVER_PORT" SDLC_VITE_PORT="$VITE_PORT" npm run dashboard >"$VITE_LOG" 2>&1 < /dev/null &
VITE_PID=$!
echo "  Vite log: $VITE_LOG"
end_group

group "Wait for dashboard readiness"
echo "  Waiting for Vite..."
for i in $(seq 1 40); do
    if curl -sf "http://localhost:$VITE_PORT" > /dev/null 2>&1; then
        echo "  Dashboard ready after ${i}s"
        end_group
        break
    fi
    sleep 1
    if [[ $((i % 5)) -eq 0 ]]; then
        echo "  Still waiting after ${i}s..."
    fi
    if [[ $i -eq 40 ]]; then
        end_group
        echo "##[error]Vite did not start within 40s"
        echo "❌ Vite did not start within 40s — aborting"
        show_runtime_diagnostics
        exit 1
    fi
done

# ── Run Cypress ───────────────────────────────────────────────────────────────
section "Cypress E2E"
group "Run Cypress in Electron"
CYPRESS_LOG="$(mktemp)"
set +e
CYPRESS_BASE_URL="http://localhost:$VITE_PORT" \
CYPRESS_API_URL="http://localhost:$SERVER_PORT" \
    npx cypress run --browser electron 2>&1 | tee "$CYPRESS_LOG"
EXIT_CODE=${PIPESTATUS[0]}
set -e
end_group

if [[ $EXIT_CODE -eq 0 ]]; then
    echo "##[section]Cypress passed"
    echo "✅ Cypress passed"
else
    echo "##[error]Cypress failed (exit $EXIT_CODE)"
    echo "❌ Cypress failed (exit $EXIT_CODE)"
    show_runtime_diagnostics
fi

exit $EXIT_CODE
