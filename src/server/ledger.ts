import type { TokenSource } from './tokens';
import { dbRecordTokens, dbGetLedgerRows } from './db';

export type TokenPhase = 'creation' | 'development' | 'review';

export interface LedgerEntry {
    ts: string;
    agent: string;
    project: string | null;
    team: string | null;
    source: TokenSource;
    phase: TokenPhase;
    input: number;
    output: number;
}

export interface StoryTokenRecord {
    storyName: string | null;
    entries: LedgerEntry[];
    totals: { input: number; output: number };
}

export type TokenLedger = Record<string, StoryTokenRecord>;

export interface RecordParams {
    storyNumber: string;
    storyName?: string | null;
    project?: string | null;
    team?: string | null;
    agent: string;
    source: TokenSource;
    phase: TokenPhase;
    input: number;
    output: number;
}

function rowsToLedger(rows: ReturnType<typeof dbGetLedgerRows>): TokenLedger {
    const ledger: TokenLedger = {};
    for (const row of rows) {
        if (!ledger[row.story_number]) {
            ledger[row.story_number] = { storyName: row.story_name ?? null, entries: [], totals: { input: 0, output: 0 } };
        }
        const rec = ledger[row.story_number];
        if (row.story_name && !rec.storyName) rec.storyName = row.story_name;
        rec.entries.push({
            ts: row.recorded_at,
            agent: row.agent,
            project: row.project ?? null,
            team: row.team ?? null,
            source: row.source as TokenSource,
            phase: row.phase as TokenPhase,
            input: row.input_tokens,
            output: row.output_tokens,
        });
        rec.totals.input += row.input_tokens;
        rec.totals.output += row.output_tokens;
    }
    return ledger;
}

// rootDir kept in signature for backward compatibility with existing callers
export function getLedger(_rootDir: string): TokenLedger {
    try {
        return rowsToLedger(dbGetLedgerRows());
    } catch { return {}; }
}

export function getStoryTokens(_rootDir: string, storyNumber: string): StoryTokenRecord | null {
    try {
        const rows = dbGetLedgerRows(storyNumber);
        if (rows.length === 0) return null;
        return rowsToLedger(rows)[storyNumber] ?? null;
    } catch { return null; }
}

// Bucket for usage recorded outside a story (self-directed / story-less agent work).
// Without this, token spend with no `storyNumber` was silently dropped from the ledger,
// blinding the AIQA scorecard and the executive cost views to real spend.
export const UNASSIGNED_STORY = '(unassigned)';

export function recordStoryTokens(
    _rootDir: string,
    params: RecordParams,
): { ok: boolean; error?: string } {
    if (!params.agent || !params.source) {
        return { ok: false, error: 'agent and source are required' };
    }
    if (params.input === 0 && params.output === 0) return { ok: true };
    const storyNumber = params.storyNumber || UNASSIGNED_STORY;
    try {
        dbRecordTokens({ ...params, storyNumber });
        return { ok: true };
    } catch (e: unknown) {
        return { ok: false, error: `Failed to record tokens: ${e instanceof Error ? e.message : String(e)}` };
    }
}
