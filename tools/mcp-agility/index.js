import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGILITY_API_KEY = process.env.AGILITY_API_KEY;
const AGILITY_BASE_URL = process.env.AGILITY_BASE_URL;

if (!AGILITY_API_KEY) {
  throw new Error(
    "AGILITY_API_KEY environment variable is required. Set it in your IDE's MCP server config."
  );
}
if (!AGILITY_BASE_URL) {
  throw new Error(
    "AGILITY_BASE_URL environment variable is required. Set it in your IDE's MCP server config."
  );
}

const CONFIG = {
  apiKey: AGILITY_API_KEY,
  baseUrl: AGILITY_BASE_URL,
  dataUrl: `${AGILITY_BASE_URL}/rest-1.v1/Data`,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const DEFAULT_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: `Bearer ${CONFIG.apiKey}`,
};

async function agilityGet(path) {
  const url = `${CONFIG.dataUrl}${path}`;
  const res = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Agility API ${res.status}: ${body}`);
  }
  return res.json();
}

async function agilityPost(path, body) {
  const url = `${CONFIG.dataUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Agility API ${res.status}: ${text}`);
  }
  return res.json();
}

function attr(value) {
  return { value: value ?? "", act: "set" };
}

// ---------------------------------------------------------------------------
// Work-item resolution
// ---------------------------------------------------------------------------

async function resolveWorkItem(number) {
  const data = await agilityGet(
    `/PrimaryWorkitem?where=Number='${number}'&sel=Name`
  );
  if (!data.Assets || data.Assets.length === 0) {
    throw new Error(`No story or defect found with number "${number}"`);
  }
  const asset = data.Assets[0];
  const id = asset.id;
  const numericId = id.split(":")[1];
  const assetType = id.startsWith("Defect:") ? "Defect" : "Story";
  return { id, numericId, assetType };
}

// ---------------------------------------------------------------------------
// OID resolution — accept a friendly name OR a raw OID for any asset type
// ---------------------------------------------------------------------------

function isOid(value) {
  return /^[A-Za-z_]+:\d+$/.test(value);
}

async function resolveAsset(assetType, nameOrOid, extraWhere = "") {
  if (isOid(nameOrOid)) return nameOrOid;
  const where = `Name='${nameOrOid}'${extraWhere ? ";" + extraWhere : ""}`;
  const data = await agilityGet(`/${assetType}?sel=Name&where=${where}`);
  if (!data.Assets || data.Assets.length === 0) {
    throw new Error(
      `No ${assetType} found named "${nameOrOid}". Pass an OID (e.g. ${assetType}:12345) if the name is ambiguous.`
    );
  }
  if (data.Assets.length > 1) {
    const matches = data.Assets.map(
      (a) => `${a.id} (${a.Attributes.Name.value})`
    ).join(", ");
    throw new Error(
      `Multiple ${assetType} matches for "${nameOrOid}": ${matches}. Use an OID to be specific.`
    );
  }
  return data.Assets[0].id;
}

async function resolveMember(nameOrOid) {
  if (isOid(nameOrOid)) return nameOrOid;
  const byName = await agilityGet(
    `/Member?sel=Name,Nickname&where=Name='${nameOrOid}';AssetState='64'`
  );
  if (byName.Assets?.length === 1) return byName.Assets[0].id;
  if (byName.Assets?.length > 1) {
    const matches = byName.Assets.map(
      (a) => `${a.id} (${a.Attributes.Name.value})`
    ).join(", ");
    throw new Error(
      `Multiple Member matches for "${nameOrOid}": ${matches}. Use an OID to be specific.`
    );
  }
  const byNick = await agilityGet(
    `/Member?sel=Name,Nickname&where=Nickname='${nameOrOid}';AssetState='64'`
  );
  if (byNick.Assets?.length === 1) return byNick.Assets[0].id;
  if (byNick.Assets?.length > 1) {
    const matches = byNick.Assets.map(
      (a) => `${a.id} (${a.Attributes.Name.value})`
    ).join(", ");
    throw new Error(
      `Multiple Member matches for nickname "${nameOrOid}": ${matches}. Use an OID to be specific.`
    );
  }
  throw new Error(
    `No Member found named "${nameOrOid}". Pass an OID (e.g. Member:12345) if the name is different.`
  );
}

async function resolveMembers(namesOrOids) {
  if (!namesOrOids?.length) return [];
  return Promise.all(namesOrOids.map(resolveMember));
}

// ---------------------------------------------------------------------------
// Field maps
// ---------------------------------------------------------------------------

const STORY_FIELD_MAP = {
  name: "Name",
  description: "Description",
  acceptance_criteria: "Custom_AcceptanceCriteria",
  frontend: "Custom_Frontend",
  backend: "Custom_Backend",
  qa: "Custom_QA",
  knowledge_base: "Custom_KnowledgeBase",
  estimate: "Estimate",
};

const STORY_FIELDS_DESCRIPTION = Object.keys(STORY_FIELD_MAP).join(", ");

// ---------------------------------------------------------------------------
// Story select clauses
// ---------------------------------------------------------------------------

const STORY_DETAIL_SEL = [
  "Name",
  "Number",
  "Description",
  "Status.Name",
  "Team.Name",
  "Scope.Name",
  "Owners.Name",
  "Estimate",
  "IsClosed",
  "CreateDate",
  "ClosedDate",
  "Super.Name",
  "Super.Number",
  "Story.Category.Name",
  "Story.Custom_AcceptanceCriteria",
  "Story.Custom_Backend",
  "Story.Custom_Frontend",
  "Story.Custom_QA",
  "Story.Custom_KnowledgeBase",
  "Story.Custom_Environment",
  "Story.Custom_EstimatedCompletionDate",
  "ClassOfService.Name",
].join(",");

const STORY_LIST_SEL = [
  "Name",
  "Number",
  "Team.Name",
  "Scope.Name",
  "Status.Name",
  "Owners.Name",
  "IsClosed",
  "Estimate",
  "CreateDate",
  "ClosedDate",
].join(",");

// ---------------------------------------------------------------------------
// Response formatting helpers
// ---------------------------------------------------------------------------

function formatStoryDetail(asset) {
  const a = asset.Attributes;
  return {
    id: asset.id,
    number: a.Number?.value,
    name: a.Name?.value,
    description: a.Description?.value,
    status: a["Status.Name"]?.value,
    team: a["Team.Name"]?.value,
    project: a["Scope.Name"]?.value,
    owners: a["Owners.Name"]?.value,
    estimate: a.Estimate?.value,
    isClosed: a.IsClosed?.value,
    createDate: a.CreateDate?.value,
    closedDate: a.ClosedDate?.value,
    epic: a["Super.Name"]?.value
      ? { name: a["Super.Name"].value, number: a["Super.Number"]?.value }
      : null,
    category: a["Category.Name"]?.value,
    acceptanceCriteria: a.Custom_AcceptanceCriteria?.value,
    frontend: a.Custom_Frontend?.value,
    backend: a.Custom_Backend?.value,
    qa: a.Custom_QA?.value,
    knowledgeBase: a.Custom_KnowledgeBase?.value,
    environment: a["Custom_Environment.Name"]?.value,
    estimatedCompletionDate: a.Custom_EstimatedCompletionDate?.value,
    classOfService: a["ClassOfService.Name"]?.value,
  };
}

function formatListItem(asset) {
  const a = asset.Attributes;
  return {
    id: asset.id,
    number: a.Number?.value,
    name: a.Name?.value,
    status: a["Status.Name"]?.value,
    team: a["Team.Name"]?.value,
    project: a["Scope.Name"]?.value,
    owners: a["Owners.Name"]?.value,
    estimate: a.Estimate?.value,
    isClosed: a.IsClosed?.value,
    createDate: a.CreateDate?.value,
    closedDate: a.ClosedDate?.value,
  };
}

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Search where-clause builder
// ---------------------------------------------------------------------------

function buildWhere(params) {
  const clauses = [];
  if (params.project) clauses.push(`Scope.Name='${params.project}'`);
  if (params.team) clauses.push(`Team.Name='${params.team}'`);
  if (params.status) clauses.push(`Status.Name='${params.status}'`);
  if (params.owner) clauses.push(`Owners.Name='${params.owner}'`);
  if (params.text) clauses.push(`Name='${params.text}'`);
  if (!params.includeClosed) clauses.push(`IsClosed='false'`);
  return clauses.length > 0 ? `&where=${clauses.join(";")}` : "";
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "Agility (Digital.ai) [formerly VersionOne]",
  version: "1.0.0",
});

// ---- get_story -----------------------------------------------------------

server.tool(
  "get_story",
  "Fetch a story by its display number (e.g. B-12345). Returns all standard and custom fields.",
  { number: z.string().describe("Story display number, e.g. B-12345") },
  async ({ number }) => {
    try {
      const data = await agilityGet(
        `/Story?where=Number='${number}'&sel=${STORY_DETAIL_SEL}`
      );
      if (!data.Assets?.length) {
        return textResult({ error: `No story found with number "${number}"` });
      }
      return textResult(formatStoryDetail(data.Assets[0]));
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- search_stories ------------------------------------------------------

server.tool(
  "search_stories",
  "Search for stories with optional filters. Returns a summary list.",
  {
    project: z.string().optional().describe("Filter by project (Scope) name"),
    team: z.string().optional().describe("Filter by team name"),
    status: z.string().optional().describe("Filter by status name"),
    owner: z.string().optional().describe("Filter by owner name"),
    text: z.string().optional().describe("Filter by name (partial match)"),
    includeClosed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include closed stories"),
    maxResults: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum results to return"),
  },
  async (params) => {
    try {
      const where = buildWhere(params);
      const data = await agilityGet(
        `/Story?sel=${STORY_LIST_SEL}${where}&sort=Order&page=${params.maxResults},0`
      );
      const stories = (data.Assets || []).map(formatListItem);
      return textResult({ total: data.total ?? stories.length, stories });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- create_story --------------------------------------------------------

server.tool(
  "create_story",
  "Create a new story. Required: name (title), scope (project name or OID), parent (backlog group name or OID), category (type name or OID).",
  {
    name: z.string().describe("Story title"),
    scope: z
      .string()
      .describe("Project name or OID (e.g. 'Hub' or Scope:12345)"),
    parent: z
      .string()
      .describe("Backlog group name or OID (e.g. 'Istari' or Theme:123)"),
    category: z
      .string()
      .describe(
        "Story type/category name or OID (e.g. 'Roadmap Features' or StoryCategory:123)"
      ),
    description: z.string().optional().describe("Description (HTML allowed)"),
    team: z
      .string()
      .optional()
      .describe("Team name or OID (e.g. 'Istari' or Team:232824)"),
    estimate: z.number().optional().describe("Estimate points"),
    acceptanceCriteria: z.string().optional(),
    frontend: z.string().optional(),
    backend: z.string().optional(),
    qa: z.string().optional(),
    knowledgeBase: z.string().optional(),
    classOfService: z
      .string()
      .optional()
      .describe("Class of Service name or OID (e.g. 'Keep lights on' or ClassOfService:227)"),
    environment: z
      .string()
      .optional()
      .describe("Environment name or OID"),
    epic: z
      .string()
      .optional()
      .describe("Epic/Portfolio Item name or OID"),
    owners: z
      .array(z.string())
      .optional()
      .describe("Array of member names or OIDs to assign"),
  },
  async (params) => {
    try {
      const scopeOid = await resolveAsset(
        "Scope",
        params.scope,
        "AssetState='64'"
      );
      const parentOid = await resolveAsset("Theme", params.parent);
      const categoryOid = await resolveAsset("StoryCategory", params.category);

      const body = {
        Attributes: {
          Name: attr(params.name),
          Scope: attr(scopeOid),
          Parent: attr(parentOid),
          Category: attr(categoryOid),
        },
      };

      const teamOid = params.team
        ? await resolveAsset("Team", params.team, "AssetState='64'")
        : undefined;
      const cosOid = params.classOfService
        ? await resolveAsset("ClassOfService", params.classOfService)
        : undefined;
      const envOid = params.environment
        ? await resolveAsset("Custom_Environment", params.environment)
        : undefined;
      const epicOid = params.epic
        ? await resolveAsset("Epic", params.epic, "IsClosed='false'")
        : undefined;
      const ownerOids = await resolveMembers(params.owners);

      const optionalAttrs = {
        Description: params.description,
        Team: teamOid,
        Estimate: params.estimate,
        ClassOfService: cosOid,
        Custom_AcceptanceCriteria: params.acceptanceCriteria,
        Custom_Frontend: params.frontend,
        Custom_Backend: params.backend,
        Custom_QA: params.qa,
        Custom_KnowledgeBase: params.knowledgeBase,
        Custom_Environment: envOid,
        Super: epicOid,
      };

      for (const [key, val] of Object.entries(optionalAttrs)) {
        if (val !== undefined && val !== null) {
          body.Attributes[key] = attr(val);
        }
      }

      if (ownerOids.length) {
        body.Attributes.Owners = {
          name: "Owners",
          value: ownerOids.map((id) => ({ act: "add", idref: id })),
        };
      }

      const result = await agilityPost("/Story", body);
      const [assetType, assetId] = result.id.split(":");
      const detail = await agilityGet(`/${assetType}/${assetId}?sel=Number`);
      return textResult({
        created: true,
        id: result.id,
        number: detail.Attributes?.Number?.value,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- update_story_field --------------------------------------------------

server.tool(
  "update_story_field",
  `Update a field on a story. Allowed fields: ${STORY_FIELDS_DESCRIPTION}`,
  {
    number: z.string().describe("Story display number, e.g. B-12345"),
    field: z
      .enum(Object.keys(STORY_FIELD_MAP))
      .describe(`Field to update: ${STORY_FIELDS_DESCRIPTION}`),
    value: z
      .union([z.string(), z.number()])
      .nullable()
      .describe("New value for the field (null or empty string to clear)"),
  },
  async ({ number, field, value }) => {
    try {
      const { numericId } = await resolveWorkItem(number);
      const agilityField = STORY_FIELD_MAP[field];
      const body = { Attributes: { [agilityField]: attr(value) } };
      const result = await agilityPost(`/Story/${numericId}`, body);
      return textResult({
        updated: true,
        id: result.id,
        field: agilityField,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Defect field map and select clauses
// ---------------------------------------------------------------------------

const DEFECT_FIELD_MAP = {
  name: "Name",
  description: "Description",
  resolution: "Resolution",
  root_cause: "Custom_RootCause",
};

const DEFECT_FIELDS_DESCRIPTION = Object.keys(DEFECT_FIELD_MAP).join(", ");

const DEFECT_DETAIL_SEL = [
  "Name",
  "Number",
  "Description",
  "Status.Name",
  "Team.Name",
  "Scope.Name",
  "Owners.Name",
  "Estimate",
  "IsClosed",
  "CreateDate",
  "ClosedDate",
  "Super.Name",
  "Super.Number",
  "Defect.Type.Name",
  "Defect.Custom_Environment3",
  "Resolution",
  "Custom_RootCause",
  "Source.Name",
].join(",");

function formatDefectDetail(asset) {
  const a = asset.Attributes;
  return {
    id: asset.id,
    number: a.Number?.value,
    name: a.Name?.value,
    description: a.Description?.value,
    status: a["Status.Name"]?.value,
    team: a["Team.Name"]?.value,
    project: a["Scope.Name"]?.value,
    owners: a["Owners.Name"]?.value,
    estimate: a.Estimate?.value,
    isClosed: a.IsClosed?.value,
    createDate: a.CreateDate?.value,
    closedDate: a.ClosedDate?.value,
    epic: a["Super.Name"]?.value
      ? { name: a["Super.Name"].value, number: a["Super.Number"]?.value }
      : null,
    type: a["Type.Name"]?.value,
    environment: a["Custom_Environment3.Name"]?.value,
    resolution: a.Resolution?.value,
    rootCause: a.Custom_RootCause?.value,
    source: a["Source.Name"]?.value,
  };
}

// ---- get_defect ----------------------------------------------------------

server.tool(
  "get_defect",
  "Fetch a defect by its display number (e.g. D-01234). Returns all standard and defect-specific fields.",
  { number: z.string().describe("Defect display number, e.g. D-01234") },
  async ({ number }) => {
    try {
      const data = await agilityGet(
        `/Defect?where=Number='${number}'&sel=${DEFECT_DETAIL_SEL}`
      );
      if (!data.Assets?.length) {
        return textResult({
          error: `No defect found with number "${number}"`,
        });
      }
      return textResult(formatDefectDetail(data.Assets[0]));
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- search_defects ------------------------------------------------------

server.tool(
  "search_defects",
  "Search for defects with optional filters. Returns a summary list.",
  {
    project: z.string().optional().describe("Filter by project (Scope) name"),
    team: z.string().optional().describe("Filter by team name"),
    status: z.string().optional().describe("Filter by status name"),
    owner: z.string().optional().describe("Filter by owner name"),
    text: z.string().optional().describe("Filter by name (partial match)"),
    includeClosed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include closed defects"),
    maxResults: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum results to return"),
  },
  async (params) => {
    try {
      const where = buildWhere(params);
      const data = await agilityGet(
        `/Defect?sel=${STORY_LIST_SEL}${where}&sort=Order&page=${params.maxResults},0`
      );
      const defects = (data.Assets || []).map(formatListItem);
      return textResult({ total: data.total ?? defects.length, defects });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- create_defect -------------------------------------------------------

server.tool(
  "create_defect",
  "Create a new defect. Required: name (title), scope (project name or OID), parent (backlog group name or OID), source (source name or OID).",
  {
    name: z.string().describe("Defect title"),
    scope: z
      .string()
      .describe("Project name or OID (e.g. 'Hub' or Scope:12345)"),
    parent: z
      .string()
      .describe("Backlog group name or OID (e.g. 'Istari' or Theme:123)"),
    source: z
      .string()
      .describe("Source name or OID (e.g. 'Internal' or StorySource:123)"),
    description: z.string().optional().describe("Description (HTML allowed)"),
    team: z
      .string()
      .optional()
      .describe("Team name or OID (e.g. 'Istari' or Team:232824)"),
    type: z
      .string()
      .optional()
      .describe("Defect type name or OID"),
    environment: z
      .string()
      .optional()
      .describe("Environment name or OID"),
    owners: z
      .array(z.string())
      .optional()
      .describe("Array of member names or OIDs to assign"),
    rootCause: z.string().optional().describe("Root cause text"),
    resolution: z.string().optional().describe("Resolution details text"),
  },
  async (params) => {
    try {
      const scopeOid = await resolveAsset(
        "Scope",
        params.scope,
        "AssetState='64'"
      );
      const parentOid = await resolveAsset("Theme", params.parent);
      const sourceOid = await resolveAsset("StorySource", params.source);

      const body = {
        Attributes: {
          Name: attr(params.name),
          Scope: attr(scopeOid),
          Parent: attr(parentOid),
          Source: attr(sourceOid),
        },
      };

      const teamOid = params.team
        ? await resolveAsset("Team", params.team, "AssetState='64'")
        : undefined;
      const typeOid = params.type
        ? await resolveAsset("DefectType", params.type)
        : undefined;
      const envOid = params.environment
        ? await resolveAsset("Custom_Environment", params.environment)
        : undefined;
      const ownerOids = await resolveMembers(params.owners);

      const optionalAttrs = {
        Description: params.description,
        Team: teamOid,
        Type: typeOid,
        Custom_Environment3: envOid,
        Custom_RootCause: params.rootCause,
        Resolution: params.resolution,
      };

      for (const [key, val] of Object.entries(optionalAttrs)) {
        if (val !== undefined && val !== null) {
          body.Attributes[key] = attr(val);
        }
      }

      if (ownerOids.length) {
        body.Attributes.Owners = {
          name: "Owners",
          value: ownerOids.map((id) => ({ act: "add", idref: id })),
        };
      }

      const result = await agilityPost("/Defect", body);
      const [assetType, assetId] = result.id.split(":");
      const detail = await agilityGet(`/${assetType}/${assetId}?sel=Number`);
      return textResult({
        created: true,
        id: result.id,
        number: detail.Attributes?.Number?.value,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- update_defect_field -------------------------------------------------

server.tool(
  "update_defect_field",
  `Update a field on a defect. Allowed fields: ${DEFECT_FIELDS_DESCRIPTION}`,
  {
    number: z.string().describe("Defect display number, e.g. D-01234"),
    field: z
      .enum(Object.keys(DEFECT_FIELD_MAP))
      .describe(`Field to update: ${DEFECT_FIELDS_DESCRIPTION}`),
    value: z
      .union([z.string(), z.number()])
      .nullable()
      .describe("New value for the field (null or empty string to clear)"),
  },
  async ({ number, field, value }) => {
    try {
      const { numericId } = await resolveWorkItem(number);
      const agilityField = DEFECT_FIELD_MAP[field];
      const body = { Attributes: { [agilityField]: attr(value) } };
      const result = await agilityPost(`/Defect/${numericId}`, body);
      return textResult({
        updated: true,
        id: result.id,
        field: agilityField,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- update_testing_notes (convenience) ----------------------------------

server.tool(
  "update_testing_notes",
  "Update testing notes on a story or defect. Routes to Custom_QA for stories, Resolution for defects.",
  {
    number: z
      .string()
      .describe("Work item display number, e.g. B-12345 or D-01234"),
    notes: z.string().describe("Testing notes content"),
  },
  async ({ number, notes }) => {
    try {
      const { numericId, assetType } = await resolveWorkItem(number);
      const field = assetType === "Defect" ? "Resolution" : "Custom_QA";
      const body = { Attributes: { [field]: attr(notes) } };
      const result = await agilityPost(
        `/${assetType}/${numericId}`,
        body
      );
      return textResult({
        updated: true,
        id: result.id,
        field,
        assetType,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

const TASK_SEL = [
  "Name",
  "Number",
  "Description",
  "Status.Name",
  "DetailEstimate",
  "ToDo",
  "Owners.Name",
  "Category.Name",
].join(",");

const TASK_FIELD_MAP = {
  name: "Name",
  description: "Description",
  status: "Status",
  todo: "ToDo",
  estimate: "DetailEstimate",
};

const TASK_FIELDS_DESCRIPTION = Object.keys(TASK_FIELD_MAP).join(", ");

function formatTask(asset) {
  const a = asset.Attributes;
  return {
    id: asset.id,
    number: a.Number?.value,
    name: a.Name?.value,
    description: a.Description?.value,
    status: a["Status.Name"]?.value,
    estimate: a.DetailEstimate?.value,
    toDo: a.ToDo?.value,
    owners: a["Owners.Name"]?.value,
    category: a["Category.Name"]?.value,
  };
}

// ---- get_tasks -----------------------------------------------------------

server.tool(
  "get_tasks",
  "List tasks for a story or defect.",
  {
    parent: z
      .string()
      .describe(
        "Parent story/defect display number, e.g. B-12345 or D-01234"
      ),
  },
  async ({ parent }) => {
    try {
      const { id } = await resolveWorkItem(parent);
      const data = await agilityGet(
        `/Task?where=Parent='${id}'&sel=${TASK_SEL}&sort=Name`
      );
      const tasks = (data.Assets || []).map(formatTask);
      return textResult({ parent, total: tasks.length, tasks });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- create_task ---------------------------------------------------------

server.tool(
  "create_task",
  "Create a task under a story or defect.",
  {
    parent: z
      .string()
      .describe(
        "Parent story/defect display number, e.g. B-12345 or D-01234"
      ),
    name: z.string().describe("Task name"),
    description: z.string().optional().describe("Task description"),
    estimate: z
      .number()
      .optional()
      .describe("Detail estimate (hours). Also sets initial ToDo."),
    category: z
      .string()
      .optional()
      .describe("Task category name or OID"),
    owners: z
      .array(z.string())
      .optional()
      .describe("Array of member names or OIDs to assign"),
  },
  async (params) => {
    try {
      const { id: parentId } = await resolveWorkItem(params.parent);
      const categoryOid = params.category
        ? await resolveAsset("TaskCategory", params.category)
        : undefined;
      const ownerOids = await resolveMembers(params.owners);

      const body = {
        Attributes: {
          Name: attr(params.name),
          Parent: attr(parentId),
        },
      };

      if (params.description !== undefined) {
        body.Attributes.Description = attr(params.description);
      }
      if (params.estimate !== undefined) {
        body.Attributes.DetailEstimate = attr(params.estimate);
        body.Attributes.ToDo = attr(params.estimate);
      }
      if (categoryOid) {
        body.Attributes.Category = attr(categoryOid);
      }
      if (ownerOids.length) {
        body.Attributes.Owners = {
          name: "Owners",
          value: ownerOids.map((id) => ({ act: "add", idref: id })),
        };
      }

      const result = await agilityPost("/Task", body);
      const [assetType, assetId] = result.id.split(":");
      const detail = await agilityGet(`/${assetType}/${assetId}?sel=Number`);
      return textResult({
        created: true,
        id: result.id,
        number: detail.Attributes?.Number?.value,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- update_task ---------------------------------------------------------

server.tool(
  "update_task",
  `Update a field on a task. Allowed fields: ${TASK_FIELDS_DESCRIPTION}`,
  {
    number: z.string().describe("Task display number, e.g. TK-00123"),
    field: z
      .enum(Object.keys(TASK_FIELD_MAP))
      .describe(`Field to update: ${TASK_FIELDS_DESCRIPTION}`),
    value: z
      .union([z.string(), z.number()])
      .nullable()
      .describe("New value for the field (null or empty string to clear)"),
  },
  async ({ number, field, value }) => {
    try {
      const data = await agilityGet(
        `/Task?where=Number='${number}'&sel=Name`
      );
      if (!data.Assets?.length) {
        return textResult({
          error: `No task found with number "${number}"`,
        });
      }
      const taskId = data.Assets[0].id.split(":")[1];
      const agilityField = TASK_FIELD_MAP[field];
      const body = { Attributes: { [agilityField]: attr(value) } };
      const result = await agilityPost(`/Task/${taskId}`, body);
      return textResult({
        updated: true,
        id: result.id,
        field: agilityField,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Links and Attachments
// ---------------------------------------------------------------------------

// ---- get_links -----------------------------------------------------------

server.tool(
  "get_links",
  "Get links attached to a story or defect.",
  {
    number: z
      .string()
      .describe("Display number, e.g. B-12345 or D-01234"),
  },
  async ({ number }) => {
    try {
      const { numericId } = await resolveWorkItem(number);
      const data = await agilityGet(
        `/PrimaryWorkitem/${numericId}?sel=Links,Links.Name,Links.URL`
      );
      const a = data.Attributes;
      const names = a["Links.Name"]?.value || [];
      const urls = a["Links.URL"]?.value || [];
      const links = names.map((name, i) => ({ name, url: urls[i] }));
      return textResult({ number, total: links.length, links });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---- get_attachments -----------------------------------------------------

server.tool(
  "get_attachments",
  "Get attachments on a story or defect.",
  {
    number: z
      .string()
      .describe("Display number, e.g. B-12345 or D-01234"),
  },
  async ({ number }) => {
    try {
      const { numericId } = await resolveWorkItem(number);
      const data = await agilityGet(
        `/PrimaryWorkitem/${numericId}?sel=Attachments,Attachments.Name,Attachments.Filename`
      );
      const a = data.Attributes;
      const names = a["Attachments.Name"]?.value || [];
      const filenames = a["Attachments.Filename"]?.value || [];
      const attachments = names.map((name, i) => ({
        name,
        filename: filenames[i],
      }));
      return textResult({
        number,
        total: attachments.length,
        attachments,
      });
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Lookup values
// ---------------------------------------------------------------------------

const LOOKUP_CONFIG = {
  Scope: { sel: "Name", where: "AssetState='64'", sort: "Name" },
  Theme: { sel: "Name", sort: "Name" },
  StoryCategory: { sel: "Name", sort: "Name" },
  DefectType: { sel: "Name", sort: "Name" },
  StorySource: { sel: "Name", sort: "Name" },
  Team: { sel: "Name", where: "AssetState='64'", sort: "Name" },
  TaskCategory: { sel: "Name", sort: "Name" },
  Custom_Environment: { sel: "Name", sort: "Name" },
  ClassOfService: { sel: "Name", sort: "Name" },
  Epic: { sel: "Name,Number", where: "IsClosed='false'", sort: "Number" },
  Member: { sel: "Name,Nickname", where: "AssetState='64'", sort: "Name" },
};

server.tool(
  "list_lookup_values",
  "List valid values for a given entity type. Use this to discover valid names for create tool parameters (e.g. backlog groups, categories, teams, sources).",
  {
    type: z
      .enum(Object.keys(LOOKUP_CONFIG))
      .describe(
        "Entity type to list: Scope, Theme, StoryCategory, DefectType, StorySource, Team, TaskCategory, Custom_Environment, ClassOfService, Epic, Member"
      ),
    maxResults: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum results to return"),
  },
  async ({ type, maxResults }) => {
    try {
      const cfg = LOOKUP_CONFIG[type];
      const parts = [`sel=${cfg.sel}`];
      if (cfg.where) parts.push(`where=${cfg.where}`);
      if (cfg.sort) parts.push(`sort=${cfg.sort}`);
      parts.push(`page=${maxResults},0`);

      const data = await agilityGet(`/${type}?${parts.join("&")}`);
      const items = (data.Assets || []).map((asset) => {
        const a = asset.Attributes;
        const item = { id: asset.id, name: a.Name?.value };
        if (a.Nickname?.value) item.nickname = a.Nickname.value;
        if (a.Number?.value) item.number = a.Number.value;
        return item;
      });
      return textResult({ type, total: items.length, items });
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
