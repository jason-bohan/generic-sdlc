---
name: git-worktree
description: >-
  Create git worktrees with shared node_modules via NTFS junction. Use when
  creating a worktree, new branch in a separate directory, or when the user
  says worktree, junction, or isolated branch.
---

# Git Worktree with node_modules Junction

## Why

Creating a worktree normally requires a full `npm install` in the new directory. An NTFS junction lets the worktree share the main repo's `node_modules` instantly -- zero install time, zero extra disk space.

## Create a worktree

### 1. Create the worktree from the main repo

```powershell
# Existing branch
git worktree add ../SDLC Framework-<purpose> <branch-name>

# New branch off main
git worktree add -b <new-branch> ../SDLC Framework-<purpose> main
```

Naming convention: `../SDLC Framework-<short-purpose>` (e.g. `../SDLC Framework-fix-dedup`, `../SDLC Framework-feat-dark-mode`).

### 2. Create the node_modules junction

```powershell
New-Item -ItemType Junction -Path "../SDLC Framework-<purpose>/node_modules" -Target "c:\repos\SDLC Framework\node_modules"
```

### 3. Verify

```powershell
(Get-Item "../SDLC Framework-<purpose>/node_modules").Target
# Should print: c:\repos\SDLC Framework\node_modules
```

### 4. Move agent to the worktree (optional)

Use the `move_agent_to_root` MCP tool if the conversation should continue from the worktree:

```
CallMcpTool: cursor-app-control / move_agent_to_root
{ "rootPath": "c:\\repos\\SDLC Framework-<purpose>" }
```

## Cleanup

```powershell
git worktree remove ../SDLC Framework-<purpose>
```

The junction is inside the worktree directory, so it is removed automatically.

## Rules

- **Never run `npm install` inside a worktree** -- it writes into the main repo's `node_modules` through the junction.
- If dependencies change on main, run `npm install` in the main repo (`c:\repos\SDLC Framework`) only.
- The junction is transparent to Node/Vite/TypeScript -- imports resolve normally.
