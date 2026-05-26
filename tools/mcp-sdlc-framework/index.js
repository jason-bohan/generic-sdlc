import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.SDLC_FRAMEWORK_BASE_URL || "http://localhost:3001").replace(/\/$/, "");

const AGENT_IDS = ["frontend", "backend", "qa", "ux", "reviewer", "devops"];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDLC Framework API ${res.status}: ${body}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SDLC Framework API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SDLC Framework API ${res.status}: ${text}`);
  }
  return res.json();
}

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "SDLC Framework SDLC Orchestration",
  version: "1.0.0",
});

// ── get_agent_status ────────────────────────────────────────────────────────

server.tool(
  "get_agent_status",
  "Get the current status of one or all SDLC Framework agents. Returns phase, story number, running state, active session ID, tasks, and recent events.",
  {
    agentId: z
      .enum(["frontend", "backend", "qa", "ux", "reviewer", "devops"])
      .optional()
      .describe("Agent to query. Omit to get all agents."),
  },
  async ({ agentId }) => {
    try {
      if (agentId) {
        const status = await apiGet(`/api/status?agentId=${agentId}`);
        return textResult({ agentId, ...status });
      }
      const results = await Promise.all(
        AGENT_IDS.map(async (id) => {
          try {
            const s = await apiGet(`/api/status?agentId=${id}`);
            return { agentId: id, currentPhase: s.currentPhase, storyNumber: s.storyNumber, isRunning: s.isRunning, storyName: s.storyName ?? null };
          } catch (e) {
            return { agentId: id, error: e.message };
          }
        })
      );
      return textResult({ agents: results });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── list_agent_sessions ─────────────────────────────────────────────────────

server.tool(
  "list_agent_sessions",
  "List durable SDLC Framework agent sessions from SQLite. Useful for finding session IDs, active runs, PIDs, logs, and workflow linkage.",
  {
    agentId: z
      .enum(["frontend", "backend", "qa", "ux", "reviewer", "devops"])
      .optional()
      .describe("Agent to query. Omit to list recent sessions for all agents."),
    status: z.string().optional().describe("Filter by session status, e.g. running, completed, failed, stopped."),
    workflowItemId: z.number().int().optional().describe("Filter sessions for a workflow item ID."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum sessions to return."),
  },
  async ({ agentId, status, workflowItemId, limit }) => {
    try {
      const qs = new URLSearchParams();
      if (agentId) qs.set("agentId", agentId);
      if (status) qs.set("status", status);
      if (workflowItemId) qs.set("workflowItemId", String(workflowItemId));
      if (limit) qs.set("limit", String(limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await apiGet(`/api/agent-sessions${suffix}`);
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

server.tool(
  "get_agent_session",
  "Get one durable SDLC Framework agent session by session ID, including PID, status, workflow linkage, prompt/log files, and timestamps.",
  {
    sessionId: z.string().describe("Session ID from get_agent_status.activeSessionId or list_agent_sessions."),
  },
  async ({ sessionId }) => {
    try {
      const data = await apiGet(`/api/agent-sessions?id=${encodeURIComponent(sessionId)}`);
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── list_workflows ──────────────────────────────────────────────────────────

server.tool(
  "list_workflows",
  "List all active workflows tracked in SDLC Framework. Returns story number, assigned agent, current phase, and workflow ID for each.",
  {},
  async () => {
    try {
      const data = await apiGet("/api/workflows");
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── get_workflow ────────────────────────────────────────────────────────────

server.tool(
  "get_workflow",
  "Get detailed workflow info including phase history and artifacts for a specific workflow item.",
  {
    workflowItemId: z.number().describe("Workflow item ID from list_workflows"),
  },
  async ({ workflowItemId }) => {
    try {
      const data = await apiGet(`/api/workflows?id=${workflowItemId}`);
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── assign_story ────────────────────────────────────────────────────────────

server.tool(
  "assign_story",
  "Assign a work item to a SDLC Framework agent to start the SDLC workflow. The agent will read the work item, plan tasks, and begin coding.",
  {
    agentId: z
      .enum(["frontend", "backend", "qa", "ux"])
      .describe("Agent to assign the work item to"),
    storyNumber: z.string().describe("Work item key, e.g. B-12345 or issue number"),
    storyName: z.string().optional().describe("Work item title (avoids an extra planning lookup)"),
    storyDescription: z.string().optional().describe("Work item description text"),
    frontend: z.string().optional().describe("Frontend implementation notes from the planning item"),
    backend: z.string().optional().describe("Backend implementation notes from the planning item"),
    qa: z.string().optional().describe("QA notes from the planning item"),
  },
  async (params) => {
    try {
      const result = await apiPost("/api/scheduler/assign", params);
      return textResult(result);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── approve_story ───────────────────────────────────────────────────────────

server.tool(
  "approve_story",
  "Approve a story that is waiting for approval (pending-approval phase). Spawns the agent to begin work.",
  {
    agentId: z
      .enum(["frontend", "backend", "qa", "ux", "reviewer", "devops"])
      .describe("Agent ID that has a story in pending-approval"),
  },
  async ({ agentId }) => {
    try {
      const result = await apiPost("/api/scheduler/approve", { agentId });
      return textResult(result);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── continue_agent ──────────────────────────────────────────────────────────

server.tool(
  "continue_agent",
  "Resume an agent that is paused in step mode, or re-spawn an agent to continue its current phase. Optionally provide a phase hint or select specific tasks.",
  {
    agentId: z
      .enum(["frontend", "backend", "qa", "ux", "reviewer", "devops"])
      .describe("Agent to resume"),
    phaseHint: z
      .string()
      .optional()
      .describe("Optional phase directive, e.g. 'creating-pr' to push the agent toward a specific next phase"),
    selectedTaskIds: z
      .array(z.string())
      .optional()
      .describe("Limit the agent to specific task IDs only"),
  },
  async ({ agentId, phaseHint, selectedTaskIds }) => {
    try {
      const body = { agentId, ...(phaseHint ? { phaseHint } : {}), ...(selectedTaskIds ? { selectedTaskIds } : {}) };
      const result = await apiPost("/api/agent/continue", body);
      return textResult(result);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── run_workflow_phase ──────────────────────────────────────────────────────

server.tool(
  "run_workflow_phase",
  "Build the phase runner prompt for a workflow item and optionally spawn the agent. Use this to manually trigger a phase when step mode is off but the agent hasn't auto-started.",
  {
    storyNumber: z.string().describe("Work item key, e.g. B-12345 or issue number"),
    agentId: z
      .enum(["frontend", "backend", "qa", "ux", "reviewer", "devops"])
      .optional()
      .describe("Agent ID hint for lookup when multiple agents could own the story"),
    spawn: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to actually spawn the agent (default true)"),
  },
  async ({ storyNumber, agentId, spawn }) => {
    try {
      const body = { storyNumber, ...(agentId ? { agentId } : {}), spawn };
      const result = await apiPost("/api/workflows/run-phase", body);
      return textResult(result);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── dismiss_item ────────────────────────────────────────────────────────────

server.tool(
  "dismiss_item",
  "Dismiss a completed task or change-request from an agent's desk. Removes it from the agent's status file.",
  {
    agentId: z
      .enum(["frontend", "backend", "qa", "ux", "reviewer", "devops"])
      .describe("Agent whose desk to update"),
    itemId: z.string().describe("Task or request ID to dismiss"),
    itemType: z
      .enum(["task", "request"])
      .optional()
      .default("task")
      .describe("Whether to dismiss a task or change-request"),
  },
  async ({ agentId, itemId, itemType }) => {
    try {
      const result = await apiPost("/api/agent/dismiss-item", { agentId, itemId, itemType });
      return textResult(result);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── search_stories ──────────────────────────────────────────────────────────

server.tool(
  "search_stories",
  "Search planning work items visible to SDLC Framework. Returns open items ready for assignment.",
  {
    team: z.string().optional().describe("Filter by team name"),
    status: z.string().optional().describe("Filter by status name, e.g. 'Future', 'In Progress'"),
    text: z.string().optional().describe("Filter by story name (partial match)"),
    maxResults: z.number().optional().default(20).describe("Max results to return"),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams();
      if (params.team) qs.set("team", params.team);
      if (params.status) qs.set("status", params.status);
      if (params.text) qs.set("text", params.text);
      if (params.maxResults) qs.set("maxResults", String(params.maxResults));
      const data = await apiGet(`/api/planning/stories?${qs}`);
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── get_story ───────────────────────────────────────────────────────────────

server.tool(
  "get_story",
  "Get full planning work item detail including acceptance criteria, frontend/backend/QA fields, and a direct URL.",
  {
    number: z.string().describe("Work item key, e.g. B-12345 or issue number"),
  },
  async ({ number }) => {
    try {
      const data = await apiGet(`/api/planning/story?number=${encodeURIComponent(number)}`);
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── get_execution_mode ──────────────────────────────────────────────────────

server.tool(
  "get_execution_mode",
  "Get the current SDLC Framework execution mode (local, balanced, or speed).",
  {},
  async () => {
    try {
      const data = await apiGet("/api/execution-mode");
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── set_execution_mode ──────────────────────────────────────────────────────

server.tool(
  "set_execution_mode",
  "Set the SDLC Framework execution mode. 'local' uses Goose+Ollama only. 'balanced' uses Ollama for enrichment + REST API. 'speed' uses cloud AI.",
  {
    mode: z.enum(["local", "balanced", "speed"]).describe("Execution mode to set"),
  },
  async ({ mode }) => {
    try {
      const data = await apiPut("/api/execution-mode", { mode });
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── get_reviewer_prs ────────────────────────────────────────────────────────

server.tool(
  "get_reviewer_prs",
  "List review requests that are eligible for the reviewer agent to pick up.",
  {},
  async () => {
    try {
      const data = await apiGet("/api/reviewer/prs");
      return textResult(data);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ── reset_agents ────────────────────────────────────────────────────────────

server.tool(
  "reset_agents",
  "Reset ALL agents to idle, clearing their status files. Use this to recover from a stuck or inconsistent state. Requires explicit confirmation.",
  {
    confirm: z
      .boolean()
      .describe("Must be true to proceed. This clears all agent state."),
  },
  async ({ confirm }) => {
    try {
      if (!confirm) {
        return textResult({ error: "Pass confirm: true to reset all agents." });
      }
      const result = await apiPost("/api/agents/reset-to-idle", { confirm: "RESET_ALL_AGENTS" });
      return textResult(result);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
