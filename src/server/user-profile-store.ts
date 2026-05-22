export interface UserProfileRecord {
    displayName: string;
    email: string;
    bio: string;
    avatarUrl: string | null;
}

const DEFAULT: UserProfileRecord = {
    displayName: 'SDLC Framework Operator',
    email: 'operator@localhost',
    bio: 'Collaborative agent workspace profiles for design-system demos.',
    avatarUrl: null,
};

/** In-memory singleton (demo fixture for the dashboard profile page). */
let store: UserProfileRecord = { ...DEFAULT };

export function getUserProfileRecord(): UserProfileRecord {
    return { ...store };
}

export function mergeUserProfileRecord(partial: Partial<UserProfileRecord>): UserProfileRecord {
    const next = { ...store };
    if (typeof partial.displayName === 'string') next.displayName = partial.displayName.trim();
    if (typeof partial.email === 'string') next.email = partial.email.trim();
    if (typeof partial.bio === 'string') next.bio = partial.bio;
    if ('avatarUrl' in partial) {
        if (partial.avatarUrl === null || partial.avatarUrl === '') next.avatarUrl = null;
        else if (typeof partial.avatarUrl === 'string') next.avatarUrl = partial.avatarUrl;
    }
    store = next;
    return getUserProfileRecord();
}

/** Test helper: restores factory defaults between cases. */
export function resetUserProfileStoreForTests(): void {
    store = { ...DEFAULT };
}
