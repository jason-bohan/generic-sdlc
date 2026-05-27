/**
 * Helpers shared across HTTP route modules (extracted from app.ts).
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import type { V1Api } from './modes';
import { isMockExternalMode } from './external-mode';
import { mockAdoFetch, mockV1Fetch, mockV1Post } from './mock-external';
import type { ProjectProfile } from './project-config';
import {
    dbGetWorkflowItemByStory,
    dbRecordPhaseEvent,
    dbTransitionWorkflowItem,
    dbUpsertWorkflowArtifact } from './db';
import type { SdlcAgentId, SdlcPhaseId } from '../shared/sdlcContracts';
import { isAgentStepMode as isAgentStepModeFromConfig } from './stepMode';
import { parseJsonUtf8File } from './json-file';

export function getSchedulerConfig(rootDir: string) {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (existsSync(configFile)) {
        try { return parseJsonUtf8File(configFile); } catch { /* fall through */ }
    }
    return { scheduler: { mode: 'notify', agents: { frontend: { enabled: true, autoStart: false } } } };
}

export function storyNumberFromOwnerStatus(status: Record<string, unknown> | null | undefined): string | undefined {
    const direct = status?.storyNumber;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const prs = Array.isArray(status?.prs) ? status.prs as Array<Record<string, unknown>> : [];
    for (const pr of prs) {
        const storyNumber = pr.storyNumber;
        if (typeof storyNumber === 'string' && storyNumber.trim()) return storyNumber.trim();
    }
    return undefined;
}

