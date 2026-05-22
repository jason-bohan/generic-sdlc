# MCP Agility Server

Local MCP server that connects Digital.ai Agility (VersionOne) to AI assistants in Cursor and VS Code. Each team member runs this on their own machine -- no cloud hosting needed, works behind VPN.

## Prerequisites

- **Node.js 18+** (the server uses native `fetch`)
- **Digital.ai Agility API key** (Bearer token)

## Install

```bash
cd tools/mcp-agility
npm install
```

## Configuration

The server reads two environment variables, both set in your IDE's MCP config:

| Variable | Purpose | Example |
|----------|---------|---------|
| `AGILITY_API_KEY` | Your personal Bearer token | `1.yaIaEh7dZbNxU8z4PUlZCXQOzSo=` |
| `AGILITY_BASE_URL` | Agility instance root (no trailing slash) | `https://www2.v1host.com/YourCompanyInc` |

For local SDLC Framework test mode, run the dashboard server and point the MCP server at the mock V1 surface:

```env
AGILITY_BASE_URL=http://localhost:3847/mock-v1
AGILITY_API_KEY=mock-token
```

The MCP will call the usual `/rest-1.v1/Data/...` paths, but SDLC Framework will persist fake stories and tasks in `.sdlc-framework/mock/state.json`.

### How to get an API key

1. Log in to Digital.ai Agility
2. Click your profile icon (top right) > **Applications**
3. Under **Personal Access Tokens**, click **Create Token**
4. Copy the token (it starts with `1.`)

## IDE Setup

### Cursor

Add to `~/.cursor/mcp.json` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "Agility (Digital.ai) [formerly VersionOne]": {
      "command": "node",
      "args": ["C:/repos/hub/tools/mcp-agility/index.js"],
      "env": {
        "AGILITY_API_KEY": "1.your-personal-key-here",
        "AGILITY_BASE_URL": "https://www2.v1host.com/YourCompanyInc"
      }
    }
  }
}
```

Adjust the path to match where you cloned the repo. Restart Cursor after saving.

### VS Code

Add to `.vscode/mcp.json` in any workspace, or to your user `settings.json`:

```json
{
  "mcpServers": {
    "Agility (Digital.ai) [formerly VersionOne]": {
      "command": "node",
      "args": ["C:/repos/hub/tools/mcp-agility/index.js"],
      "env": {
        "AGILITY_API_KEY": "1.your-personal-key-here",
        "AGILITY_BASE_URL": "https://www2.v1host.com/YourCompanyInc"
      }
    }
  }
}
```

## Tools

### Name-to-OID resolution

The create tools (`create_story`, `create_defect`, `create_task`) accept **friendly names** for fields that reference other Agility assets. For example, you can pass `scope: "Hub"` instead of `scope: "Scope:12345"`. The server resolves the name to an OID via the Agility API before creating the work item.

If a name matches multiple assets, the server returns an error listing the matches so you can use a specific OID instead.

Raw OIDs (e.g. `Scope:12345`) are always accepted and skip the lookup.

### Stories

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_story` | Fetch a story by number | `number` (e.g. `B-12345`) |
| `search_stories` | Search with filters | `project`, `team`, `status`, `owner`, `text`, `includeClosed`, `maxResults` |
| `create_story` | Create a new story | `name`, `scope`, `parent`, `category` (all required; accept names or OIDs) |
| `update_story_field` | Update any story field | `number`, `field`, `value` |

**`create_story` resolvable fields:** `scope` (project), `parent` (backlog group), `category` (story type), `team`, `environment`, `epic`, `owners`

**`update_story_field` allowed fields:** `name`, `description`, `acceptance_criteria`, `frontend`, `backend`, `qa`, `knowledge_base`, `estimate`

### Defects

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_defect` | Fetch a defect by number | `number` (e.g. `D-01234`) |
| `search_defects` | Search with filters | `project`, `team`, `status`, `owner`, `text`, `includeClosed`, `maxResults` |
| `create_defect` | Create a new defect | `name`, `scope`, `parent`, `source` (all required; accept names or OIDs) |
| `update_defect_field` | Update any defect field | `number`, `field`, `value` |

**`create_defect` resolvable fields:** `scope` (project), `parent` (backlog group), `source`, `team`, `type` (defect type), `environment`, `owners`

**`update_defect_field` allowed fields:** `name`, `description`, `resolution`, `root_cause`

### Testing Notes

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `update_testing_notes` | Update QA/testing notes | `number` (story or defect), `notes` |

Automatically routes to the correct field: `Custom_QA` for stories, `Resolution` for defects.

### Tasks

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_tasks` | List tasks for a story/defect | `parent` (e.g. `B-12345`) |
| `create_task` | Create a task | `parent`, `name`, plus optional `description`, `estimate`, `category`, `owners` (accept names or OIDs) |
| `update_task` | Update a task field | `number` (e.g. `TK-00123`), `field`, `value` |

**`create_task` resolvable fields:** `category` (task category), `owners`

**`update_task` allowed fields:** `name`, `description`, `status`, `todo`, `estimate`

### Links & Attachments

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_links` | Get links on a work item | `number` (e.g. `B-12345` or `D-01234`) |
| `get_attachments` | Get attachments on a work item | `number` (e.g. `B-12345` or `D-01234`) |

### Lookup

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_lookup_values` | List valid names/OIDs for an entity type | `type` (e.g. `Theme`, `StoryCategory`, `Team`), `maxResults` |

Use this tool to discover valid values before calling create tools. Supported types: `Scope`, `Theme`, `StoryCategory`, `DefectType`, `StorySource`, `Team`, `TaskCategory`, `Custom_Environment`, `Epic`, `Member`.

## Troubleshooting

**"AGILITY_API_KEY environment variable is required"** -- Add the `env` block to your MCP server config. See [IDE Setup](#ide-setup) above.

**"Agility API 401"** -- Your API key is invalid or expired. Generate a new one from Agility > Profile > Applications > Personal Access Tokens.

**"Agility API 403"** -- Your token doesn't have permission for that operation. Check your Agility role.

**Connection timeout** -- Make sure you're connected to VPN if your Agility instance requires it.

**"No story/defect found with number X"** -- Double-check the number format (e.g. `B-12345`, not `12345`).
