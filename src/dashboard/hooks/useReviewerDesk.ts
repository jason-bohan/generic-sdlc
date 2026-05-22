import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentProfile, Phase } from '../types';
import { AGENT_ROSTER } from '../types';
import type { ReviewerFeedbackThread, ReviewerPrCandidate } from '../components/ReviewerDeskPanel';

export interface UseReviewerDeskParams {
    agent: AgentProfile;
    agentDisplayNameOverrides?: Record<string, string>;
    currentPhase: Phase;
    onReviewerDeskChanged?: () => void;
}

export function useReviewerDesk({ agent, agentDisplayNameOverrides, currentPhase, onReviewerDeskChanged }: UseReviewerDeskParams) {
    const [reviewerDeskPrs, setReviewerDeskPrs] = useState<ReviewerPrCandidate[]>([]);
    const [reviewerAvailablePrs, setReviewerAvailablePrs] = useState<ReviewerPrCandidate[]>([]);
    const [reviewerBranchFilter, setReviewerBranchFilter] = useState('');
    const [reviewerQuery, setReviewerQuery] = useState('');
    const [reviewerPrLoading, setReviewerPrLoading] = useState(false);
    const [reviewerPrError, setReviewerPrError] = useState<string | null>(null);
    const [pickingReviewerPrId, setPickingReviewerPrId] = useState<number | null>(null);
    const [reviewerPrBanner, setReviewerPrBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
    const [reviewerAutoPick, setReviewerAutoPick] = useState(false);
    const [reviewerAutoPickBlocked, setReviewerAutoPickBlocked] = useState(false);
    const reviewerAutoPickArmedRef = useRef(true);
    const [reviewerFeedbackOpen, setReviewerFeedbackOpen] = useState<{ prId: number; title: string } | null>(null);
    const [reviewerFeedbackThreads, setReviewerFeedbackThreads] = useState<ReviewerFeedbackThread[]>([]);
    const [reviewerFeedbackLoading, setReviewerFeedbackLoading] = useState(false);

    useEffect(() => {
        if (agent.role !== 'reviewer') return;
        fetch(`${window.location.origin}/api/reviewer/auto-pick-config`)
            .then(r => r.json())
            .then((d: { autoPickPullRequests?: boolean; blockedByStepMode?: boolean }) => {
                setReviewerAutoPick(!!d.autoPickPullRequests);
                setReviewerAutoPickBlocked(!!d.blockedByStepMode);
            })
            .catch(() => {
                setReviewerAutoPick(false);
                setReviewerAutoPickBlocked(false);
            });
    }, [agent.role]);

    const loadReviewerPrs = useCallback(async () => {
        if (agent.role !== 'reviewer') return;
        setReviewerPrLoading(true);
        setReviewerPrError(null);
        try {
            const origin = window.location.origin;
            const params = new URLSearchParams();
            if (reviewerBranchFilter.trim()) params.set('branchPrefix', reviewerBranchFilter.trim());
            if (reviewerQuery.trim()) params.set('q', reviewerQuery.trim());
            const query = params.toString();
            const [resAll, resFiltered] = await Promise.all([
                fetch(`${origin}/api/reviewer/prs`),
                fetch(`${origin}/api/reviewer/prs${query ? `?${query}` : ''}`),
            ]);
            const bodyAll = await resAll.json().catch(() => ({})) as { prs?: ReviewerPrCandidate[]; error?: string };
            const bodyFiltered = await resFiltered.json().catch(() => ({})) as { prs?: ReviewerPrCandidate[]; error?: string };
            if (!resAll.ok) throw new Error(bodyAll.error || `HTTP ${resAll.status}`);
            if (!resFiltered.ok) throw new Error(bodyFiltered.error || `HTTP ${resFiltered.status}`);
            const rawAll = Array.isArray(bodyAll.prs) ? bodyAll.prs : [];
            const rawFiltered = Array.isArray(bodyFiltered.prs) ? bodyFiltered.prs : [];
            const isOnDesk = (p: ReviewerPrCandidate) => (p.deskUi?.kind ?? 'none') !== 'none';
            setReviewerDeskPrs(rawAll.filter(isOnDesk));
            setReviewerAvailablePrs(rawFiltered.filter((p) => !isOnDesk(p)));
        } catch (e) {
            setReviewerPrError(e instanceof Error ? e.message : String(e));
            setReviewerDeskPrs([]);
            setReviewerAvailablePrs([]);
        } finally {
            setReviewerPrLoading(false);
        }
    }, [agent.role, reviewerBranchFilter, reviewerQuery]);

    useEffect(() => {
        if (agent.role === 'reviewer') void loadReviewerPrs();
    }, [agent.role, loadReviewerPrs]);

    useEffect(() => {
        if (currentPhase !== 'idle') {
            reviewerAutoPickArmedRef.current = true;
        }
    }, [currentPhase]);

    const pickReviewerPr = useCallback(async (pr: ReviewerPrCandidate): Promise<boolean> => {
        setPickingReviewerPrId(pr.id);
        setReviewerPrBanner(null);
        const reviewerLabel =
            agentDisplayNameOverrides?.reviewer?.trim()
            || AGENT_ROSTER.find((a) => a.id === 'reviewer')?.name
            || 'reviewer';
        try {
            const res = await fetch(`${window.location.origin}/api/reviewer/pick-pr`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prId: pr.id, projectKey: pr.projectKey }),
            });
            const body = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setReviewerPrBanner({ tone: 'success', text: `PR #${pr.id} is on ${reviewerLabel}'s desk.` });
            void loadReviewerPrs();
            return true;
        } catch (e) {
            setReviewerPrBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
            return false;
        } finally {
            setPickingReviewerPrId(null);
        }
    }, [agentDisplayNameOverrides, loadReviewerPrs]);

    const openReviewerFeedback = useCallback((pr: ReviewerPrCandidate) => {
        setReviewerFeedbackOpen({ prId: pr.id, title: pr.title });
        setReviewerFeedbackLoading(true);
        setReviewerFeedbackThreads([]);
        void fetch(`${window.location.origin}/api/reviewer/pr-comments?prId=${pr.id}`)
            .then((r) => r.json())
            .then((body: { threads?: ReviewerFeedbackThread[] }) => {
                setReviewerFeedbackThreads(Array.isArray(body.threads) ? body.threads : []);
            })
            .catch(() => setReviewerFeedbackThreads([]))
            .finally(() => setReviewerFeedbackLoading(false));
    }, []);

    const dismissReviewerDeskRow = useCallback(async (prId: number) => {
        try {
            const res = await fetch(`${window.location.origin}/api/reviewer/dismiss-pr`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prId }),
            });
            const body = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            await loadReviewerPrs();
            onReviewerDeskChanged?.();
        } catch (e) {
            setReviewerPrBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
        }
    }, [loadReviewerPrs, onReviewerDeskChanged]);

    const removeActivePrFromReviewerDesk = useCallback(async (prId: number) => {
        try {
            const res = await fetch(`${window.location.origin}/api/reviewer/clear-desk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prId }),
            });
            const body = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            setReviewerPrBanner({ tone: 'success', text: `PR #${prId} removed from desk.` });
            await loadReviewerPrs();
            onReviewerDeskChanged?.();
        } catch (e) {
            setReviewerPrBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
        }
    }, [loadReviewerPrs, onReviewerDeskChanged]);

    useEffect(() => {
        if (agent.role !== 'reviewer' || !reviewerAutoPick || reviewerPrLoading || reviewerAvailablePrs.length === 0) return;
        if (currentPhase !== 'idle' || !reviewerAutoPickArmedRef.current) return;
        const firstPickup = reviewerAvailablePrs.find((p) => p.reviewerPickupEligible !== false);
        if (!firstPickup) return;
        reviewerAutoPickArmedRef.current = false;
        void (async () => {
            const ok = await pickReviewerPr(firstPickup);
            if (!ok) {
                reviewerAutoPickArmedRef.current = true;
                return;
            }
            onReviewerDeskChanged?.();
        })();
    }, [agent.role, reviewerAutoPick, reviewerPrLoading, reviewerAvailablePrs, currentPhase, pickReviewerPr, onReviewerDeskChanged]);

    return {
        reviewerDeskPrs,
        reviewerAvailablePrs,
        reviewerBranchFilter,
        setReviewerBranchFilter,
        reviewerQuery,
        setReviewerQuery,
        reviewerPrLoading,
        reviewerPrError,
        pickingReviewerPrId,
        reviewerPrBanner,
        reviewerAutoPick,
        reviewerAutoPickBlocked,
        loadReviewerPrs,
        pickReviewerPr,
        openReviewerFeedback,
        dismissReviewerDeskRow,
        removeActivePrFromReviewerDesk,
        reviewerFeedbackOpen,
        setReviewerFeedbackOpen,
        reviewerFeedbackThreads,
        reviewerFeedbackLoading,
    };
}
