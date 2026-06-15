import {
    existsSync,
    writeFileSync,
} from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import { type SdlcPhaseId } from '../../shared/sdlcContracts';
import { isGlobalStepMode, isAgentStepMode } from '../stepMode';
import { emitStatusChange } from '../status-events';
import { buildStatusBroadcast } from '../status-broadcast';
import { asSdlcPhaseId } from '../status-normalize';
import { parseJsonUtf8File } from '../json-file';
import { isLocalStoryNumber, updateLocalStoryStatus } from '../local-planning';
import { findStoryOwnerByPrId } from '../handoff';
import { autoCommitWorktree, autoCreatePr, autoMergePr, DEVOPS_BUILD_CHAIN, devopsBuildChainNextPhase } from './commit-pr';
import type { AutoCommitResult, AutoPrResult, AutoMergeResult } from './commit-pr';
import { serverLog as log } from '../logger';

export async function toolCompletePhase(
    args: Record<string, unknown>,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
    configPath: string,
): Promise<string> {
    let nextPhase = String(args.next_phase ?? 'analyzing');
    const summary = String(args.summary ?? '');

    const statusFile = resolve(frameworkDir, `.${agentId}-status.json`);
    let workflowItemId: number | null = null;
    let storyNumber = '1';
    let storyName = '';
    let tasks: unknown[] = [];
    let currentPhase = 'reading-story';
    try {
        const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
        if (typeof s.workflowItemId === 'number') workflowItemId = s.workflowItemId;
        if (typeof s.storyNumber === 'string') storyNumber = s.storyNumber;
        if (typeof s.storyName === 'string') storyName = s.storyName;
        if (Array.isArray(s.tasks)) tasks = s.tasks;
        if (typeof s.currentPhase === 'string' && s.currentPhase) currentPhase = s.currentPhase;
    } catch { /* use defaults */ }

    if (!workflowItemId) return 'Error: workflowItemId not found in status file. The workflow must be registered before completing a phase.';

    const taskIds = tasks.map((t: unknown) => (t as Record<string, unknown>)?.id ?? '').filter(Boolean);

    const changeTitle = `${storyNumber}: ${storyName || 'changes'}`.slice(0, 120);
    const prBody = `Story ${storyNumber}${storyName ? `: ${storyName}` : ''}\n\nOpened automatically by the ${agentId} agent.`;

    let autoCommit: AutoCommitResult | undefined;
    if (currentPhase === 'committing') {
        autoCommit = autoCommitWorktree(workspaceDir, agentId, storyNumber, changeTitle);
        if (!autoCommit.ok) {
            return `Cannot complete committing: ${autoCommit.note}. This phase requires real source changes to commit. If generating-code produced no changes, set next_phase to "generating-code" and implement the story — do not complete committing with an empty/junk commit.`;
        }
        try {
            const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 10_000, cwd: workspaceDir }).trim();
            if (branch !== 'main' && branch !== 'HEAD') {
                execFileSync('git', ['fetch', 'origin', 'main'], { encoding: 'utf8', timeout: 30_000, cwd: workspaceDir });
                try {
                    execFileSync('git', ['merge', 'origin/main'], { encoding: 'utf8', timeout: 30_000, cwd: workspaceDir });
                    autoCommit.note += '; merged origin/main into branch';
                } catch (mergeErr) {
                    const mergeOutput = typeof mergeErr === 'object' && mergeErr !== null
                        ? String((mergeErr as { stderr?: string; stdout?: string; message?: string }).stderr ?? (mergeErr as { message?: string }).message ?? '')
                        : String(mergeErr);
                    if (/conflict|CONFLICT|Merge conflict/i.test(mergeOutput)) {
                        return `Proactive merge of origin/main into ${branch} produced conflicts. Use run_command to see conflicted files (git status), read_file to view conflict markers, edit_file to resolve them, then git add + git commit + call complete_phase with next_phase="committing" to retry.`;
                    }
                }
            }
        } catch { /* fetch/merge failed (no remote, no network) — non-fatal, proceed */ }
    }

    let autoPr: AutoPrResult | undefined;
    if (currentPhase === 'creating-pr') {
        autoPr = autoCreatePr(workspaceDir, agentId, storyNumber, changeTitle, prBody, configPath);
        const prMeta = (autoPr.ok ? (autoPr.pr ?? autoPr.mockPr) : undefined) as { number?: number; url?: string; title?: string; branch?: string } | undefined;
        if (prMeta && typeof prMeta.number === 'number' && prMeta.number > 0) {
            const serverUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
            const payload = JSON.stringify({ agentId, prId: prMeta.number, prTitle: prMeta.title || changeTitle, prUrl: prMeta.url, storyNumber, branch: prMeta.branch });
            const MAX = 4;
            let handed = false;
            for (let attempt = 1; attempt <= MAX && !handed; attempt++) {
                try {
                    const res = await fetch(`${serverUrl}/api/pr/created`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: payload,
                        signal: AbortSignal.timeout(20_000),
                    });
                    if (res.ok) { handed = true; break; }
                    log.warn(`[creating-pr] reviewer handoff attempt ${attempt}/${MAX} → HTTP ${res.status}`);
                } catch (e) {
                    log.warn(`[creating-pr] reviewer handoff attempt ${attempt}/${MAX} failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                if (!handed && attempt < MAX) await new Promise((r) => setTimeout(r, attempt * 1000));
            }
            if (!handed) {
                log.error(`[creating-pr] reviewer handoff FAILED after ${MAX} attempts for PR #${prMeta.number} — it will sit unreviewed. Re-trigger with POST ${serverUrl}/api/pr/created or Pick Up on the reviewer desk.`);
            }
        }
    }

    let autoMerge: AutoMergeResult | undefined;
    if (agentId === 'devops' && DEVOPS_BUILD_CHAIN.has(currentPhase)) {
        const forward = devopsBuildChainNextPhase(currentPhase as SdlcPhaseId);
        if (forward) nextPhase = forward;

        if (currentPhase === 'build-passed') {
            const stepModeOn = isGlobalStepMode(configPath) || isAgentStepMode('devops', configPath);
            if (stepModeOn) {
                return `[build-gate] Step mode is on — PR not auto-merged. Merge it manually, then advance the story to complete. (devops desk left at build-passed.)`;
            }
            autoMerge = autoMergePr(frameworkDir, configPath);
            if (!autoMerge.ok) {
                const isDirty = autoMerge.note.startsWith('DIRTY:');
                if (isDirty) {
                    return `[build-gate] ${autoMerge.note.slice(6)}\n\nYour workspace may have a different branch checked out. Use run_command to resolve the conflicts:\n1. git fetch origin\n2. git checkout BRANCH && git merge origin/main\n3. Use read_file to see conflict markers, edit_file to resolve them\n4. git add . && git commit -m "merge main into BRANCH"\n5. git push origin BRANCH\n6. Call complete_phase with next_phase="build-passed" to retry the merge\n\nDo not advance to complete until the PR merges successfully. (devops desk left at build-passed.)`;
                }
                if (autoMerge.note.startsWith('BUILD-FAILED:')) {
                    return `[build-gate] ${autoMerge.note.slice('BUILD-FAILED:'.length)} The build-gate driver will route this to the developer for rework. Story NOT marked complete. (devops desk left at build-passed.)`;
                }
                return `[build-gate] Could not merge the PR: ${autoMerge.note}. Story NOT marked complete — resolve the merge, then re-run. (devops desk left at build-passed.)`;
            }
            if (autoMerge.ok) {
                let closeStoryNumber = storyNumber;
                if (!isLocalStoryNumber(closeStoryNumber)) {
                    try {
                        const ds = parseJsonUtf8File(resolve(frameworkDir, '.devops-status.json')) as Record<string, unknown>;
                        const prDesk = ds.assignedPR as { id?: number; storyNumber?: string } | undefined;
                        if (prDesk?.id) {
                            const owner = findStoryOwnerByPrId(frameworkDir, prDesk.id);
                            if (owner && typeof (owner.status as Record<string, unknown>)?.storyNumber === 'string') {
                                closeStoryNumber = String((owner.status as Record<string, unknown>).storyNumber);
                            }
                        }
                    } catch { /* fallback failed */ }
                }
                if (isLocalStoryNumber(closeStoryNumber)) {
                    try {
                        updateLocalStoryStatus(frameworkDir, closeStoryNumber, 'Closed');
                    } catch { /* non-critical */ }
                }
            }
        }
    }

    const outputs: Record<string, unknown> = {
        tasks,
        taskIds,
        auditEvent: {
            action: `${currentPhase}-complete`,
            storyNumber,
            agentId,
            nextPhase,
            timestamp: new Date().toISOString(),
            ...(autoCommit ? { autoCommit: autoCommit.note } : {}),
            ...(autoPr ? { autoPr: autoPr.note } : {}),
        },
    };
    const stringArg = (key: string) => args[key] === undefined || args[key] === null ? undefined : String(args[key]);
    outputs.branchPlan = stringArg('branch_plan') ?? `fix/${storyNumber}-fix`;
    outputs.risks = stringArg('risks') ?? 'None identified';
    outputs.openQuestions = stringArg('open_questions') ?? 'None';
    outputs.testMatrix = args.test_matrix !== undefined && args.test_matrix !== null
        ? (Array.isArray(args.test_matrix) ? args.test_matrix : [String(args.test_matrix)])
        : ['Unit tests for changed logic'];
    outputs.codeChanges = stringArg('code_changes') ?? summary;
    outputs.classification = stringArg('classification') ?? 'feature';
    outputs.affectedRepo = stringArg('affected_repo') ?? '';

    if (currentPhase === 'analyzing') {
        const plan = String(outputs.codeChanges ?? '').trim();
        try {
            const s = parseJsonUtf8File(statusFile) as Record<string, unknown>;
            s.analysisPlan = plan || null;
            writeFileSync(statusFile, JSON.stringify(s, null, 2));
        } catch { /* non-fatal */ }
    }
    outputs.handoff = args.handoff ?? `${agentId} completed ${currentPhase}`;
    outputs.designSpec = stringArg('design_spec') ?? '';

    const putIfProvided = (key: string, value: unknown) => {
        if (value !== undefined && value !== null) outputs[key] = value;
    };
    putIfProvided('validationResults', stringArg('validation_results'));
    putIfProvided('reviewVerdict', stringArg('review_verdict'));
    if (Array.isArray(args.review_threads)) outputs.reviewThreads = args.review_threads;
    putIfProvided('testResults', stringArg('test_results'));
    putIfProvided('staticAnalysis', stringArg('static_analysis'));
    putIfProvided('build', stringArg('build'));
    putIfProvided('pr', args.pr);
    putIfProvided('mockPr', args.mock_pr);

    if (currentPhase === 'validating' && outputs.validationResults === undefined) {
        try {
            const s = parseJsonUtf8File(statusFile) as { lastValidationResult?: unknown; lastValidationFailure?: unknown };
            if (s.lastValidationResult === 'passed' || s.lastValidationResult === 'failed') {
                const passed = s.lastValidationResult === 'passed';
                const detail = passed
                    ? 'run_validation reported OVERALL: PASSED'
                    : (typeof s.lastValidationFailure === 'string' && s.lastValidationFailure.trim() ? s.lastValidationFailure : 'run_validation reported OVERALL: FAILED');
                outputs.validationResults = { passed, source: 'run_validation', details: detail };
                if (outputs.testResults === undefined) outputs.testResults = passed ? 'run_validation: checks passed' : 'run_validation: checks failed — see validationResults';
                if (outputs.staticAnalysis === undefined) outputs.staticAnalysis = passed ? 'run_validation: no blocking issues' : 'run_validation: failures present — see validationResults';
            }
        } catch { /* no recorded verdict — leave unset; contract 409s honestly */ }
    }

    if (agentId === 'devops' && DEVOPS_BUILD_CHAIN.has(currentPhase)) {
        if (outputs.build === undefined) {
            outputs.build = { status: 'succeeded', result: 'succeeded', source: 'local-loop (no CI configured)' };
        }
        if (currentPhase === 'monitoring-build' && outputs.testResults === undefined) {
            outputs.testResults = 'No CI test stage configured in the local loop; build reported succeeded.';
        }
    }

    if (autoPr?.ok) {
        if (autoPr.pr) outputs.pr = autoPr.pr;
        if (autoPr.mockPr) outputs.mockPr = autoPr.mockPr;
        outputs.handoff = autoPr.handoff;
    }

    const serverBaseUrl = process.env.SDLC_SERVER_URL || 'http://localhost:3001';
    const payload = { workflowItemId, agentId, phase: currentPhase, nextPhase, outputs, message: summary };

    const MAX_ATTEMPTS = 4;
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`${serverBaseUrl}/api/workflows/complete-phase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000),
            });
            const text = await res.text();
            if (res.ok) {
                let recordedPhase = nextPhase;
                try {
                    const parsed = JSON.parse(text) as { workflow?: { active_phase?: string } };
                    if (parsed?.workflow?.active_phase) recordedPhase = parsed.workflow.active_phase;
                } catch { /* non-JSON body — fall back to the requested next_phase */ }
                try {
                    const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                    status.currentPhase = recordedPhase;
                    writeFileSync(statusFile, JSON.stringify(status, null, 2));
                    emitStatusChange(agentId, buildStatusBroadcast(status, agentId, true, frameworkDir));
                } catch { /* workflow completion succeeded; do not mask the server response */ }
                const commitLine = autoCommit ? `\n[commit-gate] ${autoCommit.note}` : '';
                const prLine = autoPr ? `\n[pr-gate] ${autoPr.note}` : '';
                const mergeLine = autoMerge ? `\n[build-gate] ${autoMerge.note}` : '';
                return `PHASE_COMPLETE::${recordedPhase}\nHTTP ${res.status}${commitLine}${prLine}${mergeLine}\n${text.slice(0, 500)}`;
            }
            if (res.status === 409) {
                const m = text.match(/Workflow item is in (\S+?),\s*not\b/i);
                const actual = m ? asSdlcPhaseId(m[1]) : undefined;
                if (actual) {
                    try {
                        const status = parseJsonUtf8File(statusFile) as Record<string, unknown>;
                        status.currentPhase = actual;
                        writeFileSync(statusFile, JSON.stringify(status, null, 2));
                        emitStatusChange(agentId, buildStatusBroadcast(status, agentId, true, frameworkDir));
                    } catch { /* recovery is best-effort */ }
                    return `PHASE_COMPLETE::${actual}\nPhase "${currentPhase}" was already completed — the workflow has advanced to "${actual}". Synced the desk; continue from "${actual}".`;
                }
            }
            return `HTTP ${res.status}\n${text.slice(0, 1000)}`;
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
            if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
        }
    }
    return `Could not reach the server after ${MAX_ATTEMPTS} attempts (${lastErr}). The server may be restarting; the phase was NOT recorded. Wait and call complete_phase again with the same outputs — do not set next_phase to "error".`;
}
