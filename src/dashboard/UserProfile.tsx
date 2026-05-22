import React, { useEffect, useId, useState } from 'react';
import UserAvatar from './UserAvatar';
import ProfileCard from './ProfileCard';

export interface UserProfileSaveDraft {
    displayName: string;
    email: string;
    bio: string;
}

export interface UserProfileProps {
    displayName: string;
    email?: string;
    bio?: string | null;
    avatarUrl?: string | null;
    editable?: boolean;
    /** Server round-trip in progress after Save */
    saving?: boolean;
    /** Initial hydrate */
    loading?: boolean;
    saveError?: string | null;
    onAvatarChange?: (file: File) => void;
    onSave?: (draft: UserProfileSaveDraft) => void | Promise<void>;
}

export const UserProfile: React.FC<UserProfileProps> = ({
    displayName,
    email = '',
    bio = null,
    avatarUrl = null,
    editable = false,
    saving = false,
    loading = false,
    saveError = null,
    onAvatarChange,
    onSave,
}) => {
    const headingId = 'profile-page-heading';
    const nameFieldId = useId();
    const emailFieldId = useId();
    const bioFieldId = useId();
    const [editingAbout, setEditingAbout] = useState(false);

    const [draft, setDraft] = useState<UserProfileSaveDraft>({
        displayName,
        email,
        bio: bio ?? '',
    });

    useEffect(() => {
        if (!editable) setEditingAbout(false);
    }, [editable]);

    useEffect(() => {
        if (editingAbout) return;
        setDraft({
            displayName,
            email,
            bio: bio ?? '',
        });
    }, [displayName, email, bio, editingAbout]);

    const containerStyle: React.CSSProperties = {
        maxWidth: 1200,
        margin: '0 auto',
        padding: '16px',
        boxSizing: 'border-box',
    };

    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: '1fr',
        gap: 24,
    };

    const identityStyle: React.CSSProperties = {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 16,
    };

    const nameStyle: React.CSSProperties = {
        margin: 0,
        fontSize: '1.25rem',
        fontWeight: 600,
        color: 'var(--text-primary)',
    };

    const subtitleStyle: React.CSSProperties = {
        margin: 0,
        color: 'var(--text-secondary)',
        fontSize: '0.875rem',
    };

    const fieldLabel: React.CSSProperties = {
        display: 'block',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        marginBottom: 4,
        fontFamily: 'var(--font-sans)',
    };

    const textInputStyle: React.CSSProperties = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        fontSize: '1rem',
    };

    const responsiveCss = `
    @media (min-width: 768px) {
      .sdlc-framework-profile-grid {
        grid-template-columns: 1fr 360px;
        align-items: start;
      }
    }
    .sdlc-framework-profile-btn:focus-visible,
    .sdlc-framework-profile-btn-edit:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  `;

    const toolbarBtn: React.CSSProperties = {
        padding: '8px 14px',
        borderRadius: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        cursor: 'pointer',
        border: `1px solid var(--border)`,
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
    };

    const primaryBtn: React.CSSProperties = {
        ...toolbarBtn,
        background: 'var(--accent)',
        color: '#fff',
        border: '1px solid var(--accent)',
    };

    const cancelEditAbout = () => {
        setEditingAbout(false);
        setDraft({
            displayName,
            email,
            bio: bio ?? '',
        });
    };

    const saveAbout = async () => {
        if (!onSave) return;
        try {
            await onSave(draft);
            setEditingAbout(false);
        } catch {
            /* Stay in edit mode; parent exposes saveError */
        }
    };

    if (loading && !editable) {
        return (
            <main aria-busy="true" aria-live="polite" style={containerStyle}>
                <ProfileCard loading />
            </main>
        );
    }

    return (
        <main role="main" aria-labelledby={headingId} style={containerStyle}>
            <style>{responsiveCss}</style>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
                <h1
                    id={headingId}
                    style={{ fontSize: '1.75rem', margin: 0, fontWeight: 600, color: 'var(--text-primary)', flex: '1 1 200px' }}
                >
                    Profile
                </h1>
                {editable && !editingAbout && (
                    <button
                        type="button"
                        className="sdlc-framework-profile-btn-edit"
                        onClick={() => setEditingAbout(true)}
                        style={{ ...primaryBtn }}
                    >
                        Edit profile
                    </button>
                )}
            </div>

            {saveError ? (
                <div
                    role="alert"
                    style={{
                        padding: '10px 12px',
                        marginBottom: 16,
                        borderRadius: 8,
                        border: '1px solid var(--error)',
                        background: 'var(--accent-dim)',
                        color: 'var(--error)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 14,
                    }}
                >
                    {saveError}
                </div>
            ) : null}

            <div className="sdlc-framework-profile-grid" style={gridStyle}>
                <div>
                    <section aria-labelledby="identity-heading" style={{ marginBottom: 24 }}>
                        <div style={identityStyle}>
                            <UserAvatar
                                imageUrl={avatarUrl ?? undefined}
                                altText={editingAbout ? draft.displayName : displayName}
                                size="lg"
                                editable={Boolean(editable && editingAbout)}
                                onChange={onAvatarChange}
                            />
                            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                                <h2 id="identity-heading" className="visually-hidden-for-profile">
                                    Identity
                                </h2>
                                {editingAbout ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        <div>
                                            <label htmlFor={nameFieldId} style={fieldLabel}>
                                                Display name
                                            </label>
                                            <input
                                                id={nameFieldId}
                                                type="text"
                                                autoComplete="name"
                                                required
                                                style={textInputStyle}
                                                value={draft.displayName}
                                                onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor={emailFieldId} style={fieldLabel}>
                                                Email
                                            </label>
                                            <input
                                                id={emailFieldId}
                                                type="email"
                                                autoComplete="email"
                                                style={textInputStyle}
                                                value={draft.email}
                                                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                                            />
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <p style={{ ...nameStyle, marginBottom: email ? 4 : 0 }}>{displayName}</p>
                                        {email ? <p style={subtitleStyle}>{email}</p> : null}
                                    </>
                                )}
                            </div>
                        </div>
                    </section>

                    <style>{`
              .visually-hidden-for-profile {
                position: absolute;
                width: 1px;
                height: 1px;
                padding: 0;
                margin: -1px;
                overflow: hidden;
                clip: rect(0, 0, 0, 0);
                white-space: nowrap;
                border: 0;
              }
            `}</style>

                    <ProfileCard
                        title="About"
                        subtitle={editingAbout ? 'Edit biography' : undefined}
                        actions={
                            editingAbout ? (
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <button
                                        type="button"
                                        className="sdlc-framework-profile-btn"
                                        disabled={saving || !draft.displayName.trim()}
                                        onClick={() => void saveAbout()}
                                        style={{
                                            ...(saving ? { ...toolbarBtn, opacity: 0.65, cursor: 'wait' } : primaryBtn),
                                        }}
                                    >
                                        {saving ? 'Saving\u2026' : 'Save changes'}
                                    </button>
                                    <button
                                        type="button"
                                        className="sdlc-framework-profile-btn"
                                        disabled={saving}
                                        onClick={cancelEditAbout}
                                        style={toolbarBtn}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : undefined
                        }
                    >
                        {loading ? (
                            <p style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>Loading profile\u2026</p>
                        ) : editingAbout ? (
                            <>
                                <label htmlFor={bioFieldId} style={fieldLabel}>
                                    Biography
                                </label>
                                <textarea
                                    id={bioFieldId}
                                    rows={5}
                                    style={{ ...textInputStyle, resize: 'vertical', minHeight: 100 }}
                                    value={draft.bio}
                                    onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value }))}
                                />
                            </>
                        ) : bio ? (
                            <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--text-tertiary)', lineHeight: 1.55, fontFamily: 'var(--font-sans)' }}>
                                {bio}
                            </p>
                        ) : (
                            <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>No biography provided.</p>
                        )}
                    </ProfileCard>
                </div>

                <aside>
                    <ProfileCard title="Settings" subtitle="Account preferences (read-only demo)">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontFamily: 'var(--font-sans)' }}>
                                Email notifications: <strong style={{ marginLeft: 8 }}>On</strong>
                            </div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontFamily: 'var(--font-sans)' }}>
                                Theme: <strong style={{ marginLeft: 8 }}>System</strong>
                            </div>
                        </div>
                    </ProfileCard>
                </aside>
            </div>
        </main>
    );
};

export default UserProfile;
