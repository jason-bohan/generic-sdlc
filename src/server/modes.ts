import { existsSync } from 'fs';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { runInlineQuery } from './agent-drivers';
import { buildRepoContext } from './repo-context';
import { ragQuery } from './ragIndex';
import { getActiveModel, isEmbeddingReady } from './ollamaManager';
import { updateTokens } from './tokens';
import { recordStoryTokens } from './ledger';
import { parseJsonUtf8File } from './json-file';

export type ExecMode = 'local' | 'balanced' | 'speed';

const VALID_MODES: ExecMode[] = ['local', 'balanced', 'speed'];

export function getExecMode(configFilePath: string): ExecMode {
    try {
        const cfg = parseJsonUtf8File(configFilePath);
        const m = cfg.executionMode;
        if (VALID_MODES.includes(m)) return m;
    } catch { /* fall through */ }
    return 'balanced';
}

export function isValidMode(mode: string): mode is ExecMode {
    return VALID_MODES.includes(mode as ExecMode);
}

/** How `/api/agility/create-story` fulfills a request for each execution mode. */
export type StoryCreationRoute = 'goose' | 'balanced' | 'speed';

export function storyCreationRouteForMode(mode: ExecMode): StoryCreationRoute {
    if (mode === 'local') return 'goose';
    if (mode === 'speed') return 'speed';
    return 'balanced';
}

/** Strip HTML, collapse whitespace, truncate, and escape YAML-breaking chars. */
export function sanitizeForGooseParam(raw: string, maxLen = 500): string {
    let s = raw
        .replace(/<[^>]+>/g, ' ')    // strip HTML tags
        .replace(/&[a-z]+;/gi, ' ')  // strip HTML entities
        .replace(/[\r\n]+/g, ' ')    // collapse newlines
        .replace(/\s{2 }/g, ' ')     // collapse runs of whitespace
        .trim();
    if (s.length > maxLen) s = s.slice(0, maxLen).replace(/\s\S*$/, '...');
    return s;
}

export function findGoose(): string | null {
    const candidates = [
        resolve(process.env.USERPROFILE || '', '.local', 'bin', 'goose.exe'),
        'goose.exe',
    ];
    for (const c of candidates) {
        try { if (existsSync(c)) return c; } catch { /* skip */ }
    }
    return null;
}

export interface StoryParams {
    name: string;
    /** Required — Agility Class of Service name (resolved to OID server-side). */
    classOfService: string;
    description?: string;
    estimate?: number;
    team?: string;
    owner?: string;
    workspaceDir?: string;
}

export interface GooseStoryParams extends StoryParams {
    scope: string;
    parent: string;
    category: string;
}

export interface V1Api {
    v1Fetch: (path: string, query: Record<string, string>) => Promise<any>;
    v1Post: (path: string, body: any) => Promise<any>;
    addOwner: (oidPath: string, ownerOid: string) => Promise<void>;
    baseUrl: string;
}

function storyUrl(baseUrl: string, rawOid: string): string {
    if (!baseUrl) return '';
    const uiBase = baseUrl.replace('/rest-1.v1/Data', '').replace(/\/+$/, '');
    return `${uiBase}/story.mvc/Summary?oidToken=${rawOid}`;
}

export interface StoryResult {
    success: boolean;
    number?: string;
    name?: string;
    url?: string;
    enriched: boolean;
    error?: string;
    mode?: ExecMode;
    gooseLog?: string;
}

/**
 * Extract the story-result JSON from Goose's --output-format json output.
 * Goose wraps everything in a messages array; the actual result is embedded
 * as text content in the last assistant message, possibly inside markdown
 * code fences like ```json ... ```.
 */
export function parseGooseOutput(raw: string): Record<string, any> | null {
    // Strategy 1: parse as Goose messages structure, walk assistant texts
    try {
        const envelope = JSON.parse(raw);
        const messages: any[] = envelope.messages || (Array.isArray(envelope) ? envelope : []);
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role !== 'assistant') continue;
            const texts: string[] = [];
            if (typeof msg.content === 'string') {
                texts.push(msg.content);
            } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'text' && block.text) texts.push(block.text);
                }
            }
            for (const text of texts) {
                const extracted = extractStoryJson(text);
                if (extracted) return extracted;
            }
        }
    } catch { /* not a messages envelope — fall through */ }

    // Strategy 2: line-by-line scan for bare JSON objects
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.success !== undefined || parsed.number) return parsed;
            } catch { /* not valid JSON on this line */ }
        }
    }

    // Strategy 3: regex for a JSON object containing "number"
    const jsonMatch = raw.match(/\{[^{}]*"number"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch { /* bad match */ }
    }

    return null;
}

