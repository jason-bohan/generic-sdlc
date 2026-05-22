/**
 * Auto-finetune trigger.
 *
 * Watches .devops-status.json for devops transitioning to 'idle' after
 * completing a story. When the completed-story count reaches the configured
 * threshold, spawns scripts/finetune-trigger.py to collect training data,
 * prepare the dataset, and (if Unsloth is available) run fine-tuning.
 *
 * State persists in .sdlc-framework/training-state.json so counts survive restarts.
 * Fine-tune job status is written to .sdlc-framework/finetune-status.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseJsonUtf8File } from './json-file';

const POLL_MS = 5000;
const DEFAULT_THRESHOLD = 5;

interface TrainingState {
    storiesCompleted: number;
    lastStoryNumber: string | null;
    lastTriggeredAt: string | null;
    totalFinetuneRuns: number;
}

interface FinetuneStatus {
    running: boolean;
    lastRunAt: string | null;
    lastRunResult: 'success' | 'failed' | 'skipped' | null;
    lastRunLog: string;
    storiesUntilNext: number;
    storiesCompleted: number;
    threshold: number;
}

function getConfig(rootDir: string): { enabled: boolean; threshold: number } {
    try {
        const configFile = resolve(rootDir, '.sdlc-framework.config.json');
        if (!existsSync(configFile)) return { enabled: false, threshold: DEFAULT_THRESHOLD };
        const cfg = parseJsonUtf8File(configFile) as Record<string, unknown>;
        const af = cfg.autoFinetune as Record<string, unknown> | undefined;
        if (!af) return { enabled: false, threshold: DEFAULT_THRESHOLD };
        return {
            enabled: af.enabled === true,
            threshold: typeof af.threshold === 'number' && af.threshold > 0 ? af.threshold : DEFAULT_THRESHOLD,
        };
    } catch {
        return { enabled: false, threshold: DEFAULT_THRESHOLD };
    }
}

function stateFile(rootDir: string) { return resolve(rootDir, '.sdlc-framework', 'training-state.json'); }
function statusFile(rootDir: string) { return resolve(rootDir, '.sdlc-framework', 'finetune-status.json'); }

function loadState(rootDir: string): TrainingState {
    try {
        const f = stateFile(rootDir);
        if (existsSync(f)) return parseJsonUtf8File(f) as TrainingState;
    } catch { /* ok */ }
    return { storiesCompleted: 0, lastStoryNumber: null, lastTriggeredAt: null, totalFinetuneRuns: 0 };
}

function saveState(rootDir: string, state: TrainingState): void {
    try { writeFileSync(stateFile(rootDir), JSON.stringify(state, null, 2)); } catch { /* non-fatal */ }
}

export function readFinetuneStatus(rootDir: string): FinetuneStatus {
    const { threshold } = getConfig(rootDir);
    const state = loadState(rootDir);
    const storiesUntilNext = Math.max(0, threshold - (state.storiesCompleted % threshold || threshold));
    const base: FinetuneStatus = {
        running: false,
        lastRunAt: state.lastTriggeredAt,
        lastRunResult: null,
        lastRunLog: '',
        storiesUntilNext,
        storiesCompleted: state.storiesCompleted,
        threshold,
    };
    try {
        const f = statusFile(rootDir);
        if (existsSync(f)) return { ...base, ...(parseJsonUtf8File(f) as Partial<FinetuneStatus>), storiesUntilNext, storiesCompleted: state.storiesCompleted, threshold };
    } catch { /* ok */ }
    return base;
}

let _running = false;

function triggerFinetune(rootDir: string, state: TrainingState): void {
    if (_running) { console.log('[autoFinetune] job already running, skipping'); return; }
    _running = true;
    const sf = statusFile(rootDir);
    writeFileSync(sf, JSON.stringify({ running: true, lastRunAt: new Date().toISOString(), lastRunResult: null, lastRunLog: 'Starting…' }, null, 2));

    const script = resolve(rootDir, 'scripts', 'finetune-trigger.py');
    if (!existsSync(script)) {
        const msg = 'scripts/finetune-trigger.py not found — skipping';
        console.warn(`[autoFinetune] ${msg}`);
        writeFileSync(sf, JSON.stringify({ running: false, lastRunAt: new Date().toISOString(), lastRunResult: 'skipped', lastRunLog: msg }, null, 2));
        _running = false;
        return;
    }

    const python = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(python, [script, '--root', rootDir], { cwd: rootDir, stdio: 'pipe' });
    const lines: string[] = [];

    const append = (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(`[autoFinetune] ${text}`);
        lines.push(...text.split('\n').filter(Boolean));
        try { writeFileSync(sf, JSON.stringify({ running: true, lastRunAt: new Date().toISOString(), lastRunResult: null, lastRunLog: lines.slice(-50).join('\n') }, null, 2)); } catch { /* ok */ }
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('close', code => {
        _running = false;
        const result = code === 0 ? 'success' : 'failed';
        console.log(`[autoFinetune] finetune-trigger exited ${code} (${result})`);
        try { writeFileSync(sf, JSON.stringify({ running: false, lastRunAt: new Date().toISOString(), lastRunResult: result, lastRunLog: lines.slice(-100).join('\n') }, null, 2)); } catch { /* ok */ }
        state.totalFinetuneRuns += 1;
        state.lastTriggeredAt = new Date().toISOString();
        saveState(rootDir, state);
    });
}

export function startAutoFinetune(rootDir: string): void {
    let lastPhase = 'unknown';
    let lastStory = '';

    const tick = () => {
        const { enabled, threshold } = getConfig(rootDir);
        if (!enabled) return;

        const devopsFile = resolve(rootDir, '.devops-status.json');
        if (!existsSync(devopsFile)) return;

        let currentPhase = 'unknown';
        let currentStory = '';
        try {
            const s = parseJsonUtf8File(devopsFile) as Record<string, unknown>;
            currentPhase = String(s.currentPhase ?? 'unknown');
            currentStory = String(s.storyNumber ?? '');
        } catch { return; }

        const justWentIdle = currentPhase === 'idle' && lastPhase !== 'idle' && lastPhase !== 'unknown';
        const storyChanged = lastStory && currentStory !== lastStory;

        if (justWentIdle && (storyChanged || lastStory)) {
            const completedStory = lastStory || currentStory;
            const state = loadState(rootDir);
            if (state.lastStoryNumber !== completedStory) {
                state.storiesCompleted += 1;
                state.lastStoryNumber = completedStory;
                saveState(rootDir, state);
                console.log(`[autoFinetune] story ${completedStory} complete — ${state.storiesCompleted} total (threshold: ${threshold})`);
                if (state.storiesCompleted % threshold === 0) {
                    console.log(`[autoFinetune] threshold reached — triggering fine-tune`);
                    triggerFinetune(rootDir, state);
                }
            }
        }

        lastPhase = currentPhase;
        if (currentStory) lastStory = currentStory;
    };

    setInterval(tick, POLL_MS);
    console.log('[autoFinetune] watcher started (polling every 5s)');
}

export function manualTriggerFinetune(rootDir: string): { ok: boolean; reason: string } {
    if (_running) return { ok: false, reason: 'Fine-tune job already running' };
    const state = loadState(rootDir);
    triggerFinetune(rootDir, state);
    return { ok: true, reason: 'Fine-tune job started' };
}
