/**
 * Standalone SDLC Framework API server.
 * Run with: tsx src/server/index.ts
 * Listens on PORT (default 3001); Vite dev server proxies /api/* here.
 */

import http from 'node:http';
import { resolve } from 'path';
import { config as loadDotenv } from 'dotenv';

const ROOT_DIR = resolve(__dirname, '../..');
loadDotenv({ path: resolve(ROOT_DIR, '.env') });

import chalk from 'chalk';
import { initDb, closeDb } from './db';
import { createApp } from './app';
import { resumeRetries, executeRetryAction } from './orchestrator-retry';
import { startAdoBridge, stopAdoBridge } from './ado-bridge';
import { stopOllamaManager } from './ollamaManager';
import { withSecurity } from './security';
import { probeMeshllm } from './meshllmProvider';
import { startMeshllm } from './meshllmLauncher';
import { probeMlx, startMlxIfConfigured } from './mlxProvider';
import { meshllmLog, mlxLog } from './logger';
import { startHookRunner, stopHookRunner } from './hook-runner';
import { maybeAutoContinueAgent } from './auto-continue';
import { maybeHandoffReviewVerdict } from './review-handoff';
import { maybeTriggerVerification } from './verify-trigger';
import { startAutoFinetune } from './autoFinetune';
import { startBuildGateDriver } from './build-gate-driver';
import { startDepBabysitter } from './dep-babysitter';
import { startOrchestratorLoop } from './orchestrator-loop';
import { isLoopActive } from './loop-control';
import { getActiveProject } from './project-config';
import { isMockExternalMode } from './external-mode';
import { serverLog as log } from './logger';
import { existsSync } from 'fs';
import { deriveApiPort, persistDevPort } from './worktree-port';
import { parseJsonUtf8File } from './json-file';
import { setOnAgentStop } from './spawn-agent';
import { emitStatusChange } from './status-events';
import { buildStatusBroadcast } from './status-broadcast';

const PORT = deriveApiPort(ROOT_DIR);
persistDevPort(ROOT_DIR, PORT);
const CONFIG_FILE = resolve(ROOT_DIR, '.sdlc-framework.config.json');

// ─── Request logger middleware ────────────────────────────────────────────────

/** Dashboard polls `/api/status` every 2s per active agent; skip routine 200s to keep logs readable. Set `SDLC_FRAMEWORK_LOG_STATUS_POLL=1` to log them. */
function shouldLogRequest(req: http.IncomingMessage, status: number): boolean {
    if (process.env.SDLC_FRAMEWORK_LOG_STATUS_POLL === '1') return true;
    if (status >= 400) return true;
    if ((req.method || 'GET') !== 'GET') return true;
    const path = (req.url || '').split('?')[0] ?? '';
    if (path === '/api/status') return false;
    return true;
}

function withRequestLog(inner: http.RequestListener): http.RequestListener {
    return (req, res) => {
        const start = Date.now();
        res.on('finish', () => {
            const ms = Date.now() - start;
            const status = res.statusCode;
            if (!shouldLogRequest(req, status)) return;
            const color = status >= 500 ? chalk.red : status >= 400 ? chalk.yellow : chalk.green;
            const method = chalk.bold((req.method || 'GET').padEnd(6));
            const url = chalk.white(req.url || '/');
            log.info(`${method} ${color(String(status))} ${url} ${chalk.dim(`${ms}ms`)}`);
        });
        inner(req, res);
    };
}

// ─── ADO bridge boot ─────────────────────────────────────────────────────────

