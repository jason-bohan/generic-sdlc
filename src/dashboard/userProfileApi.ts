export interface UserProfileDto {
    displayName: string;
    email: string;
    bio: string;
    avatarUrl: string | null;
}

function parseProfileJson(text: string, context: string): UserProfileDto {
    try {
        return JSON.parse(text) as UserProfileDto;
    } catch {
        throw new Error(`${context}: response was not valid JSON`);
    }
}

export async function fetchUserProfile(): Promise<UserProfileDto> {
    const r = await fetch('/api/user-profile');
    const text = await r.text();
    if (!r.ok) throw new Error(text || `GET /api/user-profile failed (${r.status})`);
    return parseProfileJson(text, 'GET /api/user-profile');
}

export async function persistUserProfile(partial: Partial<UserProfileDto>): Promise<UserProfileDto> {
    const r = await fetch('/api/user-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text || `PUT /api/user-profile failed (${r.status})`);
    return parseProfileJson(text, 'PUT /api/user-profile');
}

export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
        reader.readAsDataURL(file);
    });
}
