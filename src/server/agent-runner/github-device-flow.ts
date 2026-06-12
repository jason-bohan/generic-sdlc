/**
 * GitHub device code flow authentication helper
 * Used for GitHub Copilot and other GitHub OAuth integrations
 */

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
    expires_in?: number;
}

export interface DeviceFlowError {
    error: string;
    error_description?: string;
    error_uri?: string;
}

// GitHub's public client ID (used by GitHub CLI and similar tools)
const GITHUB_CLIENT_ID = 'github-cli';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_DEVICE_VERIFY_URL = 'https://github.com/login/device';

export async function initiateDeviceCode(
    scope = 'gist',
): Promise<DeviceCodeResponse> {
    const res = await fetch(GITHUB_DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `client_id=${GITHUB_CLIENT_ID}&scope=${encodeURIComponent(scope)}`,
    });

    if (!res.ok) {
        const err = (await res.json()) as DeviceFlowError;
        throw new Error(`GitHub device code request failed: ${err.error} — ${err.error_description || ''}`);
    }

    return (await res.json()) as DeviceCodeResponse;
}

export async function pollForToken(
    deviceCode: string,
    interval: number,
    expiresIn: number,
): Promise<TokenResponse> {
    const startTime = Date.now();
    const expiresAtMs = startTime + expiresIn * 1000;
    let currentInterval = interval * 1000;

    while (Date.now() < expiresAtMs) {
        await new Promise(resolve => setTimeout(resolve, currentInterval));

        try {
            const res = await fetch(GITHUB_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `client_id=${GITHUB_CLIENT_ID}&device_code=${encodeURIComponent(deviceCode)}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
            });

            if (!res.ok) {
                const err = (await res.json()) as DeviceFlowError;
                // Handle specific error codes from RFC 8628
                if (err.error === 'authorization_pending') {
                    // User hasn't authorized yet, keep polling
                    continue;
                } else if (err.error === 'slow_down') {
                    // Add 5 seconds to the interval as per spec
                    currentInterval += 5000;
                    continue;
                } else if (err.error === 'expired_token') {
                    throw new Error('Device code expired. Please try again.');
                } else if (err.error === 'access_denied') {
                    throw new Error('Authorization was denied.');
                } else {
                    throw new Error(`GitHub token request failed: ${err.error}`);
                }
            }

            return (await res.json()) as TokenResponse;
        } catch (e: unknown) {
            if (e instanceof Error && e.message.includes('GitHub token request')) {
                throw e;
            }
            // Network error, retry
        }
    }

    throw new Error('Device code expired. Authorization took too long.');
}

export function getVerificationUrl(): string {
    return GITHUB_DEVICE_VERIFY_URL;
}

export async function validateAccessToken(accessToken: string): Promise<{ login: string } | null> {
    try {
        const res = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/vnd.github+json',
            },
        });
        if (!res.ok) return null;
        return (await res.json()) as { login: string };
    } catch {
        return null;
    }
}
