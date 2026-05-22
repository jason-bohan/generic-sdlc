import { spawnAgent, type SpawnResult } from './spawn-agent';
import { meshllmGenerate } from './meshllmProvider';
import { getAgentModel } from './route-shared';

export interface MeetingTask {
    title: string;
    confidence: number;
    agentId?: string;
    rationale?: string;
}

export interface MeetingDecision {
    summary: string;
    confidence: number;
}

export interface MeetingExtraction {
    tasks: MeetingTask[];
    decisions: MeetingDecision[];
}

export interface MeetingExtractInput {
    text: string;
    meetingId?: string;
    speaker?: string;
    recentContext: string[];
}

export interface MeetingProcessInput {
    text: string;
    meetingId?: string;
    speaker?: string;
    execute?: boolean;
    memory?: string[];
    rootDir?: string;
}

export interface MeetingDispatchDeps {
    extract?: (input: MeetingExtractInput) => Promise<MeetingExtraction>;
    dispatchTask?: (task: MeetingTask, context: { meetingId?: string; speaker?: string; recentContext: string[] }) => Promise<SpawnResult>;
}

const MAX_TASKS_PER_CHUNK = 3;
const MAX_DECISIONS_PER_CHUNK = 5;
const MAX_MEMORY_MESSAGES = 10;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_AGENT_ID = 'frontend';

const AGENT_HINTS = new Set(['frontend', 'backend', 'qa', 'devops', 'ux', 'reviewer']);

function asNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function cleanText(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function toTitleCaseStart(value: string): string {
    if (!value) return value;
    return value[0].toUpperCase() + value.slice(1);
}

function agentFromHint(value: string | undefined): string {
    const hint = cleanText(value).toLowerCase();
    return AGENT_HINTS.has(hint) ? hint : DEFAULT_AGENT_ID;
}

export function extractExplicitMeetingActions(text: string): MeetingExtraction {
    const cleaned = cleanText(text);
    if (!cleaned) return { tasks: [], decisions: [] };

    const taskMatches = [
        ...cleaned.matchAll(/\b(?:action item|todo|to-do)\s*(?:for\s+([a-z]+))?\s*:\s*([^.!?]+[.!?]?)/gi),
    ];
    const tasks = taskMatches
        .map((match): MeetingTask | null => {
            const title = cleanText(match[2]);
            if (!title) return null;
            return {
                title: toTitleCaseStart(title),
                confidence: 0.82,
                agentId: agentFromHint(match[1]),
                rationale: 'Explicit meeting action-item cue',
            };
        })
        .filter((task): task is MeetingTask => task !== null)
        .slice(0, MAX_TASKS_PER_CHUNK);

    const decisionMatches = [
        ...cleaned.matchAll(/\bdecision\s*:\s*([^.!?]+[.!?]?)/gi),
    ];
    const decisions = decisionMatches
        .map((match): MeetingDecision | null => {
            const summary = toTitleCaseStart(cleanText(match[1]));
            return summary ? { summary, confidence: 0.82 } : null;
        })
        .filter((decision): decision is MeetingDecision => decision !== null)
        .slice(0, MAX_DECISIONS_PER_CHUNK);

    return { tasks, decisions };
}

export function rememberMeetingText(memory: string[], text: string): string[] {
    const cleaned = cleanText(text);
    if (cleaned) memory.push(cleaned);
    while (memory.length > MAX_MEMORY_MESSAGES) memory.shift();
    return memory;
}

export function parseMeetingExtraction(raw: string, threshold = DEFAULT_CONFIDENCE_THRESHOLD): MeetingExtraction {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toUpperCase() === 'NONE') return { tasks: [], decisions: [] };

    let parsed: unknown;
    try {
        const match = trimmed.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : trimmed);
    } catch {
        return { tasks: [], decisions: [] };
    }

    const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
    const rawDecisions = Array.isArray(obj.decisions) ? obj.decisions : [];

    const tasks = rawTasks
        .map((item): MeetingTask | null => {
            const task = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            const title = cleanText(task.title ?? task.task ?? task.instruction);
            const confidence = asNumber(task.confidence, 0);
            if (!title || confidence < threshold) return null;
            return {
                title,
                confidence,
                agentId: cleanText(task.agentId) || DEFAULT_AGENT_ID,
                rationale: cleanText(task.rationale) || undefined,
            };
        })
        .filter((task): task is MeetingTask => task !== null)
        .slice(0, MAX_TASKS_PER_CHUNK);

    const decisions = rawDecisions
        .map((item): MeetingDecision | null => {
            const decision = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            const summary = cleanText(decision.summary ?? decision.decision);
            const confidence = asNumber(decision.confidence, 0);
            if (!summary || confidence < threshold) return null;
            return { summary, confidence };
        })
        .filter((decision): decision is MeetingDecision => decision !== null)
        .slice(0, MAX_DECISIONS_PER_CHUNK);

    return { tasks, decisions };
}

