import type { AgentProfile } from '../types';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface AgentDetailDevopsWrapUpBannerProps {
    agent: AgentProfile;
    shownName: string;
    continuing: boolean;
    handleContinue: () => Promise<unknown>;
    setCheckpointBanner: (v: { tone: 'success' | 'error'; text: string }) => void;
}

export function AgentDetailDevopsWrapUpBanner({
    agent,
    shownName,
    continuing,
    handleContinue,
    setCheckpointBanner,
}: AgentDetailDevopsWrapUpBannerProps) {
    return (
        <section
            style={{ ...s.devopsWrapUpCallout, borderColor: `${agent.accentColor}55` }}
            aria-label="Story wrap-up after CI"
            data-testid={`${agent.id}-wrapup-cta`}
        >
            <div style={{ ...s.devopsWrapUpBadge, background: `${agent.accentColor}18`, color: agent.accentColor }}>Wrap-up</div>
            <p style={s.devopsWrapUpBody}>
                CI passed for this PR. Start the DevOps agent with the full story wrap-up prompt (ADO, Agility, reset agent status files per{' '}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>.cursor/rules/story-wrapup.mdc</span>
                ).
            </p>
            <button
                type="button"
                style={{ ...s.contextActionBtnPrimary, marginTop: 10 }}
                disabled={continuing}
                onClick={() => {
                    void handleContinue()
                        .then(() => setCheckpointBanner({ tone: 'success', text: `${shownName} is running story wrap-up.` }))
                        .catch((e: unknown) => setCheckpointBanner({ tone: 'error', text: e instanceof Error ? e.message : String(e) }));
                }}
                data-testid={`${agent.id}-run-wrapup-banner`}
            >
                {continuing ? 'Starting...' : 'Run story wrap-up'}
            </button>
        </section>
    );
}
AgentDetailDevopsWrapUpBanner.displayName = 'AgentDetailDevopsWrapUpBanner';
