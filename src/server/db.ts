/**
 * SQLite database module for SDLC Framework.
 * Single WAL-mode DB at .sdlc-framework/sdlc-framework.db
 *
 * Covers:
 *  - token_ledger     (replaces .token-ledger.json)
 *  - ollama_state     (replaces .sdlc-framework/ollama-state.json)
 *  - chat_messages    (replaces .<agentId>-messages.json)
 *
 * Agent status JSON files (.frontend-status.json, .reviewer-status.json, etc.) are intentionally kept
 * on disk — agent CLI processes (Goose/Cursor) read them directly.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { TokenSource } from './tokens';
import type { TokenPhase } from './ledger';
import type { SdlcAgentId, SdlcOutputKey, SdlcPhaseId } from '../shared/sdlcContracts';
import { emitChatMessage } from './status-events';

// ─── Canonical agent IDs ──────────────────────────────────────────────────────

const CANONICAL_AGENT_IDS = new Set(['frontend', 'backend', 'qa', 'ux', 'reviewer', 'devops', 'orchestrator']);

/** Map display names back to canonical IDs so stale callers don't pollute the DB. */
const DISPLAY_TO_CANONICAL: Record<string, string> = {
    lasair: 'frontend',
    brehon: 'reviewer',
    cairde: 'devops',
    prism: 'ux',
};

