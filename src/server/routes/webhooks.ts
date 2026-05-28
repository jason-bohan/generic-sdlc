import { createHmac } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { readBody, json } from '../router';
import { parseJsonUtf8File } from '../json-file';
import type { UseFn } from './types';

// ── GitHub webhook types ──────────────────────────────────────────────────────

interface GitHubIssuePayload {
    action: 'opened' | 'edited' | 'closed' | 'reopened' | string;
    issue: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        state: 'open' | 'closed';
    };
    repository: { full_name: string };
}

// ── GitHub → Linear state mapping ────────────────────────────────────────────

function loadGhLinearMap(rootDir: string): Record<string, string> {
    const file = resolve(rootDir, '.github-linear-map.json');
    if (!existsSync(file)) return {};
    try { return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>; } catch { return {}; }
}

function saveGhLinearMap(rootDir: string, map: Record<string, string>): void {
    writeFileSync(resolve(rootDir, '.github-linear-map.json'), JSON.stringify(map, null, 2));
}

// ── Linear GraphQL helper ─────────────────────────────────────────────────────

async function linearGql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const apiKey = process.env.LINEAR_API_KEY ?? '';
    if (!apiKey) throw new Error('LINEAR_API_KEY is not set');
    const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '));
    return body.data as T;
}

async function getLinearStateId(name: string): Promise<string | null> {
    const teamId = process.env.LINEAR_TEAM_ID ?? '';
    const data = await linearGql<{ workflowStates: { nodes: Array<{ id: string; name: string; type: string }> } }>(`
        query($filter: WorkflowStateFilter) { workflowStates(filter: $filter) { nodes { id name type } } }
    `, { filter: teamId ? { team: { id: { eq: teamId } } } : {} });
    const lower = name.toLowerCase();
    return data.workflowStates.nodes.find(s => s.name.toLowerCase().includes(lower))?.id ?? null;
}

// ── GitHub signature verification ─────────────────────────────────────────────

function verifyGitHubSignature(secret: string, rawBody: string, signature: string): boolean {
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return expected === signature;
}

interface LinearIssuePayload {
    action: string;
    type: string;
    data: {
        id: string;
        identifier: string;
        number: number;
        title: string;
        description?: string;
        state?: { name: string };
        team?: { id: string; name: string };
        assignee?: { id: string; name: string; email?: string } | null;
        labels?: Array<{ name: string }>;
        url?: string;
    };
    updatedFrom?: {
        assigneeId?: string | null;
        stateId?: string | null;
    };
}

function verifyLinearSignature(secret: string, rawBody: string, signature: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return expected === signature;
}

function resolveAgentFromConfig(
    rootDir: string,
    configFile: string,
    assigneeId: string,
    labels: string[],
): string | null {
    let cfg: Record<string, unknown> = {};
    try { cfg = parseJsonUtf8File(configFile); } catch { /* no config */ }

    // linear.agentUsers: { "<linear-user-id>": "frontend" | "backend" | ... }
    const agentUsers = (cfg.linear as Record<string, unknown> | undefined)?.agentUsers as Record<string, string> | undefined;
    if (agentUsers?.[assigneeId]) return agentUsers[assigneeId];

    // Fallback: infer from labels
    const lower = labels.map(l => l.toLowerCase());
    if (lower.some(l => l.includes('frontend') || l.includes('ui'))) return 'frontend';
    if (lower.some(l => l.includes('backend') || l.includes('api'))) return 'backend';
    if (lower.some(l => l.includes('qa') || l.includes('test'))) return 'qa';
    if (lower.some(l => l.includes('devops') || l.includes('infra'))) return 'devops';

    // Default agent
    const defaultAgent = (cfg.linear as Record<string, unknown> | undefined)?.defaultAgent as string | undefined;
    return defaultAgent ?? null;
}

