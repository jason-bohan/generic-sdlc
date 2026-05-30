import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { extname, join, relative, resolve } from 'path';
import { dbGetLedgerRows, dbListAgentSessions } from '../db';
import { parseJsonUtf8File } from '../json-file';
import { getActiveProject, getActiveProjectName } from '../project-config';
import { json } from '../router';
import { getDefaultStatus, normalizeStatus } from '../status-normalize';
import type { UseFn } from './types';

const AGENT_IDS = ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'aiqa'] as const;
const IMPLEMENTATION_AGENTS = AGENT_IDS.filter((id) => id !== 'aiqa');

type Severity = 'high' | 'medium' | 'low';

type FindingSource = 'status' | 'sessions' | 'logs' | 'tokens' | 'eval' | 'financial-control' | 'regulated-data' | 'provider-policy';

interface AiQaFinding {
    id: string;
    severity: Severity;
    agentId: string;
    title: string;
    evidence: string;
    suggestedOwner: string;
    source: FindingSource;
    status: 'open';
    createdAt: string;
}

interface AgentQualityCard {
    agentId: string;
    currentPhase: string;
    isRunning: boolean;
    openTasks: number;
    failedTasks: number;
    openRequests: number;
    activePrs: number;
    tokenTotal: number;
    findings: number;
}

interface StatusTask {
    id?: string;
    number?: string;
    name?: string;
    status?: string;
    hours?: number;
    category?: string;
}

interface FinancialControl {
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail';
    evidence: string;
    owner: string;
}

interface FinancialRiskSignal {
    area: string;
    risk: Severity;
    evidence: string;
}

interface TargetRepoScan {
    project: string;
    workspacePath: string | null;
    scannedFiles: number;
    matchedFiles: string[];
    unavailableReason?: string;
    text: string;
}

const MONEY_PATH_RE = /\b(payment|payments|billing|invoice|invoices|ledger|journal|balance|balances|transaction|transactions|settlement|reconciliation|reconcile|refund|chargeback|fee|fees|tax|taxes|interest|currency|fx|amount|price|pricing|payout|ach|wire|card|bank|accounting)\b/i;
const AUTH_CONTROL_RE = /\b(auth|authorization|permission|role|roles|rbac|access|entitlement|approval|approver|admin|security)\b/i;
const REGULATED_DATA_RE = /\b(ssn|social security|tax id|ein|pan|card number|cvv|cvc|iban|routing number|account number|bank account|dob|date of birth|passport|driver'?s license|customer pii|personally identifiable|kyc|aml)\b/i;
const CONTROL_EVIDENCE_RE = /\b(test|tests|tested|vitest|cypress|playwright|reconciliation|migration|audit log|approval|evidence|trace|screenshot|compliance|soc 2|sox|pci|glba|gdpr)\b/i;
const UNAPPROVED_PROVIDER_RE = /\b(openrouter|external model|unapproved provider|public model|non-approved|unauthorized model)\b/i;

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    use('/api/aiqa/scorecard', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        json(res, buildAiQaScorecard(rootDir, configFile));
    });

    use('/api/aiqa/sweep', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const scorecard = buildAiQaScorecard(rootDir, configFile);
        const written = writeAiQaTaskPills(rootDir, scorecard.findings);
        json(res, { ok: true, written, scorecard });
    });
}

