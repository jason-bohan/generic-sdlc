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
import { startAdoBridge, stopAdoBridge } from './ado-bridge';
import { startOllamaManager, stopOllamaManager, isEmbeddingReady } from './ollamaManager';
import { withSecurity } from './security';
import { probeMeshllm } from './meshllmProvider';
import { startMeshllm } from './meshllmLauncher';
import { probeMlx } from './mlxProvider';
import { meshllmLog, mlxLog } from './logger';
import { buildRagIndex } from './ragIndex';
import { startHookRunner, stopHookRunner } from './hook-runner';
import { startAutoFinetune } from './autoFinetune';
import { getActiveProject } from './project-config';
import { isMockExternalMode } from './external-mode';
import { serverLog as log } from './logger';
import { existsSync } from 'fs';
import { deriveApiPort, persistDevPort } from './worktree-port';
import { parseJsonUtf8File } from './json-file';

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

    // Cypress docker sets VITEST=1 to skip Ollama, but mock E2E still needs the ADO bridge
    // (reviewer changes-requested → review-complete handoff, PR automation, etc.).
    if (!process.env.VITEST || mock) {
        bootAdoBridge();
    }
    if (!process.env.VITEST) {
        startOllamaManager(ROOT_DIR);
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
        probeMlx().then((available) => {
            if (available) mlxLog.success('available as inference provider');
            else mlxLog.info('not running');
        }).catch(() => {});
        startHookRunner({ rootDir: ROOT_DIR });
        startAutoFinetune(ROOT_DIR);
        // Pre-warm RAG index for the help chatbot once embedding model is ready
        void (async () => {
            const ollamaBase = process.env.OLLAMA_HOST || 'http://localhost:11434';
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 3000));
                if (isEmbeddingReady()) {
                    log.info('Warming help RAG index…');
                    buildRagIndex(ROOT_DIR, ROOT_DIR, ollamaBase).catch(() => {});
                    break;
                }
            }
        })();
    }
});

server.once('close', () => {
    stopHookRunner();
    stopAdoBridge();
    stopOllamaManager();
    closeDb();
});

process.on('SIGTERM', () => { log.info('SIGTERM received — shutting down'); server.close(); });
process.on('SIGINT',  () => { log.info('SIGINT received — shutting down');  server.close(); });
