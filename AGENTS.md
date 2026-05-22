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
