#!/usr/bin/env bash
# Start an isolated SDLC Framework dev stack for the current git worktree.
#
# Derives COMPOSE_PROJECT_NAME from the worktree directory so multiple worktrees
# can run simultaneously without port conflicts.  After startup it writes
# .sdlc-framework/.dev-port and docker-ports.json so Vite auto-detects the port.
#
# Usage:
#   bin/docker-up.sh [options]
#
# Options:
#   --meshllm          Also start the MeshLLM client container
#   --mock             Force mock external mode (no ADO/Agility calls)
#   --foreground       Run in foreground (stream logs); default is detached
#   -h, --help         Show this message

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# ── Parse args ────────────────────────────────────────────────────────────────
MESHLLM=0; MOCK=0; DETACH=1
for arg in "$@"; do
  case "$arg" in
    --meshllm)    MESHLLM=1 ;;
    --mock)       MOCK=1 ;;
    --foreground) DETACH=0 ;;
    -h|--help)
      sed -n '/^# Usage:/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \{0,2\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# ── Derive project name (same algorithm as docker-up.ps1) ────────────────────
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_NAME=$(basename "$WORKTREE_ROOT" | tr -cs 'a-zA-Z0-9' '-' | tr '[:upper:]' '[:lower:]')
PROJECT_NAME="sdlc-framework-${WORKTREE_NAME}"
PROJECT_NAME=$(echo "$PROJECT_NAME" | tr -s '-')
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

printf '\033[36m▶ Starting stack: %s\033[0m\n' "$PROJECT_NAME"

# ── Check Docker daemon ───────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running." >&2
  echo "Start Docker Desktop (or colima) then retry: colima start" >&2
  exit 1
fi

# ── Set env overrides ─────────────────────────────────────────────────────────
[ "$MOCK" = "1" ] && export SDLC_EXTERNAL_MODE=mock

# ── Compose file list ─────────────────────────────────────────────────────────
COMPOSE_FILES=(-f docker-compose.yml)
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  printf '  \033[2mGPU detected — enabling NVIDIA passthrough\033[0m\n'
  COMPOSE_FILES+=(-f docker-compose.gpu.yml)
else
  printf '  \033[2mNo GPU detected — Ollama will run on CPU\033[0m\n'
fi

# ── Build MeshLLM image if requested and missing ──────────────────────────────
MESHLLM_IMAGE='sdlc-framework-mesh-llm:client'
if [ "$MESHLLM" = "1" ]; then
  if ! docker image inspect "$MESHLLM_IMAGE" >/dev/null 2>&1; then
    printf '  \033[2mBuilding MeshLLM client image (first run — may take a few minutes)…\033[0m\n'
    DOCKER_BUILDKIT=0 docker build \
      -t "$MESHLLM_IMAGE" \
      -f docker/Dockerfile.client \
      --build-arg CMD=console \
      https://github.com/Mesh-LLM/mesh-llm.git#main
    printf '  \033[32mMeshLLM image ready\033[0m\n'
  fi
  COMPOSE_FILES+=(--profile meshllm)
fi

# ── Start the stack ───────────────────────────────────────────────────────────
UP_ARGS=("${COMPOSE_FILES[@]}" up --build --wait)
[ "$DETACH" = "1" ] && UP_ARGS+=(--detach)

if ! docker compose "${UP_ARGS[@]}"; then
  # If MeshLLM failed due to a port conflict (ports 9337/3131 already bound by
  # a container from a previous run), connect the existing container to our
  # project network under the "meshllm" alias instead of creating a new one.
  if [ "$MESHLLM" = "1" ]; then
    NETWORK="${PROJECT_NAME}_default"
    printf '  \033[33mMeshLLM port conflict — looking for existing container…\033[0m\n'
    EXISTING=$(docker ps --format '{{.Names}}' | grep -i meshllm | head -1 || true)
    if [ -n "$EXISTING" ]; then
      printf '  Connecting %s to %s as alias "meshllm"\n' "$EXISTING" "$NETWORK"
      docker network connect --alias meshllm "$NETWORK" "$EXISTING" 2>/dev/null || true
      printf '  \033[32mMeshLLM reused\033[0m\n'
    else
      echo "docker compose up failed and no existing meshllm container found." >&2
      exit 1
    fi
  else
    echo "docker compose up failed." >&2
    exit 1
  fi
fi

# ── Read assigned ports ───────────────────────────────────────────────────────
SERVER_BINDING=$(docker compose "${COMPOSE_FILES[@]}" port server 3001 2>/dev/null || true)
OLLAMA_BINDING=$(docker compose "${COMPOSE_FILES[@]}" port ollama 11434 2>/dev/null || true)
SERVER_PORT=${SERVER_BINDING##*:}
OLLAMA_PORT=${OLLAMA_BINDING##*:}

# ── Write port files so Vite and other tooling auto-detect ───────────────────
mkdir -p .sdlc-framework
printf '%s' "$SERVER_PORT" > .sdlc-framework/.dev-port
printf '{"serverPort":%s,"ollamaPort":%s,"projectName":"%s"}\n' \
  "${SERVER_PORT:-0}" "${OLLAMA_PORT:-0}" "$PROJECT_NAME" \
  > .sdlc-framework/docker-ports.json

# ── Print usage ───────────────────────────────────────────────────────────────
printf '\n\033[32m✅ Stack is up: %s\033[0m\n\n' "$PROJECT_NAME"
printf '  API server →  http://localhost:%s\n' "$SERVER_PORT"
[ -n "$OLLAMA_PORT" ] && printf '  Ollama      →  http://localhost:%s\n' "$OLLAMA_PORT"
if [ "$MESHLLM" = "1" ]; then
  printf '  MeshLLM     →  http://localhost:9337/v1\n'
  printf '  Mesh console→  http://localhost:3131\n'
fi
printf '\n'
printf '  \033[2mStart the dashboard (port auto-detected):\033[0m\n'
printf '    \033[33mnpm run dashboard\033[0m\n\n'
printf '  \033[2mRun smoke tests:\033[0m\n'
printf '    \033[33mbin/docker-test.sh\033[0m\n\n'
printf '  \033[2mStop the stack:\033[0m\n'
printf '    \033[33mbin/docker-down.sh\033[0m\n'
if [ "$MESHLLM" = "0" ]; then
  printf '\n  \033[2mStart with MeshLLM:\033[0m\n'
  printf '    \033[33mbin/docker-up.sh --meshllm\033[0m\n'
fi
printf '\n'
