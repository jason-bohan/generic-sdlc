import React, { useId } from 'react';

export interface ProfileCardProps {
    title?: string;
    subtitle?: string;
    children?: React.ReactNode;
    headingLevel?: 2 | 3;
    loading?: boolean;
    /** Buttons or links shown below card content */
    actions?: React.ReactNode;
}

export const ProfileCard: React.FC<ProfileCardProps> = ({
    title = '',
    subtitle,
    children,
    headingLevel = 2,
    loading = false,
    actions,
}) => {
    const Heading: 'h2' | 'h3' = headingLevel === 3 ? 'h3' : 'h2';
    const headingId = useId();

    const cardStyle: React.CSSProperties = {
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 24,
        maxWidth: '100%',
        boxSizing: 'border-box',
    };

    const titleStyle: React.CSSProperties = {
        margin: 0,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        fontSize: '1rem',
        fontWeight: 600,
    };

    const subtitleStyle: React.CSSProperties = {
        marginTop: 8,
        marginBottom: 16,
        color: 'var(--text-secondary)',
        fontSize: '0.875rem',
    };

    if (loading) {
        return (
            <div style={cardStyle} aria-busy="true" aria-live="polite">
                <div style={{ height: 16, background: 'var(--bg-card-hover)', borderRadius: 4, marginBottom: 8 }} />
                <div style={{ height: 12, background: 'var(--bg-card-hover)', borderRadius: 4, width: '60%' }} />
                {children}
            </div>
        );
    }

    return (
        <section style={cardStyle} aria-labelledby={title.trim() ? headingId : undefined} role="region">
            {title.trim() ? (
                <Heading id={headingId} style={titleStyle}>
                    {title}
                </Heading>
            ) : null}
            {subtitle ? <div style={subtitleStyle}>{subtitle}</div> : null}
            <div>{children}</div>
            {actions ? <div style={{ marginTop: 16 }}>{actions}</div> : null}
        </section>
    );
};

export default ProfileCard;
