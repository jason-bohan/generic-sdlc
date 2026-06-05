#!/usr/bin/env bash
#
# Headless Claude Code agent launcher for SDLC Framework (macOS / Linux).
# POSIX-bash equivalent of bin/run-agent-claude.ps1.
#
# Called by spawn-agent.ts when scheduler.driver = "claude-code" on a non-Windows host.
# Requires 'claude' on PATH (npm install -g @anthropic-ai/claude-code).
#
# Usage: run-agent-claude.sh <AgentId> <PromptFile> <WorkspaceDir> [Model]
set -euo pipefail

AGENT_ID="${1:?AgentId required}"
PROMPT_FILE="${2:?PromptFile required}"
WORKSPACE_DIR="${3:?WorkspaceDir required}"
MODEL="${4:-auto}"

cd "$WORKSPACE_DIR"
CONFIG_PATH="$WORKSPACE_DIR/.sdlc-framework.config.json"

# Resolve external mode: env override wins, else read the config (mock if
# externalMode or integrations.mode is "mock"), else default live.
external_mode() {
    if [ "${SDLC_EXTERNAL_MODE:-}" = "mock" ] || [ "${SDLC_EXTERNAL_MODE:-}" = "live" ]; then
        printf '%s' "$SDLC_EXTERNAL_MODE"; return
    fi
    if [ -f "$CONFIG_PATH" ]; then
        node -e '
            try {
                const c = require(process.argv[1]);
                process.stdout.write((c.externalMode === "mock" || (c.integrations && c.integrations.mode === "mock")) ? "mock" : "live");
            } catch { process.stdout.write("live"); }
        ' "$CONFIG_PATH" 2>/dev/null || printf 'live'
        return
    fi
    printf 'live'
}

install_mock_guards() {
    local mock_bin="$WORKSPACE_DIR/.sdlc-framework/mock-bin"
    mkdir -p "$mock_bin"

    # git shim: block `git push`, pass everything else through to the real git.
    local real_git
    real_git="$(command -v git || true)"
    if [ -n "$real_git" ]; then
        cat > "$mock_bin/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "push" ]; then
  echo "[sdlc-framework mock mode] git push is blocked. Use local commits and mock PR state only." 1>&2
  exit 88
fi
exec "$real_git" "\$@"
EOF
        chmod +x "$mock_bin/git"
    fi

    # az shim: block the Azure CLI entirely.
    cat > "$mock_bin/az" <<'EOF'
#!/usr/bin/env bash
echo "[sdlc-framework mock mode] Azure CLI is blocked. Use SDLC Framework mock API/state instead." 1>&2
exit 88
EOF
    chmod +x "$mock_bin/az"

    case ":$PATH:" in
        *":$mock_bin:"*) ;;
        *) export PATH="$mock_bin:$PATH" ;;
    esac
    export SDLC_FRAMEWORK_MOCK_MODE="1"
    echo "[run-agent-claude] Mock command guards installed (git push and az are blocked)"
}

if [ "$(external_mode)" = "mock" ]; then
    install_mock_guards
    export AGILITY_BASE_URL="http://localhost:3001/mock-v1"
    export V1_BASE_URL="http://localhost:3001/mock-v1"
    export AGILITY_API_KEY="mock-token"
    export V1_ACCESS_TOKEN="mock-token"
    echo "[run-agent-claude] External mode: MOCK (live ADO and git push are prohibited)"
fi

if [ ! -f "$PROMPT_FILE" ]; then
    echo "Prompt file not found: $PROMPT_FILE" 1>&2
    exit 1
fi

CLAUDE_EXE="$(command -v claude || true)"
if [ -z "$CLAUDE_EXE" ]; then
    # Fallback: common npm global bin locations on macOS/Linux.
    for cand in "$HOME/.npm-global/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude"; do
        if [ -x "$cand" ]; then CLAUDE_EXE="$cand"; break; fi
    done
fi
if [ -z "$CLAUDE_EXE" ]; then
    echo "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code" 1>&2
    exit 1
fi

PROMPT="$(cat "$PROMPT_FILE")"

echo "[run-agent-claude] Spawning Claude Code for agent: $AGENT_ID"
# The reviewer is READ-ONLY: deny file-mutation tools at the harness level (mirrors the
# opencode reviewer agent's disabled write/edit tools) so it cannot "implement instead of
# review". --disallowedTools is a hard deny enforced even under --dangerously-skip-permissions;
# the reviewer keeps Bash (gh/git) and Read (SKILL.md/status). Branch separately to avoid
# bash 3.2's empty-array error under `set -u`.
if [ "$AGENT_ID" = "reviewer" ]; then
    if [ "$MODEL" != "auto" ] && [ -n "$MODEL" ]; then
        exec "$CLAUDE_EXE" --dangerously-skip-permissions --disallowedTools "Write Edit MultiEdit NotebookEdit" -p "$PROMPT" --model "$MODEL"
    else
        exec "$CLAUDE_EXE" --dangerously-skip-permissions --disallowedTools "Write Edit MultiEdit NotebookEdit" -p "$PROMPT"
    fi
fi
# Branch instead of expanding a maybe-empty array — macOS bash 3.2 errors on
# "${arr[@]}" when empty under `set -u`.
if [ "$MODEL" != "auto" ] && [ -n "$MODEL" ]; then
    exec "$CLAUDE_EXE" --dangerously-skip-permissions -p "$PROMPT" --model "$MODEL"
else
    exec "$CLAUDE_EXE" --dangerously-skip-permissions -p "$PROMPT"
fi
