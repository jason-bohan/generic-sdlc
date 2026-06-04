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

### MLX Tool-Call Proxy

The MLX server emits tool calls as `<tools>{"name":..,"arguments":..}</tools>`
text instead of the OpenAI `tool_calls` array. A proxy at `scripts/mlx-proxy.ts`
intercepts responses and converts them to proper structured `tool_calls`.

Start it alongside the MLX server:
```
npm run mlx:proxy
```

The proxy listens on port 8084 by default (`MLX_PROXY_PORT` to override).
It forwards all traffic to the upstream MLX server (`MLX_HOST`, default
`http://localhost:8082`).

To use with opencode, the `opencode.json` mlx provider points at
`http://localhost:8084/v1`. To use with the SDLC framework loop
provider, set `MLX_HOST=http://localhost:8084`.