/** PR id for DevOps wrap-up / continue (desk assignment, else first active PR). */
export function resolveDevopsStatusPrId(status: Record<string, unknown>): number | null {
    const desk = status.assignedPR as { id?: unknown } | undefined;
    if (desk != null) {
        const n = Number(desk.id);
        if (Number.isFinite(n) && n > 0) return n;
    }
    const prs = Array.isArray(status.prs) ? status.prs as Array<{ id?: unknown; status?: string }> : [];
    const active = prs.find((p) => p.status === 'active');
    if (active != null) {
        const n = Number(active.id);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

export function recordWorkflowMilestone(params: {
    storyNumber?: string | null;
    agentId: SdlcAgentId | string;
    phase: SdlcPhaseId | string;
    eventType: string;
    outputs?: Record<string, unknown>;
    message?: string;
    transition?: {
        agentId: SdlcAgentId | string;
        nextPhase: SdlcPhaseId | string;
        outputs?: Record<string, unknown>;
        message?: string;
        status?: string;
    };
}) {
    const storyNumber = params.storyNumber?.trim();
    if (!storyNumber) return null;
    let workflow;
    try {
        workflow = dbGetWorkflowItemByStory(storyNumber, params.agentId as string)
            ?? dbGetWorkflowItemByStory(storyNumber);
    } catch (e) {
        if (e instanceof Error && e.message.includes('Call initDb')) return null;
        throw e;
    }
    if (!workflow) return null;
    dbRecordPhaseEvent({
        workflowItemId: workflow.id,
        agentId: params.agentId,
        phase: params.phase,
        eventType: params.eventType,
        outputs: params.outputs,
        message: params.message });
    if (!params.transition) return workflow;
    return dbTransitionWorkflowItem({
        workflowItemId: workflow.id,
        agentId: params.transition.agentId,
        nextPhase: params.transition.nextPhase,
        outputs: params.transition.outputs,
        message: params.transition.message,
        status: params.transition.status });
}

export function tryRecordWorkflowArtifact(params: {
    storyNumber?: string | null;
    agentId?: string | null;
    artifactType: string;
    artifactKey: string;
    payload: unknown;
}) {
    const storyNumber = params.storyNumber?.trim();
    if (!storyNumber) return null;
    let workflow;
    try {
        const agent = params.agentId?.trim() || undefined;
        workflow = (agent ? dbGetWorkflowItemByStory(storyNumber, agent) : undefined)
            ?? dbGetWorkflowItemByStory(storyNumber);
    } catch (e) {
        if (e instanceof Error && e.message.includes('Call initDb')) return null;
        throw e;
    }
    if (!workflow) return null;
    return dbUpsertWorkflowArtifact({
        workflowItemId: workflow.id,
        artifactType: params.artifactType,
        artifactKey: params.artifactKey,
        payload: params.payload });
}

export function isAgentStepMode(agentId: string, rootDir: string): boolean {
    return isAgentStepModeFromConfig(agentId, resolve(rootDir, '.sdlc-framework.config.json'));
}

export function getAgentModel(agentId: string, rootDir: string): string {
    const cfg = getSchedulerConfig(rootDir);
    return cfg.scheduler?.agents?.[agentId]?.model || 'auto';
}

export interface AdoPullRequestSummary {
    pullRequestId?: number;
    id?: number;
    title?: string;
    status?: string;
    sourceRefName?: string;
    targetRefName?: string;
    createdBy?: { id?: string; displayName?: string; uniqueName?: string };
    creationDate?: string;
    url?: string;
    [key: string]: unknown;
}

function normalizeGitRef(ref?: unknown): string {
    return typeof ref === 'string' ? ref.replace(/^refs\/heads\//, '') : '';
}

export function firstNonEmpty(...values: Array<unknown>): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

export function normalizeReviewerPrCandidate(pr: AdoPullRequestSummary, profile: ProjectProfile, projectKey: string | null, config: Record<string, unknown>, mockMode = false) {
    const prId = pr.pullRequestId ?? pr.id;
    const sourceBranch = normalizeGitRef(pr.sourceRefName);
    const targetBranch = normalizeGitRef(pr.targetRefName) || profile.targetBranch || 'main';
    const prUrlBase = profile.prUrlBase || (config.project as { prUrlBase?: string } | undefined)?.prUrlBase || '';
    const haystack = `${pr.title ?? ''} ${sourceBranch}`;
    let url: string;
    if (mockMode) {
        url = `http://localhost:3001/mock-prs/${prId}`;
    } else if (prUrlBase && prId != null) {
        url = `${prUrlBase}/${prId}`;
    } else if (typeof pr.url === 'string' && pr.url) {
        url = pr.url;
    } else {
        url = `PR #${prId ?? 'unknown'}`;
    }
    return {
        id: prId,
        pullRequestId: prId,
        title: pr.title || `PR #${prId}`,
        status: pr.status || 'active',
        sourceBranch,
        targetBranch,
        createdBy: {
            id: pr.createdBy?.id || '',
            displayName: pr.createdBy?.displayName || pr.createdBy?.uniqueName || 'Unknown',
            uniqueName: pr.createdBy?.uniqueName || '' },
        creationDate: pr.creationDate || null,
        storyNumber: haystack.match(/\b[A-Z]+-\d+\b/i)?.[0]?.toUpperCase() ?? null,
        url,
        projectKey };
}

export async function adoRestFetch(rootDir: string, profile: ProjectProfile, path: string, method = 'GET', body?: unknown): Promise<any> {
    const configPath = resolve(rootDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configPath)) return mockAdoFetch(rootDir, path, method, body);
    if (!profile.organization || !profile.azureProject) throw new Error('Azure DevOps organization and project are required in .sdlc-framework.config.json');
    const pat = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || process.env.VSS_PAT || '';
    if (!pat) throw new Error('AZURE_DEVOPS_PAT, AZURE_DEVOPS_EXT_PAT, or VSS_PAT is required to query Azure DevOps PRs');
    const response = await fetch(`https://dev.azure.com/${profile.organization}/${profile.azureProject}/_apis${path}`, {
        method,
        headers: {
            'Authorization': `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
            'Content-Type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`ADO ${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.json().catch(() => ({}));
}

export function isAgilityConfigured(rootDir: string): boolean {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    return isMockExternalMode(configFile) || !!(process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL);
}

export function getV1Config(rootDir: string) {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configFile)) return { baseUrl: 'mock://agility', token: 'mock-token' };
    const baseUrl = process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL;
    const token = process.env.V1_ACCESS_TOKEN || process.env.AGILITY_API_KEY;
    if (!baseUrl || !token) throw new Error('V1_BASE_URL/AGILITY_BASE_URL and V1_ACCESS_TOKEN/AGILITY_API_KEY must be set in .env');
    return { baseUrl, token };
}

export const V1_HEADERS = (token: string) => ({
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json' });

export interface V1Asset {
    _oid?: string;
    id?: string;
    Attributes?: Record<string, { value?: unknown; name?: string }>;
    [key: string]: unknown;
}

export async function v1Fetch(rootDir: string, assetPath: string, queryParams?: Record<string, string>) {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configFile)) return mockV1Fetch(rootDir, assetPath, queryParams);
    const { baseUrl, token } = getV1Config(rootDir);
    const params = new URLSearchParams(queryParams || {});
    const qs = params.toString() ? `?${params.toString()}` : '';
    const resp = await fetch(`${baseUrl}/rest-1.v1/Data${assetPath}${qs}`, { headers: V1_HEADERS(token) });
    if (!resp.ok) throw new Error(`VersionOne API ${resp.status}: ${resp.statusText}`);
    return resp.json();
}

export async function v1Post(rootDir: string, assetPath: string, body: Record<string, unknown>) {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configFile)) return mockV1Post(rootDir, assetPath, body);
    const { baseUrl, token } = getV1Config(rootDir);
    const resp = await fetch(`${baseUrl}/rest-1.v1/Data${assetPath}`, {
        method: 'POST', headers: V1_HEADERS(token), body: JSON.stringify(body) });
    if (!resp.ok) { const text = await resp.text(); throw new Error(`VersionOne API POST ${resp.status}: ${text}`); }
    return resp.json();
}

export function storyOidToRestPath(oid: string): string {
    const trimmed = oid.trim();
    if (trimmed.includes(':')) {
        const [assetType, assetId] = trimmed.split(':', 2);
        if (!assetType || !assetId) throw new Error(`Invalid story oid: ${oid}`);
        return `${assetType}/${assetId}`;
    }
    if (/^\d+$/.test(trimmed)) return `Story/${trimmed}`;
    const noSlash = trimmed.replace(/^\/+/, '');
    if (/^[A-Za-z]+\/\d+$/.test(noSlash)) return noSlash;
    throw new Error(`Invalid story oid: ${oid}`);
}

export function pickStoryAsset(data: unknown): V1Asset | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const d = data as { Assets?: V1Asset[]; Attributes?: unknown; id?: string };
    if (Array.isArray(d.Assets) && d.Assets.length > 0) return d.Assets[0];
    if (d.Attributes && d.id) return d as V1Asset;
    return undefined;
}

export function mapV1TaskStatus(v1Status: unknown): string {
    if (!v1Status || typeof v1Status !== 'string') return 'pending';
    const t = v1Status.trim();
    const s = t.toLowerCase();
    if (s === 'completed' || s === 'done') return 'completed';
    if (s === 'in progress' || s === 'in-progress') return 'in_progress';
    if (s === 'failed') return 'failed';
    // Mock Agility persists VersionOne `Status` as an OID string (e.g. after MCP `update_task`).
    // `.cursor/hooks/workflow-validator.ps1` cites TaskStatus:123 (in progress) and :125 (completed).
    const taskOid = t.match(/^taskstatus:(\d+)$/i);
    if (taskOid) {
        if (taskOid[1] === '125') return 'completed';
        return 'in_progress';
    }
    return 'pending';
}

export function createV1ApiAdapter(rootDir: string, configFile: string): V1Api {
    return {
        v1Fetch: (path, query) => v1Fetch(rootDir, path, query),
        v1Post: (path, body) => v1Post(rootDir, path, body),
        baseUrl: process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL || '',
        addOwner: async (oidPath, ownerOid) => {
            if (isMockExternalMode(configFile)) return;
            const tok = process.env.V1_ACCESS_TOKEN || process.env.AGILITY_API_KEY;
            const baseUrl = process.env.V1_BASE_URL || process.env.AGILITY_BASE_URL || '';
            await fetch(`${baseUrl}/rest-1.v1/Data/${oidPath}/Owners`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ idref: ownerOid, act: 'add' }) });
        } };
}