function canonicalAgentId(raw: string): string {
    const lower = raw.toLowerCase();
    if (CANONICAL_AGENT_IDS.has(lower)) return lower;
    return DISPLAY_TO_CANONICAL[lower] ?? lower;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LedgerRow {
    id: number;
    story_number: string;
    story_name: string | null;
    agent: string;
    source: string;
    phase: string;
    input_tokens: number;
    output_tokens: number;
    recorded_at: string;
}

export interface ChatRow {
    id: string;
    agent_id: string;
    session_id: string | null;
    timestamp: string;
    from_who: string;
    message: string;
    status: string;
}

export interface RunnerSessionRow {
    id: string;
    agent_id: string;
    story_number: string | null;
    phase: string;
    model: string;
    status: string;
    messages_json: string;
    started_at: string;
    ended_at: string | null;
    updated_at: string;
}

export interface TestRunRow {
    id: number;
    agent_id: string;
    spec_file: string;
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
    failures_json: string;
    recorded_at: string;
}

export interface TestRunFailure {
    test: string;
    error: string;
    spec: string;
}

export interface WorkflowItemRow {
    id: number;
    story_number: string;
    story_name: string | null;
    classification: string;
    active_agent_id: string;
    active_phase: string;
    affected_repo: string | null;
    project_key: string | null;
    external_mode: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface PhaseEventRow {
    id: number;
    workflow_item_id: number;
    agent_id: string;
    phase: string;
    event_type: string;
    outputs_json: string;
    message: string | null;
    created_at: string;
}

export interface WorkflowArtifactRow {
    id: number;
    workflow_item_id: number;
    artifact_type: string;
    artifact_key: string;
    payload_json: string;
    created_at: string;
    updated_at: string;
}

export interface AgentSessionRow {
    id: string;
    agent_id: string;
    workflow_item_id: number | null;
    story_number: string | null;
    story_name: string | null;
    phase: string | null;
    driver: string | null;
    model: string | null;
    status: string;
    pid: number | null;
    workspace_dir: string | null;
    log_file: string | null;
    prompt_file: string | null;
    started_at: string;
    updated_at: string;
    ended_at: string | null;
    metadata_json: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS token_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    story_number  TEXT    NOT NULL,
    story_name    TEXT,
    agent         TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    phase         TEXT    NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    recorded_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_story ON token_ledger(story_number);

CREATE TABLE IF NOT EXISTS ollama_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id        TEXT PRIMARY KEY,
    agent_id  TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    from_who  TEXT NOT NULL,
    message   TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_messages(agent_id, timestamp);

CREATE TABLE IF NOT EXISTS test_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT    NOT NULL,
    spec_file     TEXT    NOT NULL,
    passed        INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    skipped       INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    failures_json TEXT    NOT NULL DEFAULT '[]',
    recorded_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_test_runs_agent ON test_runs(agent_id, recorded_at);

CREATE TABLE IF NOT EXISTS workflow_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    story_number    TEXT    NOT NULL,
    story_name      TEXT,
    classification  TEXT    NOT NULL DEFAULT 'unknown',
    active_agent_id TEXT    NOT NULL,
    active_phase    TEXT    NOT NULL,
    affected_repo   TEXT,
    project_key     TEXT,
    external_mode   TEXT    NOT NULL DEFAULT 'live',
    status          TEXT    NOT NULL DEFAULT 'active',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(story_number, active_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_items_active ON workflow_items(status, active_agent_id, active_phase);

CREATE TABLE IF NOT EXISTS phase_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_item_id INTEGER NOT NULL,
    agent_id         TEXT    NOT NULL,
    phase            TEXT    NOT NULL,
    event_type       TEXT    NOT NULL,
    outputs_json     TEXT    NOT NULL DEFAULT '{}',
    message          TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_phase_events_workflow ON phase_events(workflow_item_id, created_at);

CREATE TABLE IF NOT EXISTS runner_sessions (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT    NOT NULL,
    story_number  TEXT,
    phase         TEXT    NOT NULL DEFAULT 'idle',
    model         TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    messages_json TEXT    NOT NULL DEFAULT '[]',
    started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at      TEXT,
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runner_sessions_agent ON runner_sessions(agent_id, status, started_at);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_item_id INTEGER NOT NULL,
    artifact_type    TEXT    NOT NULL,
    artifact_key     TEXT    NOT NULL,
    payload_json     TEXT    NOT NULL DEFAULT '{}',
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_item_id, artifact_type, artifact_key),
    FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_workflow ON workflow_artifacts(workflow_item_id, artifact_type);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id               TEXT PRIMARY KEY,
    agent_id         TEXT    NOT NULL,
    workflow_item_id INTEGER,
    story_number     TEXT,
    story_name       TEXT,
    phase            TEXT,
    driver           TEXT,
    model            TEXT,
    status           TEXT    NOT NULL DEFAULT 'running',
    pid              INTEGER,
    workspace_dir    TEXT,
    log_file         TEXT,
    prompt_file      TEXT,
    started_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at         TEXT,
    metadata_json    TEXT    NOT NULL DEFAULT '{}',
    FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_active ON agent_sessions(agent_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_workflow ON agent_sessions(workflow_item_id, updated_at);
`;

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function initDb(rootDir: string): Database.Database {
    const dir = resolve(rootDir, '.sdlc-framework');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _db = new Database(resolve(dir, 'sdlc-framework.db'));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.exec(SCHEMA);
    _migrateWorkflowCompoundUnique(_db);
    _migrateChatSessionId(_db);
    return _db;
}

/**
 * Migrate existing DBs from single-column UNIQUE(story_number) to
 * compound UNIQUE(story_number, active_agent_id) so multiple agents
 * can each have their own workflow row for the same story.
 */
function _migrateWorkflowCompoundUnique(db: Database.Database): void {
    const indexes = db.prepare("PRAGMA index_list('workflow_items')").all() as { name: string; unique: number }[];
    const autoIdx = indexes.find(i => i.name === 'sqlite_autoindex_workflow_items_1' && i.unique === 1);
    if (!autoIdx) return;
    const cols = db.prepare("PRAGMA index_info('sqlite_autoindex_workflow_items_1')").all() as { name: string }[];
    if (cols.length !== 1 || cols[0].name !== 'story_number') return;

    db.pragma('foreign_keys = OFF');
    db.exec(`
        CREATE TABLE workflow_items_mig (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            story_number    TEXT    NOT NULL,
            story_name      TEXT,
            classification  TEXT    NOT NULL DEFAULT 'unknown',
            active_agent_id TEXT    NOT NULL,
            active_phase    TEXT    NOT NULL,
            affected_repo   TEXT,
            project_key     TEXT,
            external_mode   TEXT    NOT NULL DEFAULT 'live',
            status          TEXT    NOT NULL DEFAULT 'active',
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(story_number, active_agent_id)
        );
        INSERT INTO workflow_items_mig SELECT * FROM workflow_items;
        DROP TABLE workflow_items;
        ALTER TABLE workflow_items_mig RENAME TO workflow_items;
        CREATE INDEX IF NOT EXISTS idx_workflow_items_active ON workflow_items(status, active_agent_id, active_phase);
    `);
    db.pragma('foreign_keys = ON');
}

/** Add session_id column to chat_messages on existing DBs that predate runner sessions. */
function _migrateChatSessionId(db: Database.Database): void {
    const cols = db.prepare("PRAGMA table_info('chat_messages')").all() as { name: string }[];
    if (!cols.some(c => c.name === 'session_id')) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN session_id TEXT");
    }
}

export function getDb(): Database.Database {
    if (!_db) throw new Error('[db] Call initDb(rootDir) before using the database');
    return _db;
}

export function closeDb(): void {
    _db?.close();
    _db = null;
}

// ─── Token ledger ─────────────────────────────────────────────────────────────

const INSERT_LEDGER = `
    INSERT INTO token_ledger (story_number, story_name, agent, source, phase, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`;

export function dbRecordTokens(params: {
    storyNumber: string;
    storyName?: string | null;
    agent: string;
    source: TokenSource;
    phase: TokenPhase;
    input: number;
    output: number;
}): void {
    getDb().prepare(INSERT_LEDGER).run(
        params.storyNumber,
        params.storyName ?? null,
        params.agent,
        params.source,
        params.phase,
        params.input,
        params.output,
    );
}

export function dbGetLedgerRows(storyNumber?: string): LedgerRow[] {
    if (storyNumber) {
        return getDb()
            .prepare('SELECT * FROM token_ledger WHERE story_number = ? ORDER BY recorded_at ASC')
            .all(storyNumber) as LedgerRow[];
    }
    return getDb()
        .prepare('SELECT * FROM token_ledger ORDER BY story_number, recorded_at ASC')
        .all() as LedgerRow[];
}

// ─── Ollama state ─────────────────────────────────────────────────────────────

export function dbGetOllamaState<T>(key: string, fallback: T): T {
    const row = getDb()
        .prepare('SELECT value FROM ollama_state WHERE key = ?')
        .get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function dbSetOllamaState(key: string, value: unknown): void {
    getDb()
        .prepare('INSERT OR REPLACE INTO ollama_state (key, value) VALUES (?, ?)')
        .run(key, JSON.stringify(value));
}

// ─── Chat messages ────────────────────────────────────────────────────────────

export function dbGetMessages(agentId: string): ChatRow[] {
    return getDb()
        .prepare('SELECT * FROM chat_messages WHERE agent_id = ? ORDER BY timestamp ASC')
        .all(canonicalAgentId(agentId)) as ChatRow[];
}

export function dbAddMessage(agentId: string, msg: {
    id: string;
    from: string;
    message: string;
    timestamp: string;
    status?: string;
    sessionId?: string | null;
}): void {
    const canonical = canonicalAgentId(agentId);
    getDb()
        .prepare('INSERT OR REPLACE INTO chat_messages (id, agent_id, session_id, timestamp, from_who, message, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(msg.id, canonical, msg.sessionId ?? null, msg.timestamp, msg.from, msg.message, msg.status ?? 'pending');
    emitChatMessage(canonical, { id: msg.id, from: msg.from, message: msg.message, timestamp: msg.timestamp, status: msg.status });
}

export function dbUpdateMessageStatus(id: string, status: string): void {
    getDb()
        .prepare('UPDATE chat_messages SET status = ? WHERE id = ?')
        .run(status, id);
}

export function dbMarkMessagesRead(agentId: string): number {
    const result = getDb()
        .prepare("UPDATE chat_messages SET status = 'read' WHERE agent_id = ? AND from_who = 'user' AND (status IS NULL OR status = 'pending')")
        .run(canonicalAgentId(agentId));
    return result.changes;
}

export function dbUpdateMessageSession(id: string, status: string, sessionId: string): void {
    getDb()
        .prepare('UPDATE chat_messages SET status = ?, session_id = ? WHERE id = ?')
        .run(status, sessionId, id);
}

// ─── Test runs ─────────────────────────────────────────────────────────────

export function dbAddTestRun(params: {
    agentId: string;
    specFile: string;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    failures: TestRunFailure[];
}): number {
    const result = getDb()
        .prepare('INSERT INTO test_runs (agent_id, spec_file, passed, failed, skipped, duration_ms, failures_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(params.agentId, params.specFile, params.passed, params.failed, params.skipped, params.durationMs, JSON.stringify(params.failures));
    return result.lastInsertRowid as number;
}

export function dbGetTestRuns(agentId?: string, limit = 20): TestRunRow[] {
    if (agentId) {
        return getDb()
            .prepare('SELECT * FROM test_runs WHERE agent_id = ? ORDER BY recorded_at DESC LIMIT ?')
            .all(agentId, limit) as TestRunRow[];
    }
    return getDb()
        .prepare('SELECT * FROM test_runs ORDER BY recorded_at DESC LIMIT ?')
        .all(limit) as TestRunRow[];
}

export function dbGetLatestTestRun(agentId: string): TestRunRow | undefined {
    return getDb()
        .prepare('SELECT * FROM test_runs WHERE agent_id = ? ORDER BY recorded_at DESC LIMIT 1')
        .get(agentId) as TestRunRow | undefined;
}

export function dbGetTestSummary(): { total_runs: number; total_passed: number; total_failed: number; last_run_at: string | null } {
    const latest = getDb()
        .prepare('SELECT recorded_at FROM test_runs ORDER BY recorded_at DESC LIMIT 1')
        .get() as { recorded_at: string } | undefined;
    if (!latest) return { total_runs: 0, total_passed: 0, total_failed: 0, last_run_at: null };
    const row = getDb()
        .prepare(`SELECT COUNT(*) as total_runs, COALESCE(SUM(passed),0) as total_passed, COALESCE(SUM(failed),0) as total_failed, MAX(recorded_at) as last_run_at FROM test_runs WHERE recorded_at >= datetime(?, '-60 seconds')`)
        .get(latest.recorded_at) as { total_runs: number; total_passed: number; total_failed: number; last_run_at: string | null };
    return row;
}

// ─── Workflow state ──────────────────────────────────────────────────────────

export function dbCreateWorkflowItem(params: {
    storyNumber: string;
    storyName?: string | null;
    classification: string;
    activeAgentId: SdlcAgentId | string;
    activePhase: SdlcPhaseId | string;
    affectedRepo?: string | null;
    projectKey?: string | null;
    externalMode?: 'live' | 'mock' | string;
}): WorkflowItemRow {
    getDb()
        .prepare(`
            INSERT INTO workflow_items (
                story_number, story_name, classification, active_agent_id, active_phase,
                affected_repo, project_key, external_mode, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(story_number, active_agent_id) DO UPDATE SET
                story_name = excluded.story_name,
                classification = excluded.classification,
                active_phase = excluded.active_phase,
                affected_repo = excluded.affected_repo,
                project_key = excluded.project_key,
                external_mode = excluded.external_mode,
                status = 'active',
                updated_at = datetime('now')
        `)
        .run(
            params.storyNumber,
            params.storyName ?? null,
            params.classification,
            params.activeAgentId,
            params.activePhase,
            params.affectedRepo ?? null,
            params.projectKey ?? null,
            params.externalMode ?? 'live',
        );

    const row = dbGetWorkflowItemByStory(params.storyNumber, params.activeAgentId as string);
    if (!row) throw new Error(`Workflow item ${params.storyNumber}/${params.activeAgentId} was not created`);
    return row;
}

export function dbGetWorkflowItemByStory(storyNumber: string, agentId?: string): WorkflowItemRow | undefined {
    if (agentId) {
        return getDb()
            .prepare('SELECT * FROM workflow_items WHERE story_number = ? AND active_agent_id = ?')
            .get(storyNumber, agentId) as WorkflowItemRow | undefined;
    }
    return getDb()
        .prepare('SELECT * FROM workflow_items WHERE story_number = ? ORDER BY updated_at DESC LIMIT 1')
        .get(storyNumber) as WorkflowItemRow | undefined;
}

export function dbGetWorkflowItemsByStory(storyNumber: string): WorkflowItemRow[] {
    return getDb()
        .prepare('SELECT * FROM workflow_items WHERE story_number = ? ORDER BY active_agent_id ASC')
        .all(storyNumber) as WorkflowItemRow[];
}

export function dbGetWorkflowItem(id: number): WorkflowItemRow | undefined {
    return getDb()
        .prepare('SELECT * FROM workflow_items WHERE id = ?')
        .get(id) as WorkflowItemRow | undefined;
}

export function dbListActiveWorkflowItems(): WorkflowItemRow[] {
    return getDb()
        .prepare("SELECT * FROM workflow_items WHERE status = 'active' ORDER BY updated_at DESC")
        .all() as WorkflowItemRow[];
}

export function dbRecordPhaseEvent(params: {
    workflowItemId: number;
    agentId: SdlcAgentId | string;
    phase: SdlcPhaseId | string;
    eventType: 'assigned' | 'phase-started' | 'phase-completed' | 'transitioned' | 'error' | string;
    outputs?: Partial<Record<SdlcOutputKey, unknown>>;
    message?: string | null;
}): number {
    const result = getDb()
        .prepare(`
            INSERT INTO phase_events (workflow_item_id, agent_id, phase, event_type, outputs_json, message)
            VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
            params.workflowItemId,
            params.agentId,
            params.phase,
            params.eventType,
            JSON.stringify(params.outputs ?? {}),
            params.message ?? null,
        );
    return result.lastInsertRowid as number;
}

export function dbTransitionWorkflowItem(params: {
    workflowItemId: number;
    agentId: SdlcAgentId | string;
    nextPhase: SdlcPhaseId | string;
    outputs?: Partial<Record<SdlcOutputKey, unknown>>;
    message?: string | null;
    status?: 'active' | 'complete' | 'error' | string;
}): WorkflowItemRow {
    const existing = dbGetWorkflowItem(params.workflowItemId);
    if (!existing) throw new Error(`Workflow item ${params.workflowItemId} not found`);

    try {
        getDb()
            .prepare(`
                UPDATE workflow_items
                SET active_agent_id = ?, active_phase = ?, status = ?, updated_at = datetime('now')
                WHERE id = ?
            `)
            .run(
                params.agentId,
                params.nextPhase,
                params.status ?? (params.nextPhase === 'complete' ? 'complete' : params.nextPhase === 'error' ? 'error' : 'active'),
                params.workflowItemId,
            );
    } catch (e: unknown) {
        // Duplicate rapid-fire transition — already in target state, treat as no-op
        if ((e as any)?.code === 'SQLITE_CONSTRAINT_UNIQUE') return existing;
        throw e;
    }

    dbRecordPhaseEvent({
        workflowItemId: params.workflowItemId,
        agentId: params.agentId,
        phase: params.nextPhase,
        eventType: 'transitioned',
        outputs: params.outputs,
        message: params.message,
    });

    const row = dbGetWorkflowItem(params.workflowItemId);
    if (!row) throw new Error(`Workflow item ${params.workflowItemId} disappeared after transition`);
    return row;
}

export function dbGetPhaseEvents(workflowItemId: number): PhaseEventRow[] {
    return getDb()
        .prepare('SELECT * FROM phase_events WHERE workflow_item_id = ? ORDER BY created_at ASC, id ASC')
        .all(workflowItemId) as PhaseEventRow[];
}

export function dbUpsertWorkflowArtifact(params: {
    workflowItemId: number;
    artifactType: 'task' | 'pr' | 'review' | 'build' | string;
    artifactKey: string;
    payload: unknown;
}): WorkflowArtifactRow {
    getDb()
        .prepare(`
            INSERT INTO workflow_artifacts (workflow_item_id, artifact_type, artifact_key, payload_json, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(workflow_item_id, artifact_type, artifact_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = datetime('now')
        `)
        .run(params.workflowItemId, params.artifactType, params.artifactKey, JSON.stringify(params.payload ?? {}));

    const row = getDb()
        .prepare(`
            SELECT * FROM workflow_artifacts
            WHERE workflow_item_id = ? AND artifact_type = ? AND artifact_key = ?
        `)
        .get(params.workflowItemId, params.artifactType, params.artifactKey) as WorkflowArtifactRow | undefined;
    if (!row) throw new Error(`Workflow artifact ${params.artifactType}/${params.artifactKey} was not created`);
    return row;
}

export function dbGetWorkflowArtifacts(workflowItemId: number): WorkflowArtifactRow[] {
    return getDb()
        .prepare('SELECT * FROM workflow_artifacts WHERE workflow_item_id = ? ORDER BY artifact_type ASC, created_at ASC, id ASC')
        .all(workflowItemId) as WorkflowArtifactRow[];
}

// ─── Runner sessions ──────────────────────────────────────────────────────────

export function dbCreateSession(params: {
    id: string;
    agentId: string;
    storyNumber?: string | null;
    phase: string;
    model: string;
}): RunnerSessionRow {
    getDb()
        .prepare(`
            INSERT INTO runner_sessions (id, agent_id, story_number, phase, model, status, messages_json, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', '[]', datetime('now'))
        `)
        .run(params.id, params.agentId, params.storyNumber ?? null, params.phase, params.model);
    return dbGetSession(params.id)!;
}

export function dbGetSession(id: string): RunnerSessionRow | undefined {
    return getDb()
        .prepare('SELECT * FROM runner_sessions WHERE id = ?')
        .get(id) as RunnerSessionRow | undefined;
}

export function dbGetActiveSession(agentId: string, storyNumber?: string | null): RunnerSessionRow | undefined {
    if (storyNumber) {
        return getDb()
            .prepare(`
                SELECT * FROM runner_sessions
                WHERE agent_id = ? AND story_number = ? AND status IN ('active', 'paused')
                ORDER BY started_at DESC LIMIT 1
            `)
            .get(agentId, storyNumber) as RunnerSessionRow | undefined;
    }
    return getDb()
        .prepare(`
            SELECT * FROM runner_sessions
            WHERE agent_id = ? AND status IN ('active', 'paused')
            ORDER BY started_at DESC LIMIT 1
        `)
        .get(agentId) as RunnerSessionRow | undefined;
}

export function dbUpdateSessionMessages(id: string, messagesJson: string, phase?: string): void {
    if (phase) {
        getDb()
            .prepare(`UPDATE runner_sessions SET messages_json = ?, phase = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(messagesJson, phase, id);
    } else {
        getDb()
            .prepare(`UPDATE runner_sessions SET messages_json = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(messagesJson, id);
    }
}

export function dbUpdateSessionPhase(id: string, phase: string): void {
    getDb()
        .prepare(`UPDATE runner_sessions SET phase = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(phase, id);
}

export function dbEndSession(id: string, status: 'complete' | 'error' | 'aborted'): void {
    getDb()
        .prepare(`UPDATE runner_sessions SET status = ?, ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(status, id);
}

export function dbPauseSession(id: string): void {
    getDb()
        .prepare(`UPDATE runner_sessions SET status = 'paused', updated_at = datetime('now') WHERE id = ?`)
        .run(id);
}

export function dbGetSessionMessages(sessionId: string): ChatRow[] {
    return getDb()
        .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC')
        .all(sessionId) as ChatRow[];
}

// ─── Agent sessions ─────────────────────────────────────────────────────────

export function dbCreateAgentSession(params: {
    id?: string;
    agentId: string;
    workflowItemId?: number | null;
    storyNumber?: string | null;
    storyName?: string | null;
    phase?: string | null;
    driver?: string | null;
    model?: string | null;
    status?: 'running' | 'completed' | 'failed' | 'stopped' | string;
    pid?: number | null;
    workspaceDir?: string | null;
    logFile?: string | null;
    promptFile?: string | null;
    metadata?: Record<string, unknown>;
}): AgentSessionRow {
    const id = params.id ?? `session_${randomUUID()}`;
    const db = getDb();

    db.prepare(`
        UPDATE agent_sessions
        SET status = 'stopped', ended_at = datetime('now'), updated_at = datetime('now')
        WHERE agent_id = ? AND status = 'running'
    `).run(params.agentId);

    db.prepare(`
            INSERT INTO agent_sessions (
                id, agent_id, workflow_item_id, story_number, story_name, phase,
                driver, model, status, pid, workspace_dir, log_file, prompt_file,
                metadata_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `)
        .run(
            id,
            params.agentId,
            params.workflowItemId ?? null,
            params.storyNumber ?? null,
            params.storyName ?? null,
            params.phase ?? null,
            params.driver ?? null,
            params.model ?? null,
            params.status ?? 'running',
            params.pid ?? null,
            params.workspaceDir ?? null,
            params.logFile ?? null,
            params.promptFile ?? null,
            JSON.stringify(params.metadata ?? {}),
        );

    const row = dbGetAgentSession(id);
    if (!row) throw new Error(`Agent session ${id} was not created`);
    return row;
}

export function dbGetAgentSession(id: string): AgentSessionRow | undefined {
    return getDb()
        .prepare('SELECT * FROM agent_sessions WHERE id = ?')
        .get(id) as AgentSessionRow | undefined;
}

export function dbGetActiveAgentSession(agentId: string): AgentSessionRow | undefined {
    return getDb()
        .prepare(`
            SELECT * FROM agent_sessions
            WHERE agent_id = ? AND status = 'running'
            ORDER BY updated_at DESC, started_at DESC
            LIMIT 1
        `)
        .get(agentId) as AgentSessionRow | undefined;
}

export function dbListAgentSessions(params?: {
    agentId?: string;
    status?: string;
    workflowItemId?: number;
    limit?: number;
}): AgentSessionRow[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (params?.agentId) {
        filters.push('agent_id = ?');
        values.push(params.agentId);
    }
    if (params?.status) {
        filters.push('status = ?');
        values.push(params.status);
    }
    if (params?.workflowItemId !== undefined) {
        filters.push('workflow_item_id = ?');
        values.push(params.workflowItemId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const limit = params?.limit ?? 25;
    return getDb()
        .prepare(`SELECT * FROM agent_sessions ${where} ORDER BY updated_at DESC, started_at DESC LIMIT ?`)
        .all(...values, limit) as AgentSessionRow[];
}

export function dbUpdateAgentSession(id: string, patch: {
    workflowItemId?: number | null;
    storyNumber?: string | null;
    storyName?: string | null;
    phase?: string | null;
    driver?: string | null;
    model?: string | null;
    status?: 'running' | 'completed' | 'failed' | 'stopped' | string;
    pid?: number | null;
    workspaceDir?: string | null;
    logFile?: string | null;
    promptFile?: string | null;
    endedAt?: string | null;
    metadata?: Record<string, unknown>;
}): AgentSessionRow | undefined {
    const current = dbGetAgentSession(id);
    if (!current) return undefined;

    getDb()
        .prepare(`
            UPDATE agent_sessions
            SET workflow_item_id = ?, story_number = ?, story_name = ?, phase = ?,
                driver = ?, model = ?, status = ?, pid = ?, workspace_dir = ?,
                log_file = ?, prompt_file = ?, ended_at = ?, metadata_json = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `)
        .run(
            patch.workflowItemId ?? current.workflow_item_id,
            patch.storyNumber ?? current.story_number,
            patch.storyName ?? current.story_name,
            patch.phase ?? current.phase,
            patch.driver ?? current.driver,
            patch.model ?? current.model,
            patch.status ?? current.status,
            patch.pid ?? current.pid,
            patch.workspaceDir ?? current.workspace_dir,
            patch.logFile ?? current.log_file,
            patch.promptFile ?? current.prompt_file,
            patch.endedAt ?? current.ended_at,
            patch.metadata ? JSON.stringify({ ..._parseSessionMetadata(current.metadata_json), ...patch.metadata }) : current.metadata_json,
            id,
        );

    return dbGetAgentSession(id);
}

function _parseSessionMetadata(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}