function buildAiQaScorecard(rootDir: string, configFile: string) {
    const generatedAt = new Date().toISOString();
    const statuses = new Map<string, Record<string, any>>();
    const findings: AiQaFinding[] = [];

    for (const agentId of AGENT_IDS) {
        const raw = readAgentStatus(rootDir, agentId);
        statuses.set(agentId, raw);
    }

    for (const agentId of IMPLEMENTATION_AGENTS) {
        const status = statuses.get(agentId)!;
        findings.push(...findStatusFindings(agentId, status, generatedAt));
        findings.push(...findLogFindings(rootDir, agentId, generatedAt));
    }

    const financial = buildFinancialControls(rootDir, configFile, statuses, generatedAt);
    findings.push(...financial.findings);

    const sessions = readRecentSessions();
    findings.push(...findSessionFindings(sessions, generatedAt));

    const tokenTotals = readTokenTotals();
    for (const [agentId, total] of tokenTotals) {
        if (agentId === 'aiqa') continue;
        if (total > 100_000) {
            findings.push(makeFinding('high', agentId, 'High token burn needs eval coverage', `${agentId} has ${total.toLocaleString()} recorded tokens in the ledger.`, 'aiqa', 'tokens', generatedAt));
        } else if (total > 25_000) {
            findings.push(makeFinding('medium', agentId, 'Elevated token burn should be reviewed', `${agentId} has ${total.toLocaleString()} recorded tokens in the ledger.`, 'aiqa', 'tokens', generatedAt));
        }
    }

    const deduped = dedupeFindings(findings);
    const scorecards: AgentQualityCard[] = AGENT_IDS.map((agentId) => {
        const status = statuses.get(agentId)!;
        const tasks = Array.isArray(status.tasks) ? status.tasks as StatusTask[] : [];
        const requests = Array.isArray(status.requests) ? status.requests as Array<{ status?: string }> : [];
        const prs = Array.isArray(status.prs) ? status.prs as Array<{ status?: string }> : [];
        const normalized = normalizeStatus(status, agentId, rootDir) as Record<string, unknown>;
        return {
            agentId,
            currentPhase: String(normalized.currentPhase ?? 'idle'),
            isRunning: Boolean(normalized.isRunning),
            openTasks: tasks.filter((t) => !['completed', 'complete', 'failed'].includes(String(t.status ?? 'pending'))).length,
            failedTasks: tasks.filter((t) => String(t.status ?? '') === 'failed').length,
            openRequests: requests.filter((r) => r.status !== 'resolved').length,
            activePrs: prs.filter((p) => p.status === 'active').length,
            tokenTotal: tokenTotals.get(agentId) ?? 0,
            findings: deduped.filter((f) => f.agentId === agentId).length,
        };
    });

    const highSeverity = deduped.filter((f) => f.severity === 'high').length;
    const mediumSeverity = deduped.filter((f) => f.severity === 'medium').length;
    const qualityScore = Math.max(0, 100 - highSeverity * 18 - mediumSeverity * 8 - (deduped.length - highSeverity - mediumSeverity) * 3);

    return {
        generatedAt,
        summary: {
            qualityScore,
            openFindings: deduped.length,
            highSeverity,
            sessionsReviewed: sessions.length,
            tokenTotal: [...tokenTotals.values()].reduce((sum, n) => sum + n, 0),
        },
        scorecards,
        findings: deduped,
        evals: buildEvalChecks(deduped),
        financial,
    };
}

function readAgentStatus(rootDir: string, agentId: string): Record<string, any> {
    const file = resolve(rootDir, `.${agentId}-status.json`);
    if (!existsSync(file)) return getDefaultStatus(agentId);
    try {
        return parseJsonUtf8File(file) as Record<string, any>;
    } catch {
        return getDefaultStatus(agentId);
    }
}

function findStatusFindings(agentId: string, status: Record<string, any>, createdAt: string): AiQaFinding[] {
    const out: AiQaFinding[] = [];
    const phase = String(status.currentPhase ?? 'idle');
    const storyNumber = typeof status.storyNumber === 'string' ? status.storyNumber : null;
    const tasks = Array.isArray(status.tasks) ? status.tasks as StatusTask[] : [];
    const requests = Array.isArray(status.requests) ? status.requests as Array<{ status?: string }> : [];
    const failedTasks = tasks.filter((t) => String(t.status ?? '') === 'failed');
    const openRequests = requests.filter((r) => r.status !== 'resolved');

    if (phase === 'error') {
        out.push(makeFinding('high', agentId, 'Agent is in error phase', `${agentId} status file reports currentPhase=error.`, suggestedOwnerFor(agentId), 'status', createdAt));
    }
    if (storyNumber && !status.isRunning && !['idle', 'complete', 'approved', 'build-passed'].includes(phase)) {
        out.push(makeFinding('high', agentId, 'Agent stopped mid-workflow', `${agentId} is assigned to ${storyNumber} at phase ${phase} but is not running.`, suggestedOwnerFor(agentId), 'status', createdAt));
    }
    if (failedTasks.length > 0) {
        out.push(makeFinding('high', agentId, 'Failed task needs triage', `${agentId} has ${failedTasks.length} failed task(s).`, suggestedOwnerFor(agentId), 'status', createdAt));
    }
    if (openRequests.length > 0) {
        out.push(makeFinding('medium', agentId, 'Open request queue needs attention', `${agentId} has ${openRequests.length} unresolved request(s).`, suggestedOwnerFor(agentId), 'status', createdAt));
    }
    return out;
}

