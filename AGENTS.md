# Agent Notes

See `constitution.json` for the authority hierarchy, protected invariants, branch policy, verification policy, and escalation triggers. This file (AGENTS.md) takes precedence for operational instructions.

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

## Worker Pool (1-bit models)

The `WorkerPool` (`src/server/workerPool.ts`) runs 1-bit models (e.g.
`prism-ml/Bonsai-8B-mlx-1bit`) in parallel for cheap reading/summarization
tasks so the 8-bit main model saves context for actual code generation.

Agents can call two delegation tools:
- `summarize_file{path}` — reads a file and returns a 1-3 sentence summary
  plus key exports/symbols. Use instead of `read_file` when you only need
  to understand what a file does, not its full contents.
- `summarize_search{pattern,directory?,include?}` — searches the codebase
  and returns a grouped per-file summary. Use instead of `search_in_files`
  or `grep` when you have a broad pattern.

The pool runs up to 2 concurrent workers (Apple Silicon memory ceiling).
Configured via `scheduler.workerPool` in `.sdlc-framework.config.json`.
Falls back to stubs when MLX is unavailable (dev/test).

The Bonsai 8B 1-bit (`prism-ml/Bonsai-8B-mlx-1bit`) has native MLX
kernels and runs efficiently on Apple Silicon. Its coding ability is
~3-4B FP equivalent, which is sufficient for summarization and search
grouping — the 8-bit Qwen 14B Q8 handles the actual coding decisions.

### Bonsai model setup

The Bonsai 1-bit model requires the [PrismML fork of MLX](https://github.com/PrismML-Eng/mlx/tree/prism)
with 1-bit GPU kernel support (upstream PR pending). This fork needs the
`metal` shader compiler, which requires **full Xcode** (not just Command
Line Tools):

1. Install Xcode from the Mac App Store and open it once to accept the license.
2. Set the active developer directory: `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`
3. Create a separate Python venv and build the fork:
   ```bash
   python3 -m venv ~/bonsai-env
   source ~/bonsai-env/bin/activate
   pip install "mlx-lm==0.30.7" setuptools
   CMAKE_ARGS="-DMLX_BUILD_METAL=ON" pip install git+https://github.com/PrismML-Eng/mlx.git@prism --no-build-isolation
   ```
4. Start the worker server on a dedicated port:
   ```bash
   mlx_lm server --model prism-ml/Bonsai-8B-mlx-1bit --host 127.0.0.1 --port 8083
   ```
5. Set `WORKER_MODEL=prism-ml/Bonsai-8B-mlx-1bit` and `WORKER_BASE_URL=http://localhost:8083/v1`
   (or update `.sdlc-framework.config.json`).

Without this setup, the pool falls back to stub summaries (empty strings).
The code path is identical regardless of which MLX model serves requests.
