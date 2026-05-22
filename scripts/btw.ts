import { readFileSync, writeFileSync, existsSync, watchFile } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { AGENT_DISPLAY_NAME_DEFAULTS } from '../src/shared/agentDisplayDefaults';
import { deriveApiPort } from '../src/server/worktree-port';

interface AgentEntry {
    name: string;
    statusFile: string;
    chatFile: string;
}

interface ChatMsg {
    id: string;
    timestamp: string;
    from: string;
    agentId: string;
    message: string;
    status?: string;
}

interface AgentStatus {
    currentPhase: string;
    currentTask: string | null;
    storyNumber: string | null;
    tokens?: {
        cloud?: { input: number; output: number };
        ollama?: { input: number; output: number };
    };
    tasks?: Array<{
        id?: string;
        number?: string;
        name: string;
        status: string;
        hours?: number;
    }>;
}

const AGENTS: Record<string, AgentEntry> = {
    frontend: { name: AGENT_DISPLAY_NAME_DEFAULTS.frontend, statusFile: '.frontend-status.json', chatFile: '.frontend-messages.json' },
    backend: { name: AGENT_DISPLAY_NAME_DEFAULTS.backend, statusFile: '.backend-status.json', chatFile: '.backend-messages.json' },
    qa: { name: AGENT_DISPLAY_NAME_DEFAULTS.qa, statusFile: '.qa-status.json', chatFile: '.qa-messages.json' },
    ux: { name: AGENT_DISPLAY_NAME_DEFAULTS.ux, statusFile: '.ux-status.json', chatFile: '.ux-messages.json' },
    reviewer: { name: AGENT_DISPLAY_NAME_DEFAULTS.reviewer, statusFile: '.reviewer-status.json', chatFile: '.reviewer-messages.json' },
    devops: { name: AGENT_DISPLAY_NAME_DEFAULTS.devops, statusFile: '.devops-status.json', chatFile: '.devops-messages.json' },
};

const targetArg = process.argv[2]?.toLowerCase() ?? 'frontend';
const agent = AGENTS[targetArg];
if (!agent) {
    const available = Object.entries(AGENTS).map(([k, v]) => `  ${k} → ${v.name}`).join('\n');
    console.error(`Unknown agent "${targetArg}". Available agents:\n${available}`);
    process.exit(1);
}
const baseDir = resolve(process.cwd());
const chatPath = resolve(baseDir, agent.chatFile);
const statusPath = resolve(baseDir, agent.statusFile);

function loadMessages(): ChatMsg[] {
    if (!existsSync(chatPath)) return [];
    try {
        return JSON.parse(readFileSync(chatPath, 'utf-8')) as ChatMsg[];
    } catch {
        return [];
    }
}

function saveMessages(messages: ChatMsg[]) {
    try {
        writeFileSync(chatPath, JSON.stringify(messages, null, 2));
    } catch (err) {
        console.error('Failed to save messages:', err instanceof Error ? err.message : String(err));
    }
}

function getStatus(): AgentStatus | null {
    if (!existsSync(statusPath)) return null;
    try {
        return JSON.parse(readFileSync(statusPath, 'utf-8')) as AgentStatus;
    } catch {
        return null;
    }
}

function dim(text: string) { return `\x1b[2m${text}\x1b[0m`; }
function bold(text: string) { return `\x1b[1m${text}\x1b[0m`; }
function cyan(text: string) { return `\x1b[36m${text}\x1b[0m`; }
function green(text: string) { return `\x1b[32m${text}\x1b[0m`; }
function yellow(text: string) { return `\x1b[33m${text}\x1b[0m`; }
function gray(text: string) { return `\x1b[90m${text}\x1b[0m`; }

const ROOT_DIR = resolve(__dirname, '..');
const API_BASE = `http://localhost:${deriveApiPort(ROOT_DIR)}`;