function findLogFindings(rootDir: string, agentId: string, createdAt: string): AiQaFinding[] {
    const logDir = resolve(rootDir, '.agent-output');
    if (!existsSync(logDir)) return [];
    const files = readdirSync(logDir)
        .filter((name) => name.startsWith(`${agentId}-`) && name.endsWith('.log'))
        .sort()
        .slice(-3);
    const out: AiQaFinding[] = [];
    for (const file of files) {
        const text = safeReadTail(resolve(logDir, file), 80_000);
        const parseFailures = countMatches(text, /(tool-call|tool call|json|parse).{0,60}(fail|error|invalid|malformed)/gi);
        const phaseCompletes = countMatches(text, /\[tool\].*complete_phase/g);
        const explicitErrors = countMatches(text, /\[error\]|ERROR:|Failed running/gi);
        if (parseFailures > 0) {
            out.push(makeFinding('high', agentId, 'Tool-call parsing failures detected', `${file} includes ${parseFailures} parse/tool-call failure signal(s).`, 'aiqa', 'logs', createdAt));
        }
        if (phaseCompletes > 8) {
            out.push(makeFinding('medium', agentId, 'Repeated phase completion attempts', `${file} includes ${phaseCompletes} complete_phase tool calls.`, 'aiqa', 'logs', createdAt));
        }
        if (explicitErrors > 0) {
            out.push(makeFinding('medium', agentId, 'Agent log contains errors', `${file} includes ${explicitErrors} error signal(s).`, suggestedOwnerFor(agentId), 'logs', createdAt));
        }
    }
    return out;
}

function findSessionFindings(sessions: Array<Record<string, any>>, createdAt: string): AiQaFinding[] {
    const out: AiQaFinding[] = [];
    const now = Date.now();
    for (const session of sessions) {
        const agentId = String(session.agent_id ?? 'unknown');
        const status = String(session.status ?? '');
        const updatedAt = Date.parse(String(session.updated_at ?? session.started_at ?? ''));
        if (status === 'running' && Number.isFinite(updatedAt) && now - updatedAt > 30 * 60_000) {
            out.push(makeFinding('medium', agentId, 'Running session appears stale', `Session ${session.id} has been running with no update for more than 30 minutes.`, suggestedOwnerFor(agentId), 'sessions', createdAt));
        }
        if (['failed', 'stopped'].includes(status)) {
            out.push(makeFinding('medium', agentId, 'Recent session ended without completion', `Session ${session.id} ended with status=${status}.`, suggestedOwnerFor(agentId), 'sessions', createdAt));
        }
    }
    return out;
}

function readRecentSessions(): Array<Record<string, any>> {
    try {
        return dbListAgentSessions({ limit: 50 }) as unknown as Array<Record<string, any>>;
    } catch {
        return [];
    }
}

function readTokenTotals(): Map<string, number> {
    const totals = new Map<string, number>();
    try {
        for (const row of dbGetLedgerRows()) {
            const agent = row.agent || 'unknown';
            totals.set(agent, (totals.get(agent) ?? 0) + row.input_tokens + row.output_tokens);
        }
    } catch {
        // Ledger is informational for AIQA; startup should not depend on it.
    }
    return totals;
}

function buildEvalChecks(findings: AiQaFinding[]) {
    return [
        {
            id: 'tool-call-format',
            name: 'Tool-call format guardrail',
            status: findings.some((f) => f.title.includes('Tool-call')) ? 'fail' : 'pass',
            evidence: findings.some((f) => f.title.includes('Tool-call')) ? 'Recent logs contain parse/tool-call failures.' : 'No recent tool-call parse failures detected.',
        },
        {
            id: 'evidence-before-success',
            name: 'Evidence before success claims',
            status: findings.some((f) => f.title.includes('phase completion')) ? 'warn' : 'pass',
            evidence: findings.some((f) => f.title.includes('phase completion')) ? 'Repeated complete_phase calls should be checked for weak evidence.' : 'No repeated complete_phase pattern detected.',
        },
        {
            id: 'handoff-health',
            name: 'Workflow handoff health',
            status: findings.some((f) => f.title.includes('stopped') || f.title.includes('stale')) ? 'warn' : 'pass',
            evidence: findings.some((f) => f.title.includes('stopped') || f.title.includes('stale')) ? 'A stopped or stale workflow was detected.' : 'No stale handoff/session signal detected.',
        },
    ];
}

