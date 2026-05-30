import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { initDb, getDb, closeDb } from '../server/db';

const TMP = resolve(__dirname, '.dbmig-tmp');

afterEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
});

/**
 * Regression for the migration-ordering crash: indexes on the project/team columns
 * used to live in the always-run SCHEMA block, which executes before the ALTER TABLE
 * migration adds those columns — so an *upgraded* DB (table already exists without
 * them) threw "no such column: project" on boot. Fresh-DB tests never caught it.
 */
describe('token_ledger migration on a pre-existing (old-schema) DB', () => {
    function plantOldSchemaDb() {
        const dir = resolve(TMP, '.sdlc-framework');
        mkdirSync(dir, { recursive: true });
        const db = new Database(resolve(dir, 'sdlc-framework.db'));
        // Old token_ledger: no `project` / `team` columns.
        db.exec(`CREATE TABLE token_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT, story_number TEXT NOT NULL, story_name TEXT,
            agent TEXT NOT NULL, source TEXT NOT NULL, phase TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`);
        db.prepare('INSERT INTO token_ledger (story_number, agent, source, phase, input_tokens, output_tokens) VALUES (?,?,?,?,?,?)')
            .run('S-OLD', 'backend', 'cloud', 'development', 1000, 500);
        db.close();
    }

    it('initDb upgrades the old schema without crashing, adding project/team + indexes', () => {
        plantOldSchemaDb();

        expect(() => initDb(TMP)).not.toThrow();

        const cols = (getDb().prepare("PRAGMA table_info('token_ledger')").all() as { name: string }[]).map(c => c.name);
        expect(cols).toContain('project');
        expect(cols).toContain('team');

        const indexes = (getDb().prepare("PRAGMA index_list('token_ledger')").all() as { name: string }[]).map(i => i.name);
        expect(indexes).toContain('idx_ledger_project');
        expect(indexes).toContain('idx_ledger_team');

        // The legacy row survives and reads back as unattributed.
        const legacy = getDb().prepare('SELECT project, team FROM token_ledger WHERE story_number = ?').get('S-OLD') as { project: string | null; team: string | null };
        expect(legacy).toEqual({ project: null, team: null });
    });

    it('is idempotent — a second initDb on the now-upgraded DB is a no-op', () => {
        plantOldSchemaDb();
        initDb(TMP);
        closeDb();
        expect(() => initDb(TMP)).not.toThrow();
    });
});
