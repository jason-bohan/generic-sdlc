/**
 * Waits until the SDLC Framework API accepts TCP connections on the dev port.
 * Port resolution matches worktree-port.ts and vite.config.ts (.dev-port, main 3001, worktree hash).
 * Used by npm run dev so Vite does not proxy /api before the server is listening.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const TIMEOUT_MS = 120000;
const POLL_MS = 250;

function djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffff;
    return Math.abs(h);
}

function deriveApiPort() {
    if (process.env.SDLC_API_PORT) return Number(process.env.SDLC_API_PORT);
    try {
        const stored = fs.readFileSync(path.join(root, '.sdlc-framework', '.dev-port'), 'utf-8').trim();
        if (stored) return Number(stored);
    } catch { /* not written yet */ }
    try {
        if (fs.statSync(path.join(root, '.git')).isDirectory()) return 3001;
    } catch { /* worktree or no .git */ }
    const name = root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
    return 3100 + (djb2(name) % 900);
}

function tryConnect(port) {
    return new Promise((resolve) => {
        const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
            s.end();
            resolve(true);
        });
        s.on('error', () => {
            s.destroy();
            resolve(false);
        });
    });
}

(async () => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const port = deriveApiPort();
        if (await tryConnect(port)) process.exit(0);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    console.error('[wait-dev-api] Timed out waiting for API. Check `npm run server` / port conflicts (EADDRINUSE).');
    process.exit(1);
})();