function buildFinancialControls(rootDir: string, configFile: string, statuses: Map<string, Record<string, any>>, createdAt: string) {
    const textByAgent = new Map<string, string>();
    for (const agentId of AGENT_IDS) {
        const status = statuses.get(agentId) ?? {};
        textByAgent.set(agentId, [
            status.storyNumber,
            status.storyName,
            status.storyDescription,
            JSON.stringify(status.tasks ?? []),
            JSON.stringify(status.requests ?? []),
            JSON.stringify(status.events ?? []),
            recentAgentLogText(rootDir, agentId),
        ].filter(Boolean).join('\n'));
    }

    const targetRepo = scanTargetRepo(configFile);
    const allText = [...textByAgent.values(), targetRepo.text].join('\n');
    const riskSignals: FinancialRiskSignal[] = [];
    const findings: AiQaFinding[] = [];

    if (MONEY_PATH_RE.test(allText)) {
        riskSignals.push({
            area: 'Money movement',
            risk: 'high',
            evidence: 'Telemetry references payments, billing, ledger, balances, settlement, fees, tax, refunds, or related money-path terms.',
        });
    }
    if (AUTH_CONTROL_RE.test(allText)) {
        riskSignals.push({
            area: 'Access control',
            risk: 'high',
            evidence: 'Telemetry references auth, permissions, roles, approvals, or administrative access.',
        });
    }
    if (REGULATED_DATA_RE.test(allText)) {
        riskSignals.push({
            area: 'Regulated data',
            risk: 'high',
            evidence: 'Telemetry references PII, card data, bank data, KYC/AML, or similar regulated data terms.',
        });
    }
    if (targetRepo.matchedFiles.length > 0) {
        riskSignals.push({
            area: 'Target repository',
            risk: 'high',
            evidence: `${targetRepo.project} contains financial-control signals in ${targetRepo.matchedFiles.slice(0, 5).join(', ')}${targetRepo.matchedFiles.length > 5 ? '...' : ''}.`,
        });
    }

    const controls: FinancialControl[] = [
        {
            id: 'money-path-tests',
            name: 'Money path deterministic tests',
            status: MONEY_PATH_RE.test(allText) && !CONTROL_EVIDENCE_RE.test(allText) ? 'fail' : MONEY_PATH_RE.test(allText) ? 'warn' : 'pass',
            evidence: MONEY_PATH_RE.test(allText)
                ? CONTROL_EVIDENCE_RE.test(allText)
                    ? 'Money-path language detected; some test/evidence language is present and should be verified.'
                    : 'Money-path language detected without nearby test/evidence language.'
                : 'No current money-path signal detected in agent telemetry.',
            owner: 'qa',
        },
        {
            id: 'regulated-data-redaction',
            name: 'Regulated data redaction',
            status: REGULATED_DATA_RE.test(allText) ? 'fail' : 'pass',
            evidence: REGULATED_DATA_RE.test(allText)
                ? 'PII/card/bank/KYC terms were detected in agent telemetry; verify logs and prompts are redacted.'
                : 'No regulated data keywords detected in recent telemetry.',
            owner: 'aiqa',
        },
        {
            id: 'approval-integrity',
            name: 'Approval and separation of duties',
            status: AUTH_CONTROL_RE.test(allText) && !/\b(reviewer|approval|approved|code review|separation of duties)\b/i.test(allText) ? 'fail' : AUTH_CONTROL_RE.test(allText) ? 'warn' : 'pass',
            evidence: AUTH_CONTROL_RE.test(allText)
                ? 'Access-control language detected; reviewer approval and separation-of-duties evidence should be attached.'
                : 'No current access-control signal detected in agent telemetry.',
            owner: 'reviewer',
        },
        {
            id: 'provider-policy',
            name: 'Approved AI provider policy',
            status: UNAPPROVED_PROVIDER_RE.test(allText) ? 'fail' : 'pass',
            evidence: UNAPPROVED_PROVIDER_RE.test(allText)
                ? 'Telemetry references an unapproved or external AI provider.'
                : 'No unapproved provider signal detected in recent telemetry.',
            owner: 'aiqa',
        },
        {
            id: 'audit-evidence-bundle',
            name: 'Audit evidence bundle',
            status: riskSignals.length > 0 && !/\b(evidence bundle|audit evidence|traceability|audit trail)\b/i.test(allText) ? 'warn' : 'pass',
            evidence: riskSignals.length > 0
                ? 'Financial or control risk is present; story/PR should have traceable prompt, model, tool, test, review, and deploy evidence.'
                : 'No finance-specific evidence bundle required for current telemetry.',
            owner: 'aiqa',
        },
    ];

    for (const control of controls) {
        if (control.status === 'pass') continue;
        findings.push(makeFinding(
            control.status === 'fail' ? 'high' : 'medium',
            'aiqa',
            `Financial control check: ${control.name}`,
            control.evidence,
            control.owner,
            control.id === 'regulated-data-redaction' ? 'regulated-data' : control.id === 'provider-policy' ? 'provider-policy' : 'financial-control',
            createdAt,
        ));
    }

    for (const [agentId, text] of textByAgent) {
        if (agentId === 'aiqa') continue;
        if (REGULATED_DATA_RE.test(text)) {
            findings.push(makeFinding('high', agentId, 'Regulated data exposure signal', `${agentId} telemetry references PII/card/bank/KYC data; verify prompt/log redaction.`, 'aiqa', 'regulated-data', createdAt));
        }
        if (MONEY_PATH_RE.test(text) && !CONTROL_EVIDENCE_RE.test(text)) {
            findings.push(makeFinding('high', agentId, 'Financial code path lacks visible control evidence', `${agentId} telemetry references a money path without visible tests, reconciliation, or audit evidence.`, 'qa', 'financial-control', createdAt));
        }
        if (UNAPPROVED_PROVIDER_RE.test(text)) {
            findings.push(makeFinding('high', agentId, 'Unapproved AI provider signal', `${agentId} telemetry references an unapproved or public model/provider.`, 'aiqa', 'provider-policy', createdAt));
        }
    }

    const financialRisk = riskSignals.some((s) => s.risk === 'high') ? 'high' : riskSignals.some((s) => s.risk === 'medium') ? 'medium' : 'low';

    return {
        financialRisk,
        riskSignals,
        controls,
        findings,
        targetRepo: {
            project: targetRepo.project,
            workspacePath: targetRepo.workspacePath,
            scannedFiles: targetRepo.scannedFiles,
            matchedFiles: targetRepo.matchedFiles.slice(0, 20),
            unavailableReason: targetRepo.unavailableReason,
        },
    };
}

