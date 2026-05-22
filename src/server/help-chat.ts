import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { runInlineQuery } from './agent-drivers';
import { ollamaHost } from './ollamaManager';
import { resolveAgentDisplayName } from './agent-display-names';
import { parseJsonUtf8File } from './json-file';

export interface HelpMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface HelpAnswer {
    answer: string;
    source: 'kb' | 'ollama' | 'driver' | 'offline';
}

// Condensed knowledge base tuned for 8B model context limits (agent names resolved per workspace config)
const AGENT_KB_ROWS: { id: string; role: string }[] = [
    { id: 'frontend', role: 'Angular/TypeScript code, PRs' },
    { id: 'backend', role: '.NET/C# APIs, PRs' },
    { id: 'reviewer', role: 'PR review, inline comments, approval' },
    { id: 'devops', role: 'CI pipeline monitoring, PR merge' },
    { id: 'ux', role: 'UX design specs, Figma integration' },
    { id: 'qa', role: 'Cypress tests, failure triage' },
];

function buildAgentsKbTable(resolveName: (agentId: string) => string): string {
    const lines = ['| ID | Name | Role |', '|----|------|------|'];
    for (const { id, role } of AGENT_KB_ROWS) {
        lines.push(`| ${id} | ${resolveName(id)} | ${role} |`);
    }
    return lines.join('\n');
}

/** Full condensed KB with current workspace display names (and built-in defaults when config is unchanged). */
export function buildCondensedKb(rootDir: string): string {
    return `${KB_BEFORE_AGENTS}${buildAgentsKbTable((id) => resolveAgentDisplayName(id, rootDir))}${KB_AFTER_AGENTS}`;
}

const KB_BEFORE_AGENTS = `## SDLC Framework Quick Reference

### What is SDLC Framework?
Multi-agent SDLC automation. Six AI agents collaborate end-to-end: story → code → PR → review → CI → merge.

### Starting Up
- Dashboard: \`npm run dev\` → http://localhost:5173
- Server only: \`npm run server\` → http://localhost:3001
- TUI: \`sdlc-framework\` (terminal)
- TUI with mock integrations: \`sdlc-framework --test\`

### Dashboard Views
- **2D Floor** (card grid, default) and **3D Office** (RPG top-down). Switch in Settings (⚙ cog, bottom-right).
- Themes: Far Out (70s retro), Lumon (Severance MDR floor), Nice Admin, Simple, Rock and Roll McDonald's.
- Stats bar: agent count, token usage, open PRs (with links).

### Agent Cards
Each card shows: current phase, story number, current task.
Buttons: **Pick Up Story**, **Approve** (pending-approval only), **Open Desk**, **/btw** (chat), **Step toggle**.

### Running a Story (typical flow)
1. Click **Pick Up Story** on an agent card → select team → browse stories → Assign
2. If \`scheduler.mode\` is \`notify\`: agent waits in \`pending-approval\` → click **Approve**
3. If \`autoStart: true\` for that agent: starts immediately
4. Agent progresses through phases automatically
5. PR created → \`POST /api/pr/created\` puts that PR on the reviewer **desk** (or use **Pick Up** on an **Available PRs** row to review someone else's PR). **List pickup is manual by default.** Only turn on \`scheduler.agents.reviewer.autoPickAdoList: true\` if you want the reviewer **idle** to auto-grab the **first row** of the ADO list (blocked when global or reviewer step mode is on). That flag does **not** control whether the reviewer runs the review once a PR is already on their desk.
6. DevOps monitors build → PR merges

### Reviewer desk (\`pending-review\`)
Example: the reviewer agent has PR #5001 (*feat(B-17001): Add pagination to audit trail table*) in \`pending-review\`.
**Assigning work:** **Pick Up** (any list row) or \`/api/pr/created\` puts the PR on the desk. That works even when step mode is on; step mode does **not** block pickup. You do **not** need \`autoPickAdoList\` or \`scheduler.mode: autonomous\` for assignment.
**Auto-run:** when **global and reviewer step mode are both off**, the server may start the reviewer CLI **headless** (no new terminal): logs under \`.agent-output/reviewer-*.log\` and \`.agent-spawns.log\`; \`.reviewer-status.json\` gets \`spawnedPid\` when the process starts (same after **Pick Up** or \`/api/pr/created\` when auto-spawn runs).
**Manual run:** if **either** step mode is **on**, or **spawn failed**, read \`skills/reviewer/SKILL.md\` and run the review yourself.
On the reviewer desk page, **On reviewer's desk** vs **Available PRs** are separate: filters apply to **Available** only; the desk strip uses the full ADO list so an assigned PR stays visible even if it would not match your branch/search filter.
**Azure DevOps PR lifecycle:** REST field \`status\` is \`active\` (open), \`completed\` (**merged** PRs use this—there is no separate \`merged\` value), or \`abandoned\`. The desk list requests \`active\` only; **Pick Up** still \`GET\`s the PR from Azure so SDLC Framework sees the latest status if local workspace JSON was stale.
**Display name** is configurable via the dashboard or \`scheduler.agents.reviewer.displayName\` in config.

### Step Mode
Pause agent execution at phase boundaries for manual control.
- **Enable/disable**: Step toggle on agent card, or press \`s\` in TUI
- **Advance**: Click "Next" on card, or press \`n\` in TUI
- Pauses at: analyzing, generating-code, validating, creating-pr (and more)
- Downstream agent spawning is suppressed while step mode is active

### Scheduler Modes
- \`notify\` (default): agents wait for Approve click after assignment
- \`autonomous\`: agents start immediately on assignment
- Per-agent override: set \`scheduler.agents.<id>.autoStart: true\` in config

### Agents (IDs, names, roles)
`;