function buildExtractionPrompt(input: MeetingExtractInput): string {
    const context = input.recentContext.length
        ? `Recent meeting context:\n${input.recentContext.map((m) => `- ${m}`).join('\n')}\n\n`
        : '';
    return [
        'Extract actionable software engineering decisions and coding tasks from this Teams meeting message.',
        'Return ONLY JSON with this shape:',
        '{"tasks":[{"title":"short coding task","confidence":0.0,"agentId":"frontend|backend|qa|devops|ux|reviewer","rationale":"why"}],"decisions":[{"summary":"short decision","confidence":0.0}]}',
        'If there is no actionable coding task or decision, return {"tasks":[],"decisions":[]}.',
        '',
        context,
        `Speaker: ${input.speaker || 'unknown'}`,
        `Message: ${input.text}`,
    ].join('\n');
}

export async function extractMeetingActions(input: MeetingExtractInput): Promise<MeetingExtraction> {
    const explicit = extractExplicitMeetingActions(input.text);
    if (explicit.tasks.length || explicit.decisions.length) return explicit;

    const result = await meshllmGenerate({
        model: 'router',
        prompt: buildExtractionPrompt(input),
        temperature: 0,
        maxTokens: 512,
    });
    const extracted = parseMeetingExtraction(result.response);
    return extracted;
}

export function buildAiderMeetingPrompt(
    task: MeetingTask,
    context: { meetingId?: string; speaker?: string; recentContext?: string[] },
): string {
    const recent = context.recentContext?.length
        ? `\nRecent meeting context:\n${context.recentContext.map((m) => `- ${m}`).join('\n')}\n`
        : '';
    return [
        'Meeting-derived coding task.',
        `Task: ${task.title}`,
        `Confidence: ${task.confidence.toFixed(2)}`,
        context.meetingId ? `Meeting: ${context.meetingId}` : '',
        context.speaker ? `Speaker: ${context.speaker}` : '',
        recent,
        'Requirements:',
        '- Make the smallest code change that satisfies the task.',
        '- Add or update tests for changed behavior.',
        '- Do not push, publish, or merge anything.',
        '- If the task is ambiguous, leave a concise note and stop before broad rewrites.',
    ].filter(Boolean).join('\n');
}

export async function dispatchMeetingTask(
    task: MeetingTask,
    context: { meetingId?: string; speaker?: string; recentContext: string[]; rootDir?: string },
): Promise<SpawnResult> {
    const rootDir = context.rootDir || process.cwd();
    const agentId = task.agentId || DEFAULT_AGENT_ID;
    return spawnAgent(
        agentId,
        buildAiderMeetingPrompt(task, context),
        rootDir,
        getAgentModel(agentId, rootDir),
    );
}

export async function processMeetingText(
    input: MeetingProcessInput,
    deps: MeetingDispatchDeps = {},
) {
    const memory = input.memory ?? [];
    const recentContext = memory.slice(-MAX_MEMORY_MESSAGES);
    const extract = deps.extract ?? extractMeetingActions;
    const dispatchTask = deps.dispatchTask ?? ((task, ctx) => dispatchMeetingTask(task, { ...ctx, rootDir: input.rootDir }));
    const extraction = await extract({
        text: input.text,
        meetingId: input.meetingId,
        speaker: input.speaker,
        recentContext,
    });

    rememberMeetingText(memory, input.text);

    const trace: Array<Record<string, unknown>> = [];
    const dispatched: Array<{ task: MeetingTask; result: SpawnResult }> = [];
    for (const task of extraction.tasks) {
        if (input.execute === false) {
            trace.push({ type: 'task', title: task.title, confidence: task.confidence, action: 'held' });
            continue;
        }
        const result = await dispatchTask(task, { meetingId: input.meetingId, speaker: input.speaker, recentContext });
        dispatched.push({ task, result });
        trace.push({ type: 'task', title: task.title, confidence: task.confidence, action: result.spawned ? 'dispatched' : 'blocked', reason: result.reason });
    }
    for (const decision of extraction.decisions) {
        trace.push({ type: 'decision', summary: decision.summary, confidence: decision.confidence, action: 'recorded' });
    }

    const taskCount = extraction.tasks.length;
    const decisionCount = extraction.decisions.length;
    const reply = taskCount || decisionCount
        ? `Task detected: ${taskCount}; decisions recorded: ${decisionCount}.`
        : 'No actionable coding task detected.';
    return { ...extraction, dispatched, trace, reply, memory };
}