function scanTargetRepo(configFile: string): TargetRepoScan {
    const project = getActiveProjectName(configFile);
    const profile = getActiveProject(configFile);
    const workspacePath = profile.workspacePath ? resolve(profile.workspacePath) : null;
    if (!workspacePath) {
        return { project, workspacePath: null, scannedFiles: 0, matchedFiles: [], unavailableReason: 'active project has no workspacePath', text: '' };
    }
    if (!existsSync(workspacePath)) {
        return { project, workspacePath, scannedFiles: 0, matchedFiles: [], unavailableReason: 'workspacePath does not exist', text: '' };
    }

    const files = listScanFiles(workspacePath, 300);
    const matchedFiles: string[] = [];
    const chunks: string[] = [];
    let scannedFiles = 0;
    let remainingChars = 1_500_000;

    for (const file of files) {
        if (remainingChars <= 0) break;
        scannedFiles += 1;
        const rel = relative(workspacePath, file);
        const pathSignal = MONEY_PATH_RE.test(rel) || AUTH_CONTROL_RE.test(rel) || REGULATED_DATA_RE.test(rel) || UNAPPROVED_PROVIDER_RE.test(rel);
        let text = '';
        try {
            text = readFileSync(file, 'utf-8').slice(0, Math.min(25_000, remainingChars));
        } catch {
            continue;
        }
        remainingChars -= text.length;
        const contentSignal = MONEY_PATH_RE.test(text) || AUTH_CONTROL_RE.test(text) || REGULATED_DATA_RE.test(text) || UNAPPROVED_PROVIDER_RE.test(text);
        if (pathSignal || contentSignal) matchedFiles.push(rel);
        if (pathSignal || contentSignal || CONTROL_EVIDENCE_RE.test(text)) {
            chunks.push(`FILE ${rel}\n${text}`);
        }
    }

    return {
        project,
        workspacePath,
        scannedFiles,
        matchedFiles,
        text: chunks.join('\n'),
    };
}