const KB_AFTER_AGENTS = `

Display names are customizable: double-click in dashboard, or \`scheduler.agents.<id>.displayName\` in config.

### Mock Mode (safe local testing)
No real Azure DevOps, Agility, or Teams calls.
Enable: \`"externalMode": "mock"\` in .sdlc-framework.config.json, or \`SDLC_EXTERNAL_MODE=mock\`, or \`sdlc-framework --test\`.
Agents use local branches, simulated PRs and pipeline runs.

### TUI Hotkeys
- \`s\` — toggle step mode
- \`n\` — advance to next step (when paused)
- \`?\` — open this help chat
- \`q\` / Ctrl+C — quit

### /btw Chat (send messages to agents mid-work)
Dashboard: click **/btw** on agent card.
Terminal: \`npm run btw -- --agent frontend --message "prioritize login page"\`

### Key Config Options (.sdlc-framework.config.json)
- \`executionMode\`: \`local\` / \`balanced\` / \`speed\` — AI engine for story creation
- \`scheduler.mode\`: \`notify\` / \`autonomous\` — auto-start vs approval gate
- \`scheduler.driver\`: \`cursor\` / \`claude-code\` / \`goose\` / \`generic\` — which CLI spawns agents
- \`scheduler.agents.<id>.autoStart\`: skip approval for one agent
- \`scheduler.agents.<id>.stepMode\`: enable step mode by default
- \`scheduler.agents.<id>.displayName\`: custom display name
- \`scheduler.agents.reviewer.autoPickAdoList\`: optional; when \`true\`, auto-pick first ADO list row on reviewer desk (default off; use \`/api/pr/created\` or manual Pick Up instead)
- \`externalMode\`: \`live\` / \`mock\`

### Execution Modes (story creation)
- **Local**: Ollama only, fully offline, zero cost
- **Balanced**: Ollama enriches fields + REST creates story
- **Speed**: Cloud AI driver, best quality, higher token cost

### Prerequisites & Setup
Node.js 22+, Cursor (or claude-code CLI / goose).
First-time: \`.\\bin\\setup.ps1\`  |  Update: \`.\\bin\\update.ps1\`

### Developer Tools
- Bruno API explorer: \`bruno/sdlc-framework/\` folder, open in Bruno app
- Scalar interactive docs: http://localhost:3001/ (when server is running)
- Harlequin SQLite TUI: \`npm run db\`
- Tests: \`npm test\``;

const KB_WARMUP_INTRO =
    'The AI assistant is still warming up. Here\'s what I found in the docs:\n\n';