function extractStoryJson(text: string): Record<string, any> | null {
    // Strip markdown code fences
    const stripped = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    if (!stripped.startsWith('{')) return null;
    try {
        const obj = JSON.parse(stripped);
        if (obj.number || obj.success !== undefined) return obj;
    } catch { /* not valid JSON */ }

    // Try extracting JSON from within the text
    const match = stripped.match(/\{[^{}]*"number"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (match) {
        try { return JSON.parse(match[0]); } catch { /* bad match */ }
    }
    return null;
}

export function runGooseLocal(
    params: GooseStoryParams,
    env: { apiKey: string; baseUrl: string; rootDir: string },
    options?: { provider?: string; model?: string },
): Promise<StoryResult> {
    return new Promise((resolveP) => {
        const goose = findGoose();
        if (!goose) {
            resolveP({ success: false, enriched: false, error: 'Goose CLI not found. Install from https://block.github.io/goose/' });
            return;
        }

        const recipePath = resolve(env.rootDir, 'recipes', 'create-story.yaml');
        const agilityScript = resolve(env.rootDir, 'tools/mcp-agility/index.js');
        // Explicit Ollama provider — SDLC Framework story creation does not call OpenRouter/cloud LLMs.

        const args = [
            'run',
            '--recipe', recipePath,
            '--params', `title=${params.name}`,
            '--params', `scope=${params.scope}`,
            '--params', `parent=${params.parent}`,
            '--params', `category=${params.category}`,
            '--params', `workspaceDir=${params.workspaceDir || env.rootDir}`,
            ...(params.team ? ['--params', `team=${params.team}`] : []),
            ...(params.owner ? ['--params', `owner=${params.owner}`] : []),
            '--params', `classOfService=${params.classOfService}`,
            ...(params.description ? ['--params', `description=${sanitizeForGooseParam(params.description)}`] : []),
            ...(params.estimate ? ['--params', `estimate=${params.estimate}`] : []),
            ...(options?.provider ? ['--provider', options.provider] : []),
            ...(options?.model ? ['--model', options.model] : []),
            '--with-builtin', 'developer',
            '--with-extension', `AGILITY_API_KEY=${env.apiKey} AGILITY_BASE_URL=${env.baseUrl} node ${agilityScript}`,
            '--output-format', 'json',
            '--quiet',
            '--no-session',
            '--max-turns', '10',
        ];

        console.log('[Goose] Starting:', goose, args.join(' '));

        execFile(goose, args, {
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
            cwd: params.workspaceDir || env.rootDir,
            env: {
                ...process.env,
                OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434',
                GOOSE_PROVIDER__HOST: process.env.OLLAMA_HOST || 'http://localhost:11434' } }, (err, stdout, stderr) => {
            const rawOut = (stdout || '').trim();
            const rawErr = (stderr || '').trim();

            console.log('[Goose] stdout ───────────────────');
            console.log(rawOut || '(empty)');
            if (rawErr) {
                console.log('[Goose] stderr ───────────────────');
                console.log(rawErr);
            }
            console.log('[Goose] ──────────────────────────');

            if (err) {
                resolveP({ success: false, enriched: false, error: `Goose failed: ${err.message}\n${rawErr}`.trim(), gooseLog: rawOut });
                return;
            }
            try {
                const result = parseGooseOutput(rawOut);
                if (result) {
                    resolveP({ success: true, enriched: true, ...result, gooseLog: rawOut });
                } else {
                    resolveP({ success: false, enriched: false, error: 'Goose completed but no story result found in output', gooseLog: rawOut });
                }
            } catch (parseErr: any) {
                resolveP({ success: false, enriched: false, error: `Failed to parse Goose output: ${parseErr.message}`, gooseLog: rawOut });
            }
        });
    });
}

export async function createStoryBalanced(
    params: StoryParams,
    api: V1Api,
    ollamaHost = 'http://localhost:11434',
    rootDir?: string,
    agentId = 'frontend',
): Promise<StoryResult> {
    const workspaceDir = params.workspaceDir || rootDir || process.cwd();
    const frameworkDir = rootDir || process.cwd();

    // RAG: semantic context from the actual workspace — falls back to static tree scan
    let repoContext = '';
    if (isEmbeddingReady()) {
        const query = [params.name, params.description].filter(Boolean).join(' ');
        try {
            repoContext = await ragQuery(workspaceDir, frameworkDir, query, ollamaHost) ?? '';
        } catch { /* fall through */ }
    }
    if (!repoContext) {
        try { repoContext = await buildRepoContext(workspaceDir); } catch { /* proceed without context */ }
    }

    const enrichPrompt = [
        repoContext || '',
        '',
        '## Example output format (follow this exactly):',
        '{"description":"<h2>Summary</h2><p>Adds X to Y.</p><h3>Problem</h3><p>Users cannot do X.</p><h3>Solution</h3><p>Implement X in src/foo/bar.ts.</p>","acceptanceCriteria":"<ul><li>Given X, when Y, then Z.</li><li>Edge case handled.</li></ul>","frontend":"<ul><li>src/components/Foo.tsx — add X prop</li></ul>","backend":"<ul><li>src/server/bar.ts — add endpoint POST /api/x</li></ul>","qa":"<ul><li>Test X with valid input</li><li>Test X with empty input</li></ul>"}',
        '',
        `## Story: ${params.name}`,
        params.description ? `Description: ${params.description}` : '',
        params.estimate ? `Estimate: ${params.estimate}pts` : '',
        '',
        'Output ONLY a JSON object in the exact format shown above. Reference real file names from the codebase. Start with {',
    ].filter(Boolean).join('\n');

    let enriched: Record<string, string | null> = {};
    const creationTokens = { input: 0, output: 0 };
    try {
        const ollamaRes = await fetch(`${ollamaHost}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: getActiveModel(),
                prompt: enrichPrompt,
                system: 'You are a product owner writing Agility story fields. Respond ONLY with a single valid JSON object. No markdown. No explanation. /no_think',
                stream: false,
                options: {
                    temperature: 0.1,
                    num_ctx: 4096,
                    num_predict: 1500,
                    repeat_penalty: 1.1 } }) });
        if (ollamaRes.ok) {
            const ollamaData = await ollamaRes.json();
            creationTokens.input = ollamaData.prompt_eval_count || 0;
            creationTokens.output = ollamaData.eval_count || 0;
            if (rootDir) {
                updateTokens(rootDir, { agentId, source: 'ollama', input: creationTokens.input, output: creationTokens.output, phase: 'creation' });
            }
            const raw = (ollamaData.response || '').trim();
            const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
            enriched = JSON.parse(jsonStr);
        }
    } catch { /* Ollama unavailable — continue without enrichment */ }

    const finalDesc = enriched.description || (params.description ? `<p>${params.description}</p>` : undefined);
    const teamName = params.team || 'Ninja Turtles';

    const scopeData = await api.v1Fetch('/Scope', { where: `Name='${teamName}'`, sel: 'Name', page: '1,0' });
    const scopeOid = scopeData.Assets?.[0]?.id;
    if (!scopeOid) throw new Error(`Could not resolve Scope "${teamName}"`);

    const teamData = await api.v1Fetch('/Team', { where: `Name='${teamName}'`, sel: 'Name', page: '1,0' });
    const teamOid = teamData.Assets?.[0]?.id;
    const catData = await api.v1Fetch('/StoryCategory', { where: "Name='Roadmap Features'", sel: 'Name', page: '1,0' });
    const catOid = catData.Assets?.[0]?.id;
    const parentData = await api.v1Fetch('/Theme', { where: "Name='General'", sel: 'Name', page: '1,0' });
    const parentOid = parentData.Assets?.[0]?.id;

    let cosOid: string | undefined;
    try {
        const cosData = await api.v1Fetch('/ClassOfService', { where: `Name='${params.classOfService}'`, sel: 'Name', page: '1,0' });
        cosOid = cosData.Assets?.[0]?.id;
    } catch { /* lookup failed — omit attribute; story still created */ }

    const attrs: Record<string, any> = {
        Name: { value: params.name, act: 'set' },
        Scope: { value: scopeOid, act: 'set' } };
    if (teamOid) attrs['Team'] = { value: teamOid, act: 'set' };
    if (catOid) attrs['Category'] = { value: catOid, act: 'set' };
    if (parentOid) attrs['Parent'] = { value: parentOid, act: 'set' };
    if (finalDesc) attrs['Description'] = { value: finalDesc, act: 'set' };
    if (params.estimate) attrs['Estimate'] = { value: params.estimate, act: 'set' };
    if (cosOid) attrs['ClassOfService'] = { value: cosOid, act: 'set' };
    if (enriched.acceptanceCriteria) attrs['Custom_AcceptanceCriteria'] = { value: enriched.acceptanceCriteria, act: 'set' };
    if (enriched.frontend) attrs['Custom_Frontend'] = { value: enriched.frontend, act: 'set' };
    if (enriched.backend) attrs['Custom_Backend'] = { value: enriched.backend, act: 'set' };
    if (enriched.qa) attrs['Custom_QA'] = { value: enriched.qa, act: 'set' };

    const result = await api.v1Post('/Story', { Attributes: attrs });
    const rawOid = (result.id || '').split(':').slice(0, 2).join(':');
    const oidPath = rawOid.replace(':', '/');

    if (params.owner) {
        try {
            const ownerData = await api.v1Fetch('/Member', { where: `Name='${params.owner}'`, sel: 'Name', page: '1,0' });
            const ownerOid = ownerData.Assets?.[0]?.id;
            if (ownerOid) await api.addOwner(oidPath, ownerOid);
        } catch { /* owner assignment failed — story still created */ }
    }

    const storyData = await api.v1Fetch(`/${oidPath}`, { sel: 'Number' });
    const number = storyData.Attributes?.Number?.value || rawOid;

    if (rootDir && (creationTokens.input > 0 || creationTokens.output > 0)) {
        recordStoryTokens(rootDir, {
            storyNumber: number,
            storyName: params.name,
            agent: agentId,
            source: 'ollama',
            phase: 'creation',
            input: creationTokens.input,
            output: creationTokens.output });
    }

    return { success: true, number, name: params.name, url: storyUrl(api.baseUrl, rawOid), enriched: !!enriched.description };
}

export interface EnrichedStoryFields {
    description?: string;
    acceptanceCriteria?: string;
    frontend?: string;
    backend?: string;
    qa?: string;
    estimate?: number;
    classOfService?: string;
}

/**
 * Ollama-only story enrichment that returns the field values without writing to
 * Agility. Used by the local backlog "AI Create" path. Falls back to an empty
 * result (enriched: false) whenever Ollama is unavailable or returns junk.
 */
export async function enrichStoryFields(
    params: StoryParams,
    opts: { ollamaHost?: string; rootDir?: string; agentId?: string; includeEstimateAndClassOfService?: boolean } = {},
): Promise<{ fields: EnrichedStoryFields; enriched: boolean }> {
    const ollamaHost = opts.ollamaHost || 'http://localhost:11434';
    const agentId = opts.agentId || 'frontend';
    const workspaceDir = params.workspaceDir || opts.rootDir || process.cwd();
    const frameworkDir = opts.rootDir || process.cwd();

    let repoContext = '';
    if (isEmbeddingReady()) {
        const query = [params.name, params.description].filter(Boolean).join(' ');
        try {
            repoContext = await ragQuery(workspaceDir, frameworkDir, query, ollamaHost) ?? '';
        } catch { /* fall through to static scan */ }
    }
    if (!repoContext) {
        try { repoContext = await buildRepoContext(workspaceDir); } catch { /* proceed without context */ }
    }

    const extraKeys = opts.includeEstimateAndClassOfService
        ? ',"estimate":3,"classOfService":"Standard"'
        : '';
    const enrichPrompt = [
        repoContext || '',
        '',
        '## Example output format (follow this exactly):',
        `{"description":"<h2>Summary</h2><p>Adds X to Y.</p><h3>Problem</h3><p>Users cannot do X.</p><h3>Solution</h3><p>Implement X in src/foo/bar.ts.</p>","acceptanceCriteria":"<ul><li>Given X, when Y, then Z.</li><li>Edge case handled.</li></ul>","frontend":"<ul><li>src/components/Foo.tsx — add X prop</li></ul>","backend":"<ul><li>src/server/bar.ts — add endpoint POST /api/x</li></ul>","qa":"<ul><li>Test X with valid input</li><li>Test X with empty input</li></ul>"${extraKeys}}`,
        '',
        `## Story: ${params.name}`,
        params.description ? `Description: ${params.description}` : '',
        params.estimate ? `Estimate: ${params.estimate}pts` : '',
        '',
        'Output ONLY a JSON object in the exact format shown above. Reference real file names from the codebase. Start with {',
    ].filter(Boolean).join('\n');

    let parsed: Record<string, unknown> = {};
    try {
        const ollamaRes = await fetch(`${ollamaHost}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: getActiveModel(),
                prompt: enrichPrompt,
                system: 'You are a product owner writing Agility story fields. Respond ONLY with a single valid JSON object. No markdown. No explanation. /no_think',
                stream: false,
                options: { temperature: 0.1, num_ctx: 4096, num_predict: 1500, repeat_penalty: 1.1 } }) });
        if (ollamaRes.ok) {
            const ollamaData = await ollamaRes.json();
            if (opts.rootDir) {
                updateTokens(opts.rootDir, { agentId, source: 'ollama', input: ollamaData.prompt_eval_count || 0, output: ollamaData.eval_count || 0, phase: 'creation' });
            }
            const raw = (ollamaData.response || '').trim();
            const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
            parsed = JSON.parse(jsonStr);
        }
    } catch { /* Ollama unavailable — return un-enriched */ }

    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    const num = (v: unknown): number | undefined => {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        return Number.isFinite(n) ? n : undefined;
    };
    const fields: EnrichedStoryFields = {
        description: str(parsed.description),
        acceptanceCriteria: str(parsed.acceptanceCriteria),
        frontend: str(parsed.frontend),
        backend: str(parsed.backend),
        qa: str(parsed.qa),
        estimate: opts.includeEstimateAndClassOfService ? num(parsed.estimate) : undefined,
        classOfService: opts.includeEstimateAndClassOfService ? str(parsed.classOfService) : undefined,
    };
    return { fields, enriched: !!fields.description };
}

export async function createStorySpeed(
    params: StoryParams,
    api: V1Api,
    _ollamaHost = 'http://localhost:11434',
    rootDir?: string,
    agentId = 'frontend',
): Promise<StoryResult> {
    let enriched: Record<string, string | null> = {};
    try {
        let repoContext = '';
        try { repoContext = await buildRepoContext(rootDir || process.cwd()); } catch { /* proceed without context */ }

        const enrichPrompt = [
            'You are a senior product owner with access to this workspace.',
            '',
            repoContext ? '## Codebase Context' : '',
            repoContext,
            '',
            'IMPORTANT: Before generating fields, look at the actual workspace files to find relevant components, services, routes, and patterns. Use the search and read tools to inspect real code.',
            '',
            '## Story to Enrich',
            `Story title: ${params.name}`,
            params.description ? `Description: ${params.description}` : '',
            params.estimate ? `Estimate: ${params.estimate} points` : '',
            '',
            'Return ONLY a JSON object (no markdown fences, no explanation) with these keys:',
            '  "description" - HTML summary with <h2>Summary</h2>, <h3>Problem</h3>, <h3>Solution</h3> sections',
            '  "acceptanceCriteria" - HTML <ul><li> checklist of testable criteria',
            '  "frontend" - HTML list of specific frontend files/components to change (or null if not applicable)',
            '  "backend" - HTML list of backend/API changes (or null if not applicable)',
            '  "qa" - HTML list of QA/test steps with specific scenarios (or null if not applicable)',
            '',
            'Reference ACTUAL files, components, and patterns from the codebase.',
            'Do NOT use generic placeholders like "relevant component" or "the service".',
        ].filter(Boolean).join('\n');

        const effectiveRoot = rootDir || process.cwd();
        console.log('[speed] Enriching story via IDE CLI...');
        const raw = await runInlineQuery(enrichPrompt, effectiveRoot, resolve(effectiveRoot, '.sdlc-framework.config.json'));
        if (rootDir) {
            updateTokens(rootDir, { agentId, source: 'cloud', input: enrichPrompt.length, output: raw.length, phase: 'creation' });
        }
        const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').replace(/^[\s\S]*?(\{)/,'$1').replace(/\}[\s\S]*$/,'}').trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            enriched = JSON.parse(jsonMatch[0]);
            console.log('[speed] Enrichment succeeded via Cursor cloud AI');
        }
    } catch (err: any) {
        console.log(`[speed] Cursor CLI enrichment unavailable (${err.message}) - creating story without enrichment`);
    }

    const finalDesc = enriched.description || (params.description ? `<p>${params.description}</p>` : undefined);
    const teamName = params.team || 'Ninja Turtles';

    const scopeData = await api.v1Fetch('/Scope', { where: `Name='${teamName}'`, sel: 'Name', page: '1,0' });
    const scopeOid = scopeData.Assets?.[0]?.id;
    if (!scopeOid) throw new Error(`Could not resolve Scope "${teamName}"`);

    const teamData = await api.v1Fetch('/Team', { where: `Name='${teamName}'`, sel: 'Name', page: '1,0' });
    const teamOid = teamData.Assets?.[0]?.id;
    const catData = await api.v1Fetch('/StoryCategory', { where: "Name='Roadmap Features'", sel: 'Name', page: '1,0' });
    const catOid = catData.Assets?.[0]?.id;
    const parentData = await api.v1Fetch('/Theme', { where: "Name='General'", sel: 'Name', page: '1,0' });
    const parentOid = parentData.Assets?.[0]?.id;

    let cosOid: string | undefined;
    try {
        const cosData = await api.v1Fetch('/ClassOfService', { where: `Name='${params.classOfService}'`, sel: 'Name', page: '1,0' });
        cosOid = cosData.Assets?.[0]?.id;
    } catch { /* lookup failed - story still created */ }

    const attrs: Record<string, any> = {
        Name: { value: params.name, act: 'set' },
        Scope: { value: scopeOid, act: 'set' } };
    if (teamOid) attrs['Team'] = { value: teamOid, act: 'set' };
    if (catOid) attrs['Category'] = { value: catOid, act: 'set' };
    if (parentOid) attrs['Parent'] = { value: parentOid, act: 'set' };
    if (finalDesc) attrs['Description'] = { value: finalDesc, act: 'set' };
    if (params.estimate) attrs['Estimate'] = { value: params.estimate, act: 'set' };
    if (cosOid) attrs['ClassOfService'] = { value: cosOid, act: 'set' };
    if (enriched.acceptanceCriteria) attrs['Custom_AcceptanceCriteria'] = { value: enriched.acceptanceCriteria, act: 'set' };
    if (enriched.frontend) attrs['Custom_Frontend'] = { value: enriched.frontend, act: 'set' };
    if (enriched.backend) attrs['Custom_Backend'] = { value: enriched.backend, act: 'set' };
    if (enriched.qa) attrs['Custom_QA'] = { value: enriched.qa, act: 'set' };

    const result = await api.v1Post('/Story', { Attributes: attrs });
    const rawOid = (result.id || '').split(':').slice(0, 2).join(':');
    const oidPath = rawOid.replace(':', '/');

    if (params.owner) {
        try {
            const ownerData = await api.v1Fetch('/Member', { where: `Name='${params.owner}'`, sel: 'Name', page: '1,0' });
            const ownerOid = ownerData.Assets?.[0]?.id;
            if (ownerOid) await api.addOwner(oidPath, ownerOid);
        } catch { /* owner assignment failed */ }
    }

    const storyData = await api.v1Fetch(`/${oidPath}`, { sel: 'Number' });
    const number = storyData.Attributes?.Number?.value || rawOid;

    if (rootDir) {
        recordStoryTokens(rootDir, {
            storyNumber: number,
            storyName: params.name,
            agent: agentId,
            source: 'cloud',
            phase: 'creation',
            input: 0,
            output: 0 });
    }

    return { success: true, number, name: params.name, url: storyUrl(api.baseUrl, rawOid), enriched: !!enriched.description };
}
