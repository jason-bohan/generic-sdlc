import { EventEmitter } from 'events';
import { watchFile, unwatchFile, existsSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';
import { getDefaultStatus } from './status-normalize';
import { getActiveAgents } from './spawn-agent';
import { buildStatusBroadcast } from './status-broadcast';

export interface StatusChangeEvent {
    agentId: string;
    status: Record<string, unknown>;
    timestamp: string;
}

export interface ChatMessageEvent {
    agentId: string;
    message: {
        id: string;
        from: string;
        message: string;
        timestamp: string;
        status?: string;
    };
}

const bus = new EventEmitter();
bus.setMaxListeners(200);

export function emitStatusChange(agentId: string, status: Record<string, unknown>): void {
    const event: StatusChangeEvent = { agentId, status, timestamp: new Date().toISOString() };
    bus.emit('status', event);
    bus.emit(`status:${agentId}`, event);
}

export function onStatusChange(handler: (ev: StatusChangeEvent) => void): () => void {
    bus.on('status', handler);
    return () => bus.off('status', handler);
}

export function onAgentStatusChange(agentId: string, handler: (ev: StatusChangeEvent) => void): () => void {
    const event = `status:${agentId}`;
    bus.on(event, handler);
    return () => bus.off(event, handler);
}

export function emitChatMessage(agentId: string, message: ChatMessageEvent['message']): void {
    const event: ChatMessageEvent = { agentId, message };
    bus.emit('chat', event);
    bus.emit(`chat:${agentId}`, event);
}

export function onChatMessage(agentId: string, handler: (ev: ChatMessageEvent) => void): () => void {
    const event = `chat:${agentId}`;
    bus.on(event, handler);
    return () => bus.off(event, handler);
}

// ── File watcher (subprocess agents write status files directly) ──────────────

const AGENT_IDS = ['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops'];
const DEBOUNCE_MS = 150;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let watchedDir: string | null = null;

export function startStatusFileWatcher(sdlc-frameworkDir: string): void {
    if (watchedDir === sdlc-frameworkDir) return;
    if (watchedDir) stopStatusFileWatcher();
    watchedDir = sdlc-frameworkDir;

    for (const agentId of AGENT_IDS) {
        const file = resolve(sdlc-frameworkDir, `.${agentId}-status.json`);
        watchFile(file, { interval: 800, persistent: false }, () => {
            const existing = debounceTimers.get(agentId);
            if (existing) clearTimeout(existing);
            debounceTimers.set(agentId, setTimeout(() => {
                debounceTimers.delete(agentId);
                _emitFromFile(agentId, file, sdlc-frameworkDir);
            }, DEBOUNCE_MS));
        });
    }
}

export function stopStatusFileWatcher(): void {
    if (!watchedDir) return;
    for (const agentId of AGENT_IDS) {
        const file = resolve(watchedDir, `.${agentId}-status.json`);
        unwatchFile(file);
    }
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    watchedDir = null;
}

function _emitFromFile(agentId: string, file: string, sdlc-frameworkDir: string): void {
    try {
        const raw = existsSync(file)
            ? parseJsonUtf8File(file) as Record<string, unknown>
            : getDefaultStatus(agentId) as Record<string, unknown>;
        const active = getActiveAgents();
        const isRunning = agentId in active;
        emitStatusChange(agentId, buildStatusBroadcast(raw, agentId, isRunning, sdlc-frameworkDir));
    } catch { /* status file temporarily incomplete during write */ }
}
