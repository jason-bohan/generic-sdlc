/**
 * Security middleware for the SDLC Framework API server.
 * Provides rate limiting, security headers, CORS hardening, and localhost guards.
 */

import http from 'node:http';

// ── Rate Limiting (in-memory, per-IP) ─────────────────────────────────────────

interface RateBucket {
    count: number;
    resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_DEFAULT = 120;
const RATE_LIMIT_GENERATE = 30;

function clientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

function checkRate(ip: string, limit: number): boolean {
    const now = Date.now();
    const key = `${ip}:${limit}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
        rateBuckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count <= limit;
}

// Periodic cleanup to prevent unbounded memory growth
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) {
        if (now >= bucket.resetAt) rateBuckets.delete(key);
    }
}, RATE_WINDOW_MS);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLocalhostRequest(req: http.IncomingMessage): boolean {
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const GENERATE_PATHS = ['/api/ollama/generate', '/api/meshllm/generate'];

function isGeneratePath(path: string): boolean {
    return GENERATE_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

// ── Security Headers ──────────────────────────────────────────────────────────

function setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:3001',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3001',
    'tauri://localhost',
];

export interface SecurityConfig {
    /** Extra allowed CORS origins beyond the defaults. */
    allowedOrigins?: string[];
    /** Disable rate limiting (e.g. for tests). */
    disableRateLimit?: boolean;
    /** Require API key for non-localhost requests. Value from SDLC_FRAMEWORK_API_KEY env var. */
    apiKey?: string;
}

function resolveAllowedOrigins(config: SecurityConfig): Set<string> {
    const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
    if (config.allowedOrigins) {
        for (const o of config.allowedOrigins) origins.add(o);
    }
    return origins;
}

/** Allow any localhost port during Docker/Cypress E2E (Vite on 4000, worktree ports, etc.). */
export function isE2eLocalhostOrigin(origin: string): boolean {
    if (process.env.SDLC_FRAMEWORK_E2E !== '1') return false;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function handleCors(req: http.IncomingMessage, res: http.ServerResponse, allowed: Set<string>): void {
    const origin = req.headers.origin || '';
    if (allowed.has(origin) || isLocalhostRequest(req) || isE2eLocalhostOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Returns an http.RequestListener wrapper that applies security middleware:
 * - Security headers on every response
 * - CORS restricted to known origins
 * - Rate limiting per IP
 * - Optional API key check for non-localhost requests
 */
export function withSecurity(
    inner: http.RequestListener,
    config: SecurityConfig = {},
): http.RequestListener {
    const allowedOrigins = resolveAllowedOrigins(config);
    const apiKey = config.apiKey || process.env.SDLC_FRAMEWORK_API_KEY || '';

    return (req, res) => {
        setSecurityHeaders(res);

        // CORS
        handleCors(req, res, allowedOrigins);

        // Preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // API key check for non-localhost
        if (apiKey && !isLocalhostRequest(req)) {
            const provided =
                req.headers['x-api-key'] ||
                req.headers['authorization']?.replace(/^Bearer\s+/i, '');
            if (provided !== apiKey) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
        }

        // Rate limiting
        if (!config.disableRateLimit) {
            const ip = clientIp(req);
            const path = (req.url ?? '/').split('?')[0];
            const limit = isGeneratePath(path) ? RATE_LIMIT_GENERATE : RATE_LIMIT_DEFAULT;
            if (!checkRate(ip, limit)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many requests' }));
                return;
            }
        }

        inner(req, res);
    };
}
