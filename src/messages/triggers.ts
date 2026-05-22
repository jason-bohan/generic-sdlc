import type { MessageDeliveryStatus } from '../dashboard/types';

export interface TriggerMatch {
    trigger: string;
    targetPhase: string;
    description: string;
}

export interface ProcessedMessage {
    id: string;
    from: string;
    text: string;
    timestamp: string;
    status: MessageDeliveryStatus;
    triggerMatch?: TriggerMatch;
}

const TRIGGER_PATTERNS: { pattern: RegExp; trigger: string; targetPhase: string; description: string }[] = [
    {
        pattern: /\bpr\s+approved\b/i,
        trigger: 'pr-approved',
        targetPhase: 'running-cypress',
        description: 'PR was approved — advancing to Cypress tests',
    },
    {
        pattern: /\bchanges\s+requested\b/i,
        trigger: 'changes-requested',
        targetPhase: 'addressing-feedback',
        description: 'Changes requested on PR — returning to address feedback',
    },
    {
        pattern: /\bbuild\s+passed\b/i,
        trigger: 'build-passed',
        targetPhase: 'complete',
        description: 'Build passed — story can be completed',
    },
    {
        pattern: /\bbuild\s+failed\b/i,
        trigger: 'build-failed',
        targetPhase: 'validating',
        description: 'Build failed — returning to validation',
    },
    {
        pattern: /\bapproved\s+(?:your\s+)?pr\b/i,
        trigger: 'pr-approved',
        targetPhase: 'running-cypress',
        description: 'PR was approved — advancing to Cypress tests',
    },
    {
        pattern: /\breviewer\s+(?:approved|did\s+(?:his|her|their)\s+review|finished\s+review)\b/i,
        trigger: 'pr-approved',
        targetPhase: 'running-cypress',
        description: 'Reviewer completed review — advancing to Cypress tests',
    },
    {
        pattern: /\bbrehon\s+(?:approved|did\s+(?:his|her|their)\s+review|finished\s+review)\b/i,
        trigger: 'pr-approved',
        targetPhase: 'running-cypress',
        description: 'Legacy phrasing matched — advancing to Cypress tests',
    },
];

export function matchTrigger(messageText: string): TriggerMatch | null {
    for (const { pattern, trigger, targetPhase, description } of TRIGGER_PATTERNS) {
        if (pattern.test(messageText)) {
            return { trigger, targetPhase, description };
        }
    }
    return null;
}

export function isWorkflowTrigger(messageText: string): boolean {
    return matchTrigger(messageText) !== null;
}

export function processMessage(
    raw: { id?: string; from: string; message?: string; text?: string; timestamp?: string },
): ProcessedMessage {
    const text = raw.message ?? raw.text ?? '';
    return {
        id: raw.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: raw.from,
        text,
        timestamp: raw.timestamp ?? new Date().toISOString(),
        status: 'pending',
        triggerMatch: raw.from === 'user' ? matchTrigger(text) ?? undefined : undefined,
    };
}

export function getPendingMessages(
    messages: Array<{ status?: MessageDeliveryStatus; from?: string }>,
): typeof messages {
    return messages.filter(m => m.from === 'user' && (!m.status || m.status === 'pending'));
}
