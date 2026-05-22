import type { AgentProfile, AgentStatus } from '../types';
import { Section, TestRunHistory, CypressStat } from './DetailHelpers';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface AgentDetailCypressColumnProps {
    agent: AgentProfile;
    cypress: NonNullable<AgentStatus['cypress']>;
}

export function AgentDetailCypressColumn({ agent, cypress }: AgentDetailCypressColumnProps) {
    if (agent.role === 'qa') {
        return <TestRunHistory agentId={agent.id} accentColor={agent.accentColor} />;
    }
    return (
        <Section title="Cypress">
            {!cypress.lastRun ? (
                <p style={s.emptyText}>No test runs yet</p>
            ) : (
                <>
                    <div style={s.cypressStats}>
                        <CypressStat label="Passed" value={cypress.passed} color="var(--success)" />
                        <CypressStat label="Failed" value={cypress.failed} color="var(--error)" />
                        <CypressStat label="Skipped" value={cypress.skipped} color="var(--text-secondary)" />
                        <CypressStat label="Total" value={cypress.total} color="var(--text-primary)" />
                    </div>
                    {(cypress.failures?.length ?? 0) > 0 && (
                        <div style={s.failureList}>
                            {cypress.failures.map((f, i) => (
                                <div key={i} style={s.failureItem}>
                                    <span style={s.failureSpec}>{f.spec}</span>
                                    <span style={s.failureTest}>{f.test}</span>
                                    <code style={s.failureError}>{f.error}</code>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </Section>
    );
}
AgentDetailCypressColumn.displayName = 'AgentDetailCypressColumn';
