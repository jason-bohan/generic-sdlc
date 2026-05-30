import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { initDb, closeDb, dbGetLedgerRows } from '../server/db';
import { updateTokens } from '../server/tokens';
import { UNASSIGNED_STORY } from '../server/ledger';

const TMP = resolve(__dirname, '.token-ledger-storyless-tmp');
const AGENT = 'aiqa';

function writeStatus(data: object) {
    writeFileSync(resolve(TMP, `.${AGENT}-status.json`), JSON.stringify(data, null, 2));
}

beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    initDb(TMP);
});

afterEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
});

/**
 * Regression: token spend by an agent with no `storyNumber` (self-directed work,
 * including AIQA's own loop) used to be dropped from the DB ledger, so the AIQA
 * scorecard and the executive cost views saw zero. Story-less usage must now be
 * bucketed under UNASSIGNED_STORY instead of vanishing.
 */
describe('token ledger records story-less usage', () => {
    it('writes a ledger row under UNASSIGNED_STORY when the agent has no storyNumber', () => {
        writeStatus({ tokens: {} }); // no storyNumber → self-directed work
        const r = updateTokens(TMP, { agentId: AGENT, source: 'cloud', input: 1234, output: 567 });
        expect(r.ok).toBe(true);

        const rows = dbGetLedgerRows().filter((row) => row.agent === AGENT);
        expect(rows.length).toBe(1);
        expect(rows[0].story_number).toBe(UNASSIGNED_STORY);
        expect(rows[0].input_tokens).toBe(1234);
        expect(rows[0].output_tokens).toBe(567);
    });

    it('still attributes usage to the real story when one is set', () => {
        writeStatus({ storyNumber: 'B-42', tokens: {} });
        updateTokens(TMP, { agentId: AGENT, source: 'cloud', input: 10, output: 5 });

        const rows = dbGetLedgerRows().filter((row) => row.agent === AGENT);
        expect(rows.length).toBe(1);
        expect(rows[0].story_number).toBe('B-42');
    });

    it('does not write a row for a zero-token update', () => {
        writeStatus({ tokens: {} });
        updateTokens(TMP, { agentId: AGENT, source: 'cloud', input: 0, output: 0 });
        expect(dbGetLedgerRows().filter((row) => row.agent === AGENT).length).toBe(0);
    });
});
