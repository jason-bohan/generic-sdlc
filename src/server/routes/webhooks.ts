import { createHmac } from 'crypto';
import { resolve } from 'path';
import { readBody, json } from '../router';
import { parseJsonUtf8File } from '../json-file';
import type { UseFn } from './types';

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

}
