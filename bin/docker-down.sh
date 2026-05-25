#!/usr/bin/env bash
# Stop the SDLC Framework Docker stack for the current worktree.
#
# Usage:
#   bin/docker-down.sh [--volumes]
#
# Options:
#   --volumes    Also remove per-worktree volumes (DB, .sdlc-framework state).
#                The shared Ollama model cache is never removed.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VOLUMES=0
for arg in "$@"; do
  case "$arg" in
    --volumes) VOLUMES=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

WORKTREE_NAME=$(basename "$(git rev-parse --show-toplevel)" | tr -cs 'a-zA-Z0-9' '-' | tr '[:upper:]' '[:lower:]')
PROJECT_NAME="sdlc-framework-${WORKTREE_NAME}"
PROJECT_NAME=$(echo "$PROJECT_NAME" | tr -s '-')
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

printf '\033[36m▶ Stopping stack: %s\033[0m\n' "$PROJECT_NAME"

DOWN_ARGS=(compose down)
if [ "$VOLUMES" = "1" ]; then
  DOWN_ARGS+=(--volumes)
  printf '  \033[2mRemoving per-worktree volumes (Ollama model cache preserved)\033[0m\n'
fi

docker "${DOWN_ARGS[@]}"
rm -f .sdlc-framework/docker-ports.json .sdlc-framework/.dev-port
printf '\033[32m✅ Stack stopped\033[0m\n'