async function isServerRunning(): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE}/api/execution-mode`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

let serverAvailable = false;

function printHeader() {
    const status = getStatus();
    console.log('');
    console.log(bold(`  /btw ${agent.name}`));
    console.log(dim('  ─────────────────────────────'));

    if (status) {
        const phase = status.currentPhase ?? 'idle';
        const task = status.currentTask ?? 'none';
        const story = status.storyNumber ?? 'none';
        console.log(`  ${dim('Story:')}  ${cyan(story)}`);
        console.log(`  ${dim('Phase:')}  ${phase === 'idle' ? gray(phase) : green(phase)}`);
        console.log(`  ${dim('Task:')}   ${task === 'none' ? gray(task) : yellow(task)}`);
    } else {
        console.log(`  ${gray(`${agent.name} is not reporting status`)}`);
    }

    console.log(dim('  ─────────────────────────────'));
    console.log(dim(`  ${serverAvailable ? 'Connected to dashboard server' : `Offline mode — writing to ${agent.chatFile}`}`));
    console.log(dim('  Type a message and press Enter. Ctrl+C to exit.'));
    console.log('');
}

function printExistingMessages() {
    const messages = loadMessages();
    if (messages.length === 0) return;

    console.log(dim('  Recent messages:'));
    const recent = messages.slice(-10);
    for (const msg of recent) {
        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const from = msg.from === 'user' ? bold('You') : cyan(agent.name);
        console.log(`  ${gray(time)} ${from}: ${msg.message}`);
    }
    console.log('');
}

let lastMessageCount = loadMessages().length;

function checkForReplies() {
    const messages = loadMessages();
    if (messages.length > lastMessageCount) {
        const newMessages = messages.slice(lastMessageCount);
        for (const msg of newMessages) {
            if (msg.from !== 'user') {
                const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                console.log(`  ${gray(time)} ${cyan(agent.name)}: ${msg.message}`);
            }
        }
        lastMessageCount = messages.length;
    }
}

const agentKey = Object.keys(AGENTS).find((k) => AGENTS[k] === agent) ?? 'frontend';

async function sendViaServer(text: string): Promise<boolean> {
    try {
        const msg = { from: 'user', message: text, timestamp: new Date().toISOString() };
        const res = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: agentKey, message: msg }),
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

function sendViaFile(text: string) {
    const messages = loadMessages();
    const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        from: 'user',
        agentId: agentKey,
        message: text,
    };
    messages.push(msg);
    saveMessages(messages);
    lastMessageCount = messages.length;
}

async function main() {
    serverAvailable = await isServerRunning();
    printHeader();
    printExistingMessages();

    watchFile(chatPath, { interval: 1000 }, () => {
        checkForReplies();
    });

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `  ${dim('/btw')} > `,
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            rl.prompt();
            return;
        }

        if (trimmed === '/status') {
            const status = getStatus();
            if (status) {
                console.log(`  ${dim('Phase:')} ${green(status.currentPhase)}`);
                console.log(`  ${dim('Task:')}  ${yellow(status.currentTask ?? 'none')}`);
                const cloud = (status.tokens?.cloud?.input ?? 0) + (status.tokens?.cloud?.output ?? 0);
                const ollama = (status.tokens?.ollama?.input ?? 0) + (status.tokens?.ollama?.output ?? 0);
                console.log(`  ${dim('Cloud:')} ${cloud.toLocaleString()} tokens`);
                console.log(`  ${dim('Ollama:')} ${ollama.toLocaleString()} tokens`);
            } else {
                console.log(`  ${gray('No status available')}`);
            }
            rl.prompt();
            return;
        }

        if (trimmed === '/tasks') {
            const status = getStatus();
            if (status?.tasks && status.tasks.length > 0) {
                for (const t of status.tasks) {
                    const s = t.status === 'completed' || t.status === 'complete' ? 'completed' : t.status;
                    const icon = s === 'completed' ? green('\u2713') : s === 'in_progress' ? yellow('\u25B6') : s === 'failed' ? '\u2716' : gray('\u25CB');
                    const label = t.number ?? t.id ?? '??';
                    const hours = t.hours != null ? dim(` ${t.hours}h`) : '';
                    const active = status.currentTask && (status.currentTask === t.id || status.currentTask === t.number) ? yellow(' ← active') : '';
                    console.log(`  ${icon} ${dim(label.padEnd(10))} ${t.name}${hours}${active}`);
                }
            } else {
                console.log(`  ${gray('No tasks')}`);
            }
            rl.prompt();
            return;
        }

        if (trimmed === '/help') {
            console.log(`  ${bold('Commands:')}`);
            console.log(`  ${cyan('/status')}  — Show current agent status`);
            console.log(`  ${cyan('/tasks')}   — List tasks and progress`);
            console.log(`  ${cyan('/help')}    — Show this help`);
            console.log(`  ${dim('Anything else is sent as a message to ' + agent.name)}`);
            rl.prompt();
            return;
        }

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        console.log(`  ${gray(time)} ${bold('You')}: ${trimmed}`);

        if (serverAvailable) {
            const ok = await sendViaServer(trimmed);
            if (!ok) {
                sendViaFile(trimmed);
                console.log(`  ${gray(time)} ${dim('Server unavailable — wrote to file')}`);
            }
        } else {
            sendViaFile(trimmed);
        }

        lastMessageCount = loadMessages().length;
        rl.prompt();
    });

    rl.on('close', () => {
        console.log(`\n  ${dim('Disconnected from ' + agent.name)}`);
        process.exit(0);
    });
}

main();