export function mount(use: UseFn, rootDir: string, configFile: string): void {

    // ── POST /api/webhooks/linear/test ────────────────────────────────────────
    // Must be registered before /api/webhooks/linear due to prefix-match routing.
    // Simulate a Linear assignment event without needing a real webhook.
    use('/api/webhooks/linear/test', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { identifier, title, description, agentId, assigneeId } = JSON.parse(body);
            if (!identifier || !agentId) { json(res, { error: 'identifier and agentId required' }, 400); return; }

            // Build a synthetic webhook payload and POST it to the main webhook handler
            const fakePayload: LinearIssuePayload = {
                action: 'update',
                type: 'Issue',
                data: {
                    id: `test-${identifier}`,
                    identifier,
                    number: parseInt(identifier.split('-')[1] ?? '0', 10),
                    title: title ?? identifier,
                    description: description ?? '',
                    assignee: { id: assigneeId ?? 'test-agent', name: agentId },
                    labels: [],
                },
                updatedFrom: { assigneeId: null },
            };

            // Write a temporary agent mapping so the resolver finds agentId
            let cfg: Record<string, unknown> = {};
            try { cfg = parseJsonUtf8File(configFile); } catch { /* ok */ }
            if (!cfg.linear) cfg.linear = {};
            const linearCfg = cfg.linear as Record<string, unknown>;
            if (!linearCfg.agentUsers) linearCfg.agentUsers = {};
            (linearCfg.agentUsers as Record<string, string>)[fakePayload.data.assignee!.id] = agentId;
            const { writeFileSync } = await import('fs');
            writeFileSync(configFile, JSON.stringify(cfg, null, 2));

            const rawBody = JSON.stringify(fakePayload);
            const webhookUrl = `http://localhost:${process.env.PORT ?? 3001}/api/webhooks/linear`;
            const webhookRes = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: rawBody,
            });
            const result = await webhookRes.json();
            json(res, result);
        } catch (e) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── POST /api/webhooks/linear ─────────────────────────────────────────────
    // Receives Linear webhook events. Configure the webhook URL in Linear at:
    //   Settings → API → Webhooks → Add webhook
    // Set the URL to: https://<your-host>/api/webhooks/linear
    // Subscribe to: Issue events
    // Copy the signing secret into LINEAR_WEBHOOK_SECRET env var.
    use('/api/webhooks/linear', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const rawBody = await readBody(req);

        // Verify signature when secret is configured
        const secret = process.env.LINEAR_WEBHOOK_SECRET ?? '';
        if (secret) {
            const sig = (req.headers['linear-signature'] as string) ?? '';
            if (!sig || !verifyLinearSignature(secret, rawBody, sig)) {
                json(res, { error: 'Invalid signature' }, 401);
                return;
            }
        }

        let payload: LinearIssuePayload;
        try {
            payload = JSON.parse(rawBody) as LinearIssuePayload;
        } catch {
            json(res, { error: 'Invalid JSON' }, 400);
            return;
        }

        // Only handle Issue update events where the assignee changed
        if (payload.type !== 'Issue' || payload.action !== 'update') {
            json(res, { ok: true, skipped: true, reason: 'not an issue update' });
            return;
        }

        const assignee = payload.data.assignee;
        const previousAssigneeId = payload.updatedFrom?.assigneeId;
        const assigneeChanged = previousAssigneeId !== undefined && previousAssigneeId !== (assignee?.id ?? null);

        if (!assigneeChanged || !assignee) {
            json(res, { ok: true, skipped: true, reason: 'assignee unchanged or cleared' });
            return;
        }

        const labels = (payload.data.labels ?? []).map(l => l.name);
        const agentId = resolveAgentFromConfig(rootDir, configFile, assignee.id, labels);

        if (!agentId) {
            json(res, { ok: true, skipped: true, reason: `no agent mapped for assignee ${assignee.id}` });
            return;
        }

        const storyNumber = payload.data.identifier;   // e.g. "UNW-5"
        const storyName = payload.data.title;
        const storyDescription = payload.data.description ?? '';

        // Forward to scheduler assign
        const assignUrl = `http://localhost:${process.env.PORT ?? 3001}/api/scheduler/assign`;
        try {
            const assignRes = await fetch(assignUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId, storyNumber, storyName, storyDescription }),
            });
            const result = await assignRes.json();
            json(res, { ok: true, agentId, storyNumber, assign: result });
        } catch (e) {
            json(res, { error: `Failed to trigger assign: ${e instanceof Error ? e.message : String(e)}` }, 500);
        }
    });

    // ── POST /api/webhooks/github/test ────────────────────────────────────────
    // Must be registered before /api/webhooks/github due to prefix-match routing.
    use('/api/webhooks/github/test', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { action, number, title, body: issueBody } = JSON.parse(body);
            if (!number || !action) { json(res, { error: 'number and action required' }, 400); return; }
            const fakePayload: GitHubIssuePayload = {
                action,
                issue: { number, title: title ?? `Test issue #${number}`, body: issueBody ?? '', html_url: `https://github.com/test/repo/issues/${number}`, state: 'open' },
                repository: { full_name: process.env.GITHUB_REPO ?? 'test/repo' },
            };
            const webhookUrl = `http://localhost:${process.env.PORT ?? 3001}/api/webhooks/github`;
            const webhookRes = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-github-event': 'issues' },
                body: JSON.stringify(fakePayload),
            });
            json(res, await webhookRes.json());
        } catch (e) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── POST /api/webhooks/github ─────────────────────────────────────────────
    // Receives GitHub issue events and mirrors them to Linear.
    // Configure in GitHub: Settings → Webhooks → Add webhook
    //   Payload URL: https://<your-host>/api/webhooks/github
    //   Content type: application/json
    //   Events: Issues
    //   Secret: copy into GITHUB_WEBHOOK_SECRET env var
    use('/api/webhooks/github', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const rawBody = await readBody(req);

        const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
        if (secret) {
            const sig = (req.headers['x-hub-signature-256'] as string) ?? '';
            if (!sig || !verifyGitHubSignature(secret, rawBody, sig)) {
                json(res, { error: 'Invalid signature' }, 401);
                return;
            }
        }

        const event = (req.headers['x-github-event'] as string) ?? '';
        if (event !== 'issues') {
            json(res, { ok: true, skipped: true, reason: `unhandled event: ${event}` });
            return;
        }

        let payload: GitHubIssuePayload;
        try { payload = JSON.parse(rawBody) as GitHubIssuePayload; }
        catch { json(res, { error: 'Invalid JSON' }, 400); return; }

        const { action, issue } = payload;
        const mapKey = `${payload.repository.full_name}#${issue.number}`;
        const teamId = process.env.LINEAR_TEAM_ID ?? '';
        const description = `${issue.body ?? ''}\n\nRef: ${issue.html_url}`.trim();

        try {
            if (action === 'opened') {
                if (!teamId) { json(res, { error: 'LINEAR_TEAM_ID is required to create issues' }, 500); return; }
                const data = await linearGql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } } }>(`
                    mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }
                `, { input: { teamId, title: issue.title, description } });
                if (!data.issueCreate.success) { json(res, { error: 'Linear issueCreate failed' }, 500); return; }
                const map = loadGhLinearMap(rootDir);
                map[mapKey] = data.issueCreate.issue.id;
                saveGhLinearMap(rootDir, map);
                json(res, { ok: true, action, linearId: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier });
                return;
            }

            const map = loadGhLinearMap(rootDir);
            const linearId = map[mapKey];
            if (!linearId) {
                json(res, { ok: true, skipped: true, reason: `no Linear issue mapped for ${mapKey}` });
                return;
            }

            if (action === 'edited') {
                await linearGql(`
                    mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }
                `, { id: linearId, input: { title: issue.title, description } });
                json(res, { ok: true, action, linearId });
                return;
            }

            if (action === 'closed' || action === 'reopened') {
                const stateName = action === 'closed' ? 'done' : 'todo';
                const stateId = await getLinearStateId(stateName);
                if (!stateId) { json(res, { error: `Could not find Linear state for "${stateName}"` }, 500); return; }
                await linearGql(`
                    mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }
                `, { id: linearId, stateId });
                json(res, { ok: true, action, linearId, stateName });
                return;
            }

            json(res, { ok: true, skipped: true, reason: `unhandled action: ${action}` });
        } catch (e) {
            json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });
}
