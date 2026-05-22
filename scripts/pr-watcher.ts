/**
 * PR Watcher for SDLC Framework agents
 *
 * This script is designed to be invoked by the Cursor agent via Shell tool.
 * It uses the Azure DevOps MCP tools (called by the agent) to check PR status.
 *
 * Since MCP tools can only be called by the Cursor agent (not directly from Node),
 * this script provides the polling loop structure and status tracking. The agent
 * calls MCP tools and feeds results back through the status file.
 *
 * Usage by the agent:
 *   1. Agent calls Azure DevOps MCP `repo_list_pull_request_threads`
 *   2. Agent calls this script with --update to record new state
 *   3. Agent calls this script with --check to see what changed
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PrThread {
    id: number;
    status: 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending' | 'unknown';
    author: string;
    content: string;
    lastUpdated: string;
    isNew?: boolean;
}

interface PrState {
    prId: number;
    repositoryId: string;
    status: string;
    threads: PrThread[];
    reviewerVotes: Record<string, string>;
    lastChecked: string;
}

interface WatcherState {
    prs: PrState[];
}

const STATE_FILE = resolve(__dirname, '../.pr-watcher-state.json');
const STORY_LOG_DIR = resolve(__dirname, '../.sdlc-framework');
const STORY_LOG_FILE = resolve(STORY_LOG_DIR, 'story-creation-log.jsonl');

function loadState(): WatcherState {
    if (existsSync(STATE_FILE)) {
        try {
            return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as WatcherState;
        } catch {
            console.error('Warning: corrupt watcher state file, starting fresh');
        }
    }
    return { prs: [] };
}

function saveState(state: WatcherState): void {
    try {
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('Failed to save watcher state:', err instanceof Error ? err.message : String(err));
    }
}

function appendStoryCreationLog(record: Record<string, unknown>): void {
    if (!existsSync(STORY_LOG_DIR)) {
        mkdirSync(STORY_LOG_DIR, { recursive: true });
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), kind: 'story-creation', ...record }) + '\n';
    appendFileSync(STORY_LOG_FILE, line, 'utf-8');
}

/** POST /api/pr/created per OpenAPI (agentId + prId required). */
async function postPrCreated(baseUrl: string, body: Record<string, unknown>): Promise<unknown> {
    const root = baseUrl.replace(/\/$/, '');
    const res = await fetch(`${root}/api/pr/created`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        parsed = text;
    }
    if (!res.ok) {
        throw new Error(`POST /api/pr/created failed (${res.status}): ${text}`);
    }
    return parsed;
}

function updatePr(prId: number, repoId: string, threads: PrThread[], votes: Record<string, string>): {
    newThreads: PrThread[];
    statusChanges: Array<{ threadId: number; from: string; to: string }>;
    newVotes: Array<{ reviewer: string; vote: string }>;
} {
    const state = loadState();
    const existing = state.prs.find((p) => p.prId === prId);

    const newThreads: PrThread[] = [];
    const statusChanges: Array<{ threadId: number; from: string; to: string }> = [];
    const newVotes: Array<{ reviewer: string; vote: string }> = [];

    if (existing) {
        const existingThreadIds = new Set(existing.threads.map((t) => t.id));
        for (const thread of threads) {
            if (!existingThreadIds.has(thread.id)) {
                newThreads.push({ ...thread, isNew: true });
            } else {
                const old = existing.threads.find((t) => t.id === thread.id);
                if (!old) continue;
                if (old.status !== thread.status) {
                    statusChanges.push({ threadId: thread.id, from: old.status, to: thread.status });
                }
            }
        }

        for (const [reviewer, vote] of Object.entries(votes)) {
            if (existing.reviewerVotes[reviewer] !== vote) {
                newVotes.push({ reviewer, vote });
            }
        }

        existing.threads = threads;
        existing.reviewerVotes = votes;
        existing.lastChecked = new Date().toISOString();
    } else {
        newThreads.push(...threads.map((t) => ({ ...t, isNew: true })));
        for (const [reviewer, vote] of Object.entries(votes)) {
            newVotes.push({ reviewer, vote });
        }
        state.prs.push({
            prId,
            repositoryId: repoId,
            status: 'active',
            threads,
            reviewerVotes: votes,
            lastChecked: new Date().toISOString(),
        });
    }

    saveState(state);

    return { newThreads, statusChanges, newVotes };
}

