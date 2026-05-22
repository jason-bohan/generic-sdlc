import type { AgentProfile } from '../types';
import { ROLE_DESCRIPTIONS } from '../agent-detail-utils';
import { agentDetailStyles as s } from './AgentDetail.styles';

export interface AgentDetailIdleHeroProps {
    agent: AgentProfile;
    onPickUpStory?: () => void;
    onChat?: () => void;
}

export function AgentDetailIdleHero({ agent, onPickUpStory, onChat }: AgentDetailIdleHeroProps) {
    const roleInfo = ROLE_DESCRIPTIONS[agent.role];
    return (
        <div style={s.idleHero}>
            <div style={{ ...s.idleAvatar, background: `linear-gradient(135deg, ${agent.accentColor}, ${agent.accentColor}66)` }}>
                <span style={s.idleAvatarLetter}>{agent.avatar}</span>
            </div>
            <p style={s.idleSummary}>{roleInfo.summary}</p>
            <div style={s.idleCapabilities}>
                {roleInfo.capabilities.map((cap) => (
                    <span key={cap} style={{ ...s.idleCapBadge, borderColor: `${agent.accentColor}44`, color: agent.accentColor }}>
                        {cap}
                    </span>
                ))}
            </div>
            {onPickUpStory && (
                <button
                    style={{ ...s.idlePickupBtn, background: agent.accentColor }}
                    onClick={onPickUpStory}
                >
                    Assign a Story
                </button>
            )}
            {onChat && (
                <button
                    style={{ ...s.idleChatBtn, color: agent.accentColor, borderColor: `${agent.accentColor}44` }}
                    onClick={onChat}
                >
                    Send a message (/btw)
                </button>
            )}
        </div>
    );
}
AgentDetailIdleHero.displayName = 'AgentDetailIdleHero';
