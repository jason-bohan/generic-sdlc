---
description: Protect vite.config.ts API middleware from accidental overwrites during code generation
globs:
  - vite.config.ts
alwaysApply: false
---

# vite.config.ts — Protected File

**DO NOT overwrite or replace the contents of `vite.config.ts`.**

This file contains critical API middleware endpoints that the SDLC Framework dashboard depends on:

- `/api/status` — agent status polling
- `/api/agility/*` — Agility proxy (teams, stories, story detail, tasks)
- `/api/chat` and `/api/chat/messages` — agent messaging
- `/api/scheduler/*` — story assignment and approval
- `/api/notify` — Teams webhook proxy
- `/api/ollama/*` — Ollama delegation proxy

## Rules for agents:

1. **NEVER use the Write tool** to overwrite `vite.config.ts` — always use StrReplace for targeted edits
2. **NEVER remove or modify existing middleware routes** unless the story specifically requires it
3. **Only ADD new middleware routes** when the story calls for new API endpoints
4. When adding routes, add them BEFORE the catch-all/fallback handlers
5. Preserve all imports, the `loadDotenv` call, `v1Fetch`, and the Tauri plugin configuration