function checkPr(prId: number): {
    activeThreads: number;
    unresolvedComments: PrThread[];
    approvals: string[];
    rejections: string[];
} {
    const state = loadState();
    const pr = state.prs.find((p) => p.prId === prId);

    if (!pr) {
        return { activeThreads: 0, unresolvedComments: [], approvals: [], rejections: [] };
    }

    const activeThreads = pr.threads.filter((t) => t.status === 'active').length;
    const unresolvedComments = pr.threads.filter((t) => t.status === 'active');

    const approvals: string[] = [];
    const rejections: string[] = [];
    for (const [reviewer, vote] of Object.entries(pr.reviewerVotes)) {
        if (vote === 'approved' || vote === 'approvedWithSuggestions') approvals.push(reviewer);
        if (vote === 'rejected' || vote === 'waitingForAuthor') rejections.push(reviewer);
    }

    return { activeThreads, unresolvedComments, approvals, rejections };
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
    console.log(`
SDLC Framework PR Watcher

Usage:
  npx tsx scripts/pr-watcher.ts --update --pr-id <id> --repo-id <id> --threads <json> --votes <json>
  npx tsx scripts/pr-watcher.ts --check --pr-id <id>
  npx tsx scripts/pr-watcher.ts --list
  npx tsx scripts/pr-watcher.ts --append-story-log --json <json>
  npx tsx scripts/pr-watcher.ts --post-pr-created [--base-url <url>] --json <json>

Options:
  --update          Record new PR thread/vote state (agent feeds MCP results here)
  --check           Check what needs attention on a PR
  --list            List all tracked PRs and their status
  --append-story-log Append one JSON line to .sdlc-framework/story-creation-log.jsonl (gitignored)
  --post-pr-created POST body to /api/pr/created (default base from SDLC_FRAMEWORK_API_BASE or http://localhost:3001)
  --pr-id <id>      Pull request ID
  --repo-id <id>    Repository ID
  --threads <json>  JSON array of thread objects
  --votes <json>    JSON object of reviewer votes
  --base-url <url>  SDLC Framework server root for --post-pr-created
  --json <json>     JSON object for --append-story-log or --post-pr-created

Output:
  JSON with changes detected (new threads, status changes, new votes)
`);
    process.exit(0);
}

if (args.includes('--list')) {
    const state = loadState();
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
}

let prId = 0;
let repoId = '';
let threadsJson = '[]';
let votesJson = '{}';
let jsonPayload = '';
let baseUrl = process.env.SDLC_FRAMEWORK_API_BASE || 'http://localhost:3001';

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--pr-id':
            if (i + 1 < args.length) prId = parseInt(args[++i], 10) || 0;
            break;
        case '--repo-id':
            if (i + 1 < args.length) repoId = args[++i];
            break;
        case '--threads':
            if (i + 1 < args.length) threadsJson = args[++i];
            break;
        case '--votes':
            if (i + 1 < args.length) votesJson = args[++i];
            break;
        case '--json':
            if (i + 1 < args.length) jsonPayload = args[++i];
            break;
        case '--base-url':
            if (i + 1 < args.length) baseUrl = args[++i];
            break;
    }
}

if (args.includes('--append-story-log')) {
    if (!jsonPayload) {
        console.error('--json is required for --append-story-log');
        process.exit(1);
    }
    try {
        const data = JSON.parse(jsonPayload) as Record<string, unknown>;
        appendStoryCreationLog(data);
        console.log(JSON.stringify({ ok: true, logFile: STORY_LOG_FILE }, null, 2));
    } catch (e) {
        console.error('Invalid --json for story log:', e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
    process.exit(0);
}

if (args.includes('--post-pr-created')) {
    if (!jsonPayload) {
        console.error('--json is required for --post-pr-created');
        process.exit(1);
    }
    try {
        const body = JSON.parse(jsonPayload) as Record<string, unknown>;
        const result = await postPrCreated(baseUrl, body);
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
    process.exit(0);
}

if (args.includes('--update')) {
    if (!prId) {
        console.error('--pr-id is required for --update');
        process.exit(1);
    }
    try {
        const threads: PrThread[] = JSON.parse(threadsJson) as PrThread[];
        const votes: Record<string, string> = JSON.parse(votesJson) as Record<string, string>;
        const result = updatePr(prId, repoId, threads, votes);
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('Invalid JSON in --threads or --votes:', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
} else if (args.includes('--check')) {
    if (!prId) {
        console.error('--pr-id is required for --check');
        process.exit(1);
    }
    const result = checkPr(prId);
    console.log(JSON.stringify(result, null, 2));
}