function listScanFiles(root: string, limit: number): string[] {
    const out: string[] = [];
    const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.svelte-kit', '.nuxt', '.sdlc-framework', '.agent-output']);
    const textExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.yml', '.yaml', '.cs', '.java', '.py', '.rb', '.go', '.rs', '.sql', '.feature']);
    const visit = (dir: string, depth: number) => {
        if (out.length >= limit || depth > 5) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= limit) return;
            const full = join(dir, entry);
            let st;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (!skipDirs.has(entry)) visit(full, depth + 1);
                continue;
            }
            if (!st.isFile() || st.size > 500_000) continue;
            if (textExts.has(extname(entry).toLowerCase())) out.push(full);
        }
    };
    visit(root, 0);
    return out;
}

function recentAgentLogText(rootDir: string, agentId: string): string {
    const logDir = resolve(rootDir, '.agent-output');
    if (!existsSync(logDir)) return '';
    return readdirSync(logDir)
        .filter((name) => name.startsWith(`${agentId}-`) && name.endsWith('.log'))
        .sort()
        .slice(-2)
        .map((name) => safeReadTail(resolve(logDir, name), 40_000))
        .join('\n');
}

function writeAiQaTaskPills(rootDir: string, findings: AiQaFinding[]): number {
    const statusFile = resolve(rootDir, '.aiqa-status.json');
    const raw = readAgentStatus(rootDir, 'aiqa');
    const existingTasks = Array.isArray(raw.tasks) ? raw.tasks as StatusTask[] : [];
    const existingIds = new Set(existingTasks.map((t) => String(t.id ?? t.number ?? '')));
    const newTasks = findings
        .filter((f) => f.status === 'open')
        .map((f) => ({
            id: `AIQA-${stableHash(f.id)}`,
            number: `AIQA-${stableHash(f.id)}`,
            name: `${severityLabel(f.severity)}: ${f.title} - ${f.agentId}`,
            status: 'pending',
            hours: f.severity === 'high' ? 2 : 1,
            category: 'AI Quality',
            priority: f.severity,
            evidence: f.evidence,
            suggestedOwner: f.suggestedOwner,
        }))
        .filter((task) => !existingIds.has(task.id));
    const now = new Date().toISOString();
    const next = {
        ...getDefaultStatus('aiqa'),
        ...raw,
        currentPhase: raw.currentPhase ?? 'idle',
        tasks: [...existingTasks, ...newTasks],
        events: [
            ...(Array.isArray(raw.events) ? raw.events : []),
            { timestamp: now, type: newTasks.length ? 'warning' : 'success', message: `AIQA eval sweep filed ${newTasks.length} new finding task(s).` },
        ].slice(-50),
    };
    writeFileSync(statusFile, JSON.stringify(next, null, 2));
    return newTasks.length;
}

function makeFinding(severity: Severity, agentId: string, title: string, evidence: string, suggestedOwner: string, source: FindingSource, createdAt: string): AiQaFinding {
    const id = `${source}:${agentId}:${title}:${evidence}`;
    return { id, severity, agentId, title, evidence, suggestedOwner, source, status: 'open', createdAt };
}

function dedupeFindings(findings: AiQaFinding[]): AiQaFinding[] {
    const seen = new Set<string>();
    const out: AiQaFinding[] = [];
    for (const finding of findings) {
        const key = `${finding.source}:${finding.agentId}:${finding.title}:${finding.evidence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(finding);
    }
    return out.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.agentId.localeCompare(b.agentId));
}

function suggestedOwnerFor(agentId: string): string {
    if (agentId === 'reviewer') return 'reviewer';
    if (agentId === 'devops') return 'devops';
    if (agentId === 'qa') return 'qa';
    if (agentId === 'ux') return 'ux';
    return agentId === 'aiqa' ? 'aiqa' : agentId;
}

function safeReadTail(file: string, maxChars: number): string {
    try {
        const text = readFileSync(file, 'utf-8');
        return text.slice(-maxChars);
    } catch {
        return '';
    }
}

function countMatches(text: string, re: RegExp): number {
    return text.match(re)?.length ?? 0;
}

function severityRank(severity: Severity): number {
    return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

function severityLabel(severity: Severity): string {
    return severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';
}

function stableHash(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).toUpperCase();
}
