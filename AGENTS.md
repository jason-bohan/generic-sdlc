# Agent Notes

## Node and worktrees

- Use NVS and the repo's `.node-version` before running Node, npm, tests, or dev servers:
  `nvs use 22`
- In noninteractive PowerShell sessions, avoid the NVS picker by prepending the installed Node 22 path:
  `$env:PATH = "$env:LOCALAPPDATA\nvs\node\22.22.2\x64;$env:PATH"`
- Worktrees should use a junctioned dependency tree, not a fresh install:
  `node_modules -> C:\repos\SDLC Framework\node_modules`
- Do not run `npm install` or `npm ci` inside worktrees unless the user explicitly asks.
- If a worktree is missing dependencies, create or repair the junction instead of installing packages.

## MLX (Apple Silicon)

- MLX runs faster than Ollama on Apple Silicon for the same model.
- Setup script: `./scripts/setup-mlx.sh` — installs `mlx-lm`, downloads a Q4 model, sets up a launch agent.
- The MLX server is an OpenAI-compatible API at `http://localhost:8082/v1`.
- Server probes at startup: `GET /api/mlx/health`, `GET /api/mlx/models`.
- Set `MLX_HOST` env var to override the default endpoint.
- To switch opencode to an MLX model: `/model mlx/<model-id>`.
