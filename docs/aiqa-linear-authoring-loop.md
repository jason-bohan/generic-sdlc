---
name: aiqa-linear-authoring-loop
description: AI-QA findings → authored stories → Linear loop, verified end-to-end (incl. bulk linkage); config reqs, dedup rule, closing issues via Linear API
metadata: 
  node_type: memory
  type: project
  originSessionId: 9dc07b58-e168-4e66-b48b-68ea1aa161e8
---

As of 2026-06-09 the AI-QA → fix-story → Linear loop is fully wired and verified end-to-end from the dashboard desk (PRs #177, #178, #180 on main): pick a finding → author a fix story → story tagged with `sourceFindingId` → mirrored to the live tracker → reflected back on the finding's scorecard entry (badge + story link). The AI-QA desk now shows ALL findings (was top-6), an "Author Fix Stories" button, and a per-finding "Author fix story" action.

Non-obvious operational facts:
- The Linear mirror needs `PM_PROVIDER=linear` + `LINEAR_API_KEY` + `LINEAR_TEAM_ID` (all in .env). dotenv loads them at runtime, so `ps eww` won't show them — don't conclude they're unset from that.
- The mirror is **fire-and-forget**; failures are now logged (not swallowed) as `mirror to linear failed … story is local-only`. If authored stories aren't reaching Linear, grep the server log for that line.
- The finding→story link rides on the **content-stable finding id** (`source:agentId:title:evidence`), so it survives scorecard rebuilds. Stored on the local story as `sourceFindingId`.
- Bulk linkage is DONE (PR #181, merged 2026-06-09): the goal numbers findings and the model emits `findingRef` per story; the route resolves index→finding id and tags each story. Verified live — a bulk run tagged 5/5 stories. Note `linkAuthoredStories` is first-story-wins per finding, so a finding that already has a story keeps showing the original even after a duplicate bulk story links to the same id.

User feedback (2026-06-09): a story authored for a *net-new* finding is a **legit backlog item — keep it** (e.g. UNW-124..127 backfilled, UNW-129/131 from desk tests). But running bulk over findings that already have stories produces **duplicates** — those the user DOES want closed (UNW-133..137 were canceled). So the rule is net-new = keep, re-author-of-already-linked = dupe to close. Related: [[feedback-task-dedup]].

Closing/updating Linear issues from a session: the Linear **MCP is NOT authenticated** in sessions (`linear_auth` needed) — instead hit the GraphQL API directly with the `.env` `LINEAR_API_KEY`. Gotchas: the team filter wants `ID!` not `String!` (`team:{id:{eq:$t}}`, `$t:ID!`); the "Duplicate" workflow state can't be set without a formal duplicate-relation, so to just close dupes use the `canceled`-type state (`issueUpdate(input:{stateId})`). When canceling a mirrored issue, also `deleteLocalStory` its local counterpart so it doesn't re-mirror.

Server run pattern used this session: `nohup npm exec tsx src/server/index.ts > /tmp/sdlc-server.log 2>&1 &` (non-watch, per [[tsx-watch-zombie-hang]]); health via GET :3001/api/status. Relates to the "Linear alignment" NEXT item in [[loop-vs-opencode-serving-gap]].
