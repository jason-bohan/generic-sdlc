import type { StatusEvent } from '../types';
import { agentDetailStyles as s } from './AgentDetail.styles';
import { formatRelativeTime, eventAccent } from '../agent-detail-utils';
import { Section } from './DetailHelpers';

export interface EventLogProps {
    events: StatusEvent[];
}

export function EventLog({ events }: EventLogProps) {
    return (
        <Section title="Events">
            <div style={s.eventList}>
                {[...events]
                    .reverse()
                    .slice(0, 15)
                    .map((event, i) => {
                        const accent = eventAccent(event.type);
                        const abs = new Date(event.timestamp).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                        });
                        return (
                            <div
                                key={`${event.timestamp}-${i}`}
                                style={{
                                    ...s.eventRow,
                                    borderLeftColor: accent.color,
                                }}
                                title={abs}
                            >
                                <span
                                    style={{
                                        ...s.eventGlyph,
                                        color: accent.color,
                                    }}
                                    aria-hidden="true"
                                >
                                    {accent.glyph}
                                </span>
                                <span style={s.eventTime}>
                                    {formatRelativeTime(event.timestamp)}
                                </span>
                                <span style={s.eventMessage}>{event.message}</span>
                            </div>
                        );
                    })}
            </div>
        </Section>
    );
}
EventLog.displayName = 'EventLog';
