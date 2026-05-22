/**
 * Local Teams webhook spy.
 * Listens for incoming MessageCard POSTs and pretty-prints them to the console.
 *
 * Usage:
 *   npx tsx scripts/teams-webhook-spy.ts          # default port 3099
 *   PORT=4000 npx tsx scripts/teams-webhook-spy.ts
 *
 * In .sdlc-framework.config.json set:
 *   "notifications": { "teams": { "webhookUrl": "http://localhost:3099" } }
 *
 * Then run with NOTIFY_PROVIDER=teams (or leave unset — teams is the default).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';

const PORT = Number(process.env.PORT ?? 3099);

const LEVEL_COLORS: Record<string, string> = {
    '22c55e': '🟢',  // green   – approved / passed
    '06b6d4': '🔵',  // cyan    – devops build gate
    'ef4444': '🔴',  // red     – changes requested / failed
    'D97706': '🟠',  // orange  – PR created
    'f59e0b': '🟡',  // amber   – waiting
    '6366f1': '🟣',  // indigo  – default / assigned
    'ec4899': '🩷',  // pink    – UX / design
};

function icon(color?: string) {
    if (!color) return '📣';
    return LEVEL_COLORS[color] ?? `[#${color}]`;
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
    }

    const raw = await readBody(req);
    let card: Record<string, unknown> = {};
    try { card = JSON.parse(raw); } catch { /* log raw below */ }

    const title = String(card.summary ?? card.title ?? '(no title)');
    const color = String(card.themeColor ?? '');
    const sections = Array.isArray(card.sections) ? card.sections : [];
    const text = sections.map((s: unknown) => {
        const sec = s as Record<string, unknown>;
        return [sec.activityTitle, sec.activitySubtitle, sec.text]
            .filter(Boolean).join('\n  ');
    }).join('\n  ---\n  ');

    const ts = new Date().toLocaleTimeString();
    console.log(`\n${icon(color)} [${ts}] ${title}`);
    if (text) console.log(`  ${text}`);
    if (!card.summary && !card.sections) {
        console.log('  (raw)', raw.slice(0, 300));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => {
    console.log(`Teams webhook spy listening on http://localhost:${PORT}`);
    console.log('Add to .sdlc-framework.config.json:');
    console.log(`  "notifications": { "teams": { "webhookUrl": "http://localhost:${PORT}" } }\n`);
});
