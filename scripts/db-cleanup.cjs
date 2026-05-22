/**
 * Database cleanup / migration script.
 * Removes duplicate PRs, stale workflow items, orphaned sessions,
 * and resets mock state. Creates a backup before any changes.
 *
 * Usage: node scripts/db-cleanup.cjs [--dry-run]
 */

const Database = require('better-sqlite3');
const { copyFileSync, existsSync, writeFileSync, readFileSync } = require('fs');
const { resolve } = require('path');

const ROOT = resolve(__dirname, '..');
const DB_PATH = resolve(ROOT, '.SDLC Framework', 'SDLC Framework.db');
const MOCK_STATE = resolve(ROOT, '.SDLC Framework', 'mock', 'state.json');
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(DB_PATH)) {
    console.log('No database found at', DB_PATH);
    process.exit(0);
}

// ── Backup ──────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupPath = DB_PATH.replace('.db', `-backup-${ts}.db`);
copyFileSync(DB_PATH, backupPath);
console.log(`Backup created: ${backupPath}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function counts() {
    const tables = ['workflow_items', 'phase_events', 'workflow_artifacts', 'agent_sessions', 'chat_messages', 'token_ledger', 'test_runs'];
    const out = {};
    for (const t of tables) {
        out[t] = db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get().cnt;
    }
    return out;
}

console.log('\n=== BEFORE ===');
const before = counts();
console.table(before);

// ── 1. Fix stale "running" agent sessions ───────────────────────────────────
const staleRunning = db.prepare(`
    SELECT id, agent_id, story_number, phase, started_at
    FROM agent_sessions
    WHERE status = 'running'
      AND updated_at < datetime('now', '-2 hours')
`).all();

if (staleRunning.length > 0) {
    console.log(`\n1. Closing ${staleRunning.length} stale "running" session(s):`);
    staleRunning.forEach(s => console.log(`   ${s.agent_id} / ${s.story_number} / ${s.phase} (started ${s.started_at})`));
    if (!dryRun) {
        db.prepare(`
            UPDATE agent_sessions
            SET status = 'stopped', ended_at = datetime('now'), updated_at = datetime('now')
            WHERE status = 'running' AND updated_at < datetime('now', '-2 hours')
        `).run();
    }
} else {
    console.log('\n1. No stale running sessions.');
}

// ── 2. Remove old workflow items (and cascade phase_events + artifacts) ─────
const oldWorkflows = db.prepare(`
    SELECT id, story_number, active_agent_id, active_phase, status, created_at
    FROM workflow_items
    WHERE status IN ('complete', 'error')
       OR updated_at < datetime('now', '-3 days')
`).all();

if (oldWorkflows.length > 0) {
    console.log(`\n2. Removing ${oldWorkflows.length} old/completed workflow item(s):`);
    oldWorkflows.forEach(w => console.log(`   [${w.status}] ${w.story_number} / ${w.active_agent_id} / ${w.active_phase} (created ${w.created_at})`));
    if (!dryRun) {
        const ids = oldWorkflows.map(w => w.id);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM phase_events WHERE workflow_item_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM workflow_artifacts WHERE workflow_item_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM workflow_items WHERE id IN (${placeholders})`).run(...ids);
    }
} else {
    console.log('\n2. No old workflow items to remove.');
}

// ── 3. Remove ended agent sessions older than 24h ───────────────────────────
const oldSessions = db.prepare(`
    SELECT COUNT(*) as cnt FROM agent_sessions
    WHERE status IN ('completed', 'failed', 'stopped')
      AND updated_at < datetime('now', '-24 hours')
`).get();

if (oldSessions.cnt > 0) {
    console.log(`\n3. Removing ${oldSessions.cnt} ended agent session(s) older than 24h.`);
    if (!dryRun) {
        db.prepare(`
            DELETE FROM agent_sessions
            WHERE status IN ('completed', 'failed', 'stopped')
              AND updated_at < datetime('now', '-24 hours')
        `).run();
    }
} else {
    console.log('\n3. No old ended sessions to remove.');
}

// ── 4. Clear stale chat messages ────────────────────────────────────────────
const staleChatAgents = db.prepare(`
    SELECT agent_id, COUNT(*) as cnt
    FROM chat_messages
    GROUP BY agent_id
`).all();

const validAgentIds = new Set(['frontend', 'backend', 'reviewer', 'devops', 'qa', 'ux']);
const staleChats = staleChatAgents.filter(r => !validAgentIds.has(r.agent_id));

if (staleChats.length > 0) {
    console.log(`\n4. Removing chat messages for non-standard agent IDs:`);
    staleChats.forEach(r => console.log(`   ${r.agent_id}: ${r.cnt} message(s)`));
    if (!dryRun) {
        for (const r of staleChats) {
            db.prepare('DELETE FROM chat_messages WHERE agent_id = ?').run(r.agent_id);
        }
    }
} else {
    console.log('\n4. No stale chat agent IDs found.');
}

// ── 5. Mark all pending chat messages as read (clean badge counts) ──────────
const pendingCount = db.prepare(`SELECT COUNT(*) as cnt FROM chat_messages WHERE status = 'pending'`).get().cnt;
if (pendingCount > 0) {
    console.log(`\n5. Marking ${pendingCount} pending chat message(s) as read.`);
    if (!dryRun) {
        db.prepare(`UPDATE chat_messages SET status = 'read' WHERE status = 'pending'`).run();
    }
} else {
    console.log('\n5. No pending chat messages.');
}

// ── 6. Reset mock external state ────────────────────────────────────────────
if (existsSync(MOCK_STATE)) {
    console.log('\n6. Resetting mock external state (PRs, builds, notifications).');
    if (!dryRun) {
        writeFileSync(MOCK_STATE, JSON.stringify({ prs: [], builds: [], notifications: [] }, null, 2));
    }
} else {
    console.log('\n6. No mock state file found.');
}

// ── 7. Reset agent status files ─────────────────────────────────────────────
const statusFiles = ['.frontend-status.json', '.backend-status.json', '.reviewer-status.json', '.devops-status.json', '.qa-status.json', '.ux-status.json'];
let resetCount = 0;
for (const f of statusFiles) {
    const fp = resolve(ROOT, f);
    if (existsSync(fp)) {
        try {
            const data = JSON.parse(readFileSync(fp, 'utf-8').replace(/^\uFEFF/, ''));
            if (data.currentPhase && data.currentPhase !== 'idle') {
                resetCount++;
                const agentName = f.replace(/^\./,'').replace('-status.json','');
                console.log(`   Resetting ${f} from "${data.currentPhase}" to idle`);
                if (!dryRun) {
                    writeFileSync(fp, JSON.stringify({
                        currentPhase: 'idle',
                        assignedPR: null,
                        tasks: [],
                        events: [{ timestamp: new Date().toISOString(), type: 'info', message: `${agentName.charAt(0).toUpperCase() + agentName.slice(1)} reset to idle by cleanup script.` }],
                    }, null, 2));
                }
            }
        } catch { /* skip malformed */ }
    }
}
if (resetCount > 0) {
    console.log(`\n7. Reset ${resetCount} agent status file(s) to idle.`);
} else {
    console.log('\n7. All agent status files already idle (or not present).');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (dryRun) {
    console.log('\n[DRY RUN] No changes were made. Run without --dry-run to apply.');
} else {
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('\n=== AFTER ===');
    console.table(counts());
}

db.close();
console.log('\nDone.');