const KB_STOPWORDS = new Set([
    'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
    'can', 'need', 'i', 'you', 'we', 'they', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'which',
    'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'if', 'or', 'and', 'but', 'not', 'no', 'yes', 'any',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very', 'just',
    'also', 'only', 'own', 'same', 'so', 'then', 'here', 'there', 'from', 'up', 'down', 'out', 'off', 'over',
    'under', 'again', 'further', 'once', 'me', 'my', 'our', 'your', 'their', 'about', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'with', 'without', 'against', 'among', 'get', 'use', 'using',
    'tell', 'want', 'make', 'made', 'give', 'go', 'going', 'let', 'like', 'know', 'something', 'anything', 'help',
    'please', 'thanks', 'question', 'ask', 'does', 'am', 'im',
]);

function kbQuestionTokens(question: string): string[] {
    const words = question.toLowerCase().match(/\b[a-z0-9][a-z0-9'-]*\b/g) ?? [];
    return words.filter(w => w.length >= 2 && !KB_STOPWORDS.has(w));
}

function parseKbSections(kb: string): { heading: string; text: string }[] {
    const parts = kb.trim().split(/\n(?=### )/);
    const out: { heading: string; text: string }[] = [];
    for (const p of parts) {
        const t = p.trim();
        if (!t) continue;
        const hMatch = t.match(/^###\s+([^\n]+)/);
        if (hMatch) {
            out.push({ heading: hMatch[1], text: t });
        } else {
            out.push({ heading: 'SDLC Framework Quick Reference', text: t });
        }
    }
    return out;
}

function scoreKbSection(tokens: string[], section: { heading: string; text: string }): number {
    const h = section.heading.toLowerCase();
    const b = section.text.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
        if (h.includes(tok)) score += 5;
        else if (b.includes(tok)) score += 2;
    }
    return score;
}

function pickKbAnswer(scored: { section: { heading: string; text: string }; score: number }[]): string | null {
    if (scored.length === 0 || scored[0].score <= 0) return null;
    const top = scored[0].score;
    const picks = scored.filter(s => s.score >= top * 0.65 && s.score > 0);
    const joined = picks.map(p => p.section.text).join('\n\n---\n\n');
    return joined;
}

/**
 * Keyword match against the condensed KB. Tried before Ollama for fast, offline-friendly answers.
 * `rootDir` selects `.sdlc-framework.config.json` so the in-KB agent name column matches the dashboard.
 */
export function matchFromKnowledgeBase(
    question: string,
    rootDir: string,
    options?: { relaxed?: boolean },
): string | null {
    const relaxed = options?.relaxed ?? false;
    const tokens = kbQuestionTokens(question);
    const sections = parseKbSections(buildCondensedKb(rootDir));
    if (tokens.length === 0) {
        if (!relaxed) return null;
        const lc = question.trim().toLowerCase();
        if (lc.length < 2) return null;
        const fallbackScored = sections
            .map(section => ({ section, score: section.text.toLowerCase().includes(lc) ? 3 : 0 }));
        fallbackScored.sort((a, b) => b.score - a.score);
        return pickKbAnswer(fallbackScored);
    }
    const scored = sections
        .map(section => ({ section, score: scoreKbSection(tokens, section) }))
        .sort((a, b) => b.score - a.score);
    const minScore = relaxed ? 1 : 2;
    if (!scored[0] || scored[0].score < minScore) return null;
    return pickKbAnswer(scored);
}

const AGENT_IDS = ['frontend', 'backend', 'reviewer', 'devops', 'ux', 'qa'];

function getLiveState(rootDir: string): string {
    const lines: string[] = [];
    for (const id of AGENT_IDS) {
        const file = resolve(rootDir, `.${id}-status.json`);
        if (!existsSync(file)) continue;
        try {
            const s = parseJsonUtf8File(file);
            const phase = s.currentPhase ?? 'idle';
            const story = s.storyNumber ? ` on ${s.storyNumber}` : '';
            const task = s.currentTask ? ` (${s.currentTask})` : '';
            lines.push(`${id}: ${phase}${story}${task}`);
        } catch { /* skip */ }
    }
    return lines.length ? lines.join('\n') : 'All agents idle.';
}

function loadFullDocs(rootDir: string): string {
    const docsDir = resolve(rootDir, 'docs');
    if (!existsSync(docsDir)) return buildCondensedKb(rootDir);
    const MAX = 40_000;
    const parts: string[] = [];
    let total = 0;
    for (const file of readdirSync(docsDir).filter(f => f.endsWith('.md')).sort()) {
        if (total >= MAX) break;
        try {
            const content = readFileSync(join(docsDir, file), 'utf-8');
            const chunk = `\n## From ${file}\n${content}`;
            const slice = chunk.slice(0, MAX - total);
            parts.push(slice);
            total += slice.length;
        } catch { /* skip */ }
    }
    return parts.join('\n') || buildCondensedKb(rootDir);
}

async function pingOllama(): Promise<boolean> {
    try {
        const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch { return false; }
}

async function callOllamaChat(
    systemPrompt: string,
    history: HelpMessage[],
    question: string,
): Promise<string | null> {
    const model = process.env.LOCAL_LLM_MODEL || 'qwen3:8b';
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: question },
    ];
    try {
        const res = await fetch(`${ollamaHost()}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages,
                stream: false,
                think: false,
                options: { temperature: 0.3, num_predict: 2000, num_ctx: 8192 },
            }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return null;
        const data = await res.json() as { message?: { content?: string; thinking?: string } };
        const content = data.message?.content?.trim();
        if (content) return content;
        // qwen3 thinking models put output in `thinking` when content is empty
        return data.message?.thinking?.trim() ?? null;
    } catch {
        return null;
    }
}

async function callDriverFallback(
    message: string,
    history: HelpMessage[],
    liveState: string,
    rootDir: string,
    configPath: string,
): Promise<string | null> {
    const fullDocs = loadFullDocs(rootDir);
    const conversationText = history.length
        ? history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\n'
        : '';

    const driverPrompt = `You are a helpful in-app assistant for SDLC Framework, a multi-agent SDLC automation platform.
Answer the user's question about using SDLC Framework concisely and accurately. Keep the answer under 200 words unless more is needed.

Current agent state:
${liveState}

${fullDocs}

${conversationText}User: ${message}
Assistant:`;

    const answer = await runInlineQuery(driverPrompt, rootDir, configPath, { timeout: 15_000 });
    const trimmed = answer.trim();
    return trimmed || null;
}

export async function answerHelpQuestion(
    message: string,
    history: HelpMessage[],
    rootDir: string,
    configPath: string,
): Promise<HelpAnswer> {
    const liveState = getLiveState(rootDir);

    const condensedKb = buildCondensedKb(rootDir);
    const kbFirst = matchFromKnowledgeBase(message, rootDir);
    if (kbFirst) {
        return { answer: kbFirst, source: 'kb' };
    }

    const ollamaSystem = `You are a helpful in-app assistant for SDLC Framework, a multi-agent SDLC automation platform.
Answer questions about using SDLC Framework concisely and accurately. Use the knowledge base below.
If you don't know, say so. Keep answers under 200 words unless the question requires more detail.

Current agent state:
${liveState}

${condensedKb}`;

    if (await pingOllama()) {
        const answer = await callOllamaChat(ollamaSystem, history, message);
        if (answer) return { answer, source: 'ollama' };
        try {
            const driverAnswer = await callDriverFallback(message, history, liveState, rootDir, configPath);
            if (driverAnswer) return { answer: driverAnswer, source: 'driver' };
        } catch {
            // Continue to KB/offline fallbacks below.
        }
        const warmed = matchFromKnowledgeBase(message, rootDir, { relaxed: true });
        if (warmed) {
            return { answer: KB_WARMUP_INTRO + warmed, source: 'kb' };
        }
        return { answer: KB_WARMUP_INTRO + condensedKb, source: 'kb' };
    }

    // Fallback: configured driver (claude-code, cursor, goose)
    try {
        const answer = await callDriverFallback(message, history, liveState, rootDir, configPath);
        if (answer) return { answer, source: 'driver' };
    } catch {
        // Continue to KB/offline fallbacks below.
    }
    const warmed = matchFromKnowledgeBase(message, rootDir, { relaxed: true });
    if (warmed) {
        return { answer: warmed, source: 'kb' };
    }
    return {
        answer: 'Help is currently unavailable — Ollama is offline and no AI driver responded. Make sure Ollama is running (`ollama serve`) or check `scheduler.driver` in `.sdlc-framework.config.json`.',
        source: 'offline',
    };
}
