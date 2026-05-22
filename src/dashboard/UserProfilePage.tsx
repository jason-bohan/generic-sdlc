import { useCallback, useEffect, useState } from 'react';
import UserProfile, { type UserProfileSaveDraft } from './UserProfile';
import { fetchUserProfile, persistUserProfile, readFileAsDataUrl, type UserProfileDto } from './userProfileApi';

function ProfileNavChrome({ displayName }: { displayName?: string }) {
    return (
        <header
            style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
            }}
        >
            <a
                href="#/"
                style={{
                    color: 'var(--accent)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: 'none',
                }}
            >
                Back to dashboard
            </a>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 13, fontFamily: 'var(--font-sans)' }}>{displayName || 'User Profile'}</span>
        </header>
    );
}

export default function UserProfilePage() {
    const [profile, setProfile] = useState<UserProfileDto | null>(null);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
    const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoadState('loading');
        setLoadError(null);
        try {
            const p = await fetchUserProfile();
            setProfile(p);
            setLoadState('ready');
        } catch (e) {
            setLoadState('error');
            setLoadError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (!pendingAvatarFile) {
            setAvatarPreviewUrl(null);
            return;
        }
        const url = URL.createObjectURL(pendingAvatarFile);
        setAvatarPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [pendingAvatarFile]);

    const resolvedAvatarUrl = avatarPreviewUrl ?? profile?.avatarUrl ?? null;

    const handleAvatarChange = (file: File) => {
        setPendingAvatarFile(file);
    };

    const handleSave = async (draft: UserProfileSaveDraft) => {
        setSaving(true);
        setSaveError(null);
        try {
            let avatarUrl: string | null | undefined = profile?.avatarUrl ?? null;
            if (pendingAvatarFile) avatarUrl = await readFileAsDataUrl(pendingAvatarFile);
            const updated = await persistUserProfile({
                displayName: draft.displayName,
                email: draft.email,
                bio: draft.bio,
                ...(avatarUrl !== undefined ? { avatarUrl } : {}),
            });
            setProfile(updated);
            setPendingAvatarFile(null);
            setAvatarPreviewUrl(null);
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    const errorBanner = (
        <>
            {loadError && (
                <div
                    role="alert"
                    style={{
                        margin: 16,
                        padding: '12px 14px',
                        borderRadius: 8,
                        background: 'var(--accent-dim)',
                        border: '1px solid var(--error)',
                        color: 'var(--error)',
                        fontFamily: 'var(--font-sans)',
                    }}
                >
                    {loadError}
                    <button
                        type="button"
                        onClick={() => void load()}
                        style={{
                            marginLeft: 12,
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            background: 'var(--bg-card)',
                            cursor: 'pointer',
                            color: 'var(--text-primary)',
                        }}
                    >
                        Retry
                    </button>
                </div>
            )}
        </>
    );

    return (
        <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
            <ProfileNavChrome displayName={profile?.displayName} />
            {errorBanner}
            {loadState === 'loading' && !profile ? (
                <p
                    style={{ padding: '24px 16px', color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}
                    aria-live="polite"
                >
                    Loading profile...
                </p>
            ) : null}
            {profile && (
                <UserProfile
                    displayName={profile.displayName}
                    email={profile.email}
                    bio={profile.bio}
                    avatarUrl={resolvedAvatarUrl}
                    editable
                    loading={false}
                    saving={saving}
                    saveError={saveError}
                    onAvatarChange={handleAvatarChange}
                    onSave={handleSave}
                />
            )}
        </div>
    );
}