function bootAdoBridge() {
    const profile = getActiveProject(CONFIG_FILE);
    const pat = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || process.env.VSS_PAT || '';

    let agentPats: Record<string, string> = {};
    try {
        if (existsSync(CONFIG_FILE)) {
            const cfg = parseJsonUtf8File(CONFIG_FILE);
            const agents = cfg.scheduler?.agents || {};
            for (const [id, agentCfg] of Object.entries(agents)) {
                const agentPat = (agentCfg as Record<string, unknown>).adoPat as string;
                if (agentPat) agentPats[id] = agentPat;
            }
        }
    } catch { /* non-fatal */ }

    startAdoBridge({
        workspaceDir: ROOT_DIR,
        organization: profile.organization,
        azureProject: profile.azureProject,
        repositoryId: profile.repositoryId,
        prUrlBase: profile.prUrlBase || '',
        reviewerIds: profile.reviewerIds,
        pat,
        agentPats });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Init DB before anything else so ledger, messages, and ollama state are ready
initDb(ROOT_DIR);

const app = createApp(ROOT_DIR);
const secured = withSecurity(app, { disableRateLimit: !!process.env.VITEST });
const server = http.createServer(withRequestLog(secured));

server.listen(PORT, () => {
    const mock = isMockExternalMode(CONFIG_FILE);
    log.success(`SDLC Framework API server → ${chalk.bold(`http://localhost:${PORT}`)}`);
    if (mock) log.warn('External mode: MOCK — ADO/Agility calls are simulated');

    // The (legacy) ADO/status-watcher bridge only matters on an ADO host or in mock-E2E
    // mode (cypress relies on it to drive PR/review/build). On a GitHub+Linear stack the
    // autonomous loop path handles automation, so don't even attempt it — startAdoBridge
    // already self-disables without a PAT, but gating here makes ADO-off explicit and
    // skips the misleading "bridge disabled" startup log.
    const adoConfigured = !!(process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || process.env.VSS_PAT)
        || (process.env.PM_PROVIDER ?? '').toLowerCase() === 'azure';
    if ((adoConfigured && !process.env.VITEST) || mock) {
        bootAdoBridge();
    }
    // Reschedule any orchestrator limit-retries that were pending across this restart
    // (a Claude usage pause whose refresh time may be in the past or future now).
    if (!process.env.VITEST) {
        try {
            const resumed = resumeRetries(ROOT_DIR, (action) => executeRetryAction(`http://localhost:${PORT}`, action));
            if (resumed > 0) log.info(`Resumed ${resumed} pending orchestrator limit-retry(ies)`);
        } catch { /* non-fatal */ }
    }
    if (!process.env.VITEST) {
        probeMeshllm().then(async (available) => {
            if (available) {
                meshllmLog.success('available as inference provider');
            } else {
                meshllmLog.info('not running — attempting auto-launch…');
                const result = await startMeshllm(ROOT_DIR);
                if (result.ok) meshllmLog.info('launch command sent — health will confirm when ready');
                else meshllmLog.info(`auto-launch skipped: ${result.reason ?? 'no launch source configured'}`);
            }
        }).catch(() => {});
        probeMlx().then(async (available) => {
            if (available) {
                mlxLog.success('available as inference provider');
            } else {
                mlxLog.info('not running — attempting auto-launch…');
                const result = await startMlxIfConfigured();
                if (result.ok) mlxLog.info('launch command sent — health will confirm when ready');
                else mlxLog.info(`auto-launch skipped: ${result.reason ?? 'MLX_MODEL not configured'}`);
            }
        }).catch(() => {});
        startHookRunner({
            rootDir: ROOT_DIR,
            // Opt-in (scheduler.verifyOnComplete): run the goose verify-change recipe
            // when an implementation agent reaches a done phase. Never throws.
            onEvent: (ev) => {
                try { maybeTriggerVerification(ROOT_DIR, CONFIG_FILE, ev); }
                catch (e) { log.warn(`[verify-trigger] ${e instanceof Error ? e.message : String(e)}`); }
                // Autonomous reviewer→dev handoff: when the reviewer posts a verdict,
                // route it back (changes → dev rework, approved → devops build).
                // Gated by the loop brake — a paused/stopped loop spawns no handoff agents.
                try { if (isLoopActive(ROOT_DIR)) maybeHandoffReviewVerdict(PORT, ev); }
                catch (e) { log.warn(`[review-handoff] ${e instanceof Error ? e.message : String(e)}`); }
                try { maybeAutoContinueAgent(ROOT_DIR, PORT, CONFIG_FILE, ev.agentId); }
                catch (e) { log.warn(`[auto-continue] ${e instanceof Error ? e.message : String(e)}`); }
            },
        });
        // When a spawn-based agent process exits, run the same guarded auto-continue
        // path. This complements the file-watcher-based hook-runner (which may miss
        // rapid phase transitions before the process exits); the shared function
        // honors step mode, driver type, and the active-agent guards either way.
        setOnAgentStop((agentId) => {
            try { maybeAutoContinueAgent(ROOT_DIR, PORT, CONFIG_FILE, agentId); }
            catch (e) { log.warn(`[agent-stop] ${agentId}: ${e instanceof Error ? e.message : String(e)}`); }
        });
        startAutoFinetune(ROOT_DIR);
        // Deterministically drive the GitHub build gate so a slow devops agent can't strand a
        // CI-green, mergeable PR at pending-build (autonomous-gated internally).
        startBuildGateDriver(ROOT_DIR, CONFIG_FILE);
        // Auto-merge safe (non-major, CI-green) Renovate/Dependabot PRs across the framework +
        // target repos. Gated internally to loop-active + autonomous; never touches majors.
        startDepBabysitter(ROOT_DIR, CONFIG_FILE);
        // Continuous autonomy: periodically tick the assign-loop so the orchestrator keeps
        // picking up backlog as specialists free. Gated to loop-active + autonomous.
        startOrchestratorLoop(ROOT_DIR, PORT);
    }

    // Seed the orchestrator status into the SSE stream so the FleetView
    // sees it even without a status file on disk.
    try {
        const idleStatus = {
            storyNumber: null, storyName: null, currentPhase: 'idle',
            currentTask: null, startedAt: null, tasks: [], prs: [], requests: [],
            tokens: { cloud: { input: 0, output: 0 }, ollama: { input: 0, output: 0 }, mlx: { input: 0, output: 0 } },
            cypress: { lastRun: null, total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
            events: [{ timestamp: new Date().toISOString(), type: 'info', message: 'Orchestrator is idle.' }],
        };
        emitStatusChange('orchestrator', buildStatusBroadcast(idleStatus, 'orchestrator', true, ROOT_DIR));
    } catch { /* non-fatal */ }
});

server.once('close', () => {
    stopHookRunner();
    stopAdoBridge();
    stopOllamaManager();
    closeDb();
});

// Graceful shutdown that can't wedge. `server.close()` alone waits forever for
// keep-alive / SSE connections (dashboard polls, status streams) to drain, which
// leaves a zombie process bound to no port on `tsx --watch` restarts and on any
// SIGTERM (Docker stop / redeploy). Force-drop connections and hard-exit on a timer.
let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`Received ${signal} — shutting down…`);
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    // Last-resort: if a handle still keeps the loop alive, exit anyway.
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
