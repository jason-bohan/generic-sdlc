/** Pull request rows for the reviewer agent dashboard work card (last N, Active vs Complete). */

export const REVIEWER_WORK_CARD_MAX_PRS = 5;

/** Phases where the assigned PR is still Brehon's live desk item (includes post–changes-requested monitoring). */
const REVIEWER_DESK_ACTIVE_PHASES = new Set([
    'pending-review',
    'reviewing',
    'commenting',
    'changes-requested',
    'waiting-for-fixes',
    'approved',
]);

export type WorkCardPrStatus = 'draft' | 'active' | 'completed' | 'abandoned';

export function extractRecentPrIdsFromReviewerEvents(events: unknown, maxIds: number): number[] {
    if (!Array.isArray(events) || maxIds <= 0) return [];
    const out: number[] = [];
    const seen = new Set<number>();
    for (let i = events.length - 1; i >= 0 && out.length < maxIds; i--) {
        const msg = String((events[i] as { message?: string })?.message ?? '');
        const re = /PR\s*#?\s*(\d+)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(msg)) !== null) {
            const id = Number(m[1]);
            if (!Number.isFinite(id) || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
            if (out.length >= maxIds) return out;
        }
    }
    return out;
}

export function normalizeReviewerWorkCardPrs(raw: Record<string, unknown>): Array<{
    id: number;
    title: string;
    status: WorkCardPrStatus;
    comments: number;
    approvals: number;
    url?: string;
}> {
    const phase = String(raw.currentPhase ?? 'idle');
    const assigned = raw.assignedPR as { id?: number; title?: string; url?: string } | undefined | null;
    const assignedId = assigned?.id != null && Number.isFinite(Number(assigned.id)) ? Number(assigned.id) : null;

    const rawList = Array.isArray(raw.prs) ? raw.prs as Record<string, unknown>[] : [];
    const picked: Record<string, unknown>[] = [];
    const seenIds = new Set<number>();
    for (let i = rawList.length - 1; i >= 0 && picked.length < REVIEWER_WORK_CARD_MAX_PRS; i--) {
        const row = rawList[i];
        const id = Number(row?.id);
        if (!Number.isFinite(id) || seenIds.has(id)) continue;
        seenIds.add(id);
        picked.push(row);
    }

    const toCardStatus = (s: unknown): WorkCardPrStatus => {
        const t = String(s ?? '').toLowerCase().trim();
        if (t === 'completed' || t === 'complete' || t === 'done') return 'completed';
        if (t === 'abandoned') return 'abandoned';
        if (t === 'draft') return 'draft';
        return 'active';
    };

    const rows = picked.map((p) => {
        const id = Number(p.id);
        const title = typeof p.title === 'string' && p.title.trim() ? p.title : `PR #${id}`;
        const url = typeof p.url === 'string' ? p.url : undefined;
        const comments = typeof p.comments === 'number' && Number.isFinite(p.comments) ? p.comments : 0;
        const approvals = typeof p.approvals === 'number' && Number.isFinite(p.approvals) ? p.approvals : 0;
        return {
            id,
            title,
            status: toCardStatus(p.status),
            comments,
            approvals,
            ...(url ? { url } : {}),
        };
    });

    const present = new Set(rows.map((r) => r.id));
    for (const id of extractRecentPrIdsFromReviewerEvents(raw.events, REVIEWER_WORK_CARD_MAX_PRS * 3)) {
        if (rows.length >= REVIEWER_WORK_CARD_MAX_PRS) break;
        if (present.has(id)) continue;
        present.add(id);
        rows.push({
            id,
            title: `PR #${id}`,
            status: 'completed' as WorkCardPrStatus,
            comments: 0,
            approvals: 0,
        });
    }

    if (assignedId != null && !rows.some((r) => r.id === assignedId)) {
        const title = typeof assigned?.title === 'string' && assigned.title.trim() ? assigned.title : `PR #${assignedId}`;
        const url = typeof assigned?.url === 'string' ? assigned.url : undefined;
        rows.unshift({
            id: assignedId,
            title,
            status: 'active',
            comments: 0,
            approvals: 0,
            ...(url ? { url } : {}),
        });
        while (rows.length > REVIEWER_WORK_CARD_MAX_PRS) rows.pop();
    }

    const onActiveDesk = assignedId != null && REVIEWER_DESK_ACTIVE_PHASES.has(phase);

    return rows.map((r) => {
        let { status, title, url } = r;
        if (assignedId != null && r.id === assignedId) {
            title = typeof assigned?.title === 'string' && assigned.title.trim() ? assigned.title : title;
            if (typeof assigned?.url === 'string' && assigned.url) url = assigned.url;
            status = onActiveDesk ? 'active' : 'completed';
            return { id: r.id, title, status, comments: r.comments, approvals: r.approvals, ...(url ? { url } : {}) };
        }
        if (status === 'active') {
            status = 'completed';
        }
        return { id: r.id, title, status, comments: r.comments, approvals: r.approvals, ...(r.url ? { url: r.url } : {}) };
    });
}
